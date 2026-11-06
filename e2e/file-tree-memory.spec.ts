/** Pure shared explorer memory contracts: source/session/root isolation,
 * validated parent-first restoration, stale reads and legacy Code preservation.
 * No Electron, workspace mutations or filesystem fixtures. */
import { expect, test } from '@playwright/test'
import type { FsEntry } from '../src/shared/ipc'
import {
  createFileTreeScope, FILE_TREE_MEMORY_KEY, fileTreePathKey, isFileTreePathWithin,
  readFileTreeMemory, restoreFileTreeExpansion, writeFileTreeMemory, type TreeMemoryStorage
} from '../src/renderer/src/core/workspace/file-tree-memory'

function storage(): TreeMemoryStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } }
}
const entry = (path: string, isDirectory = true): FsEntry => ({ path, name: path.split('/').at(-1) ?? path, isDirectory, size: 0, mtimeMs: 0 })

test('Work memories isolate same-root sessions, sources, accounts, roots and Code', () => {
  const store = storage()
  const first = createFileTreeScope('work', 'remote:https://one:account:a', 'work-a', '/root')
  writeFileTreeMemory(first, { expanded: ['/root', '/root/docs'], selection: ['/root/docs/a.md'], cursorPath: '/root/docs/a.md', activeFilePath: '/root/docs/a.md', scrollTop: 1840, scrollLeft: 27, filter: 'item-' }, store)
  const others = [
    createFileTreeScope('work', 'remote:https://one:account:a', 'work-b', '/root'),
    createFileTreeScope('work', 'remote:https://two:account:a', 'work-a', '/root'),
    createFileTreeScope('work', 'remote:https://one:account:b', 'work-a', '/root'),
    createFileTreeScope('work', 'remote:https://one:account:a', 'work-a', '/other'),
    createFileTreeScope('code', 'remote:https://one:account:a', 'work-a', '/root')
  ]
  for (const scope of others) {
    expect(readFileTreeMemory(scope, store)).toMatchObject({ expanded: [scope.root], selection: [], cursorPath: null, scrollTop: 0, filter: '' })
    writeFileTreeMemory(scope, { scrollTop: 30 }, store)
  }
  expect(readFileTreeMemory(first, store)).toMatchObject({ expanded: ['/root', '/root/docs'], selection: ['/root/docs/a.md'], scrollTop: 1840, scrollLeft: 27, filter: 'item-' })
})

test('memory survives a fresh reader and partial patches preserve independent fields', () => {
  const store = storage(), scope = createFileTreeScope('work', 'remote:engine', 'work-a', '/root')
  writeFileTreeMemory(scope, { expanded: ['/root', '/root/docs'], selection: ['/root/docs/a.md'], scrollTop: 600, filter: '.md' }, store)
  const reloaded = storage()
  reloaded.values.set(FILE_TREE_MEMORY_KEY, store.values.get(FILE_TREE_MEMORY_KEY)!)
  writeFileTreeMemory(scope, { cursorPath: '/root/docs/a.md' }, reloaded)
  expect(readFileTreeMemory(scope, reloaded)).toMatchObject({ expanded: ['/root', '/root/docs'], selection: ['/root/docs/a.md'], cursorPath: '/root/docs/a.md', scrollTop: 600, filter: '.md' })
})

test('Windows path variants share scope while POSIX case remains distinct', () => {
  expect(createFileTreeScope('work', '', 'a', 'C:\\Root\\').key).toBe(createFileTreeScope('work', '', 'a', 'c:/root').key)
  expect(fileTreePathKey('\\\\Server\\Share\\folder\\')).toBe('//server/share/folder')
  expect(createFileTreeScope('work', '', 'a', '/Root').key).not.toBe(createFileTreeScope('work', '', 'a', '/root').key)
  expect(isFileTreePathWithin('/root', '/root-other/file')).toBe(false)
  expect(isFileTreePathWithin('/root', '/root/../outside')).toBe(false)
})

test('the same Windows root keeps its expanded state before directory restoration completes', () => {
  const store = storage()
  const oldScope = createFileTreeScope('work', '', 'a', 'D:\\Trust-Test')
  writeFileTreeMemory(oldScope, { expanded: ['D:\\Trust-Test', 'D:\\Trust-Test\\docs'] }, store)
  const reopened = createFileTreeScope('work', '', 'a', 'd:/trust-test/')
  expect(readFileTreeMemory(reopened, store).expanded).toEqual(['d:/trust-test/', 'D:\\Trust-Test\\docs'])
  writeFileTreeMemory(oldScope, { expanded: [] }, store)
  expect(readFileTreeMemory(reopened, store).expanded).toEqual([])
})

