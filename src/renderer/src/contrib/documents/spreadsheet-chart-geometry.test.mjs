/** New chart geometry regressions: real zero vs missing, signed scales,
 * extreme numeric data, and pie/doughnut shape correctness. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const javascript = ts.transpileModule(readFileSync(new URL('./spreadsheet-chart-geometry.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const geometry = {}
new vm.Script(`(function(exports){${javascript}\n})`).runInThisContext()(geometry)
const { spreadsheetChartScale: scale, spreadsheetChartSegments: segments, spreadsheetChartSlices: slices, spreadsheetChartArc: arc, spreadsheetChartNumber: number, spreadsheetChartLabelIndices: labelIndices } = geometry

test('signed columns share a real zero baseline and preserve numeric ordering', () => {
  const values = scale([-20, null, 0, 50])
  assert.ok(values.position(-20) < values.position(0))
  assert.ok(values.position(0) < values.position(50))
  assert.ok(values.ticks.includes(0))
  assert.ok(values.position(-20) >= 0)
})

test('missing line values split paths while an authored zero remains plotted', () => {
  const paths = segments([1, null, 0, 3, null, 2], index => index * 10, value => 100 - value)
  assert.deepEqual(paths.map(points => points.map(point => point.index)), [[0], [2, 3], [5]])
  assert.deepEqual(paths[1][0], { x: 20, y: 100, index: 2, value: 0 })
})

test('finite extreme data always produces finite coordinates and labels', () => {
  for (const input of [[-1e308, 1e308], [0, 1e-300], [9], [0], []]) {
    const domain = scale(input)
    for (const value of input) assert.ok(Number.isFinite(domain.position(value)))
    assert.ok(domain.ticks.every(Number.isFinite))
    assert.ok(domain.ticks.length >= 2 && domain.ticks.length <= 8)
    assert.ok(domain.ticks.every(value => !number(value).includes('Infinity')))
  }
})

test('pie shares distinguish missing, zero and negative values without overflowing totals', () => {
  assert.deepEqual(slices([null, 0, -1, 2]), [])
  assert.deepEqual(slices([null, 0]), [])
  const values = slices([1e308, null, 0, 1e308])
  assert.deepEqual(values.map(value => [value.index, value.ratio]), [[0, 0.5], [3, 0.5]])
  assert.ok(Math.abs(values.at(-1).end - values[0].start - Math.PI * 2) < 1e-8)
})

test('single-slice pie and doughnut use two arcs so the full circle stays visible', () => {
  const full = slices([42])[0]
  const pie = arc(full, 120, 100, 80), ring = arc(full, 120, 100, 80, 40)
  assert.equal((pie.match(/ A /g) || []).length, 2)
  assert.equal((ring.match(/ A /g) || []).length, 4)
  assert.ok(!pie.includes('NaN') && !ring.includes('NaN'))
})

test('small nonzero values never become a displayed zero', () => {
  assert.equal(number(0), '0')
  assert.equal(number(0.001), '0.001')
  assert.equal(number(0.000001), '1e-6')
})

test('scatter axes adapt decimal precision to small differences around a nonzero value', () => {
  for (const values of [[1, 1.000001], [1, 1.0000000000001], [-1.000001, -1]]) {
    const domain = scale(values, false)
    const labels = domain.ticks.map(domain.formatTick)
    assert.equal(new Set(domain.ticks).size, domain.ticks.length)
    assert.equal(new Set(labels).size, labels.length)
    assert.ok(labels.some(label => label.includes('.00000')))
    assert.ok(domain.position(values[0]) < domain.position(values[1]))
  }
})

test('signed extreme axes retain distinct finite exponential tick labels', () => {
  for (const values of [[-1e308, 1e308], [1e308, 1.000001e308]]) {
    const domain = scale(values, false)
    const labels = domain.ticks.map(domain.formatTick)
    assert.ok(domain.ticks.every(Number.isFinite))
    assert.equal(new Set(labels).size, labels.length)
    assert.ok(labels.every(label => !/NaN|Infinity/.test(label)))
    assert.ok(domain.position(values[0]) < domain.position(values[1]))
  }
})

test('numeric ranges use human-readable physical tick steps matching their labels', () => {
  const domain = scale([8, 38])
  assert.deepEqual(domain.ticks, [0, 10, 20, 30, 40])
  assert.deepEqual(domain.ticks.map(domain.formatTick), ['0', '10', '20', '30', '40'])
  assert.equal(domain.position(10), 0.25)
  const fractional = scale([0.8, 3.8])
  assert.deepEqual(fractional.ticks, [0, 1, 2, 3, 4])
  assert.deepEqual(scale([-38, 8]).ticks, [-40, -20, 0, 20])
})

test('label sampling keeps four short months and prevents long category overlap', () => {
  assert.deepEqual(labelIndices([24, 24, 24, 24], 190), [0, 1, 2, 3])
  const widths = [108, 108, 108, 108], indices = labelIndices(widths, 190)
  assert.ok(indices.length < 4 && indices.length > 0)
  for (let index = 1; index < indices.length; index++) {
    const previous = indices[index - 1], current = indices[index]
    assert.ok((current - previous) / widths.length * 190 >= (widths[previous] + widths[current]) / 2 + 12)
  }
})
