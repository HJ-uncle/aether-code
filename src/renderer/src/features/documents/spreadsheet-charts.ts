import { DOMParser } from '@xmldom/xmldom'
import type { Cell, Workbook, Worksheet } from 'exceljs'
import type { SheetLayout } from './spreadsheet-preview-contract'
import { expandOfficeEntry, inspectOfficeArchive } from './office-archive'
import { DOCUMENT_LIMITS } from './document-kind'
import { spreadsheetDisplayValue } from './spreadsheet-value'
import { spreadsheetThemeColors } from './spreadsheet-style'

export type SheetChartType = 'column' | 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter' | 'unsupported'
export interface SheetChartSeries { name: string; values: (number | null)[]; xValues?: (number | null)[]; color?: string; pointColors?: (string | undefined)[] }
export interface SheetChart {
  id: string; type: SheetChartType; title: string; categories: string[]; series: SheetChartSeries[]; legend: boolean
  /** Coordinates are relative to worksheet cells, before the preview row/column headers. */
  x: number; y: number; width: number; height: number; warnings: string[]
}

const EMU_PER_PIXEL = 9525
const LIMITS = { chartsPerSheet: 24, charts: 96, series: 8, points: 1000, xmlBytes: 2 * 1024 * 1024, xmlElements: 60_000, label: 512, position: 2_000_000 }
type Relationship = { target: string; type: string; external: boolean }
type Geometry = Pick<SheetChart, 'x' | 'y' | 'width' | 'height'>
const children = (node: Node, name?: string): Element[] => Array.from(node.childNodes).filter((child): child is Element => child.nodeType === 1 && (!name || (child as Element).localName === name))
const child = (node: Node | undefined, name: string): Element | undefined => node ? children(node, name)[0] : undefined
const descendants = (node: Element | Document | undefined, name: string): Element[] => node ? Array.from(node.getElementsByTagNameNS('*', name)) : []
const value = (node: Node | undefined): string => node?.textContent?.trim() || ''
const attr = (node: Element | undefined, name = 'val'): string => node?.getAttribute(name) || ''
const relationshipId = (node: Element): string => Array.from(node.attributes).find(attribute => attribute.localName === 'id')?.value || ''
const problem = (message: string): never => { throw new Error(message) }
const warn = (warnings: string[], message: string): void => { if (!warnings.includes(message)) warnings.push(message) }
const label = (text: string, warnings: string[]): string => {
  if (text.length > LIMITS.label) warn(warnings, '较长的图表标签仅显示前 512 个字符。')
  return text.slice(0, LIMITS.label)
}

function partPath(owner: string, target: string): string {
  if (!target || /[\\\u0000-\u001f?#]/.test(target) || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(target)) return problem('图表引用不是可读取的本地文档部件。')
  const parts = target.startsWith('/') ? [] : owner.split('/').slice(0, -1)
  for (const part of target.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!parts.length) return problem('图表引用超出文档范围。'); parts.pop() }
    else parts.push(part)
  }
  return parts.join('/')
}
const relationshipPath = (owner: string): string => {
  const parts = owner.split('/'), file = parts.pop() || ''
  return [...parts, '_rels', file + '.rels'].join('/')
}

function parseXml(text: string): Document {
  if (text.length > LIMITS.xmlBytes || /<!DOCTYPE|<!ENTITY/i.test(text)) return problem('图表 XML 超出预览范围。')
  let malformed = false
  const xml = new DOMParser({ errorHandler: { warning: () => { malformed = true }, error: () => { malformed = true }, fatalError: () => { malformed = true } } }).parseFromString(text, 'application/xml')
  if (malformed || !xml.documentElement || xml.getElementsByTagName('*').length > LIMITS.xmlElements) return problem('图表 XML 无法完整解析。')
  return xml
}

/** Worksheets can be much larger than their drawings. The archive preparer
 * already validates their XML; scan only direct drawing references here instead
 * of retaining a second DOM for hundreds of thousands of cells in this worker. */
