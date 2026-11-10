/** Fresh regression: worker-compatible relationship removal must retain native
 * chart drawing links and cached data while stripping inactive attachments. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import * as xmldom from '@xmldom/xmldom'

const directory = dirname(fileURLToPath(import.meta.url)), modules = new Map()
function load(name) {
  if (modules.has(name)) return modules.get(name)
  const source = readFileSync(join(directory, `${name}.ts`), 'utf8')
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const exports = {}
  new vm.Script(`(function(require,exports){${javascript}\n})`, { filename: name }).runInThisContext()(specifier => {
    if (specifier === './document-kind') return load('document-kind')
    if (specifier === 'jszip') return JSZip
    if (specifier === '@xmldom/xmldom') return xmldom
    throw new Error(`Unexpected import ${specifier}`)
  }, exports)
  modules.set(name, exports)
  return exports
}
const { prepareOfficeArchive } = load('office-archive')
const parse = xml => new xmldom.DOMParser().parseFromString(xml, 'application/xml')
const values = (xml, localName) => Array.from(parse(xml).getElementsByTagNameNS('*', localName)).map(node => node.textContent)
const relationships = xml => Array.from(parse(xml).getElementsByTagNameNS('*', 'Relationship')).map(node => ({
  id: node.getAttribute('Id'), target: node.getAttribute('Target'), type: node.getAttribute('Type'), mode: node.getAttribute('TargetMode'),
}))

test('native chart preview retains editable-chart caches and slide links without requiring embedded workbook execution', async () => {
  const deck = new PptxGenJS(), slide = deck.addSlide()
  slide.addChart(deck.ChartType.bar, [{ name: '样例数量', labels: ['第一周', '第二周', '第三周'], values: [12, 25, 38] }],
    { x: 1, y: 1, w: 8, h: 4, showValue: true })
  const source = await JSZip.loadAsync(await deck.write({ outputType: 'arraybuffer' }))
  const chartPart = Object.keys(source.files).find(name => /^ppt\/charts\/chart\d+\.xml$/.test(name))
  const relationPart = chartPart.replace('/charts/', '/charts/_rels/') + '.rels'
  const originalChart = await source.file(chartPart).async('string')
  const originalRelations = relationships(await source.file(relationPart).async('string'))
  assert.equal(originalRelations.filter(item => item.type.endsWith('/package')).length, 1)
  assert.ok(Object.keys(source.files).some(name => name.startsWith('ppt/embeddings/') && name.endsWith('.xlsx')))
  const slideRelationsPart = 'ppt/slides/_rels/slide1.xml.rels'
  const nativeChartLink = relationships(await source.file(slideRelationsPart).async('string')).find(item => item.type.endsWith('/chart'))
  assert.ok(nativeChartLink)
  source.file(slideRelationsPart, (await source.file(slideRelationsPart).async('string')).replace('</Relationships>',
    '<Relationship Id="external-image" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.invalid/tracker.png" TargetMode="External"/></Relationships>'))
  const bytes = await source.generateAsync({ type: 'arraybuffer', compression: 'STORE' }), before = Buffer.from(bytes)
  const prepared = await prepareOfficeArchive(bytes, 'pptx', new AbortController().signal)
  const cleaned = await JSZip.loadAsync(prepared)
  assert.deepEqual(Buffer.from(bytes), before, 'preview preparation must preserve the original editable PPTX')
  const cleanedChart = await cleaned.file(chartPart).async('string')
  assert.deepEqual(values(cleanedChart, 'strCache'), values(originalChart, 'strCache'))
  assert.deepEqual(values(cleanedChart, 'numCache'), values(originalChart, 'numCache'))
  for (const label of ['第一周', '第二周', '第三周']) assert.ok(cleanedChart.includes(label))
  for (const number of ['12', '25', '38']) assert.ok(values(cleanedChart, 'v').includes(number))
  assert.deepEqual(relationships(await cleaned.file(slideRelationsPart).async('string')).find(item => item.type.endsWith('/chart')), nativeChartLink)
  assert.equal(relationships(await cleaned.file(slideRelationsPart).async('string')).some(item => item.id === 'external-image'), false)
  assert.equal(relationships(await cleaned.file(relationPart).async('string')).some(item => item.type.endsWith('/package')), false)
  assert.equal(Object.keys(cleaned.files).some(name => name.startsWith('ppt/embeddings/')), false)
})
