/** Pure discovery contract: fixed boundaries, bounded identity fences and fair real request slots. */
import { expect, test } from '@playwright/test'
import type { SubagentDiscoveryPage, SubagentDiscoveryRef } from '../src/shared/subagent'
import { createSubagentDiscovery, reduceSubagentDiscovery, subagentDiscoveryRead, subagentDiscoveryBytes,
  acknowledgeSubagentDiscoveryRef, restartSubagentDiscovery, parseSubagentDiscoveryPage,
  type SubagentDiscoveryState } from '../src/renderer/src/core/engine/subagent-discovery'
import { executeSubagentObservationCycle, withSubagentReadPermit } from '../src/renderer/src/core/engine/subagent-refresh'

const scope = { source: 1, expectedEngine: { mode: 'embedded' as const, baseUrl: '', instanceId: 'synthetic' },
  parentSessionId: 'parent', localEpoch: 1 }
function ref(index: number, status: SubagentDiscoveryRef['status'] = 'running', revision = index, runSeq = 100): SubagentDiscoveryRef {
  return { tenantId: 'tenant', parentSessionId: 'parent', rootSessionId: 'root', parentConversationId: 'turn',
    parentMessageId: 'message', parentToolCallId: `dispatch-${index}`, runId: `run-${index}`,
    childSessionId: `child-${index}`, modelId: 'model', createdAt: 1000, createdRevision: index,
    revision, runSeq, status, deleted: false }
}
function page(mode: 'active' | 'changes', items: SubagentDiscoveryRef[], options: Partial<SubagentDiscoveryPage> = {}): SubagentDiscoveryPage {
  return { protocolVersion: 1, source: 'durable-lifecycle', generation: 'G1', scope: { tenantId: 'tenant', parentSessionId: 'parent' },
    mode, asOfRevision: 129, floorRevision: 0, activeCount: 129, items, includedCount: items.length,
    scannedCount: items.length, hasMore: false, nextCursor: null, membershipCompleteness: 'complete',
    ...(mode === 'changes' ? { nextRevision: 129 } : {}), ...options }
}
function apply(state: SubagentDiscoveryState, incoming: SubagentDiscoveryPage): SubagentDiscoveryState {
  const result = reduceSubagentDiscovery(state, subagentDiscoveryRead(state, incoming.mode), incoming, 1000)
  expect(result.status, result.reason).toBe('applied')
  return result.state
}

test('129 active references follow the fixed cursor and preserve authority apart from residency', () => {
  let state = createSubagentDiscovery(scope)
  state = apply(state, page('active', Array.from({ length: 64 }, (_, i) => ref(i + 1)),
    { hasMore: true, nextCursor: 'active-64', membershipCompleteness: 'partial' }))
  state = apply(state, page('changes', []))
  expect(subagentDiscoveryRead(state, 'active').cursor).toBe('active-64')
  state = apply(state, page('active', Array.from({ length: 64 }, (_, i) => ref(i + 65)),
    { hasMore: true, nextCursor: 'active-128', membershipCompleteness: 'partial' }))
  state = apply(state, page('active', [ref(129)]))
  expect(state.baseline?.complete).toBe(true)
  expect(state.activeCount).toBe(129)
  expect(state.refs.size).toBe(129)
  expect(state.residentPartial).toBe(true)
  expect(subagentDiscoveryBytes(state)).toBeLessThanOrEqual(256 * 1024)
})

test('changes cancelled before a late W page cannot revive that run or lower the authoritative count', () => {
  let state = apply(createSubagentDiscovery(scope), page('active', [ref(1)],
    { hasMore: true, nextCursor: 'active-tail', membershipCompleteness: 'partial' }))
  const late = subagentDiscoveryRead(state, 'active')
  state = apply(state, page('changes', [ref(75, 'cancelling', 130, 101), ref(75, 'cancelled', 131, 102)],
    { asOfRevision: 131, nextRevision: 131, activeCount: 128 }))
  state = acknowledgeSubagentDiscoveryRef(state, 'run-75', 131)
  expect(state.refs.get('run-75')?.hydrated).toBe(true)
  const result = reduceSubagentDiscovery(state, late, page('active', [ref(75)]), 1001)
  expect(result.status).toBe('applied')
  expect(result.state.refs.get('run-75')?.ref.status).not.toBe('running')
  expect(result.state.activeCount).toBe(128)
  expect(result.state.countRevision).toBe(131)
})