function worksheetDrawingIds(text: string): string[] {
  if (text.length > DOCUMENT_LIMITS.xmlBytes || /<!DOCTYPE|<!ENTITY/i.test(text)) return problem('工作表 XML 超出图表读取范围。')
  const result: string[] = [], stack: string[] = []
  const tags = /<(?:!--[\s\S]*?--|!\[CDATA\[[\s\S]*?\]\]|\?[\s\S]*?\?|\/?[A-Za-z_][\w:.-]*(?:[^"'<>]|"[^"]*"|'[^']*')*)>/g
  for (const match of text.matchAll(tags)) {
    const token = match[0]
    if (/^<[!?]/.test(token)) continue
    const name = /^<\/?([\w:.-]+)/.exec(token)?.[1]
    if (!name) continue
    if (token.startsWith('</')) { if (stack.pop() !== name) return problem('工作表 XML 层级无效。'); continue }
    if (stack.length === 1 && name.split(':').at(-1) === 'drawing') {
      const id = /\s(?:[A-Za-z_][\w.-]*:)?id\s*=\s*("[^"]*"|'[^']*')/.exec(token)?.[1]
      if (!id) return problem('工作表图表关系标识缺失。')
      result.push(parseXml(`<drawing id=${id}/>`).documentElement.getAttribute('id') || '')
    }
    if (!/\/\s*>$/.test(token)) stack.push(name)
  }
  if (stack.length) return problem('工作表 XML 层级不完整。')
  return result
}

function coordinate(marker: Element | undefined, dimension: 'column' | 'row', layout: SheetLayout): number {
  if (!marker) return problem('图表缺少工作表定位信息。')
  const name = dimension === 'column' ? 'col' : 'row'
  const indexNode = child(marker, name)
  if (!indexNode) return problem('图表缺少工作表定位信息。')
  const index = Number(value(indexNode)), offset = Number(value(child(marker, name + 'Off')) || 0) / EMU_PER_PIXEL
  if (!Number.isInteger(index) || index < 0 || index >= (dimension === 'column' ? 16384 : 1048576) || !Number.isFinite(offset) || offset < 0) return problem('图表定位信息无效。')
  const sizes = dimension === 'column' ? layout.columns : layout.rows, fallback = dimension === 'column' ? 110 : 30
  let total = Math.max(0, index - sizes.length) * fallback + offset
  for (let cursor = 0; cursor < Math.min(index, sizes.length); cursor++) total += sizes[cursor]
  if (total > LIMITS.position) return problem('图表距离工作表内容过远，超出预览范围。')
  return total
}

function geometry(anchor: Element, layout: SheetLayout): Geometry {
  let x: number, y: number, width: number, height: number
  if (anchor.localName === 'absoluteAnchor') {
    const pos = child(anchor, 'pos')
    x = Number(attr(pos, 'x')) / EMU_PER_PIXEL; y = Number(attr(pos, 'y')) / EMU_PER_PIXEL
  } else {
    x = coordinate(child(anchor, 'from'), 'column', layout); y = coordinate(child(anchor, 'from'), 'row', layout)
  }
  if (anchor.localName === 'twoCellAnchor') {
    width = coordinate(child(anchor, 'to'), 'column', layout) - x; height = coordinate(child(anchor, 'to'), 'row', layout) - y
  } else {
    const extent = child(anchor, 'ext')
    width = Number(attr(extent, 'cx')) / EMU_PER_PIXEL; height = Number(attr(extent, 'cy')) / EMU_PER_PIXEL
  }
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || x > LIMITS.position || y > LIMITS.position || width < 24 || height < 24 || width > 2400 || height > 1800) return problem('图表尺寸或位置超出预览范围。')
  return { x, y, width, height }
}

function cellCoordinate(address: string): { row: number; column: number } | null {
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d*)$/i.exec(address)
  if (!match) return null
  const column = Array.from(match[1].toUpperCase()).reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0), row = Number(match[2])
  return row <= DOCUMENT_LIMITS.rows && column <= DOCUMENT_LIMITS.columns ? { row, column } : null
}

