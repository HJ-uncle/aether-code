/** New pure coverage for Work's directory-name scan: collapsed descendants,
 * bounded/cancelled reads, partial errors, and temporary result collapse.
 * No Electron, engine, file-content reads, or existing E2E fixtures. */
import { expect, test } from '@playwright/test'
import type { FsEntry } from '../src/shared/ipc'
import { collapseSessionFilterRows, scanSessionFileDirectories, type SessionFileScan } from '../src/renderer/src/features/workspace/file-filter'

function entry(path: string, isDirectory = false): FsEntry {
  return { name: path.split('/').at(-1)!, path, isDirectory, size: isDirectory ? 0 : 64 * 1024 * 1024, mtimeMs: 1 }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

test('loads untouched nested folders and Work output metadata without opening file contents', async () => {
  const report = entry('/project/办公验收/第 6 轮/围棋项目介绍.pptx')
  // A name scan must not inspect file bytes, even for large binary deliverables.
  Object.defineProperty(report, 'content', { get() { throw new Error('File content must not be read') } })
  const tree: Record<string, FsEntry[]> = {
    '/project': [entry('/project/办公验收', true), entry('/project/out', true), entry('/project/.ae', true), entry('/project/.git', true), entry('/project/node_modules', true)],
    '/project/办公验收': [entry('/project/办公验收/第 6 轮', true)],
    '/project/办公验收/第 6 轮': [report],
    '/project/out': [entry('/project/out/最终报告.pdf')],
    '/project/.ae': [entry('/project/.ae/工作草稿.md')],
  }
  const reads: string[] = [], progress: SessionFileScan[] = []
  const result = await scanSessionFileDirectories({ root: '/project', current: () => true,
    readDirectory: async path => { reads.push(path); if (!(path in tree)) throw new Error('Unexpected directory'); return tree[path] },
    onProgress: state => { progress.push(state) } })
  expect([...reads].sort()).toEqual(Object.keys(tree).sort())
  expect(result).toEqual({ directories: 5, entries: 9, failed: 0, limited: false })
  expect(progress[0]).toEqual({ directories: 1, entries: 5, failed: 0, limited: false })
  expect(progress.at(-1)).toEqual(result)
  expect(report.name).toBe('围棋项目介绍.pptx')
})

test('reports unknown and failed directories as incomplete while continuing readable siblings', async () => {
  const reads: string[] = []
  const result = await scanSessionFileDirectories({ root: '/project', current: () => true, readDirectory: async path => {
    reads.push(path)
    if (path === '/project') return ['unavailable', 'denied', 'readable'].map(name => entry(`/project/${name}`, true))
    if (path === '/project/unavailable') return null
    if (path === '/project/denied') throw new Error('Permission denied')
    return [entry('/project/readable/围棋.xlsx')]
  } })
  expect(reads).toEqual(['/project', '/project/unavailable', '/project/denied', '/project/readable'])
  expect(result).toEqual({ directories: 4, entries: 4, failed: 2, limited: false })
})

test('an empty completed directory is not a failure or a truncated result', async () => {
  const result = await scanSessionFileDirectories({ root: '/empty', current: () => true, readDirectory: async () => [] })
  expect(result).toEqual({ directories: 1, entries: 0, failed: 0, limited: false })
})

test('does not begin reads after its task has already been cancelled', async () => {
  const reads: string[] = []
  const result = await scanSessionFileDirectories({ root: '/project', current: () => false,
    readDirectory: async path => { reads.push(path); return [] } })
  expect(result).toBeNull()
  expect(reads).toEqual([])
})

test('cancellation during a pending directory read does not publish or schedule descendants', async () => {
  const listing = deferred<FsEntry[]>(), reads: string[] = [], progress: SessionFileScan[] = []
  let current = true
  const run = scanSessionFileDirectories({ root: '/project', current: () => current,
    readDirectory: async path => { reads.push(path); return listing.promise }, onProgress: value => { progress.push(value) } })
  expect(reads).toEqual(['/project'])
  current = false
  listing.resolve([entry('/project/must-not-be-read', true)])
  expect(await run).toBeNull()
  expect(reads).toEqual(['/project'])
  expect(progress).toEqual([])
})

test('cancellation between batches does not drain the already queued directories', async () => {
  const reads: string[] = []
  let current = true
  const result = await scanSessionFileDirectories({ root: '/project', current: () => current,
    readDirectory: async path => { reads.push(path); return [entry('/project/queued', true)] },
    onProgress: () => { current = false } })
  expect(result).toBeNull()
  expect(reads).toEqual(['/project'])
})

test('directory limit bounds actual reads and reports omitted branches', async () => {
  const reads: string[] = []
  const result = await scanSessionFileDirectories({ root: '/project', maxDirectories: 3, current: () => true,
    readDirectory: async path => {
      reads.push(path)
      return path === '/project' ? ['one', 'two', 'three', 'four'].map(name => entry(`/project/${name}`, true)) : []
    } })
  expect(reads).toEqual(['/project', '/project/one', '/project/two'])
  expect(result).toEqual({ directories: 3, entries: 4, failed: 0, limited: true })
})

test('reaching the exact directory count with no omitted branches remains complete', async () => {
  const result = await scanSessionFileDirectories({ root: '/project', maxDirectories: 3, current: () => true,
    readDirectory: async path => path === '/project' ? [entry('/project/one', true), entry('/project/two', true)] : [] })
  expect(result).toEqual({ directories: 3, entries: 2, failed: 0, limited: false })
})

test('entry limit reports when child directories cannot be visited', async () => {
  const reads: string[] = []
  const result = await scanSessionFileDirectories({ root: '/project', maxEntries: 2, current: () => true,
    readDirectory: async path => { reads.push(path); return [entry('/project/one', true), entry('/project/two', true)] } })
  expect(reads).toEqual(['/project'])
  expect(result).toEqual({ directories: 1, entries: 2, failed: 0, limited: true })
})

test('an oversized flat listing reports its entry limit even without further directories', async () => {
  const result = await scanSessionFileDirectories({ root: '/project', maxEntries: 2, current: () => true,
    readDirectory: async () => [entry('/project/a.pptx'), entry('/project/b.pdf'), entry('/project/c.xlsx')] })
  expect(result).toEqual({ directories: 1, entries: 3, failed: 0, limited: true })
})

test('exactly reaching the entry limit with all entries known remains complete', async () => {
  const result = await scanSessionFileDirectories({ root: '/project', maxEntries: 2, current: () => true,
    readDirectory: async () => [entry('/project/a.pptx'), entry('/project/b.pdf')] })
  expect(result).toEqual({ directories: 1, entries: 2, failed: 0, limited: false })
})

test('duplicate directory entries cannot cause repeat scans or a loop', async () => {
  const reads: string[] = []
  const result = await scanSessionFileDirectories({ root: '/project', current: () => true, readDirectory: async path => {
    reads.push(path)
    return path === '/project' ? [entry('/project/child', true), entry('/project/child', true)] : [entry('/project', true)]
  } })
  expect(reads).toEqual(['/project', '/project/child'])
  expect(result).toEqual({ directories: 2, entries: 3, failed: 0, limited: false })
})

test('temporary result collapse hides only descendants and preserves source rows and selection', () => {
  const row = (path: string, depth: number, directory = true) => Object.freeze({ entry: Object.freeze(entry(path, directory)), depth, isExpanded: directory, selected: path.endsWith('围棋.pptx') })
  const rows = Object.freeze([row('/project', 0), row('/project/one', 1), row('/project/one/sub', 2), row('/project/one/sub/围棋.pptx', 3, false),
    row('/project/two', 1), row('/project/two/报告.pdf', 2, false)])
  const collapsed = new Set(['/project/one'])
  const result = collapseSessionFilterRows(rows, collapsed, path => path.toLowerCase())
  expect(result.map(item => item.entry.path)).toEqual(['/project', '/project/one', '/project/two', '/project/two/报告.pdf'])
  expect(result[1].isExpanded).toBe(false)
  expect(rows[1].isExpanded).toBe(true)
  expect(rows[3].selected).toBe(true)
  expect([...collapsed]).toEqual(['/project/one'])
  expect(collapseSessionFilterRows(rows, new Set(), path => path)).toEqual(rows)
})

test('collapsing the root is temporary and normalized path identities are respected', () => {
  const rows = [{ entry: entry('C:/Project', true), depth: 0, isExpanded: true },
    { entry: entry('C:/Project/Report.pptx'), depth: 1, isExpanded: false }]
  const result = collapseSessionFilterRows(rows, new Set(['c:/project']), path => path.replaceAll('\\', '/').toLowerCase())
  expect(result).toEqual([{ ...rows[0], isExpanded: false }])
  expect(rows[0].isExpanded).toBe(true)
})
