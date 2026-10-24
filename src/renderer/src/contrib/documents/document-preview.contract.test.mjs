/** Pure boundary checks; no Electron/window/model/engine interaction. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import ExcelJS from 'exceljs'
import ssf from 'ssf'

const directory = dirname(fileURLToPath(import.meta.url)), modules = new Map()
function load(name) {
  if (modules.has(name)) return modules.get(name)
  const source = readFileSync(join(directory, name + '.ts'), 'utf8')
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  new vm.Script('(function(require,exports){' + javascript + '\n})', { filename: name }).runInThisContext()(specifier => {
    if (specifier === './document-kind') return load('document-kind')
    if (specifier === 'ssf') return ssf
    throw new Error('Unexpected dependency: ' + specifier)
  }, exports)
  modules.set(name, exports)
  return exports
}
const { documentKindFor, documentBytes, spreadsheetColumn, pdfCanvasSize, DOCUMENT_LIMITS } = load('document-kind')
const { inspectOfficeArchive, expandOfficeEntry, officeImagePixels, passiveOfficePart, passiveOfficeRelationship, sanitizeMergeRefs } = load('office-archive')
const { spreadsheetDisplayValue } = load('spreadsheet-value')
const archive = async (name = 'word/document.xml', text = '<document/>') => {
  const zip = new JSZip(); zip.file(name, text)
  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })
}
test('document dispatch excludes macro/legacy/unknown formats and handles uppercase extensions', () => {
  for (const kind of ['pdf', 'docx', 'xlsx', 'pptx']) assert.equal(documentKindFor('report.' + kind.toUpperCase()), kind)
  for (const name of ['readme', 'report.docm', 'report.xlsm', 'report.pptm', 'report.xls', 'report.doc', 'report.pdf.exe']) assert.equal(documentKindFor(name), null)
})
test('input requires exact byte size and rejects oversized data before decoding', () => {
  assert.deepEqual([...new Uint8Array(documentBytes('AQID', 3))], [1, 2, 3])
  assert.throws(() => documentBytes('AQID', 2), /不完整/)
  assert.throws(() => documentBytes('', DOCUMENT_LIMITS.inputBytes + 1), /16 MB/)
})
test('column labels cover visible bounded sheet ranges', () => {
  assert.equal(spreadsheetColumn(1), 'A'); assert.equal(spreadsheetColumn(26), 'Z')
  assert.equal(spreadsheetColumn(27), 'AA'); assert.equal(spreadsheetColumn(256), 'IV')
})
test('PDF pixel cap holds for huge pages, zoomed pages and fractional DPR', () => {
  for (const [width, height, dpr] of [[120000, 120000, 2], [800, 1200, 1.5], [1, 100000000, 2], [100000000, 1, 2], [4097, 3001, 3]]) {
    const size = pdfCanvasSize(width, height, dpr)
    assert.ok(size.width * size.height <= DOCUMENT_LIMITS.canvasPixels)
    assert.ok(size.width > 0 && size.height > 0 && size.width <= 16384 && size.height <= 16384)
  }
  assert.throws(() => pdfCanvasSize(Infinity, 100, 2)); assert.throws(() => pdfCanvasSize(0, 100, 2))
})
test('a normal deflate archive admits complete entry byte ranges', async () => {
  const bytes = await archive(), entries = inspectOfficeArchive(bytes)
  assert.equal(entries.length, 2); assert.equal(entries[1].name, 'word/document.xml')
  assert.equal(entries[1].unpacked, 11); assert.ok(entries[1].offset + entries[1].packed <= bytes.byteLength)
})
test('invalid/truncated/zip64-like metadata, encryption and expanded-size bombs are rejected', async () => {
  const original = await archive()
  assert.throws(() => inspectOfficeArchive(original.slice(0, -3)))
  const find = () => { const result = original.slice(0), view = new DataView(result); for (let i = 0; i < result.byteLength - 46; i++) if (view.getUint32(i, true) === 0x02014b50) return { result, view, at: i }; throw new Error('no central record') }
  for (const mutation of [
    ({ view, at }) => view.setUint16(at + 8, 1, true),
    ({ view, at }) => view.setUint32(at + 24, DOCUMENT_LIMITS.expandedBytes + 1, true),
    ({ view, at }) => view.setUint32(at + 42, 0xffffffff, true),
    ({ view, at }) => view.setUint16(at + 10, 99, true)
  ]) { const item = find(); mutation(item); assert.throws(() => inspectOfficeArchive(item.result)) }
})
test('archive traversal and duplicate case aliases are rejected', async () => {
  await assert.rejects(async () => inspectOfficeArchive(await archive('../document.xml')))
  const zip = new JSZip(); zip.file('word/a.xml', 'a'); zip.file('word/A.xml', 'b')
  const awaitable = await zip.generateAsync({ type: 'arraybuffer' })
  assert.throws(() => inspectOfficeArchive(awaitable))
})
test('malformed overlapping spreadsheet merges are reduced to valid non-overlapping refs', () => {
  assert.deepEqual(sanitizeMergeRefs(['A1:B2', 'A1:B2', 'B2:C3', 'D4:E4', 'bad', 'F0:G1', 'H1:I1']), ['A1:B2', 'D4:E4', 'H1:I1'])
  // A large range that overlaps an earlier range is dropped deterministically;
  // preserving source order avoids changing which cell owns the displayed value.
  assert.deepEqual(sanitizeMergeRefs(['A24:G25', 'A24:G26', 'A27:G28']), ['A24:G25', 'A27:G28'])
})
test('real PowerPoint chart containers retain cached chart parts while embedded workbooks and active relationships are excluded', async () => {
  const presentation = new PptxGenJS()
  presentation.addSlide().addChart(presentation.ChartType.bar, [{ name: '收入', labels: ['Q1', 'Q2'], values: [20, 35] }], { x: 1, y: 1, w: 6, h: 3 })
  const data = await presentation.write({ outputType: 'arraybuffer' })
  const entries = inspectOfficeArchive(data)
  const workbook = entries.find(entry => /^ppt\/embeddings\/.*\.xlsx$/.test(entry.name))
  const chart = entries.find(entry => /^ppt\/charts\/chart\d+\.xml$/.test(entry.name))
  assert.ok(workbook); assert.ok(chart)
  assert.equal(passiveOfficePart(workbook.name), false); assert.equal(passiveOfficePart(chart.name), true)
  const zip = await JSZip.loadAsync(data)
  const xml = await zip.file(chart.name).async('string')
  assert.match(xml, /numCache/); assert.match(xml, />35</)
  assert.equal(passiveOfficeRelationship('../embeddings/workbook.xlsx', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/package'), false)
  assert.equal(passiveOfficeRelationship('../charts/chart1.xml', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart'), true)
  for (const name of ['word/vbaProject.bin', 'word/activeX/a.xml', 'word/embeddings/object.bin']) assert.equal(passiveOfficePart(name), false)
  assert.equal(passiveOfficeRelationship('https://example.invalid/image.png', 'image', 'External'), false)
})
test('deflate output is bounded by actual streaming bytes, and abort does not start expansion', async () => {
  const buffer = await archive('word/document.xml', 'x'.repeat(1024 * 1024))
  const entry = inspectOfficeArchive(buffer).find(item => item.name === 'word/document.xml')
  await assert.rejects(expandOfficeEntry(buffer, { ...entry, unpacked: 16 }, new AbortController().signal), /安全预览/)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(expandOfficeEntry(buffer, entry, abort.signal), { name: 'AbortError' })
  const small = await archive(), actual = inspectOfficeArchive(small).find(item => item.name === 'word/document.xml')
  assert.equal(new TextDecoder().decode(await expandOfficeEntry(small, actual, new AbortController().signal)), '<document/>')
})
test('image pixel bounds are established from headers without allocating image pixels', () => {
  const png = new Uint8Array(33), view = new DataView(png.buffer)
  view.setUint32(0, 0x89504e47); view.setUint32(4, 0x0d0a1a0a); view.setUint32(8, 13)
  png.set([73, 72, 68, 82], 12); view.setUint32(16, 100); view.setUint32(20, 100)
  assert.equal(officeImagePixels(png), 10000)
  view.setUint32(20, 100000); assert.throws(() => officeImagePixels(png))
  assert.throws(() => officeImagePixels(new Uint8Array([1, 2, 3])))
})
test('real XLSX saved percentages, amounts, dates and formula caches retain their display formats without recalculation', async () => {
  const source = new ExcelJS.Workbook(), sheet = source.addWorksheet('财务')
  sheet.getCell('A1').value = 0.2; sheet.getCell('A1').numFmt = '0%'
  sheet.getCell('A2').value = 12345.6; sheet.getCell('A2').numFmt = '#,##0.00'
  sheet.getCell('A3').value = new Date('2026-10-24T00:00:00Z'); sheet.getCell('A3').numFmt = 'yyyy-mm-dd'
  sheet.getCell('A4').value = { formula: '1/5', result: 0.2 }; sheet.getCell('A4').numFmt = '0.0%'
  const loaded = new ExcelJS.Workbook(); await loaded.xlsx.load(await source.xlsx.writeBuffer())
  for (const [row, expected] of [[1, '20%'], [2, '12,345.60'], [3, '2026-10-24'], [4, '20.0%']]) {
    const cell = loaded.worksheets[0].getCell('A' + row)
    assert.deepEqual(spreadsheetDisplayValue(cell.value, cell.text, cell.numFmt), { text: expected, formatFallback: false })
  }
  assert.deepEqual(spreadsheetDisplayValue({ formula: '2+3' }, '', '0'), { text: '未保存计算结果', formatFallback: true })
  assert.deepEqual(spreadsheetDisplayValue(12, '12', '0'.repeat(257)), { text: '12', formatFallback: true })
})
