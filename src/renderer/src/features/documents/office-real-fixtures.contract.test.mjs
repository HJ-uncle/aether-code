/** Opt-in real delivery fixtures: AETHER_OFFICE_FIXTURE_ROOT points at the four
 * named files. Nothing in the fixture directory is scanned or executed. */
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import JSZip from 'jszip'
import ExcelJS from 'exceljs'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'

const previousParser = globalThis.DOMParser, previousSerializer = globalThis.XMLSerializer
globalThis.DOMParser = DOMParser; globalThis.XMLSerializer = XMLSerializer
after(() => {
  if (previousParser) globalThis.DOMParser = previousParser; else delete globalThis.DOMParser
  if (previousSerializer) globalThis.XMLSerializer = previousSerializer; else delete globalThis.XMLSerializer
})
const directory = dirname(fileURLToPath(import.meta.url)), modules = new Map()
function load(name) {
  if (modules.has(name)) return modules.get(name)
  const source = readFileSync(join(directory, name + '.ts'), 'utf8')
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  new vm.Script('(function(require,exports){' + javascript + '\n})', { filename: name }).runInThisContext()(specifier => {
    if (specifier === './document-kind') return load('document-kind')
    if (specifier === 'jszip') return { default: JSZip }
    if (specifier === '@xmldom/xmldom') return { DOMParser, XMLSerializer }
    throw new Error('Unexpected dependency: ' + specifier)
  }, exports)
  modules.set(name, exports)
  return exports
}
const { DOCUMENT_LIMITS } = load('document-kind')
const { prepareOfficeArchive, inspectOfficeArchive, expandOfficeEntry, officeImagePixels } = load('office-archive')
const root = process.env.AETHER_OFFICE_FIXTURE_ROOT
const fixture = name => {
  const data = readFileSync(join(root, name))
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
}
const options = { skip: !root ? '未提供 AETHER_OFFICE_FIXTURE_ROOT 真实办公文件目录' : false }

test('real 12000-row workbook passes bounded XML preparation and ExcelJS reads its last rows', options, async () => {
  const input = fixture('04_Excel_大型_12000行数据.xlsx')
  const sheet = inspectOfficeArchive(input).find(entry => entry.name === 'xl/worksheets/sheet1.xml')
  assert.ok(sheet.unpacked > 4 * 1024 * 1024 && sheet.unpacked <= DOCUMENT_LIMITS.xmlBytes)
  assert.equal(input.byteLength, 598960)
  const started = performance.now()
  const prepared = await prepareOfficeArchive(input, 'xlsx', new AbortController().signal)
  console.info(`04 prepareOfficeArchive: ${(performance.now() - started).toFixed(1)}ms`)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(prepared, { ignoreNodes: ['drawing', 'picture', 'extLst', 'conditionalFormatting', 'dataValidations'] })
  assert.equal(workbook.worksheets.length, 1)
  assert.equal(workbook.worksheets[0].actualRowCount, 12003)
  assert.equal(workbook.worksheets[0].rowCount, 12005)
  assert.equal(workbook.worksheets[0].model.rows.length, 12003)
  assert.ok(workbook.worksheets[0].getRow(12000).actualCellCount > 0)
  assert.match(workbook.worksheets[0].getRow(12005).getCell(1).text, /TEST-012000/)
  const xml = new DOMParser().parseFromString(await JSZip.loadAsync(prepared).then(zip => zip.file('xl/worksheets/sheet1.xml').async('string')), 'application/xml')
  assert.equal(xml.getElementsByTagNameNS('*', 'row').length, 12003)
  assert.equal(xml.getElementsByTagNameNS('*', 'c').length, 96010)
})

for (const [name, kind] of [['02_Word_大型_图文报告.docx', 'docx'], ['06_PPT_中型_图文演示.pptx', 'pptx']]) {
  test(`${name} is legal 4K-image content, not an unsafe archive`, options, async () => {
    const input = fixture(name)
    const entries = inspectOfficeArchive(input)
    let pixels = 0
    for (const entry of entries.filter(item => /\.(?:png|jpe?g)$/i.test(item.name))) {
      pixels += officeImagePixels(await expandOfficeEntry(input, entry, new AbortController().signal))
    }
    assert.ok(pixels > 16_000_000 && pixels <= DOCUMENT_LIMITS.totalImagePixels)
    const prepared = await prepareOfficeArchive(input, kind, new AbortController().signal)
    assert.ok((await JSZip.loadAsync(prepared)).file(kind === 'docx' ? 'word/document.xml' : 'ppt/presentation.xml'))
  })
}

test('real 14.5MB presentation and its 6K image stay within explicit preview budgets', options, async () => {
  const input = fixture('07_PPT_大型_高清图册.pptx')
  assert.equal(input.byteLength, 14516177)
  assert.ok(input.byteLength < DOCUMENT_LIMITS.inputBytes)
  const entries = inspectOfficeArchive(input)
  assert.equal(entries.length, 51)
  const image = entries.find(entry => entry.name === 'ppt/media/image4.png')
  const bytes = await expandOfficeEntry(input, image, new AbortController().signal)
  assert.equal(officeImagePixels(bytes), 25600000)
  const started = performance.now()
  const prepared = await prepareOfficeArchive(input, 'pptx', new AbortController().signal)
  console.info(`07 prepareOfficeArchive: ${(performance.now() - started).toFixed(1)}ms`)
  assert.ok(prepared.byteLength < DOCUMENT_LIMITS.expandedBytes + DOCUMENT_LIMITS.entries * 2048)
  assert.ok((await JSZip.loadAsync(prepared)).file('ppt/media/image4.png'))
})
