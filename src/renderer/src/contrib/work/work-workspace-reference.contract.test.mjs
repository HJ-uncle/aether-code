import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const directory = dirname(fileURLToPath(import.meta.url))
const cache = new Map()
function load(path) {
  if (cache.has(path)) return cache.get(path)
  const exports = {}
  cache.set(path, exports)
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new vm.Script(`(function(require,exports){${code}\n})`, { filename: path }).runInThisContext()(name => {
    if (name === '@renderer/core/workspace/file-tree-memory') return load(resolve(directory, '../../core/workspace/file-tree-memory.ts'))
    throw new Error(`Unexpected dependency: ${name}`)
  }, exports)
  return exports
}
const { workWorkspaceReferencePaths, resolveWorkWorkspaceReferences } = load(resolve(directory, 'work-workspace-reference.ts'))

test('references retain the root and a specifically selected child alongside its parent', () => {
  assert.deepEqual(workWorkspaceReferencePaths(['/task', '/task/docs', '/task/docs/spec.md', '/task/docs'], '/task'),
    ['/task', '/task/docs', '/task/docs/spec.md'])
  assert.deepEqual(workWorkspaceReferencePaths(['C:\\Task\\Docs', 'c:/task/docs', 'c:/task/docs/a.txt'], 'C:/Task'),
    ['c:/task/docs', 'c:/task/docs/a.txt'])
})

test('outside paths, traversal and sibling prefixes cannot become references', () => {
  assert.deepEqual(workWorkspaceReferencePaths(['/task/a.txt', '/task-other/b.txt', '/task/../private/a', '/private'], '/task'), ['/task/a.txt'])
})

test('each selected item uses its own metadata without collapsing mixed file and directory selections', async () => {
  const reads = []
  const entries = await resolveWorkWorkspaceReferences(['/task/demo.ts', '/task/docs', '/task/docs/a.md'], '/task', async path => {
    reads.push(path)
    return { isDirectory: path === '/task/docs' }
  }, () => true)
  assert.deepEqual(reads, ['/task/demo.ts', '/task/docs', '/task/docs/a.md'])
  assert.deepEqual(entries, [
    { path: '/task/demo.ts', kind: 'file' }, { path: '/task/docs', kind: 'directory' }, { path: '/task/docs/a.md', kind: 'file' }
  ])
})

test('switching the task while metadata is pending cannot publish a late selection', async () => {
  let current = true, release
  const pending = resolveWorkWorkspaceReferences(['/task/demo.ts'], '/task', () => new Promise(resolve => { release = resolve }), () => current)
  current = false
  release({ isDirectory: false })
  assert.equal(await pending, null)
  let reads = 0
  assert.equal(await resolveWorkWorkspaceReferences(['/task/demo.ts'], '/task', async () => { reads++; return { isDirectory: false } }, () => false), null)
  assert.equal(reads, 0)
})

test('a failed metadata read rejects the whole selection instead of attaching a partial result', async () => {
  await assert.rejects(resolveWorkWorkspaceReferences(['/task/ok.ts', '/task/gone.ts'], '/task', async path => {
    if (path.endsWith('gone.ts')) throw new Error('missing file')
    return { isDirectory: false }
  }, () => true), /missing file/)
})
