/** Pure idle-session discovery: independent next roots, terminal stability, single flight and stale source/view rejection. No Electron/model. */
import { expect, test } from '@playwright/test'
import type { RootRun } from '../src/shared/root-run'
import { createIdleRootDiscovery, idleRootChanged } from '../src/renderer/src/core/engine/idle-root-discovery'
import { sameRecoveryScope, type RecoveryScope } from '../src/renderer/src/core/engine/chat-recovery-loop'

const scope: RecoveryScope = { source: 1, sessionId: 'code-a', viewEpoch: 1 }
function run(overrides: Partial<RootRun> = {}): RootRun {
  return { schemaVersion: 1, runId: 'old', sessionId: scope.sessionId, turnId: 'turn-old', userMessageId: 'user-old',
    assistantMessageId: 'assistant-old', status: 'succeeded', version: 3, seq: 3, createdAt: 100, updatedAt: 200,
    pending: [], ...overrides }
}
const next = run({ runId: 'new', turnId: 'turn-new', userMessageId: 'user-new', assistantMessageId: 'assistant-new', status: 'running', createdAt: 201, updatedAt: 201 })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
async function microtasks(): Promise<void> { for (let i = 0; i < 8; i++) await Promise.resolve() }

test('completed or cancelled selected sessions discover an independent newer root, including one already finished', () => {
  expect(idleRootChanged(scope.sessionId, run(), next)).toBe(true)
  expect(idleRootChanged(scope.sessionId, run({ status: 'cancelled' }), next)).toBe(true)
  expect(idleRootChanged(scope.sessionId, run(), { ...next, status: 'succeeded' })).toBe(true)
  expect(idleRootChanged(scope.sessionId, undefined, next)).toBe(true)
})

test('unchanged terminal roots never hydrate again and same-run running frames cannot revive them', async () => {
  const discovery = createIdleRootDiscovery(); let refreshed = 0, reads = 0
  for (let i = 0; i < 4; i++) await discovery.check(scope, { current: () => true, known: () => run(),
    read: async () => { reads++; return run({ version: 3 + i, status: i === 3 ? 'running' : 'succeeded' }) }, refresh: async () => { refreshed++ } })
  expect(reads).toBe(4); expect(refreshed).toBe(0)
})

test('waiting or detached running roots refresh only a newer version with the same exact turn/message identities', () => {
  const waiting = run({ status: 'waiting' })
  expect(idleRootChanged(scope.sessionId, waiting, { ...waiting, version: 4, status: 'running' })).toBe(true)
  expect(idleRootChanged(scope.sessionId, waiting, { ...waiting, version: 4, status: 'succeeded' })).toBe(true)
  expect(idleRootChanged(scope.sessionId, waiting, { ...waiting, version: 3 })).toBe(false)
  expect(idleRootChanged(scope.sessionId, waiting, { ...waiting, version: 4, userMessageId: 'other-user' })).toBe(false)
  expect(idleRootChanged(scope.sessionId, waiting, { ...waiting, version: 4, turnId: 'other-turn' })).toBe(false)
})

test('wrong session and older independent roots do not replace the selected owner', () => {
  expect(idleRootChanged(scope.sessionId, run(), { ...next, sessionId: 'work-b' })).toBe(false)
  expect(idleRootChanged(scope.sessionId, run(), { ...next, createdAt: 99 })).toBe(false)
  expect(idleRootChanged(scope.sessionId, run(), { ...next, createdAt: NaN })).toBe(false)
  expect(idleRootChanged(scope.sessionId, run({ sessionId: 'work-b' }), next)).toBe(false)
})

test('twenty concurrent ticks share one status read and one hydration; the hydration stays in flight', async () => {
  const discovery = createIdleRootDiscovery(), status = deferred<RootRun>(), hydrate = deferred<void>()
  let reads = 0, refreshed = 0
  const input = { current: () => true, known: () => run(), read: () => { reads++; return status.promise }, refresh: () => { refreshed++; return hydrate.promise } }
  const first = discovery.check(scope, input)
  for (let i = 0; i < 20; i++) expect(discovery.check({ ...scope }, input)).toBe(first)
  await microtasks(); expect(reads).toBe(1)
  status.resolve(next); await microtasks(); expect(refreshed).toBe(1)
  expect(discovery.check(scope, input)).toBe(first)
  hydrate.resolve(); await first
})

test('hidden modes or a live subscription suppress reads; a visibility change while reading suppresses hydration', async () => {
  const discovery = createIdleRootDiscovery(); let visible = false, reads = 0, refreshed = 0
  const status = deferred<RootRun>()
  const input = { current: () => visible, known: () => run(), read: () => { reads++; return status.promise }, refresh: async () => { refreshed++ } }
  await discovery.check(scope, input); expect(reads).toBe(0)
  visible = true; const result = discovery.check(scope, input); await microtasks(); expect(reads).toBe(1)
  visible = false; status.resolve(next); await result; expect(refreshed).toBe(0)
})

test('late source/session/ABA probes cannot refresh or clear the new generation single flight', async () => {
  const discovery = createIdleRootDiscovery(), old = deferred<RootRun>(), newest = deferred<RootRun>()
  let selected = scope, refreshed = 0, newReads = 0
  const oldResult = discovery.check(scope, { current: () => sameRecoveryScope(selected, scope), known: () => run(), read: () => old.promise, refresh: async () => { refreshed++ } })
  await microtasks(); selected = { ...scope, source: 2, viewEpoch: 3 }; discovery.clear()
  const newerScope = selected
  const newInput = { current: () => sameRecoveryScope(selected, newerScope), known: () => run(), read: () => { newReads++; return newest.promise }, refresh: async () => { refreshed++ } }
  const newResult = discovery.check(newerScope, newInput); await microtasks()
  old.resolve(next); await oldResult; expect(refreshed).toBe(0)
  expect(discovery.check(newerScope, newInput)).toBe(newResult); expect(newReads).toBe(1)
  newest.resolve(next); await newResult; expect(refreshed).toBe(1)
})