function referenceCells(formula: string, workbook: Workbook, current: Worksheet): Cell[] | null {
  if (formula.includes('[') || formula.includes(']')) return problem('外部工作簿图表数据不读取，也不以旧缓存替代。')
  const text = formula.replace(/^=/, '')
  const qualified = /^(?:'((?:[^']|'')+)'|([^!']+))!(.+)$/.exec(text)
  const sheetName = qualified && (qualified[1]?.replace(/''/g, "'") ?? qualified[2]).toLowerCase()
  const sheet = qualified ? workbook.worksheets.find(item => item.name.toLowerCase() === sheetName) : current
  const range = qualified ? qualified[3] : text
  const pieces = range.split(':')
  if (pieces.length > 2) return null
  const first = cellCoordinate(pieces[0]), last = cellCoordinate(pieces[1] ?? pieces[0])
  if (!first || !last) {
    if (pieces.every(piece => /^\$?[A-Z]{1,3}\$?[1-9]\d*$/i.test(piece))) return problem('图表引用超出工作表预览范围。')
    return null
  }
  if (!sheet) return problem('图表引用的本地工作表不存在。')
  if (last.row < first.row || last.column < first.column || first.row !== last.row && first.column !== last.column) return problem('图表引用必须是单行或单列区域。')
  const length = Math.max(last.row - first.row, last.column - first.column) + 1
  if (length > LIMITS.points) return problem('图表单个系列超过 1000 个数据点，未省略数据作图。')
  return Array.from({ length }, (_, index) => sheet.getCell(first.row + (first.row === last.row ? 0 : index), first.column + (first.column === last.column ? 0 : index)))
}

function savedValue(cell: Cell, warnings: string[]): unknown {
  const source = cell.value
  if (source && typeof source === 'object' && ('formula' in source || 'sharedFormula' in source)) {
    const saved = 'result' in source ? source.result : cell.model.result
    if (saved === undefined || saved === null) warn(warnings, '部分公式未保存计算结果，图表对应位置留空；请先重算工作簿。')
    return saved
  }
  return source
}

function numeric(input: unknown, warnings: string[], date1904 = false): number | null {
  if (input === undefined || input === null || input === '') return null
  // ExcelJS has already applied the workbook date epoch while loading date-
  // formatted numbers. Restore its serial for numeric axes, using the same
  // conversion as ExcelJS, including its treatment of early 1900 dates.
  if (input instanceof Date && Number.isFinite(input.getTime())) return input.getTime() / 86400000 + 25569 - (date1904 ? 1462 : 0)
  if (typeof input === 'number' && Number.isFinite(input)) return input
  warn(warnings, '部分数据不是有效数值，图表对应位置留空。')
  return null
}

function cacheValues(container: Element | undefined, numericValues: boolean, warnings: string[], date1904: boolean): (string | number | null)[] {
  if (!container) return []
  const countNode = child(container, 'ptCount'), points = children(container, 'pt')
  const count = countNode ? Number(attr(countNode)) : points.reduce((maximum, point) => Math.max(maximum, Number(attr(point, 'idx')) + 1), 0)
  if (!Number.isInteger(count) || count < 0 || count > LIMITS.points || points.length > LIMITS.points) return problem('图表单个系列超过 1000 个数据点或索引无效。')
  const result: (string | number | null)[] = Array.from({ length: count }, () => numericValues ? null : '')
  const seen = new Set<number>()
  for (const point of points) {
    const index = Number(attr(point, 'idx')), text = value(child(point, 'v'))
    if (!Number.isInteger(index) || index < 0 || index >= count || seen.has(index)) return problem('图表缓存数据索引无效。')
    seen.add(index)
    const format = value(child(container, 'formatCode'))
    const formatted = !numericValues && container.localName.startsWith('num') && text !== '' && Number.isFinite(Number(text))
      ? spreadsheetDisplayValue(Number(text), text, format || 'General', date1904).text : text
    result[index] = numericValues ? text === '' ? null : numeric(Number(text), warnings) : label(formatted, warnings)
  }
  return result
}

