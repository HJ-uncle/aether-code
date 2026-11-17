/** Shared project preferences: storage/event isolation, legacy data, archive projections and ordering. */
import { expect, test } from '@playwright/test'
import { buildProjectGroups, isProjectTaskArchived, normalizeProjectPath, patchProjectPreferences, projectDisplayName,
  readProjectPreferences, subscribeProjectPreferences } from '../src/renderer/src/features/projects/project-preferences'
import type { SessionTask } from '../src/renderer/src/features/sessions/state'

let entries: Map<string, string>, events: EventTarget, failReads: boolean, failWrites: boolean
let storageDescriptor: PropertyDescriptor | undefined, windowDescriptor: PropertyDescriptor | undefined
let sequence = 0
const key = (): string => `project-preferences-${++sequence}`
test.beforeEach(() => {
  entries = new Map(); events = new EventTarget(); failReads = false; failWrites = false
  storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => { if (failReads) throw new Error('Storage blocked'); return entries.get(key) ?? null },
    setItem: (key: string, value: string) => { if (failWrites) throw new Error('Storage full'); entries.set(key, value) }
  } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events })
})
test.afterEach(() => {
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
  else Reflect.deleteProperty(globalThis, 'localStorage')
  if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
  else Reflect.deleteProperty(globalThis, 'window')
})

function task(id: string, workspacePath: string | null, patch: Partial<SessionTask> = {}): SessionTask {
  return { id, title: id, workspacePath, status: 'done', draft: '', createdAt: 1, updatedAt: 2, modelId: '', attachments: [], sources: [], ...patch }
}

test('legacy pins and mixed separators normalize without folding case-sensitive remote paths', () => {
  const storageKey = key()
  entries.set(storageKey, JSON.stringify(['D:\\projects\\alpha\\', 'D:/projects/alpha', '/remote/Alpha/', '/remote/alpha', '', null]))
  expect(readProjectPreferences(storageKey)).toEqual({ pinnedPaths: ['D:/projects/alpha', '/remote/Alpha', '/remote/alpha'],
    archivedPaths: [], names: {}, selectedPath: null, selectedCollection: 'projects', sort: 'recent' })
  expect(normalizeProjectPath('/')).toBe('/')
  expect(normalizeProjectPath('D:\\projects\\alpha\\')).toBe('D:/projects/alpha')
})

test('partial edits merge with the latest stored preferences and preserve other surfaces', () => {
  const storageKey = key()
  patchProjectPreferences(storageKey, { pinnedPaths: ['/alpha'], names: { '/alpha/': ' Alpha workspace ' }, sort: 'name' })
  const earlier = readProjectPreferences(storageKey)
  entries.set(storageKey, JSON.stringify({ ...earlier, archivedPaths: ['/beta'], selectedPath: '/beta', selectedCollection: 'independent' }))
  const latest = patchProjectPreferences(storageKey, current => ({ pinnedPaths: [...current.pinnedPaths, '/beta'] }))
  expect(latest).toEqual({ pinnedPaths: ['/alpha', '/beta'], archivedPaths: ['/beta'], names: { '/alpha': 'Alpha workspace' },
    sort: 'name', selectedPath: '/beta', selectedCollection: 'independent' })
  expect(projectDisplayName('/alpha/', latest)).toBe('Alpha workspace')
  expect(projectDisplayName('/parent/unknown', latest)).toBe('unknown')
  expect(readProjectPreferences(storageKey)).toBe(latest)
  expect(JSON.parse(entries.get(storageKey)!)).toEqual(latest)
})

test('same-window changes notify only the matching engine and unsubscribe cleanly', () => {
  const first = key(), second = key(), changes: string[] = []
  const unsubscribe = subscribeProjectPreferences(first, () => { changes.push('first') })
  const unsubscribeSecond = subscribeProjectPreferences(second, () => { changes.push('second') })
  patchProjectPreferences(first, { archivedPaths: ['/alpha'] })
  expect(changes).toEqual(['first'])
  expect(readProjectPreferences(second).archivedPaths).toEqual([])
  patchProjectPreferences(second, { pinnedPaths: ['/beta'] })
  expect(changes).toEqual(['first', 'second'])
  expect(readProjectPreferences(first).pinnedPaths).toEqual([])
  unsubscribe(); unsubscribeSecond()
  patchProjectPreferences(first, { archivedPaths: [] })
  expect(changes).toEqual(['first', 'second'])
})

test('cross-window storage changes refresh the matching key and clear refreshes all keys', () => {
  const first = key(), second = key(), changes: string[] = []
  const unsubscribe = subscribeProjectPreferences(first, () => { changes.push(projectDisplayName('/alpha', readProjectPreferences(first))) })
  const unsubscribeSecond = subscribeProjectPreferences(second, () => { changes.push('second') })
  readProjectPreferences(first)
  entries.set(first, JSON.stringify({ names: { '/alpha': 'Renamed project' } }))
  const storage = new Event('storage'); Object.defineProperty(storage, 'key', { value: first })
  events.dispatchEvent(storage)
  expect(changes).toEqual(['Renamed project'])
  entries.clear()
  const clear = new Event('storage'); Object.defineProperty(clear, 'key', { value: null })
  events.dispatchEvent(clear)
  expect(changes).toEqual(['Renamed project', 'alpha', 'second'])
  unsubscribe(); unsubscribeSecond()
})

