import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const directory = dirname(fileURLToPath(import.meta.url))
function load(name) {
  const path = resolve(directory, name)
  const exports = {}
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new vm.Script(`(function(require,exports){${code}\n})`, { filename: path }).runInThisContext()(specifier => {
    if (specifier === '../chat/mention-context') return load('../chat/mention-context.ts')
    throw new Error(`Unexpected dependency ${specifier}`)
  }, exports)
  return exports
}
const { workCodeReference } = load('work-code-reference.ts')

test('a selected code slice retains its exact bytes, source identity and columns', () => {
  const selection = { startLineNumber: 2, startColumn: 3, endLineNumber: 4, endColumn: 8 }
  const text = '  中文😀();\r\n  next();\r\n  tail '
  const model = { getLineMaxColumn: () => 99, getValueInRange: actual => { assert.equal(actual, selection); return text } }
  assert.deepEqual(workCodeReference(model, selection, '/task/src/demo.ts'), {
    source: 'code', origin: 'workspace', path: '/task/src/demo.ts', displayText: 'src/demo.ts:2-4',
    startLine: 2, endLine: 4, startColumn: 3, endColumn: 8, content: text
  })
})

test('ending at next-line column one excludes that line from the label without dropping its newline', () => {
  const selection = { startLineNumber: 7, startColumn: 1, endLineNumber: 9, endColumn: 1 }
  const model = { getLineMaxColumn: line => { assert.equal(line, 8); return 14 },
    getValueInRange: actual => { assert.equal(actual, selection); return 'one\ntwo\n' } }
  assert.deepEqual(workCodeReference(model, selection, 'C:/work/demo.ts', 'artifact'), {
    source: 'code', origin: 'artifact', path: 'C:/work/demo.ts', displayText: 'work/demo.ts:7-8',
    startLine: 7, endLine: 8, startColumn: 1, endColumn: 14, content: 'one\ntwo\n'
  })
})

test('same-line selections keep both columns and a single-line display label', () => {
  const model = { getLineMaxColumn: () => { throw new Error('Same-line range must not be widened') }, getValueInRange: () => 'test' }
  const result = workCodeReference(model, { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 9 }, 'demo.ts')
  assert.equal(result.displayText, 'demo.ts:3')
  assert.equal(result.startColumn, 5)
  assert.equal(result.endColumn, 9)
  assert.equal(result.content, 'test')
})