function vector(container: Element | undefined, numbers: boolean, workbook: Workbook, current: Worksheet, warnings: string[]): (string | number | null)[] {
  if (!container) return []
  if (child(container, 'multiLvlStrRef')) return problem('多级分类轴暂不支持预览。')
  const ref = child(container, 'numRef') || child(container, 'strRef')
  const formula = value(child(ref, 'f'))
  if (formula) {
    const cells = referenceCells(formula, workbook, current)
    if (cells) return cells.map(cell => {
      const saved = savedValue(cell, warnings)
      if (numbers) return numeric(saved, warnings, workbook.properties.date1904 === true)
      if (saved === null || saved === undefined) return ''
      const formatted = spreadsheetDisplayValue(cell.value, cell.text, cell.numFmt, workbook.properties.date1904 === true, cell.model)
      return label(formatted.text, warnings)
    })
    warn(warnings, '此图表使用命名区域或复杂引用，仅显示文件保存的图表缓存。')
  }
  const cache = child(ref, numbers ? 'numCache' : 'strCache') || child(ref, 'numCache') || child(container, numbers ? 'numLit' : 'strLit') || child(container, 'numLit')
  if (!cache && ref) return problem('图表数据引用无法读取，且没有可用缓存。')
  return cacheValues(cache, numbers, warnings, workbook.properties.date1904 === true)
}

function seriesColor(series: Element, theme: string[]): string | undefined {
  const properties = child(series, 'spPr'), fill = child(properties, 'solidFill') || child(child(properties, 'ln'), 'solidFill')
  const rgb = attr(child(fill, 'srgbClr'))
  if (/^[a-f0-9]{6}$/i.test(rgb)) return '#' + rgb
  const scheme = attr(child(fill, 'schemeClr'))
  const index = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].indexOf(scheme)
  return index >= 0 && theme[index] ? '#' + theme[index] : undefined
}

function pointColors(series: Element, count: number, theme: string[]): (string | undefined)[] | undefined {
  const points = children(series, 'dPt')
  if (!points.length) return undefined
  if (points.length > LIMITS.points) return problem('图表逐点样式超过预览范围。')
  const colors: (string | undefined)[] = Array.from({ length: count })
  for (const point of points) {
    const index = Number(attr(child(point, 'idx')))
    if (!Number.isInteger(index) || index < 0 || index >= count) return problem('图表逐点样式索引无效。')
    colors[index] = seriesColor(point, theme)
  }
  return colors
}

