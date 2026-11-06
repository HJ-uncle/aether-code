/** Pure browser selection contracts: mode, engine and session own independent tab sets. */
import { expect, test } from '@playwright/test'
import type { BrowserSurfaceOwner, BrowserTabState } from '../src/shared/browser'
import { BrowserScopeRegistry, browserPendingSourceId, browserScopeKey, browserTabInScope } from '../src/renderer/src/core/browser/scope'

const code: BrowserSurfaceOwner = { mode: 'code', sessionId: 'same', engineId: 'engine-A', generation: 1 }
const work: BrowserSurfaceOwner = { ...code, mode: 'work', generation: 2 }
const otherWork: BrowserSurfaceOwner = { ...work, sessionId: 'other', generation: 3 }
const otherEngine: BrowserSurfaceOwner = { ...work, engineId: 'engine-B', generation: 4 }
function tab(tabId: string, presentation = code): BrowserTabState {
  return { tabId, title: tabId, url: 'https://example.test/' + tabId, loading: false, canGoBack: false, canGoForward: false,
    zoomFactor: 1, viewport: null, navigationId: 1,
    presentation: { mode: presentation.mode, sessionId: presentation.sessionId ?? null, engineId: presentation.engineId,
      pendingSourceId: presentation.pendingSourceId } }
}
const ids = (registry: BrowserScopeRegistry, owner: BrowserSurfaceOwner) => registry.view(owner).tabs.map(tab => tab.tabId)

test('Code and Work remain distinct even with the same session ID, and sessions/accounts remain isolated', () => {
  const registry = new BrowserScopeRegistry()
  registry.replace([tab('code', code), tab('work', work), tab('other-work', otherWork), tab('other-engine', otherEngine)])
  expect(ids(registry, code)).toEqual(['code'])
  expect(ids(registry, work)).toEqual(['work'])
  expect(ids(registry, otherWork)).toEqual(['other-work'])
  expect(ids(registry, otherEngine)).toEqual(['other-engine'])
  expect(registry.select('code', work)).toBe(false)
  expect(registry.select('other-work', work)).toBe(false)
})

test('background creation, reveal and address focus preserve each scope selection across round trips', () => {
  const registry = new BrowserScopeRegistry()
  for (const item of [tab('code-1'), tab('code-2'), tab('work-1', work), tab('work-2', work)]) registry.receive({ type: 'created', tabId: item.tabId, tab: item })
  registry.select('code-1', code); registry.select('work-1', work)
  registry.receive({ type: 'reveal', tabId: 'work-2', tab: tab('work-2', work), requestId: 'request-work' })
  registry.receive({ type: 'focus-address', tabId: 'work-2' })
  expect(registry.view(code)).toMatchObject({ activeTabId: 'code-1', revealRequest: null, addressFocusRequest: 0 })
  expect(registry.view(work)).toMatchObject({ activeTabId: 'work-2', revealRequest: { requestId: 'request-work' }, addressFocusRequest: 1 })
  registry.receive({ type: 'focused', tabId: 'code-2' })
  expect(registry.view(code).activeTabId).toBe('code-2')
  expect(registry.view(work).activeTabId).toBe('work-2')
  expect(registry.view({ ...work, generation: 20 }).activeTabId).toBe('work-2')
})

test('closing an active tab selects only its own scope sibling and leaves other scope reveal pending', () => {
  const registry = new BrowserScopeRegistry()
  registry.replace([tab('code'), tab('work-1', work), tab('work-2', work)])
  registry.receive({ type: 'reveal', tabId: 'code', tab: tab('code'), requestId: 'request-code' })
  registry.select('work-2', work)
  registry.receive({ type: 'closed', tabId: 'work-2' })
  expect(registry.view(work).activeTabId).toBe('work-1')
  expect(registry.view(code).revealRequest?.requestId).toBe('request-code')
  registry.receive({ type: 'closed', tabId: 'work-1' })
  expect(registry.view(work).activeTabId).toBeNull()
  expect(ids(registry, code)).toEqual(['code'])
})

