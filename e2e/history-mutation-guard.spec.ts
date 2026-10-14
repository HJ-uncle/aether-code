/** Pure mutation/discovery races: destructive write + intended hydration, failures and stale view/source completions. No Electron/model. */
import { expect, test } from '@playwright/test'
import type { RootRun } from '../src/shared/root-run'
import { createRecoverySingleFlight, sameRecoveryScope, type RecoveryScope } from '../src/renderer/src/core/engine/chat-recovery-loop'
import { createHistoryMutationGuard } from '../src/renderer/src/core/engine/history-mutation'
import { createIdleRootDiscovery } from '../src/renderer/src/core/engine/idle-root-discovery'

const scope: RecoveryScope = { source: 1, sessionId: 'code-mutation', viewEpoch: 2 }
const next: RootRun = { schemaVersion: 1, runId: 'external', sessionId: scope.sessionId, turnId: 'turn-external',
  userMessageId: 'user-external', assistantMessageId: 'assistant-external', status: 'succeeded', version: 3,
  seq: 3, createdAt: 100, updatedAt: 200, pending: [] }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
async function microtasks(): Promise<void> { for (let i = 0; i < 8; i++) await Promise.resolve() }

test('a slow delete cannot admit a new status probe after invalidation or prefetch a stale shared snapshot', async () => {
  const guard = createHistoryMutationGuard(), discovery = createIdleRootDiscovery(), snapshots = createRecoverySingleFlight<string[]>()
  const write = deferred<void>(), hydrate = deferred<void>()
  let rows = ['retained', 'deleted'], displayed = [...rows], reads = 0, refreshes = 0, hydrations = 0
  const current = () => !guard.blocked(scope)
  const restore = () => snapshots.read(scope, async () => { hydrations++; const captured = [...rows]; await hydrate.promise; displayed = captured; return captured })
  const input = { current, known: () => undefined, read: async () => { reads++; return next }, refresh: async () => { refreshes++; await restore() } }
  // The actual hook invalidates old discovery and snapshot flights before beginning its new scope.
  discovery.clear(); snapshots.clear()
  const token = guard.begin(scope)
  const mutation = (async () => {
    try { await write.promise; rows = ['retained']; await restore() }
    finally { guard.release(token) }
  })()
  for (let tick = 0; tick < 20; tick++) await discovery.check(scope, input)
  expect(reads).toBe(0); expect(refreshes).toBe(0); expect(hydrations).toBe(0)
  write.resolve(); await microtasks()
  expect(hydrations).toBe(1); expect(guard.blocked(scope)).toBe(true)
  await discovery.check(scope, input); expect(reads).toBe(0)
  hydrate.resolve(); await mutation
  expect(displayed).toEqual(['retained']); expect(guard.blocked(scope)).toBe(false)
  await discovery.check(scope, input)
  expect(reads).toBe(1); expect(refreshes).toBe(1)
})

test('a pre-mutation probe arriving late cannot refresh through the newly invalidated view', async () => {
  const guard = createHistoryMutationGuard(), discovery = createIdleRootDiscovery(), status = deferred<RootRun>()
  const previous = { ...scope, viewEpoch: 1 }
  let selected = previous, refreshed = 0, reads = 0
  const oldResult = discovery.check(previous, { current: () => sameRecoveryScope(selected, previous) && !guard.blocked(previous),
    known: () => undefined, read: () => { reads++; return status.promise }, refresh: async () => { refreshed++ } })
  await microtasks(); expect(reads).toBe(1)
  selected = scope; discovery.clear(); const token = guard.begin(scope)
  status.resolve(next); await oldResult
  expect(refreshed).toBe(0); expect(guard.blocked(scope)).toBe(true)
  guard.release(token); expect(guard.blocked(scope)).toBe(false)
})

test('an old finally cannot unlock a newer mutation across session, source or ABA view changes', () => {
  const guard = createHistoryMutationGuard(), original = guard.begin(scope)
  expect(guard.blocked({ ...scope })).toBe(true)
  const work = { ...scope, sessionId: 'work-b', viewEpoch: 3 }
  expect(guard.blocked(work)).toBe(false)
  const changed = { ...scope, source: 2, viewEpoch: 4 }
  const newest = guard.begin(changed)
  guard.release(original)
  expect(guard.blocked(changed)).toBe(true); expect(guard.blocked(scope)).toBe(false)
  guard.release({ scope: { ...changed } })
  expect(guard.blocked(changed)).toBe(true)
  const aba = guard.begin({ ...scope, viewEpoch: 5 })
  guard.release(newest)
  expect(guard.blocked({ ...scope, viewEpoch: 5 })).toBe(true)
  guard.release(aba); expect(guard.blocked({ ...scope, viewEpoch: 5 })).toBe(false)
})

test('guard copies the scope so a caller cannot move an active mutation onto another view', () => {
  const guard = createHistoryMutationGuard(), supplied = { ...scope }
  const token = guard.begin(supplied)
  supplied.viewEpoch++
  expect(token.scope).toEqual(scope)
  expect(guard.blocked(scope)).toBe(true); expect(guard.blocked(supplied)).toBe(false)
  expect(Object.isFrozen(token)).toBe(true); expect(Object.isFrozen(token.scope)).toBe(true)
})

test('failure and early-return finally paths release passive discovery without sending or cancelling any task', async () => {
  const guard = createHistoryMutationGuard(), discovery = createIdleRootDiscovery()
  let reads = 0, refreshed = 0
  const input = { current: () => !guard.blocked(scope), known: () => undefined,
    read: async () => { reads++; return next }, refresh: async () => { refreshed++ } }
  for (const fail of [true, false]) {
    const token = guard.begin(scope)
    await (async () => {
      try { await discovery.check(scope, input); if (fail) throw new Error('synthetic write failed'); return }
      finally { guard.release(token) }
    })().catch(cause => { expect(String(cause)).toContain('synthetic write failed') })
    expect(guard.blocked(scope)).toBe(false)
  }
  expect(reads).toBe(0); expect(refreshed).toBe(0)
  await discovery.check(scope, input)
  expect(reads).toBe(1); expect(refreshed).toBe(1)
})

test('the intended truncate hydration and retry may run while only passive discovery is guarded', async () => {
  const guard = createHistoryMutationGuard(), snapshots = createRecoverySingleFlight<string[]>()
  const token = guard.begin(scope)
  let hydrations = 0, sends = 0, selected = scope
  try {
    const restored = await snapshots.read(scope, async () => { hydrations++; return ['retained'] })
    expect(restored).toEqual(['retained']); expect(guard.blocked(scope)).toBe(true)
    // retryFrom's intentional send advances the epoch and attaches its own SSE;
    // it must not be mistaken for user work and queue itself behind this guard.
    selected = { ...scope, viewEpoch: scope.viewEpoch + 1 }; sends++
    expect(guard.blocked(selected)).toBe(false)
  } finally { guard.release(token) }
  expect(hydrations).toBe(1); expect(sends).toBe(1); expect(guard.blocked(selected)).toBe(false)
})
