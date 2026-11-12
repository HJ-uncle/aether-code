import ExcelJS from 'exceljs'
import type { ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { SpreadsheetCell } from '@renderer/features/documents/SpreadsheetCell'
import gridCss from '@renderer/features/documents/spreadsheet-grid.css?inline'
import chartCss from '@renderer/features/documents/spreadsheet-chart.css?inline'
import { SpreadsheetChart } from '@renderer/features/documents/SpreadsheetChart'
import { spreadsheetColumn, DOCUMENT_LIMITS } from '@renderer/features/documents/document-kind'
import { passiveDocumentHtml } from '@renderer/features/documents/document-html'
import { prepareOfficeArchiveOffThread } from '@renderer/features/documents/office-archive-client'
import { buildSpreadsheetLayout, buildSpreadsheetPage, prepareSpreadsheetPageSource } from '@renderer/features/documents/spreadsheet-page'
import { spreadsheetThemeColors } from '@renderer/features/documents/spreadsheet-style'
import { readSpreadsheetCharts } from '@renderer/features/documents/spreadsheet-charts'
import type { SheetLayout, SheetPage } from '@renderer/features/documents/spreadsheet-preview-contract'
import type { XlsxPreviewRegion, XlsxPreviewSheet, XlsxRenderedDocument } from '../../../../shared/office-render'

const WIDTH = 960, HEIGHT = 540, PADDING = 16, ROW_HEADER = 52, TITLE_HEIGHT = 28
const CONTENT_WIDTH = WIDTH - PADDING * 2, TABLE_HEIGHT = HEIGHT - PADDING * 2 - TITLE_HEIGHT
const MAX_PAGES = 100, MAX_HTML_BYTES = 32 * 1024 * 1024
interface Merge { startRow: number; endRow: number; startColumn: number; endColumn: number; ref: string }
const fail = (message: string): never => { throw new Error(`XLSX 画面检查：${message}`) }
function columnIndex(letters: string): number { return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1 }
function mergesOf(refs: string[]): Merge[] {
  return refs.map(ref => {
    const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref)
    if (!match) return fail(`合并区域 ${ref} 无法定位，未生成截断画面。`)
    return { startColumn: columnIndex(match[1]), startRow: Number(match[2]) - 1, endColumn: columnIndex(match[3]) + 1, endRow: Number(match[4]), ref }
  })
}
function columnBands(widths: number[], merges: Merge[]): Array<{ start: number; end: number }> {
  const result: Array<{ start: number; end: number }> = []
  for (let start = 0; start < widths.length;) {
    let end = start, width = ROW_HEADER
    while (end < widths.length && width + widths[end] <= CONTENT_WIDTH) width += widths[end++]
    if (end === start) fail(`第 ${spreadsheetColumn(start + 1)} 列宽度超过可用画面，请缩窄列宽。`)
    // Never turn one merge into two unrelated cells on separate column bands.
    let boundary: number
    do {
      boundary = end
      for (const merge of merges) if (merge.startColumn < end && merge.endColumn > end) end = Math.min(end, merge.startColumn)
    } while (end !== boundary && end > start)
    if (end <= start) fail(`合并区域 ${merges.find(merge => merge.startColumn <= start && merge.endColumn > boundary)?.ref || ''} 宽于单个预览区域，请拆分合并区域或调整列宽。`)
    result.push({ start, end }); start = end
  }
  return result
}
function Table({ page, widths, name }: { page: SheetPage; widths: number[]; name: string }) {
  return <table className="document-preview__table" aria-label={name} style={{ width: ROW_HEADER + widths.reduce((sum, value) => sum + value, 0) }}>
    <colgroup><col style={{ width: ROW_HEADER, minWidth: ROW_HEADER }} />{widths.map((width, index) => <col key={index} style={{ width, minWidth: width }} />)}</colgroup>
    <thead><tr style={{ height: 30 }}><th aria-label="行号" />{widths.map((_width, index) => <th key={index} scope="col">{spreadsheetColumn(page.column + index + 1)}</th>)}</tr></thead>
    <tbody>{page.cells.map((row, index) => <tr key={index} style={{ height: page.layout.rows[index] }} data-sheet-row={page.row + index + 1}>
      <th scope="row" style={{ height: page.layout.rows[index] }}>{page.row + index + 1}</th>
      {row.map((cell, column) => <SpreadsheetCell key={column} cell={cell} />)}
    </tr>)}</tbody>
  </table>
}
function currentTokens(element: HTMLElement, markup = ''): string {
  const computed = getComputedStyle(element)
  const names = new Set([...`${gridCss}\n${chartCss}\n${markup}`.matchAll(/var\((--[\w-]+)/g)].map(match => match[1]))
  names.add('--font-ui')
  return [...names].map(name => `${name}:${computed.getPropertyValue(name).trim()};`).join('')
}
const pageCss = `.aether-xlsx-region{box-sizing:border-box;width:${WIDTH}px;height:${HEIGHT}px;padding:${PADDING}px;overflow:hidden;background:var(--document-paper);color:var(--document-ink);font-family:var(--font-ui);font-size:12px;color-scheme:light}.aether-xlsx-region__title{box-sizing:border-box;height:${TITLE_HEIGHT}px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}.aether-xlsx-region__content{display:block;width:${CONTENT_WIDTH}px;min-height:0}.aether-xlsx-region .document-preview__table th{position:static}`

/** Styled regions from the same cell/format/chart renderers as the live preview.
 * Regions are measured in Chromium; they are not native Excel print pages. */
export async function renderXlsxDocument(data: ArrayBuffer, signal: AbortSignal): Promise<XlsxRenderedDocument> {
  signal.throwIfAborted()
  const prepared = await prepareOfficeArchiveOffThread(data, 'xlsx', signal)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(prepared, { ignoreNodes: ['drawing', 'picture', 'extLst', 'conditionalFormatting', 'dataValidations'] })
  signal.throwIfAborted()
  if (!workbook.worksheets.length) fail('没有可检查的工作表。')
  let cells = 0
  workbook.eachSheet(sheet => sheet.eachRow(row => { cells += row.actualCellCount }))
  if (workbook.worksheets.length > DOCUMENT_LIMITS.sheets || cells > DOCUMENT_LIMITS.cells) fail('工作簿超出当前预览范围。')
  const sources = workbook.worksheets.map(prepareSpreadsheetPageSource)
  if (sources.some(source => source.rowCount > DOCUMENT_LIMITS.rows || source.columnCount > DOCUMENT_LIMITS.columns)) fail('工作表行列数超出当前预览范围。')
  const layouts: SheetLayout[] = sources.map(buildSpreadsheetLayout)
  const themes = spreadsheetThemeColors((workbook as ExcelJS.Workbook & { _themes?: { theme1?: unknown } })._themes?.theme1)
  const charts = await readSpreadsheetCharts(data, workbook, layouts)
  signal.throwIfAborted()
  const host = document.createElement('div')
  host.dataset.xlsxMeasure = 'true'
  Object.assign(host.style, { position: 'fixed', left: '-12000px', top: '0', width: `${WIDTH}px`, visibility: 'hidden', pointerEvents: 'none' })
  const style = document.createElement('style'); style.textContent = gridCss + '\n' + chartCss + '\n' + pageCss
  const target = document.createElement('div')
  host.append(style, target); document.body.append(host)
  let root: Root | undefined
  const pages: string[] = [], regions: XlsxPreviewRegion[] = [], sheets: XlsxPreviewSheet[] = []; let htmlBytes = 0
  try {
    const tokens = currentTokens(host)
    host.style.cssText += tokens
    root = createRoot(target)
    const render = (title: string, content: ReactNode) => {
      signal.throwIfAborted()
      flushSync(() => root!.render(<div className="aether-xlsx-region" style={{ colorScheme: 'light' }}>
        <div className="aether-xlsx-region__title">{title}</div><div className="aether-xlsx-region__content">{content}</div>
      </div>))
    }
    const capture = (region: XlsxPreviewRegion) => {
      signal.throwIfAborted()
      if (pages.length >= MAX_PAGES) fail(`超过 ${MAX_PAGES} 个预览区域，请缩小工作簿范围。`)
      const content = target.querySelector<HTMLElement>('.aether-xlsx-region__content')!
      const bounds = content.getBoundingClientRect(), pageBounds = target.firstElementChild!.getBoundingClientRect()
      if (bounds.bottom > pageBounds.bottom - PADDING + .5 || content.scrollWidth > CONTENT_WIDTH + 1) fail('当前区域超过画面边界，未生成截断画面。')
      const wrapper = document.createElement('div')
      // Chart series also reference palette tokens in SVG attributes and inline
      // legend styles; a scriptless frame cannot inherit those from the app.
      wrapper.style.cssText = currentTokens(host, target.innerHTML); wrapper.innerHTML = target.innerHTML
      const html = passiveDocumentHtml(`<style>${gridCss}\n${chartCss}\n${pageCss}</style>${wrapper.outerHTML}`)
      htmlBytes += html.length * 2
      if (htmlBytes > MAX_HTML_BYTES) fail('预览页面总量超过 32 MiB，请缩小工作簿范围。')
      pages.push(html)
      regions.push(region)
    }
    for (const [sheetIndex, source] of sources.entries()) {
      const name = workbook.worksheets[sheetIndex].name, layout = layouts[sheetIndex], merges = mergesOf(source.model.merges)
      const sheet: XlsxPreviewSheet = { sheet: sheetIndex + 1, name, firstPage: pages.length + 1, lastPage: 0, chartPages: [] }
      const bands = columnBands(layout.columns, merges)
      const rowCount = Math.max(1, source.rowCount)
      // Even the minimum-height product cells cannot fit beyond this bound.
      if (bands.length * Math.ceil(rowCount / 15) + pages.length > MAX_PAGES) fail(`工作表“${name}”超过 ${MAX_PAGES} 个预览区域，请缩小工作簿范围。`)
      for (const band of bands) {
        const widths = layout.columns.slice(band.start, band.end)
        const relevantMerges = merges.filter(merge => merge.startColumn >= band.start && merge.endColumn <= band.end)
        for (let row = 0; row < rowCount;) {
          signal.throwIfAborted()
          let end = Math.min(rowCount, row + 15)
          let previous: number
          do {
            previous = end
            for (const merge of relevantMerges) if (merge.startRow < end && merge.endRow > end) end = Math.min(end, merge.startRow)
          } while (end !== previous && end > row)
          if (end <= row) fail(`工作表“${name}”合并区域跨越过多行，单个画面无法完整显示，请拆分合并区域。`)
          let page = buildSpreadsheetPage(source, sheetIndex, row, band.start, themes, workbook.properties.date1904 === true, end, band.end)
          const title = () => `${name} · 第 ${row + 1}–${end} 行 · ${spreadsheetColumn(band.start + 1)}–${spreadsheetColumn(band.end)} 列`
          render(title(), <Table page={page} widths={widths} name={name} />)
          await document.fonts.ready
          signal.throwIfAborted()
          const table = target.querySelector<HTMLTableElement>('table')!
          let height = table.tHead!.getBoundingClientRect().height, fit = row
          for (const tr of [...table.tBodies[0].rows]) {
            const next = tr.getBoundingClientRect().height
            if (height + next > TABLE_HEIGHT + .5) break
            height += next; fit++
          }
          do {
            previous = fit
            for (const merge of relevantMerges) if (merge.startRow < fit && merge.endRow > fit) fit = Math.min(fit, merge.startRow)
          } while (fit !== previous && fit > row)
          if (fit <= row) fail(`工作表“${name}”第 ${row + 1} 行或合并单元格高于单个画面，请调整行高或拆分内容。`)
          if (fit < end) {
            end = fit
            page = buildSpreadsheetPage(source, sheetIndex, row, band.start, themes, workbook.properties.date1904 === true, end, band.end)
            render(title(), <Table page={page} widths={widths} name={name} />)
          }
          const clipped = [...target.querySelectorAll<HTMLTableCellElement>('tbody td')].find(cell => cell.scrollWidth > cell.clientWidth + 2 || cell.scrollHeight > cell.clientHeight + 2)
          if (clipped) fail(`工作表“${name}”第 ${clipped.parentElement?.getAttribute('data-sheet-row')} 行单元格文字超出原列宽，请加宽列或启用换行，未生成截断画面。`)
          capture({ sheet: sheet.sheet, name, kind: 'cells', range: `${spreadsheetColumn(band.start + 1)}${row + 1}:${spreadsheetColumn(band.end)}${end}` }); row = end
          await new Promise(resolve => setTimeout(resolve, 0))
        }
      }
      for (const chart of charts[sheetIndex]) {
        if (chart.type === 'unsupported') fail(`工作表“${name}”的图表“${chart.title}”类型暂不支持完整预览。`)
        if (chart.width > CONTENT_WIDTH || chart.height > TABLE_HEIGHT) fail(`工作表“${name}”的图表“${chart.title}”大于单个画面，请调整图表尺寸。`)
        render(`${name} · 图表：${chart.title || chart.type}`, <SpreadsheetChart chart={chart} />)
        capture({ sheet: sheet.sheet, name, kind: 'chart', title: chart.title || chart.type })
        sheet.chartPages.push(pages.length)
      }
      sheet.lastPage = pages.length
      sheets.push(sheet)
    }
    return { pages, regions, navigation: { sheets } }
  } finally {
    if (root) flushSync(() => root!.unmount())
    host.remove()
  }
}

// Existing consumers that need only image HTML keep the same contract.
export async function renderXlsxPages(data: ArrayBuffer, signal: AbortSignal): Promise<string[]> {
  return (await renderXlsxDocument(data, signal)).pages
}
