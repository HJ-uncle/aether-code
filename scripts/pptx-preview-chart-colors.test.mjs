/** New regressions for the chart text color lost by the preview converter.
 * Native PPTX fixtures stay in memory; no model, export flow or user file is used. */
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
const transformed = ts.transpileModule(readFileSync(join(root, 'scripts/pptx-preview-transform.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
new vm.Script(`(function(exports){${transformed}\n})`).runInThisContext()(exports)
const original = readFileSync(join(root, 'node_modules/@jvmr/pptx-to-html/dist/index.js'), 'utf8')
const patched = exports.patchPptxPreview(original).replace('import JSZip from "jszip";', '').replace('export { pptxToHtml };', '')
const converter = new vm.Script(`(function(JSZip){${patched}\nreturn {ChartExtractor,XmlHelper,renderChartElement,aetherChartFontColors};})`).runInThisContext()(JSZip)
converter.XmlHelper.domParserFactory = () => new DOMParser()
const parse = xml => new DOMParser().parseFromString(xml, 'application/xml')
const drawingNS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const chartNS = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const properties = color => `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200"><a:solidFill>${color}</a:solidFill></a:defRPr></a:pPr></a:p></c:txPr>`
const colorDocument = content => parse(`<c:chartSpace xmlns:c="${chartNS}" xmlns:a="${drawingNS}">${content}</c:chartSpace>`)

async function nativeChart(type, colors) {
  const deck = new PptxGenJS(), slide = deck.addSlide()
  slide.background = { color: colors.background }
  slide.addChart(deck.ChartType[type], [{ name: '功能模块', labels: ['对局', '规则'], values: [6, 3] }], {
    x: 1, y: 1, w: 8, h: 4, showValue: true, showLegend: true,
    catAxisLabelFontSize: 14, valAxisLabelFontSize: 14, legendFontSize: 14,
    catAxisLabelColor: colors.category, valAxisLabelColor: colors.value,
    legendColor: colors.legend, dataLabelColor: colors.data,
  })
  const zip = await JSZip.loadAsync(await deck.write({ outputType: 'arraybuffer' }))
  const slideXml = parse(await zip.file('ppt/slides/slide1.xml').async('string'))
  const rels = parse(await zip.file('ppt/slides/_rels/slide1.xml.rels').async('string'))
  const elements = await converter.ChartExtractor.extract(slideXml.getElementsByTagNameNS('*', 'spTree')[0], rels, zip, {})
  assert.equal(elements.length, 1)
  return converter.renderChartElement(elements[0])
}

function labelColors(html, role) {
  return [...html.matchAll(new RegExp(`<text\\b[^>]*data-pptx-chart-label="${role}"[^>]*fill="([^"]+)"`, 'g'))].map(match => match[1])
}

for (const [name, colors] of Object.entries({
  dark: { background: '151923', category: '96A3B2', value: 'BBC7D6', legend: 'E5EBF4', data: 'F8FAFC' },
  light: { background: 'FFFFFF', category: '334155', value: '475569', legend: '1E293B', data: '0F172A' },
})) {
  for (const type of ['bar', 'line']) {
    test(`native ${name} ${type} retains separate source axis, legend and value label colors through extraction and SVG rendering`, async () => {
      const html = await nativeChart(type, colors)
      for (const role of ['category', 'value', 'legend', 'data']) {
        const actual = labelColors(html, role)
        assert.ok(actual.length > 0, `missing ${role} labels`)
        assert.deepEqual(new Set(actual), new Set([`#${colors[role]}`]))
      }
      assert.match(html, /对局/)
      assert.match(html, /规则/)
    })
  }
}

test('axis theme references resolve independently and missing local color inherits chart text color', () => {
  const doc = colorDocument(`${properties('<a:schemeClr val="tx2"/>')}<c:chart><c:plotArea>
    <c:catAx>${properties('<a:schemeClr val="accent3"/>')}</c:catAx>
    <c:valAx><c:txPr><a:p><a:pPr><a:defRPr sz="1400"/></a:pPr></a:p></c:txPr></c:valAx>
    <c:barChart><c:dLbls>${properties('<a:sysClr val="windowText" lastClr="DDEEFF"/>')}</c:dLbls></c:barChart>
    </c:plotArea><c:legend>${properties('<a:srgbClr val="ABCD12"/>')}</c:legend></c:chart>`)
  assert.deepEqual(converter.aetherChartFontColors(doc, { dk1: '#000000', dk2: '#90A0B0', accent3: '#80B0E0' }), {
    category: '#80B0E0', value: '#90A0B0', legend: '#ABCD12', data: '#DDEEFF',
  })
})

test('chart text default inherits theme text color, while invalid source colors cannot become SVG attributes', () => {
  const doc = colorDocument(`<c:chart><c:plotArea><c:catAx>${properties('<a:srgbClr val="not-a-color"/>')}</c:catAx></c:plotArea></c:chart>`)
  assert.deepEqual(converter.aetherChartFontColors(doc, { dk1: '#123456' }), {
    category: '#123456', value: '#123456', legend: '#123456', data: '#123456',
  })
  assert.deepEqual(converter.aetherChartFontColors(doc, {}), {
    category: undefined, value: undefined, legend: undefined, data: undefined,
  })
})

test('date axes and run properties retain source colors without borrowing chart series fills', () => {
  const doc = colorDocument(`<c:chart><c:plotArea><c:lineChart><c:ser><c:spPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></c:spPr></c:ser></c:lineChart>
    <c:dateAx><c:txPr><a:p><a:r><a:rPr><a:solidFill><a:srgbClr val="CAD5E2"/></a:solidFill></a:rPr><a:t>日期</a:t></a:r></a:p></c:txPr></c:dateAx>
    </c:plotArea></c:chart>`)
  assert.equal(converter.aetherChartFontColors(doc, {}).category, '#CAD5E2')
  assert.equal(converter.aetherChartFontColors(doc, {}).value, undefined)
})