test('filtered empty changes advance their scanned revision without inventing contiguous included rows', () => {
  let state = apply(createSubagentDiscovery(scope), page('active', []))
  state = apply(state, page('changes', [], { asOfRevision: 300, nextRevision: 193,
    scannedCount: 64, hasMore: true, nextCursor: 'changes-193', membershipCompleteness: 'partial' }))
  expect(subagentDiscoveryRead(state, 'changes')).toMatchObject({ cursor: 'changes-193', afterRevision: 129 })
  state = apply(state, page('changes', [], { asOfRevision: 300, nextRevision: 300 }))
  expect(state.changes).toMatchObject({ key: 300, complete: true })
  expect(subagentDiscoveryRead(state, 'changes').afterRevision).toBe(300)
})

test('a short-lived unseen run retains its actual terminal identity, without usage or tool fabrication', () => {
  let state = apply(createSubagentDiscovery(scope), page('active', []))
  const run = ref(130, 'queued', 130, 1)
  state = apply(state, page('changes', [run, { ...run, revision: 131, runSeq: 2, status: 'running' },
    { ...run, revision: 132, runSeq: 3, status: 'succeeded' }], { asOfRevision: 132, nextRevision: 132 }))
  expect(state.refs.get('run-130')?.ref).toMatchObject({ status: 'succeeded', runSeq: 3, childSessionId: 'child-130' })
  expect(state.refs.get('run-130')?.ref).not.toHaveProperty('usage')
  expect(state.refs.get('run-130')?.ref).not.toHaveProperty('toolCalls')
})

test('scope, generation and old operation responses cannot mutate a replacement state', () => {
  let state = apply(createSubagentDiscovery(scope), page('active', [ref(1)],
    { hasMore: true, nextCursor: 'tail', membershipCompleteness: 'partial' }))
  const old = subagentDiscoveryRead(state)
  state = restartSubagentDiscovery(state, 'Synthetic fence reset')
  const result = reduceSubagentDiscovery(state, old, page('active', [ref(2)]), 2)
  expect(result.status).toBe('rejected')
  expect(result.state).toBe(state)
  const foreign = { ...subagentDiscoveryRead(state), scope: { ...scope, parentSessionId: 'other' } }
  expect(reduceSubagentDiscovery(state, foreign, page('active', []), 3).reason).toBe('stale-operation')
  const recovery = reduceSubagentDiscovery(state, subagentDiscoveryRead(state), page('active', [], { generation: 'G2' }), 4)
  expect(recovery.status).toBe('recovery')
  expect(recovery.state.generation).toBe('G2')
  expect(recovery.state.stale).toBe(true)
})

test('unknown refs are backpressured at capacity without advancing or silently dropping identity', () => {
  let state = createSubagentDiscovery(scope)
  for (let pageIndex = 0; pageIndex < 3; pageIndex++) state = apply(state, page('active',
    Array.from({ length: 64 }, (_, i) => ref(pageIndex * 64 + i + 1)), { asOfRevision: 1000, activeCount: 1000,
      hasMore: true, nextCursor: `cursor-${pageIndex}`, membershipCompleteness: 'partial' }))
  const input = subagentDiscoveryRead(state, 'active')
  const next = page('active', [ref(193)], { asOfRevision: 1000, activeCount: 1000, hasMore: true,
    nextCursor: 'cursor-3', membershipCompleteness: 'partial' })
  const rejected = reduceSubagentDiscovery(state, input, next, 1)
  expect(rejected.status).toBe('rejected')
  expect(rejected.state).toBe(state)
  expect(state.refs.size).toBe(192)
  state = acknowledgeSubagentDiscoveryRef(state, 'run-1', 1)
  const accepted = reduceSubagentDiscovery(state, subagentDiscoveryRead(state, 'active'), next, 2)
  expect(accepted.status).toBe('applied')
  expect(accepted.state.refs.has('run-193')).toBe(true)
  expect(accepted.state.refs.size).toBe(192)
})

test('fence eviction invalidates old W operations before a fresh baseline can admit them', () => {
  let state = apply(createSubagentDiscovery(scope), page('active', [ref(1)], { asOfRevision: 1, activeCount: 1,
    hasMore: true, nextCursor: 'held-tail', membershipCompleteness: 'partial' }))
  const old = subagentDiscoveryRead(state, 'active')
  state = acknowledgeSubagentDiscoveryRef(state, 'run-1', 1)
  state = apply(state, page('changes', Array.from({ length: 192 }, (_, i) => ref(i + 2, 'cancelled', i + 2, 102)),
    { asOfRevision: 1000, nextRevision: 193, activeCount: 0, hasMore: true, nextCursor: 'changes-193', membershipCompleteness: 'partial' }))
  for (let i = 2; i <= 193; i++) state = acknowledgeSubagentDiscoveryRef(state, `run-${i}`, i)
  const result = reduceSubagentDiscovery(state, subagentDiscoveryRead(state, 'changes'), page('changes', [ref(194, 'cancelled', 194, 102)],
    { asOfRevision: 1000, activeCount: 0, nextRevision: 194, hasMore: true, nextCursor: 'changes-194', membershipCompleteness: 'partial' }), 3)
  expect(result.status).toBe('recovery')
  expect(result.state.epoch).toBeGreaterThan(old.epoch)
  expect(result.state.baseline).toBeUndefined()
  expect(result.state.stale).toBe(true)
  expect(result.state.refs.size).toBe(0)
  expect(reduceSubagentDiscovery(result.state, old, page('active', [ref(75)], { asOfRevision: 1 }), 4).reason).toBe('stale-operation')
})

