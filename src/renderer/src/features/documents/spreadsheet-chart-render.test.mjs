/** New native-chart rendering checks: inspect rendered SVG/data for all seven
 * chart kinds, missing values, signed bars and unsupported source settings. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DOMParser } from '@xmldom/xmldom'

const require = createRequire(import.meta.url), modules = new Map()
function load(name) {
  if (modules.has(name)) return modules.get(name)
  const file = name === 'SpreadsheetChart' ? 'SpreadsheetChart.tsx' : name + '.ts'
  const javascript = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText
  const exports = {}
  new vm.Script(`(function(require,exports){${javascript}\n})`, { filename: file }).runInThisContext()(specifier => {
    if (specifier === './spreadsheet-chart.css') return {}
    if (specifier.startsWith('./')) return load(specifier.slice(2))
    return require(specifier)
  }, exports)
  modules.set(name, exports)
  return exports
}
const { SpreadsheetChart } = load('SpreadsheetChart')
function render(type, changes = {}) {
  const chart = { id: 'chart-one', type, title: '销量与趋势', categories: ['一月', '二月', '三月'], series: [{ name: '销量', values: [12, 0, 24], xValues: [1, 2, 3], color: '#225588' }], legend: true, x: 0, y: 0, width: 640, height: 360, warnings: [], ...changes }
  const html = renderToStaticMarkup(React.createElement(SpreadsheetChart, { chart }))
  const document = new DOMParser().parseFromString(html, 'text/html')
  const elements = name => Array.from(document.getElementsByTagName(name))
  return { html, document, elements }
}

for (const type of ['column', 'bar', 'line', 'area', 'pie', 'doughnut', 'scatter']) test(`${type} produces native SVG with title, legend and source values`, () => {
  const result = render(type)
  assert.equal(result.elements('svg').length, 1)
  assert.ok(result.html.includes('销量与趋势') && result.html.includes('销量'))
  assert.ok(!result.html.includes('NaN') && !result.html.includes('Infinity'))
  const points = result.elements(type === 'column' || type === 'bar' ? 'rect' : type === 'pie' || type === 'doughnut' ? 'path' : 'circle').filter(element => element.hasAttribute('data-chart-point') || element.hasAttribute('data-chart-slice'))
  assert.equal(points.length, type === 'pie' || type === 'doughnut' ? 2 : 3)
  assert.ok(result.elements('title').some(element => element.textContent.includes('24')))
})

test('negative and positive columns fall on opposite sides of zero, missing cells draw nothing', () => {
  const result = render('column', { series: [{ name: '变化', values: [-20, null, 30] }] })
  const bars = result.elements('rect').filter(element => element.hasAttribute('data-chart-point'))
  assert.equal(bars.length, 2)
  assert.equal(bars[0].getAttribute('data-chart-point'), '0')
  assert.equal(bars[1].getAttribute('data-chart-point'), '2')
  assert.equal(Number(bars[0].getAttribute('y')), Number(bars[1].getAttribute('y')) + Number(bars[1].getAttribute('height')))
})

test('line charts keep gaps and render explicit point colors in pie charts', () => {
  const line = render('line', { series: [{ name: '值', values: [1, null, 2] }] })
  assert.equal(line.elements('path').filter(element => element.getAttribute('data-chart-line') === 'true').length, 2)
  const pie = render('pie', { series: [{ name: '值', values: [1, 2], pointColors: ['#123456', '#abcdef'] }] })
  assert.deepEqual(pie.elements('path').filter(element => element.hasAttribute('data-chart-slice')).map(element => element.getAttribute('fill')), ['#123456', '#abcdef'])
})

test('unsupported charts and negative pie shares show a truthful message instead of a misleading image', () => {
  const unsupported = render('unsupported', { warnings: ['组合图暂不支持'] })
  assert.equal(unsupported.elements('svg').length, 0)
  assert.ok(unsupported.html.includes('原图表已保留') && unsupported.html.includes('组合图暂不支持'))
  const pie = render('pie', { series: [{ name: '值', values: [-1, 2] }] })
  assert.equal(pie.elements('svg').length, 0)
  assert.ok(pie.html.includes('非负数值'))
})

test('boundary markers in scatter and line plots fit completely inside the clip rectangle', () => {
  for (const type of ['scatter', 'line']) {
    const result = render(type, { series: [{ name: '边界', values: [0, 10], xValues: [0, 10] }] })
    const clip = Array.from(result.elements('clipPath')[0].getElementsByTagName('rect'))[0]
    const left = Number(clip.getAttribute('x')), top = Number(clip.getAttribute('y'))
    const right = left + Number(clip.getAttribute('width')), bottom = top + Number(clip.getAttribute('height'))
    const points = result.elements('circle').filter(element => element.hasAttribute('data-chart-point'))
    assert.equal(points.length, 2)
    for (const point of points) {
      const x = Number(point.getAttribute('cx')), y = Number(point.getAttribute('cy')), radius = Number(point.getAttribute('r'))
      assert.ok(x - radius >= left && x + radius <= right && y - radius >= top && y + radius <= bottom)
    }
  }
})

test('a narrow plot displays every short month but samples long labels', () => {
  const months = ['一月', '二月', '三月', '四月']
  const compact = render('column', { width: 300, categories: months, series: [{ name: '值', values: [8, 18, 28, 38] }] })
  const labels = result => result.elements('text').filter(element => element.getAttribute('class') === 'spreadsheet-chart__category')
  assert.equal(labels(compact).length, 4)
  assert.ok(compact.elements('text').some(element => element.textContent === '40'))
  const verbose = render('column', { width: 300, categories: months.map(month => `${month}的较长分类说明`), series: [{ name: '值', values: [8, 18, 28, 38] }] })
  assert.ok(labels(verbose).length < 4)
})