test('blocked storage keeps local changes usable and can persist them on recovery', () => {
  const storageKey = key()
  patchProjectPreferences(storageKey, { pinnedPaths: ['/alpha'] })
  failWrites = true
  const failedWrite = patchProjectPreferences(storageKey, { archivedPaths: ['/beta'] })
  expect(readProjectPreferences(storageKey)).toBe(failedWrite)
  expect(readProjectPreferences(storageKey).archivedPaths).toEqual(['/beta'])
  expect(JSON.parse(entries.get(storageKey)!).archivedPaths).toEqual([])
  failReads = true
  patchProjectPreferences(storageKey, { names: { '/alpha': 'Offline project' } })
  expect(readProjectPreferences(storageKey).names).toEqual({ '/alpha': 'Offline project' })
  failReads = false; failWrites = false
  patchProjectPreferences(storageKey, { selectedPath: '/alpha' })
  expect(JSON.parse(entries.get(storageKey)!)).toMatchObject({ archivedPaths: ['/beta'], names: { '/alpha': 'Offline project' }, selectedPath: '/alpha' })
})

test('malformed preferences do not leak invalid paths or unstable snapshots', () => {
  const storageKey = key()
  entries.set(storageKey, '{bad-json')
  const fallback = readProjectPreferences(storageKey)
  expect(fallback.pinnedPaths).toEqual([])
  expect(readProjectPreferences(storageKey)).toBe(fallback)
  entries.set(storageKey, JSON.stringify({ pinnedPaths: [5, '', '/alpha'], archivedPaths: false, names: { '/alpha/': 'Named', '/beta': 1 }, sort: 'bad' }))
  expect(readProjectPreferences(storageKey)).toMatchObject({ pinnedPaths: ['/alpha'], archivedPaths: [], names: { '/alpha': 'Named' }, sort: 'recent' })
})

test('archive projection combines project and task archives without changing runtime state', () => {
  const storageKey = key()
  const preferences = patchProjectPreferences(storageKey, { archivedPaths: ['/alpha'], pinnedPaths: ['/alpha'] })
  const active = task('running', '/alpha/', { status: 'running', runStartedAt: 5 })
  const individuallyArchived = task('archived', '/alpha', { archived: true })
  const current = task('current', '/beta')
  const archivedInCurrentProject = task('archived-beta', '/beta', { archived: true })
  const independent = task('independent', null)
  const tasks = [active, individuallyArchived, current, archivedInCurrentProject, independent]
  expect(isProjectTaskArchived(active, preferences)).toBe(true)
  expect(buildProjectGroups(tasks, preferences, 'current').map(group => [group.path, group.tasks.map(task => task.id)])).toEqual([['/beta', ['current']]])
  expect(buildProjectGroups(tasks, preferences, 'archived').map(group => [group.path, group.archived, group.tasks.map(task => task.id)])).toEqual([
    ['/alpha', true, ['running', 'archived']], ['/beta', false, ['archived-beta']]
  ])
  expect(buildProjectGroups(tasks, preferences, 'all')).toHaveLength(2)
  const restored = patchProjectPreferences(storageKey, { archivedPaths: [] })
  expect(buildProjectGroups(tasks, restored, 'current').map(group => group.tasks.map(task => task.id))).toEqual([['running'], ['current']])
  expect(buildProjectGroups(tasks, restored, 'archived').map(group => group.tasks.map(task => task.id))).toEqual([['archived'], ['archived-beta']])
  expect(active.status).toBe('running'); expect(active.archived).toBeUndefined(); expect(individuallyArchived.archived).toBe(true)
})

test('project recency uses every task and pins override ordering without changing task pins', () => {
  const storageKey = key(), preferences = readProjectPreferences(storageKey)
  const tasks = [task('old-pinned', '/alpha', { pinned: true, updatedAt: 1 }), task('new', '/alpha', { updatedAt: 30 }),
    task('beta', '/beta', { updatedAt: 20, runStartedAt: 40 }), task('gamma', '/gamma', { updatedAt: 25 })]
  const groups = buildProjectGroups(tasks, preferences, 'current')
  expect(groups.map(group => [group.path, group.updatedAt])).toEqual([['/beta', 40], ['/alpha', 30], ['/gamma', 25]])
  expect(groups[1].tasks.map(task => task.id)).toEqual(['old-pinned', 'new'])
  const pinned = patchProjectPreferences(storageKey, { pinnedPaths: ['/gamma'], sort: 'name', names: { '/beta': 'A project', '/alpha': 'Z project' } })
  expect(buildProjectGroups(tasks, pinned, 'current').map(group => group.path)).toEqual(['/gamma', '/beta', '/alpha'])
  expect(tasks[0].pinned).toBe(true); expect(tasks[3].pinned).toBeUndefined()
})
