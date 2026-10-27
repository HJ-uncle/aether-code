/** Pure Monaco change-offset contract; no DOM, Electron or Monaco runtime required. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(fileURLToPath(new URL('./MonacoEditor.tsx', import.meta.url)), 'utf8')
const match = source.match(/export function applyModelContentChanges[\s\S]*?\n}/)
assert.ok(match, 'incremental content helper must remain available')
const javascript = ts.transpileModule(match[0], {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const exports = {}
new vm.Script('(function(exports){' + javascript + '\n})').runInThisContext()(exports)
const apply = exports.applyModelContentChanges
const change = (rangeOffset, rangeLength, text) => ({ rangeOffset, rangeLength, text })

test('typing and deletion apply at UTF-16 offsets without reading the full model', () => {
  const original = 'alpha\r\nconst smile = "😀"\r\nomega'
  const inserted = original.slice(0, 6) + 'value' + original.slice(6)
  assert.equal(apply(original, [change(6, 0, 'value')]), inserted)
  assert.equal(apply(inserted, [change(6, 5, '')]), original)
  const unicode = original.indexOf('😀')
  assert.equal(apply(original, [change(unicode, 2, 'ok')]), original.replace('😀', 'ok'))
})

test('a Monaco batch is applied backwards even if changes arrive unsorted', () => {
  const original = '0123456789abcdef'
  const expected = '0XY3456789abZef'
  const changes = [change(12, 2, 'Z'), change(1, 2, 'XY')]
  assert.equal(apply(original, changes), expected)
  assert.equal(apply(original, [...changes].reverse()), expected)
})

test('sequential input preserves every intermediate buffer including CRLF', () => {
  let content = 'first\r\n\r\nlast'
  for (const [offset, length, text] of [[6, 0, 'A'], [7, 0, 'B'], [6, 2, ''], [0, 5, 'FIRST'], [9, 0, 'x']]) {
    const expected = content.slice(0, offset) + text + content.slice(offset + length)
    content = apply(content, [change(offset, length, text)])
    assert.equal(content, expected)
  }
  assert.equal(content, 'FIRST\r\n\r\nxlast')
})
