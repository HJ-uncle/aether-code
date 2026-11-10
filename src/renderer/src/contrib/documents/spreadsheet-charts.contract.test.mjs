/** New chart-reader tests: real OOXML relation graphs, live worksheet values,
 * sparse caches, bounded parsing and explicit unsupported-chart placeholders. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import JSZip from 'jszip'
import ExcelJS from 'exceljs'
import * as xmldom from '@xmldom/xmldom'
import * as ssf from 'ssf'

const directory = dirname(fileURLToPath(import.meta.url)), modules = new Map()
function load(name) {
  if (modules.has(name)) return modules.get(name)
  const source = readFileSync(join(directory, `${name}.ts`), 'utf8')
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const exports = {}
  new vm.Script(`(function(require,exports){${javascript}\n})`, { filename: name }).runInThisContext()(specifier => {
    if (specifier.startsWith('./')) return load(specifier.slice(2))
    if (specifier === 'jszip') return JSZip
    if (specifier === '@xmldom/xmldom') return xmldom
    if (specifier === 'ssf') return ssf
    throw new Error(`Unexpected import ${specifier}`)
  }, exports)
  modules.set(name, exports)
  return exports
}
const { readSpreadsheetCharts } = load('spreadsheet-charts')
const relationNs = 'http://schemas.openxmlformats.org/package/2006/relationships'
const relationshipNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const chartNs = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const rels = values => `<Relationships xmlns="${relationNs}">${values.join('')}</Relationships>`
const rel = (id, kind, target, external = false) => `<Relationship Id="${id}" Type="${relationshipNs}/${kind}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`
const cache = (type, values) => `<c:${type}Cache><c:ptCount val="${values.length}"/>${values.map((value, index) => value === null ? '' : `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`).join('')}</c:${type}Cache>`
const source = (name, formula, values, type = 'num') => `<c:${name}><c:${type}Ref><c:f>${formula}</c:f>${cache(type, values)}</c:${type}Ref></c:${name}>`
const series = (values = [999, 999, 999], extra = '', formula = "'Report''s data'!$B$2:$B$4") => `<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>Series A</c:v></c:tx><c:spPr><a:solidFill><a:srgbClr val="1257AA"/></a:solidFill></c:spPr>${source('cat', "'Report''s data'!$A$2:$A$4", ['Old A', 'Old B', 'Old C'], 'str')}${source('val', formula, values)}${extra}</c:ser>`
const chart = (group = `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>${series()}</c:barChart>`, axis = '') => `<c:chartSpace xmlns:c="${chartNs}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Quarterly values</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea>${group}${axis}</c:plotArea><c:legend/></c:chart></c:chartSpace>`
const marker = (name, col, row) => `<xdr:${name}><xdr:col>${col}</xdr:col><xdr:colOff>95250</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>190500</xdr:rowOff></xdr:${name}>`
const frame = '<xdr:graphicFrame><a:graphic><a:graphicData><c:chart r:id="chart-custom"/></a:graphicData></a:graphic></xdr:graphicFrame>'
const anchor = (kind = 'oneCellAnchor') => `<xdr:${kind}>${kind === 'absoluteAnchor' ? '<xdr:pos x="952500" y="1905000"/>' : marker('from', 2, 1)}${kind === 'twoCellAnchor' ? marker('to', 7, 15) : '<xdr:ext cx="6096000" cy="3429000"/>'}${frame}<xdr:clientData/></xdr:${kind}>`

async function fixture({ xml = chart(), anchorXml = anchor(), mutate, values = [12, null, -5] } = {}) {
  const original = new ExcelJS.Workbook(), sheet = original.addWorksheet("Report's data")
  sheet.addRows([['Category', 'Value'], ['Current A', values[0]], ['Current B', values[1]], ['Current C', values[2]]])
  const base = await original.xlsx.writeBuffer(), workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(base)
  const zip = await JSZip.loadAsync(base)
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string')
  zip.file('xl/worksheets/sheet1.xml', sheetXml.replace('</worksheet>', '<drawing r:id="custom-drawing"/></worksheet>'))
  zip.file('xl/worksheets/_rels/sheet1.xml.rels', rels([rel('custom-drawing', 'drawing', '../drawings/renamed-art.xml')]))
  zip.file('xl/drawings/renamed-art.xml', `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="${chartNs}" xmlns:r="${relationshipNs}">${anchorXml}</xdr:wsDr>`)
  zip.file('xl/drawings/_rels/renamed-art.xml.rels', rels([rel('chart-custom', 'chart', '../charts/arbitrary-name.xml')]))
  zip.file('xl/charts/arbitrary-name.xml', xml)
  if (mutate) await mutate(zip, workbook)
  const buffer = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })
  return { buffer, workbook, layouts: [{ columns: [70, 140], rows: [27, 30, 30, 30] }] }
}
async function read(options) { const input = await fixture(options); return (await readSpreadsheetCharts(input.buffer, input.workbook, input.layouts))[0] }

test('follows actual renamed parts and uses current worksheet values instead of stale caches', async () => {
  const input = await fixture({ mutate: async zip => {
    const xml = await zip.file('xl/workbook.xml').async('string'), relations = await zip.file('xl/_rels/workbook.xml.rels').async('string')
    const content = await zip.file('xl/worksheets/sheet1.xml').async('string'), sheetRels = await zip.file('xl/worksheets/_rels/sheet1.xml.rels').async('string')
    zip.remove('xl/worksheets/sheet1.xml'); zip.remove('xl/worksheets/_rels/sheet1.xml.rels')
    zip.file('xl/data/real-data.xml', content); zip.file('xl/data/_rels/real-data.xml.rels', sheetRels)
    zip.file('xl/workbook.xml', xml); zip.file('xl/_rels/workbook.xml.rels', relations.replace('worksheets/sheet1.xml', 'data/real-data.xml'))
  } })
  const before = Buffer.from(input.buffer), [result] = await readSpreadsheetCharts(input.buffer, input.workbook, input.layouts)
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].categories, ['Current A', 'Current B', 'Current C'])
  assert.deepEqual(result[0].series[0].values, [12, null, -5])
  assert.equal(result[0].series[0].color, '#1257AA')
  assert.equal(result[0].title, 'Quarterly values')
  assert.deepEqual([result[0].x, result[0].y, result[0].width, result[0].height], [220, 47, 640, 360])
  assert.deepEqual(Buffer.from(input.buffer), before)
})

test('reads one-cell, two-cell and absolute anchors in worksheet pixels', async () => {
  const [two] = await read({ anchorXml: anchor('twoCellAnchor') })
  assert.deepEqual([two.x, two.y, two.width, two.height], [220, 47, 550, 420])
  const [absolute] = await read({ anchorXml: anchor('absoluteAnchor') })
  assert.deepEqual([absolute.x, absolute.y, absolute.width, absolute.height], [100, 200, 640, 360])
})

for (const [type, markup] of [
  ['bar', `<c:barChart><c:barDir val="bar"/>${series()}</c:barChart>`],
  ['line', `<c:lineChart>${series()}</c:lineChart>`],
  ['area', `<c:areaChart>${series()}</c:areaChart>`],
  ['pie', `<c:pieChart>${series()}</c:pieChart>`],
  ['doughnut', `<c:doughnutChart>${series()}</c:doughnutChart>`],
]) test(`reads a native ${type} chart without converting data to an image`, async () => {
  const [result] = await read({ xml: chart(markup), values: [12, 0, 5] })
  assert.equal(result.type, type)
  assert.deepEqual(result.series[0].values, [12, 0, 5])
  assert.deepEqual(result.warnings, [])
})

test('scatter chart pairs actual X and Y values, including zero and blanks', async () => {
  const [result] = await read({ xml: chart(`<c:scatterChart><c:scatterStyle val="marker"/><c:ser>${source('xVal', "'Report''s data'!B2:B4", [99, 99, 99])}${source('yVal', "'Report''s data'!C2:C4", [99, 99, 99])}</c:ser></c:scatterChart>`),
    values: [0, 2, 3], mutate: async (_zip, workbook) => { for (const [index, value] of [4, null, 8].entries()) workbook.worksheets[0].getCell(index + 2, 3).value = value } })
  assert.equal(result.type, 'scatter')
  assert.deepEqual(result.series[0].xValues, [0, 2, 3])
  assert.deepEqual(result.series[0].values, [4, null, 8])
})

test('uncomputed formulas stay empty even when a stale chart cache exists', async () => {
  const [result] = await read({ mutate: async (_zip, workbook) => {
    workbook.worksheets[0].getCell('B2').value = { formula: '1+1' }
    workbook.worksheets[0].getCell('B3').value = { formula: '0', result: 0 }
  } })
  assert.deepEqual(result.series[0].values, [null, 0, -5])
  assert.match(result.warnings.join(' '), /未保存计算结果/)
})

test('bounded literal caches retain sparse point indexes', async () => {
  const [result] = await read({ xml: chart(`<c:lineChart><c:ser><c:cat><c:strLit><c:ptCount val="3"/><c:pt idx="0"><c:v>A</c:v></c:pt><c:pt idx="2"><c:v>C</c:v></c:pt></c:strLit></c:cat><c:val><c:numLit><c:ptCount val="3"/><c:pt idx="0"><c:v>0</c:v></c:pt><c:pt idx="2"><c:v>8</c:v></c:pt></c:numLit></c:val></c:ser></c:lineChart>`) })
  assert.deepEqual(result.categories, ['A', '', 'C'])
  assert.deepEqual(result.series[0].values, [0, null, 8])
})

test('preserves explicit per-point colors for pie and doughnut series', async () => {
  const [result] = await read({ xml: chart(`<c:pieChart>${series([1, 2, 3], '<c:dPt><c:idx val="1"/><c:spPr><a:solidFill><a:srgbClr val="AABBCC"/></a:solidFill></c:spPr></c:dPt>')}</c:pieChart>`), values: [1, 2, 3] })
  assert.deepEqual(result.series[0].pointColors, [undefined, '#AABBCC', undefined])
})

for (const [name, xml] of [
  ['3D', chart(`<c:bar3DChart>${series()}</c:bar3DChart>`)],
  ['stacked', chart(`<c:barChart><c:grouping val="stacked"/>${series()}</c:barChart>`)],
  ['combination', chart(`<c:barChart>${series()}</c:barChart><c:lineChart>${series()}</c:lineChart>`)],
  ['external data', chart(`<c:lineChart>${series([1, 2, 3], '', "'[other.xlsx]Sheet1'!B2:B4")}</c:lineChart>`)],
  ['point limit', chart(`<c:lineChart><c:ser><c:val><c:numLit><c:ptCount val="1001"/></c:numLit></c:val></c:ser></c:lineChart>`)],
]) test(`reports ${name} as unsupported instead of silently displaying a different chart`, async () => {
  const [result] = await read({ xml })
  assert.equal(result.type, 'unsupported')
  assert.deepEqual(result.series, [])
  assert.ok(result.warnings[0].length > 8)
})

test('external and missing chart parts become isolated placeholders', async () => {
  const [external] = await read({ mutate: async zip => zip.file('xl/drawings/_rels/renamed-art.xml.rels', rels([rel('chart-custom', 'chart', 'https://example.invalid/chart.xml', true)])) })
  assert.equal(external.type, 'unsupported'); assert.match(external.warnings[0], /外部/)
  const [missing] = await read({ mutate: async zip => zip.remove('xl/charts/arbitrary-name.xml') })
  assert.equal(missing.type, 'unsupported'); assert.match(missing.warnings[0], /不存在/)
})

test('rejects entity markup and oversized geometry without affecting worksheet cells', async () => {
  const [entity] = await read({ xml: '<!DOCTYPE chart [<!ENTITY x "payload">]>' + chart() })
  assert.equal(entity.type, 'unsupported'); assert.match(entity.warnings[0], /XML/)
  const [large] = await read({ anchorXml: anchor().replace('6096000', '9525000000') })
  assert.equal(large.type, 'unsupported'); assert.match(large.warnings[0], /尺寸/)
})

test('limits chart count explicitly instead of silently omitting extra drawings', async () => {
  const result = await read({ anchorXml: anchor().repeat(25) })
  assert.equal(result.length, 25)
  assert.equal(result.filter(item => item.type === 'column').length, 24)
  assert.equal(result[24].type, 'unsupported')
  assert.match(result[24].warnings[0], /数量上限/)
})

test('worksheet metadata scan ignores drawing-like comments and handles large cell markup', async () => {
  const [result] = await read({ mutate: async zip => {
    const name = 'xl/worksheets/sheet1.xml', xml = await zip.file(name).async('string')
    zip.file(name, xml.replace('<sheetData>', '<!-- <drawing r:id="comment-fake"/> --><sheetData>').replace('</sheetData>', '<row r="5"><c r="A5" t="inlineStr"><is><t>' + '正文'.repeat(600_000) + '</t></is></c></row></sheetData>'))
  } })
  assert.equal(result.type, 'column')
  assert.deepEqual(result.series[0].values, [12, null, -5])
})

test('valid Excel ranges outside the preview budget never fall back to shortened caches', async () => {
  const [result] = await read({ xml: chart(`<c:lineChart>${series([1, 2, 3], '', "'Report''s data'!B2:B100000")}</c:lineChart>`) })
  assert.equal(result.type, 'unsupported')
  assert.match(result.warnings[0], /预览范围/)
})

test('local chart references follow Excel case-insensitive worksheet names', async () => {
  const [result] = await read({ xml: chart(`<c:lineChart>${series([99, 99, 99], '', "'REPORT''S DATA'!B2:B4")}</c:lineChart>`) })
  assert.equal(result.type, 'line')
  assert.deepEqual(result.series[0].values, [12, null, -5])
})

for (const date1904 of [false, true]) test(`date-formatted numeric chart data retains the ${date1904 ? 1904 : 1900} serial epoch`, async () => {
  const dates = [new Date('2026-11-10T00:00:00Z'), new Date('2026-11-11T12:00:00Z'), new Date('1900-01-01T00:00:00Z')]
  const [result] = await read({ xml: chart(`<c:scatterChart><c:scatterStyle val="marker"/><c:ser>${source('xVal', "'Report''s data'!B2:B4", [99, 99, 99])}${source('yVal', "'Report''s data'!C2:C4", [99, 99, 99])}</c:ser></c:scatterChart>`),
    values: dates, mutate: async (_zip, workbook) => {
      workbook.properties.date1904 = date1904
      for (const [index, date] of dates.entries()) workbook.worksheets[0].getCell(index + 2, 3).value = date
    } })
  const expected = dates.map(date => date.getTime() / 86400000 + 25569 - (date1904 ? 1462 : 0))
  assert.deepEqual(result.series[0].xValues, expected)
  assert.deepEqual(result.series[0].values, expected)
  assert.deepEqual(result.warnings, [])
})