test('unassigned background tabs stay hidden until main reports their explicit presentation binding', () => {
  const registry = new BrowserScopeRegistry()
  const unknown = { ...tab('pending', work), presentation: undefined }
  registry.receive({ type: 'created', tabId: unknown.tabId, tab: unknown })
  expect(ids(registry, code)).toEqual([])
  expect(ids(registry, work)).toEqual([])
  registry.receive({ type: 'changed', tabId: unknown.tabId, tab: tab('pending', work) })
  expect(ids(registry, work)).toEqual(['pending'])
  expect(registry.view(work).activeTabId).toBe('pending')
  expect(ids(registry, code)).toEqual([])
})

test('a list response racing events retains untouched tabs, latest navigation and confirmed closures', () => {
  const registry = new BrowserScopeRegistry()
  const snapshot = [tab('closed'), tab('changed', work), tab('untouched', otherWork)]
  registry.replace(snapshot)
  registry.receive({ type: 'closed', tabId: 'closed' })
  registry.receive({ type: 'changed', tabId: 'changed', tab: { ...tab('changed', work), navigationId: 2, title: 'new title' } })
  registry.receive({ type: 'created', tabId: 'created', tab: tab('created') })
  registry.replace(snapshot, new Set(['closed', 'changed', 'created']))
  expect(ids(registry, code)).toEqual(['created'])
  expect(registry.view(work).tabs[0]).toMatchObject({ title: 'new title', navigationId: 2 })
  expect(ids(registry, otherWork)).toEqual(['untouched'])
})

test('surface generations fence geometry without discarding the same scope tab choice', () => {
  expect(browserScopeKey(code)).toBe(browserScopeKey({ ...code, generation: 100 }))
  expect(browserScopeKey(code)).not.toBe(browserScopeKey(work))
  expect(browserTabInScope(tab('code'), { ...code, sessionId: null })).toBe(false)
  expect(browserTabInScope(tab('code'), { ...code, engineId: 'engine-B' })).toBe(false)
})

test('verified engine binding preserves the selected pre-bootstrap tab without moving it to another session', () => {
  const registry = new BrowserScopeRegistry(), pending = { ...code, engineId: undefined }
  registry.replace([tab('one', pending), tab('two', pending)])
  registry.select('two', pending)
  registry.receive({ type: 'changed', tabId: 'one', tab: tab('one', code) })
  registry.receive({ type: 'changed', tabId: 'two', tab: tab('two', code) })
  expect(registry.view(code).activeTabId).toBe('two')
  expect(ids(registry, pending)).toEqual([])
  expect(ids(registry, work)).toEqual([])
})

test('offline endpoints and accounts retain separate tabs and selection without AI engine identities', () => {
  const first = { ...work, engineId: undefined, pendingSourceId: browserPendingSourceId('remote', 'https://first.test/', 'alice') }
  const second = { ...first, pendingSourceId: browserPendingSourceId('remote', 'https://second.test', 'alice') }
  const otherAccount = { ...first, pendingSourceId: browserPendingSourceId('remote', 'https://first.test', 'bob') }
  const registry = new BrowserScopeRegistry()
  registry.replace([tab('first-1', first), tab('first-2', first), tab('second', second), tab('other-account', otherAccount)])
  registry.select('first-2', first)
  expect(ids(registry, first)).toEqual(['first-1', 'first-2'])
  expect(ids(registry, second)).toEqual(['second'])
  expect(ids(registry, otherAccount)).toEqual(['other-account'])
  expect(registry.select('first-1', second)).toBe(false)
  expect(registry.view(first).activeTabId).toBe('first-2')
  expect(browserScopeKey(first)).not.toBe(browserScopeKey(second))
  expect(browserPendingSourceId('remote', 'https://first.test/', 'alice')).toBe(browserPendingSourceId('remote', 'https://first.test', 'alice'))
  expect(browserPendingSourceId('embedded', 'ignored', null)).not.toBe(browserPendingSourceId('remote', '', null))
  registry.receive({ type: 'changed', tabId: 'first-2', tab: tab('first-2', work) })
  expect(registry.view(work).activeTabId).toBe('first-2')
  expect(ids(registry, second)).toEqual(['second'])
  expect(ids(registry, otherAccount)).toEqual(['other-account'])
})