test('temporary directory failures retain expansion preferences without reading unverified descendants', async () => {
  const expanded = ['/root', '/root/docs', '/root/docs/deep', '/root/deleted', '/outside']
  const reads: string[] = []
  const restored = await restoreFileTreeExpansion({ root: '/root', expanded, rootEntries: [entry('/root/docs')],
    readChildren: async path => { reads.push(path); return null } })
  expect([...restored]).toEqual(['/root', '/root/docs', '/root/docs/deep'])
  expect(reads).toEqual(['/root/docs'])
  const unavailableRoot = await restoreFileTreeExpansion({ root: '/root', expanded, rootEntries: null,
    readChildren: async () => { throw new Error('An unreadable root must not authorize descendant reads') } })
  expect([...unavailableRoot].sort()).toEqual(expanded.filter(path => path !== '/outside').sort())
  const retried = await restoreFileTreeExpansion({ root: '/root', expanded: [...restored], rootEntries: [entry('/root/docs')],
    readChildren: async () => [] })
  expect([...retried]).toEqual(['/root', '/root/docs'])
})

test('untrusted persisted paths and offsets are sanitized without touching legacy Code memory', () => {
  const store = storage(), scope = createFileTreeScope('work', '', 'a', '/root')
  store.values.set('aether.expandedDirs', '{"C:/code":["C:/code/src"]}')
  store.values.set(FILE_TREE_MEMORY_KEY, JSON.stringify({ [scope.key]: {
    expanded: ['/root', '/root/docs', '/root/docs', '/root/../outside', '/other'],
    selection: ['/root/docs/a.md', '/rooted/a.md'], cursorPath: '/other', activeFilePath: '/root/../private',
    scrollTop: -10, scrollLeft: '500', filter: '.md'
  } }))
  expect(readFileTreeMemory(scope, store)).toEqual({ expanded: ['/root', '/root/docs'], selection: ['/root/docs/a.md'], cursorPath: null, activeFilePath: null, scrollTop: 0, scrollLeft: 0, filter: '.md' })
  writeFileTreeMemory(scope, { scrollTop: 100 }, store)
  expect(store.values.get('aether.expandedDirs')).toBe('{"C:/code":["C:/code/src"]}')
})

test('corrupt and unavailable storage do not prevent browsing', () => {
  const store = storage(), scope = createFileTreeScope('work', '', 'a', '/root')
  store.values.set(FILE_TREE_MEMORY_KEY, '{ broken')
  expect(readFileTreeMemory(scope, store).expanded).toEqual(['/root'])
  const unavailable: TreeMemoryStorage = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('full') } }
  expect(writeFileTreeMemory(scope, { scrollTop: 321 }, unavailable).scrollTop).toBe(321)
})

test('memory eviction keeps the latest scope and bounds storage', () => {
  const store = storage()
  for (let index = 0; index < 100; index++) writeFileTreeMemory(createFileTreeScope('work', '', `work-${index}`, '/root'), { scrollTop: index }, store)
  expect(Object.keys(JSON.parse(store.values.get(FILE_TREE_MEMORY_KEY)!))).toHaveLength(80)
  expect(readFileTreeMemory(createFileTreeScope('work', '', 'work-99', '/root'), store).scrollTop).toBe(99)
})

test('restoration reads real parents first and prunes missing, file and outside candidates', async () => {
  const reads: string[] = []
  const restored = await restoreFileTreeExpansion({ root: '/root', expanded: ['/root/docs/deep', '/root/docs', '/root/missing', '/root/plain.md', '/outside', '/root/../outside'],
    rootEntries: [entry('/root/docs'), entry('/root/plain.md', false)],
    readChildren: async path => { reads.push(path); return path === '/root/docs' ? [entry('/root/docs/deep')] : [entry('/root/docs/deep/file.md', false)] } })
  expect(reads).toEqual(['/root/docs', '/root/docs/deep'])
  expect([...restored]).toEqual(['/root', '/root/docs', '/root/docs/deep'])
})

test('restoration never reads descendants of an unpersisted collapsed parent', async () => {
  const reads: string[] = []
  const restored = await restoreFileTreeExpansion({ root: '/root', expanded: ['/root', '/root/docs/deep'], rootEntries: [entry('/root/docs')],
    readChildren: async path => { reads.push(path); return [] } })
  expect(reads).toEqual([])
  expect([...restored]).toEqual(['/root'])
  expect([...await restoreFileTreeExpansion({ root: '/root', expanded: [], rootEntries: [entry('/root/docs')], keepRootExpanded: false, readChildren: async () => [] })]).toEqual([])
})

test('restoration uses canonical filesystem paths and stops after a scope switch', async () => {
  let current = true
  const reads: string[] = []
  const restored = await restoreFileTreeExpansion({ root: 'C:\\Root', expanded: ['c:/root/docs', 'c:/root/docs/deep'], rootEntries: [entry('C:\\Root\\Docs')], current: () => current,
    readChildren: async path => { reads.push(path); current = false; return [entry('C:\\Root\\Docs\\Deep')] } })
  expect(reads).toEqual(['C:\\Root\\Docs'])
  expect([...restored]).toEqual(['C:\\Root'])
})
