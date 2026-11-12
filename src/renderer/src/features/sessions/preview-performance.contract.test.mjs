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
    if (specifier === './useDocumentContextMenu') return { useDocumentContextMenu: () => { throw new Error('DOM context menus are outside this pure preview test') } }
    if (specifier === '../documents/document-kind') return load('../documents/document-kind')
    if (specifier.endsWith('.css')) return {}
    throw new Error(`Unexpected dependency: ${specifier}`)
  }, exports)
  return exports
}
const { readSessionFileCached, invalidateSessionFileReadCache, clearSessionFileReadCache, sessionFileReadCacheStats } = load('../workspace/file-read-cache')
const { isLargeSessionText } = load('../workspace/TextPreview', 'tsx')
const { resourcePreviewEntries } = load('../workspace/resource-preview-policy')
const { retainPreviewEntries, PREVIEW_RETENTION_LIMITS } = load('../../core/editor/preview-retention')
const byteSource = readFileSync(join(directory, '../../core/workspace/file-content-bytes.ts'), 'utf8')
const byteExports = {}
new vm.Script('(function(exports){' + ts.transpileModule(byteSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText + '\n})').runInThisContext()(byteExports)
const { fileContentBytes, fileContentUrl } = byteExports
const file = content => ({ path: 'sample', content, isBinary: false, size: content.length, truncated: false })

test('ordinary activation reuses content and coalesces concurrent reads', async () => {
  clearSessionFileReadCache()
  let reads = 0
  const reader = async () => { reads++; return file('first') }
  const [left, right] = await Promise.all([readSessionFileCached('a', reader), readSessionFileCached('a', reader)])
  assert.equal(left.content, 'first')
  assert.equal(right.content, 'first')
  await readSessionFileCached('a', reader)
  assert.equal(reads, 1)
  assert.deepEqual(sessionFileReadCacheStats(), { entries: 1, bytes: 10, pending: 0 })
})

test('explicit refresh bypasses cached content and failed reads do not poison it', async () => {
  clearSessionFileReadCache()
  let value = 'first'
  await readSessionFileCached('a', async () => file(value))
  value = 'second'
  assert.equal((await readSessionFileCached('a', async () => file(value))).content, 'first')
  assert.equal((await readSessionFileCached('a', async () => file(value), true)).content, 'second')
  await assert.rejects(readSessionFileCached('a', async () => { throw new Error('read failed') }, true))
  assert.equal((await readSessionFileCached('a', async () => file('never'))).content, 'second')
  invalidateSessionFileReadCache('a')
  assert.equal((await readSessionFileCached('a', async () => file('third'))).content, 'third')
})

test('cache stays bounded across many files and session keys remain independent', async () => {
  clearSessionFileReadCache()
  for (let index = 0; index < 30; index++) await readSessionFileCached(`file:${index}`, async () => file('x'.repeat(128 * 1024)))
  assert.ok(sessionFileReadCacheStats().entries <= 24)
  assert.ok(sessionFileReadCacheStats().bytes <= 128 * 1024 * 1024)
  await readSessionFileCached('session:a', async () => file('A'))
  await readSessionFileCached('session:b', async () => file('B'))
  assert.equal((await readSessionFileCached('session:a', async () => file('wrong'))).content, 'A')
  assert.equal((await readSessionFileCached('session:b', async () => file('wrong'))).content, 'B')
  clearSessionFileReadCache()
  assert.deepEqual(sessionFileReadCacheStats(), { entries: 0, bytes: 0, pending: 0 })
})

test('large CSV and long source files use viewport rendering while small files use the same lightweight preview', () => {
  assert.equal(isLargeSessionText(Array.from({ length: 30000 }, (_, index) => `${index},value`).join('\n')), true)
  assert.equal(isLargeSessionText('x'.repeat(600 * 1024)), true)
  assert.equal(isLargeSessionText('const value = 1\n'.repeat(5000)), true)
  assert.equal(isLargeSessionText('const value = 1\n'.repeat(100)), false)
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

test('retained Work previews reuse a five-file round trip and bound a larger working set', () => {
  const files = Array.from({ length: 20 }, (_, index) => ({ id: `file:${index}`, name: `report-${index}.docx`, externalFile: { size: 1024 * 1024 } }))
  const entries = resourcePreviewEntries(files)
  let retained = []
  for (const index of [0, 1, 2, 3, 4, 0]) retained = retainPreviewEntries(entries, `file:${index}`, retained)
  assert.deepEqual(retained.map(entry => entry.id), ['file:0', 'file:4', 'file:3', 'file:2', 'file:1'])
  for (let index = 5; index < 20; index++) retained = retainPreviewEntries(entries, `file:${index}`, retained)
  assert.equal(retained.length, PREVIEW_RETENTION_LIMITS.entries)
  assert.deepEqual(retained.map(entry => entry.id), ['file:19', 'file:18', 'file:17', 'file:16', 'file:15', 'file:14'])
  assert.deepEqual(retainPreviewEntries(entries, null, []), [])
})

test('retention accounts for byte size and charges unknown files conservatively', () => {
  const entries = [
    { id: 'small', size: 1024 * 1024 },
    { id: 'large', size: 40 * 1024 * 1024 },
    { id: 'unknown-a' }, { id: 'unknown-b' }, { id: 'unknown-c' }
  ]
  assert.deepEqual(retainPreviewEntries(entries, 'large', entries).map(entry => entry.id), ['large', 'small'])
  assert.deepEqual(retainPreviewEntries(entries, 'unknown-c', entries.slice(2)).map(entry => entry.id), ['unknown-c', 'unknown-a'])
  const oversized = { id: 'oversized', size: 100 * 1024 * 1024 }
  assert.deepEqual(retainPreviewEntries([...entries, oversized], oversized.id, entries), [oversized])
})

test('close, reopen and background content replacement evict old preview generations', () => {
  const first = { id: 'file-a', version: new ArrayBuffer(10), size: 10 }
  const second = { id: 'file-b', version: new ArrayBuffer(10), size: 10 }
  const previous = [first, second]
  assert.deepEqual(retainPreviewEntries([second], second.id, previous), [second])
  const changed = { ...first, version: new ArrayBuffer(10) }
  assert.deepEqual(retainPreviewEntries([changed, second], second.id, previous), [second])
  assert.deepEqual(retainPreviewEntries([changed, second], changed.id, previous), [changed, second])
  const reopened = { ...first, id: 'file-a:instance-2' }
  assert.deepEqual(retainPreviewEntries([reopened, second], second.id, previous), [second])
})

test('hidden panes keep only visited unchanged surfaces and never mount newly selected resources', () => {
  const files = [{ id: 'old', name: 'old.pdf', externalFile: { size: 1 } }, { id: 'new', name: 'new.pdf', externalFile: { size: 1 } }]
  const entries = resourcePreviewEntries(files)
  const visited = retainPreviewEntries(entries, 'old', [])
  assert.deepEqual(retainPreviewEntries(entries, null, visited).map(entry => entry.id), ['old'])
  const replaced = resourcePreviewEntries([{ ...files[0] }, files[1]])
  assert.deepEqual(retainPreviewEntries(replaced, null, visited), [])
  // An empty history is also the input after a workspace/session scope reset.
  assert.deepEqual(retainPreviewEntries(entries, 'new', []).map(entry => entry.id), ['new'])
})

test('retention ignores duplicate and removed history entries without spending their byte budget', () => {
  const entries = [{ id: 'a', size: 32 * 1024 * 1024 }, { id: 'b', size: 32 * 1024 * 1024 }]
  const history = [entries[0], entries[0], { id: 'closed', size: 64 * 1024 * 1024 }, entries[1]]
  assert.deepEqual(retainPreviewEntries(entries, null, history).map(entry => entry.id), ['a', 'b'])
})

test('a mixed ten-file tour retains four decoded Office surfaces without charging text as a heavy preview', () => {
  const files = ['requirements.md', 'plan.xlsx', 'review.pptx', 'guide.pdf', 'checklist.md', 'list.csv', 'list.tsv', 'delivery.txt', 'index.html', 'requirements.docx']
    .map(name => ({ id: name, name, externalFile: { size: 20480 } }))
  const entries = resourcePreviewEntries(files)
  let retained = []
  for (let round = 0; round < 3; round++) for (const file of files) retained = retainPreviewEntries(entries, file.id, retained)
  assert.deepEqual(new Set(retained.map(entry => entry.id)), new Set(['plan.xlsx', 'review.pptx', 'guide.pdf', 'requirements.docx']))
  assert.ok(retained.length <= PREVIEW_RETENTION_LIMITS.entries)
  const changed = files.map(file => file.name === 'plan.xlsx' ? { ...file } : file)
  assert.equal(retainPreviewEntries(resourcePreviewEntries(changed), null, retained).some(entry => entry.id === 'plan.xlsx'), false)
})
