/** New converter regression tests use native PptxGenJS charts and the exact
 * Vite transformation; no production dependencies are modified. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import { DOMParser } from '@xmldom/xmldom'

const root = join(dirname(fileURLToPath(import.meta.url)), '..'), exports = {}
const js = ts.transpileModule(readFileSync(join(root, 'scripts/pptx-preview-transform.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
new vm.Script(`(function(exports){${js}\n})`).runInThisContext()(exports)
const original = readFileSync(join(root, 'node_modules/@jvmr/pptx-to-html/dist/index.js'), 'utf8')
const patched = exports.patchPptxPreview(original).replace('import JSZip from "jszip";', '').replace('export { pptxToHtml };', '')
const converter = new vm.Script(`(function(JSZip){${patched}\nreturn {ChartExtractor,ImageExtractor,TableExtractor,renderChartElement,renderImageElement,renderTableElement,computeCellBordersCSS,aetherChartFontSizes};})`).runInThisContext()(JSZip)
const parse = xml => new DOMParser().parseFromString(xml, 'application/xml')

async function chart(type, showValue, series = [{ name: '样例 A', labels: ['第一周', '第二周'], values: [12, 38] }]) {
  const deck = new PptxGenJS(), slide = deck.addSlide()
  slide.addChart(deck.ChartType[type], series, { x: 1, y: 1, w: 8, h: 4, showValue,
    showLabel: type === 'pie', showPercent: type === 'pie', showLegend: true,
    catAxisLabelFontSize: 12, valAxisLabelFontSize: 12, legendFontSize: 12, dataLabelFormatCode: '0' })
  const zip = await JSZip.loadAsync(await deck.write({ outputType: 'arraybuffer' }))
  const part = Object.keys(zip.files).find(name => /^ppt\/charts\/chart\d+\.xml$/.test(name))
  const document = parse(await zip.file(part).async('string'))
  const parsed = converter.ChartExtractor.parseChart(document, {})
  return converter.renderChartElement({ ...parsed, chartType: parsed.type, fontSizes: converter.aetherChartFontSizes(document),
    position: { x: 0, y: 0 }, size: { width: 8 * 914400, height: 4 * 914400 } })
}
function texts(html, role) {
  return [...html.matchAll(new RegExp(`<text\\b[^>]*data-pptx-chart-label="${role}"[^>]*>([\\s\\S]*?)<\\/text>`, 'g'))]
}

test('guard rejects incompatible dependency source instead of silently keeping the buggy chart renderer', () => {
  assert.throws(() => exports.patchPptxPreview(original.replace('var ChartExtractor = class {', 'var UpstreamChartExtractor = class {')), /no longer matches/)
  assert.equal(exports.pptxPreviewPatch().transform(original, '/node_modules/@jvmr/pptx-to-html/dist/index.js').code, exports.patchPptxPreview(original))
})
test('native bar showVal=false suppresses data values while OOXML 12pt axis labels render at 16 SVG pixels', async () => {
  const html = await chart('bar', false)
  assert.equal(texts(html, 'data').length, 0)
  for (const role of ['category', 'value', 'legend']) {
    const nodes = texts(html, role)
    assert.ok(nodes.length > 0, `missing ${role}`)
    for (const node of nodes) assert.match(node[0], /font-size="16"/)
  }
  assert.match(html, /第一周/); assert.match(html, /第二周/)
})
test('explicit value labels stay visible and line series keep their legend names', async () => {
  assert.equal(texts(await chart('bar', true), 'data').length, 2)
  const html = await chart('line', false, [
    { name: '样例 A', labels: ['第一周', '第二周'], values: [12, 38] },
    { name: '样例 B', labels: ['第一周', '第二周'], values: [22, 48] },
  ])
  assert.deepEqual(texts(html, 'legend').map(value => value[1]), ['样例 A', '样例 B'])
  assert.equal(texts(html, 'data').length, 0)
})
test('pie category and percentage labels remain enabled independently from showValue=false', async () => {
  const html = await chart('pie', false, [{ name: '分类', labels: ['研究', '设计', '验收'], values: [2, 5, 3] }])
  assert.deepEqual(texts(html, 'data').map(value => value[1]), ['研究 20%', '设计 50%', '验收 30%'])
  assert.deepEqual(texts(html, 'data').map(value => /text-anchor="([^"]+)"/.exec(value[0])[1]), ['start', 'end', 'start'])
  assert.ok(texts(html, 'data').every(value => value[0].includes('dominant-baseline="middle"')))
})
test('near-vertical pie labels are centered entirely beyond the circle top and bottom', async () => {
  const html = await chart('pie', false, [{ name: '分类', labels: ['上半部分', '下半部分'], values: [1, 1] }])
  const labels = texts(html, 'data'), height = 4 * 96, radius = height * 0.35
  for (const [index, label] of labels.entries()) {
    assert.match(label[0], /text-anchor="middle"/)
    const y = Number(/\by="([^"]+)"/.exec(label[0])[1]), font = Number(/font-size="([^"]+)"/.exec(label[0])[1])
    if (index === 0) assert.ok(y - font > height / 2 + radius)
    else assert.ok(y + font < height / 2 - radius)
  }
})
test('source rectangle projection keeps positive cover crop and negative contain margins', () => {
  const common = { src: 'data:image/png;base64,AAAA', position: { x: 0, y: 0 }, size: { width: 400 * 9525, height: 400 * 9525 } }
  const cover = converter.renderImageElement({ ...common, crop: { left: 25000, right: 25000, top: 0, bottom: 0 } })
  assert.match(cover, /left:-200px; top:0px; width:800px; height:400px/)
  const contain = converter.renderImageElement({ ...common, crop: { left: 0, right: 0, top: -50000, bottom: -50000 } })
  assert.match(contain, /left:0px; top:100px; width:400px; height:200px/)
  assert.ok(!patched.includes('Math.max(0, Number(srcRect.getAttribute('))
})

test('explicit noFill hides cell edges instead of rendering the converter black grid fallback', () => {
  const cell = parse('<a:tcPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:lnL><a:noFill/></a:lnL><a:lnR w="0"><a:noFill/></a:lnR><a:lnT><a:noFill/></a:lnT><a:lnB w="12700"><a:solidFill><a:srgbClr val="AABBCC"/></a:solidFill><a:prstDash val="solid"/></a:lnB></a:tcPr>').documentElement
  const borders = converter.TableExtractor.extractCellBorders(cell, {})
  assert.deepEqual(borders.left, { style: 'none', width: 0 })
  assert.deepEqual(borders.right, { style: 'none', width: 0 })
  const table = { rows: [{ cells: [] }], columns: [914400], tableBorders: { top: { width: 2, color: '#123456' }, left: { width: 2, color: '#123456' }, right: { width: 2, color: '#123456' } } }
  const css = converter.computeCellBordersCSS(table, { borders }, 0, 0)
  assert.match(css, /border-top:none;/)
  assert.match(css, /border-left:none;/)
  assert.match(css, /border-right:none;/)
  assert.match(css, /border-bottom: 1px solid #AABBCC;/)
  assert.doesNotMatch(css, /#000|#123456/)
})

test('table-level noFill stays absent while ordinary solid and dashed edges retain width and color', () => {
  const tableProperties = parse('<a:tblPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:tblBorders><a:top><a:ln><a:noFill/></a:ln></a:top><a:insideV><a:noFill/></a:insideV><a:bottom><a:ln w="25400"><a:solidFill><a:srgbClr val="336699"/></a:solidFill><a:prstDash val="dash"/></a:ln></a:bottom></a:tblBorders></a:tblPr>').documentElement
  const tableBorders = converter.TableExtractor.extractTableBorders(tableProperties, {})
  assert.deepEqual(tableBorders.top, { style: 'none', width: 0 })
  assert.deepEqual(tableBorders.insideV, { style: 'none', width: 0 })
  const css = converter.computeCellBordersCSS({ rows: [{ cells: [] }], columns: [914400, 914400], tableBorders }, {}, 0, 1)
  assert.match(css, /border-top:none;/)
  assert.match(css, /border-left:none;/)
  assert.match(css, /border-bottom: 3px dashed #336699;/)
  assert.doesNotMatch(css, /#000/)
})

test('a hidden border does not discard a cell solid fill, but direct cell noFill remains transparent', () => {
  const cell = xml => parse(`<a:tcPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${xml}</a:tcPr>`).documentElement
  assert.equal(converter.TableExtractor.extractFillColor(cell('<a:lnL><a:noFill/></a:lnL><a:solidFill><a:srgbClr val="F5EEDD"/></a:solidFill>'), {}), '#F5EEDD')
  assert.equal(converter.TableExtractor.extractFillColor(cell('<a:noFill/><a:lnL><a:solidFill><a:srgbClr val="F5EEDD"/></a:solidFill></a:lnL>'), {}), undefined)
})