test('bad cursor, future revision and same-version identity conflicts preserve the old cursor', () => {
  const state = apply(createSubagentDiscovery(scope), page('active', [ref(1)],
    { hasMore: true, nextCursor: 'tail', membershipCompleteness: 'partial' }))
  for (const invalid of [page('active', [ref(2)], { hasMore: true, nextCursor: 'tail', membershipCompleteness: 'partial' }),
    page('active', [ref(2)], { asOfRevision: 130 }), page('active', [{ ...ref(2), revision: 130 }])]) {
    const result = reduceSubagentDiscovery(state, subagentDiscoveryRead(state, 'active'), invalid, 1)
    expect(result.status).toBe('rejected')
    expect(result.state).toBe(state)
  }
  const duplicate = page('changes', [{ ...ref(1), childSessionId: 'wrong', revision: 130 }], { asOfRevision: 130, nextRevision: 130 })
  expect(reduceSubagentDiscovery(state, subagentDiscoveryRead(state, 'changes'), duplicate, 1).reason).toBe('identity-or-version-conflict')
})

test('oversized UTF-8 metadata and malformed controls are rejected rather than clipped', () => {
  const huge = page('active', Array.from({ length: 64 }, (_, i) => ({ ...ref(i + 1), agentName: '字'.repeat(4096) })))
  expect(() => parseSubagentDiscoveryPage(huge)).toThrow('响应预算')
  expect(() => parseSubagentDiscoveryPage(page('active', [{ ...ref(1), runId: 'x'.repeat(1025) }]))).toThrow('摘要支持范围')
  expect(() => parseSubagentDiscoveryPage({ ...page('active', []), includedCount: 1 })).toThrow('协议无效')
  expect(() => parseSubagentDiscoveryPage(page('changes', [], { asOfRevision: 129, nextRevision: 130 }))).toThrow('协议无效')
})

test('terminal revival, contradictory same sequence and an item past nextRevision reject the whole page', () => {
  let state = apply(createSubagentDiscovery(scope), page('active', [ref(1)],
    { hasMore: true, nextCursor: 'tail', membershipCompleteness: 'partial' }))
  state = apply(state, page('changes', [ref(75, 'succeeded', 130, 102)],
    { asOfRevision: 130, nextRevision: 130, activeCount: 0 }))
  const input = subagentDiscoveryRead(state, 'changes')
  for (const invalid of [
    page('changes', [ref(75, 'running', 131, 103)], { asOfRevision: 131, nextRevision: 131 }),
    page('changes', [ref(75, 'failed', 131, 102)], { asOfRevision: 131, nextRevision: 131 }),
    page('changes', [ref(76, 'running', 132)], { asOfRevision: 132, nextRevision: 131,
      hasMore: true, nextCursor: 'wrong-watermark', membershipCompleteness: 'partial' })
  ]) {
    const result = reduceSubagentDiscovery(state, input, invalid, 2)
    expect(result.status).toBe('rejected')
    expect(result.state).toBe(state)
    expect(result.state.refs.get('run-75')?.ref).toMatchObject({ status: 'succeeded', runSeq: 102 })
  }
})

test('a held discovery cannot consume the selected and known opportunities with a second discovery', async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const started: string[] = []
  let inFlight = 0, maximum = 0
  const cycle = executeSubagentObservationCycle({ current: () => true,
    candidates: () => ({ selectedRunId: 'selected', knownIds: ['known-1', 'known-2'], pendingIds: ['new-1'], modes: ['active', 'changes'] }),
    read: job => withSubagentReadPermit(async () => {
      inFlight++; maximum = Math.max(maximum, inFlight)
      const id = job.kind === 'discovery' ? job.mode : job.runId
      started.push(id)
      try { if (id === 'active') await held }
      finally { inFlight-- }
    })
  })
  await expect.poll(() => started.includes('known-1')).toBe(true)
  expect(started.slice(0, 3)).toEqual(['active', 'selected', 'known-1'])
  expect(started.indexOf('changes')).toBeGreaterThan(started.indexOf('known-1'))
  release()
  const issued = await cycle
  expect(issued.length).toBeLessThanOrEqual(7)
  expect(started).toContain('new-1')
  expect(maximum).toBe(2)
  expect(inFlight).toBe(0)
})