function parseChart(xml: Document, id: string, rect: Geometry, workbook: Workbook, sheet: Worksheet, theme: string[]): SheetChart {
  const warnings: string[] = [], chart = descendants(xml, 'chart')[0], plot = child(chart, 'plotArea')
  const titleNode = child(chart, 'title'), title = label(descendants(titleNode, 't').map(node => node.textContent || '').join('') || '图表', warnings)
  const base: SheetChart = { id, type: 'unsupported', title, categories: [], series: [], legend: Boolean(child(chart, 'legend')), ...rect, warnings }
  try {
    if (!plot) return problem('图表缺少绘图区。')
    const groups = children(plot).filter(node => /Chart$/.test(node.localName))
    if (groups.length !== 1) return problem('组合图表暂不支持预览，原图表仍保留在文件中。')
    const group = groups[0]
    const types: Record<string, SheetChartType> = { barChart: attr(child(group, 'barDir')) === 'bar' ? 'bar' : 'column', lineChart: 'line', areaChart: 'area', pieChart: 'pie', doughnutChart: 'doughnut', scatterChart: 'scatter' }
    const type = types[group.localName]
    if (!type) return problem('此图表类型暂不支持预览，原图表仍保留在文件中。')
    const grouping = attr(child(group, 'grouping'))
    if (grouping && !['standard', 'clustered'].includes(grouping)) return problem('堆积或百分比堆积图暂不支持预览。')
    if (descendants(plot, 'logBase').length) return problem('对数坐标轴图表暂不支持预览。')
    if (descendants(plot, 'scaling').some(node => attr(child(node, 'orientation')) === 'maxMin')) return problem('反向坐标轴图表暂不支持预览。')
    if (descendants(plot, 'scaling').some(node => child(node, 'min') || child(node, 'max'))) warn(warnings, '预览按实际数据自动缩放坐标轴，不复刻文件中的固定刻度范围。')
    if (descendants(group, 'trendline').length || descendants(group, 'errBars').length) warn(warnings, '趋势线和误差线暂不显示。')
    const series = children(group, 'ser')
    if (!series.length || series.length > LIMITS.series) return problem('图表需要 1–8 个数据系列，未省略系列作图。')
    if (['pie', 'doughnut'].includes(type) && series.length !== 1) return problem('多系列饼图或环形图暂不支持预览。')
    base.type = type
    for (const [index, item] of series.entries()) {
      const name = value(child(child(item, 'tx'), 'v')) || String(vector(child(item, 'tx'), false, workbook, sheet, warnings)[0] || '') || `系列 ${index + 1}`
      const values = vector(child(item, type === 'scatter' ? 'yVal' : 'val'), true, workbook, sheet, warnings) as (number | null)[]
      if (!values.length) return problem('图表系列没有可读取的数据。')
      if (type === 'scatter') {
        const xValues = vector(child(item, 'xVal'), true, workbook, sheet, warnings) as (number | null)[]
        if (xValues.length !== values.length) return problem('散点图的 X、Y 数据长度不一致。')
        base.series.push({ name: label(name, warnings), values, xValues, color: seriesColor(item, theme) })
      } else {
        const labels = vector(child(item, 'cat'), false, workbook, sheet, warnings).map(entry => entry === null ? '' : String(entry))
        const categories = labels.length ? labels : values.map((_, point) => String(point + 1))
        if (categories.length !== values.length || index > 0 && (categories.length !== base.categories.length || categories.some((entry, point) => entry !== base.categories[point]))) return problem('图表各系列的分类范围不一致。')
        if (['pie', 'doughnut'].includes(type) && values.some(entry => entry !== null && entry < 0)) return problem('含负数的饼图或环形图暂不支持预览。')
        base.categories = categories
        base.series.push({ name: label(name, warnings), values, color: seriesColor(item, theme), pointColors: pointColors(item, values.length, theme) })
      }
    }
    if (!base.series.some(item => item.values.some(entry => entry !== null))) warn(warnings, '图表没有已保存的有效数值。')
    return base
  } catch (error) {
    base.type = 'unsupported'; base.series = []; base.categories = []
    warn(warnings, error instanceof Error ? error.message : '此图表暂时无法预览。')
    return base
  }
}

/** Parse passive chart objects separately from ExcelJS, which intentionally
 * ignores drawings. Cell references win over stale chart caches; no formulas or
 * external resources execute during preview. A chart failure keeps cells usable. */
