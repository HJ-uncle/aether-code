import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

const directory = dirname(fileURLToPath(import.meta.url))
function load(name, extension = 'ts') {
  const source = readFileSync(join(directory, `${name}.${extension}`), 'utf8')
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const exports = {}
  new vm.Script(`(function(require,exports){${javascript}\n})`, { filename: name }).runInThisContext()(specifier => {
    if (specifier === 'react') return {}
    if (specifier === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null }
    if (specifier === '@renderer/core/editor/TextPreview') return load('../../core/editor/TextPreview', 'tsx')
    if (specifier === './source-highlight-language') return { sourceLanguage: () => undefined }
    if (specifier.endsWith('.css')) return {}
    throw new Error(`Unexpected dependency: ${specifier}`)
  }, exports)
  return exports
}
const { readWorkFileCached, invalidateWorkFileReadCache, clearWorkFileReadCache, workFileReadCacheStats } = load('work-file-read-cache')
const { isLargeWorkText } = load('WorkTextPreview', 'tsx')
const { retainedResourceIds } = load('work-resource-preview-policy')
const byteSource = readFileSync(join(directory, '../../core/workspace/file-content-bytes.ts'), 'utf8')
const byteExports = {}
new vm.Script('(function(exports){' + ts.transpileModule(byteSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText + '\n})').runInThisContext()(byteExports)
const { fileContentBytes, fileContentUrl } = byteExports
const file = content => ({ path: 'sample', content, isBinary: false, size: content.length, truncated: false })

test('ordinary activation reuses content and coalesces concurrent reads', async () => {
  clearWorkFileReadCache()
  let reads = 0
  const reader = async () => { reads++; return file('first') }
  const [left, right] = await Promise.all([readWorkFileCached('a', reader), readWorkFileCached('a', reader)])
  assert.equal(left.content, 'first')
  assert.equal(right.content, 'first')
  await readWorkFileCached('a', reader)
  assert.equal(reads, 1)
  assert.deepEqual(workFileReadCacheStats(), { entries: 1, bytes: 10, pending: 0 })
})

test('explicit refresh bypasses cached content and failed reads do not poison it', async () => {
  clearWorkFileReadCache()
  let value = 'first'
  await readWorkFileCached('a', async () => file(value))
  value = 'second'
  assert.equal((await readWorkFileCached('a', async () => file(value))).content, 'first')
  assert.equal((await readWorkFileCached('a', async () => file(value), true)).content, 'second')
  await assert.rejects(readWorkFileCached('a', async () => { throw new Error('read failed') }, true))
  assert.equal((await readWorkFileCached('a', async () => file('never'))).content, 'second')
  invalidateWorkFileReadCache('a')
  assert.equal((await readWorkFileCached('a', async () => file('third'))).content, 'third')
})

test('cache stays bounded across many files and session keys remain independent', async () => {
  clearWorkFileReadCache()
  for (let index = 0; index < 30; index++) await readWorkFileCached(`file:${index}`, async () => file('x'.repeat(128 * 1024)))
  assert.ok(workFileReadCacheStats().entries <= 24)
  assert.ok(workFileReadCacheStats().bytes <= 128 * 1024 * 1024)
  await readWorkFileCached('session:a', async () => file('A'))
  await readWorkFileCached('session:b', async () => file('B'))
  assert.equal((await readWorkFileCached('session:a', async () => file('wrong'))).content, 'A')
  assert.equal((await readWorkFileCached('session:b', async () => file('wrong'))).content, 'B')
  clearWorkFileReadCache()
  assert.deepEqual(workFileReadCacheStats(), { entries: 0, bytes: 0, pending: 0 })
})

test('large CSV and long source files use viewport rendering while small files use the same lightweight preview', () => {
  assert.equal(isLargeWorkText(Array.from({ length: 30000 }, (_, index) => `${index},value`).join('\n')), true)
  assert.equal(isLargeWorkText('x'.repeat(600 * 1024)), true)
  assert.equal(isLargeWorkText('const value = 1\n'.repeat(5000)), true)
  assert.equal(isLargeWorkText('const value = 1\n'.repeat(100)), false)
})

test('binary and text content retain every byte across attachment and URL conversion', async () => {
  const expected = Uint8Array.from([0, 37, 80, 68, 70, 255, 128, 1, 2, 3])
  const source = expected.buffer
  assert.deepEqual(fileContentBytes({ bytes: source, content: '' }), expected)
  assert.deepEqual(fileContentBytes({ base64: btoa(String.fromCharCode(...expected)), content: '' }), expected)
  assert.deepEqual(fileContentBytes({ content: '中文\n' }), new TextEncoder().encode('中文\n'))
  const resource = fileContentUrl({ bytes: source, content: '' }, 'application/pdf')
  assert.deepEqual(new Uint8Array(await (await fetch(resource.url)).arrayBuffer()), expected)
  resource.revoke()
  await assert.rejects(fetch(resource.url))
})

test('retained Work previews stay bounded to current and recent across a large working set', () => {
  const files = Array.from({ length: 20 }, (_, index) => ({ id: `file:${index}`, externalFile: { size: 1024 * 1024 } }))
  assert.deepEqual([...retainedResourceIds(files, 'file:8', ['file:2', 'file:4'])], ['file:8', 'file:2'])
  assert.deepEqual([...retainedResourceIds(files, null, [])], [])
})
