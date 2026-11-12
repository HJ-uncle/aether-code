import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./office-visible-page.ts', import.meta.url), 'utf8')
const exports = {}
new vm.Script('(function(exports){' + ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText + '\n})').runInThisContext()(exports)
const { officeVisiblePage } = exports

test('the last short slide owns its notes at the scrollbar end even when the anchor stays in the preceding slide', () => {
  const heights = Array(8).fill(443)
  assert.equal(officeVisiblePage(2838.67, 849, 3687.67, heights), 8)
  assert.equal(officeVisiblePage(2837.5, 849, 3687.67, heights), 8)
  assert.equal(officeVisiblePage(2700, 849, 3687.67, heights), 7)
})

test('top and middle positions still follow their page, including zoomed pages and non-scrollable documents', () => {
  assert.equal(officeVisiblePage(0, 849, 3687.67, Array(8).fill(443)), 1)
  assert.equal(officeVisiblePage(500, 849, 3687.67, Array(8).fill(443)), 2)
  assert.equal(officeVisiblePage(2200, 600, 9100, Array(8).fill(1100)), 3)
  assert.equal(officeVisiblePage(0, 900, 900, [200, 200]), 1)
  assert.equal(officeVisiblePage(0, 900, 900, []), 1)
})