export async function readSpreadsheetCharts(buffer: ArrayBuffer, workbook: Workbook, layouts: SheetLayout[]): Promise<SheetChart[][]> {
  const result: SheetChart[][] = workbook.worksheets.map(() => [])
  const admitted = inspectOfficeArchive(buffer), entries = new Map(admitted.map(entry => [entry.name, entry]))
  const xmlCache = new Map<string, Promise<Document | undefined>>(), signal = new AbortController().signal
  const readText = async (name: string, maximum: number): Promise<string> => {
    const entry = entries.get(name)
    if (!entry) return problem('图表引用的文档部件不存在。')
    if (entry.unpacked > maximum) return problem('图表 XML 超出预览范围。')
    return new TextDecoder('utf-8', { fatal: true }).decode(await expandOfficeEntry(buffer, entry, signal))
  }
  const readXml = (name: string, optional = false): Promise<Document | undefined> => {
    let found = xmlCache.get(name)
    if (!found) {
      found = (async () => {
        const entry = entries.get(name)
        if (!entry) { if (optional) return undefined; return problem('图表引用的文档部件不存在。') }
        return parseXml(await readText(name, LIMITS.xmlBytes))
      })()
      xmlCache.set(name, found)
    }
    return found
  }
  const relations = async (owner: string): Promise<Map<string, Relationship>> => {
    const xml = await readXml(relationshipPath(owner), true), output = new Map<string, Relationship>()
    for (const relation of descendants(xml, 'Relationship')) {
      const id = attr(relation, 'Id'), target = attr(relation, 'Target'), type = attr(relation, 'Type')
      if (!id || output.has(id)) return problem('图表部件关系存在重复标识。')
      output.set(id, { target, type, external: attr(relation, 'TargetMode').toLowerCase() === 'external' })
    }
    return output
  }
  const resolve = (owner: string, relation: Relationship | undefined, kind: string): string => {
    if (!relation || !relation.type.endsWith('/' + kind)) return problem('图表部件关系缺失或不匹配。')
    if (relation.external) return problem('外部图表部件不读取。')
    return partPath(owner, relation.target)
  }
  const placeholder = (id: string, index: number, message: string, rect?: Geometry): SheetChart => ({ id, type: 'unsupported', title: '图表暂不可预览', categories: [], series: [], legend: false,
    ...(rect || { x: 0, y: index * 380, width: 640, height: 360 }), warnings: [message] })
  try {
    const roots = await relations(''), root = [...roots.values()].find(item => item.type.endsWith('/officeDocument'))
    const workbookPath = resolve('', root, 'officeDocument'), workbookXml = await readXml(workbookPath), workbookRels = await relations(workbookPath)
    const theme = spreadsheetThemeColors((workbook as Workbook & { _themes?: { theme1?: unknown } })._themes?.theme1)
    let count = 0
    for (const [index, sheet] of workbook.worksheets.entries()) {
      const metadata = descendants(workbookXml, 'sheet').find(item => attr(item, 'name') === sheet.name)
      if (!metadata) continue
      try {
        const sheetPath = resolve(workbookPath, workbookRels.get(relationshipId(metadata)), 'worksheet'), drawingIds = worksheetDrawingIds(await readText(sheetPath, DOCUMENT_LIMITS.xmlBytes)), sheetRels = await relations(sheetPath)
        const layout = layouts[index] || { columns: [], rows: [] }
        for (const drawingId of drawingIds) {
          const drawingPath = resolve(sheetPath, sheetRels.get(drawingId), 'drawing'), drawingXml = await readXml(drawingPath), drawingRels = await relations(drawingPath)
          for (const anchor of children(drawingXml!.documentElement)) {
            const chartReferences = descendants(anchor, 'chart')
            for (const reference of chartReferences) {
              if (result[index].length >= LIMITS.chartsPerSheet || count >= LIMITS.charts) {
                result[index].push(placeholder(`${sheet.name}-limit`, result[index].length, '图表超过预览数量上限（每表 24 个、工作簿 96 个），其余图表仍保留在文件中。'))
                break
              }
              count++
              const id = `${sheet.name}:${drawingPath}:${relationshipId(reference)}:${result[index].length}`
              let rect: Geometry | undefined
              try {
                if (!['oneCellAnchor', 'twoCellAnchor', 'absoluteAnchor'].includes(anchor.localName)) return problem('此图表定位方式暂不支持预览。')
                rect = geometry(anchor, layout)
                const chartPath = resolve(drawingPath, drawingRels.get(relationshipId(reference)), 'chart'), chartXml = await readXml(chartPath)
                result[index].push(parseChart(chartXml!, id, rect, workbook, sheet, theme))
              } catch (error) { result[index].push(placeholder(id, result[index].length, error instanceof Error ? error.message : '图表暂时无法预览。', rect)) }
            }
            if (result[index].length > LIMITS.chartsPerSheet || result[index].at(-1)?.id === `${sheet.name}-limit`) break
          }
          if (result[index].length > LIMITS.chartsPerSheet || result[index].at(-1)?.id === `${sheet.name}-limit`) break
        }
      } catch (error) { result[index].push(placeholder(`${sheet.name}-error`, result[index].length, error instanceof Error ? error.message : '图表暂时无法预览。')) }
    }
  } catch (error) {
    if (admitted.some(entry => /(?:^|\/)charts\//.test(entry.name)) && result.length) result[0].push(placeholder('workbook-chart-error', 0, error instanceof Error ? error.message : '工作簿图表暂时无法预览。'))
  }
  return result
}
