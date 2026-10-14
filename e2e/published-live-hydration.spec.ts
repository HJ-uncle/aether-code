/** Fixed-prefix rebases preserve accepted message edits; limits stop reading only. */
import { test, expect } from '@playwright/test'
import { createPublishedHydrationBuffer } from '../src/renderer/src/core/engine/published-hydration-buffer'
import { restoreChatSnapshot } from '../src/renderer/src/core/engine/chat-recovery'
import { restorePublishedProjection } from '../src/renderer/src/core/engine/published-child-recovery'
import type { PublishedChildUsage } from '../src/shared/published-child'
import type { ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'
test('queued rebase captures accepted updates once and does not consume later dispatches', () => {
  const buffer = createPublishedHydrationBuffer<string>({ current: () => true, exhausted: () => { throw Error('unexpected cap') } })
  buffer.record(value => value + '+first')
  const queued = buffer.rebase('full')
  buffer.record(value => value + '+second')
  expect(queued('preview+first')).toBe('full+first')
  expect(buffer.rebase('full')('preview+first+second')).toBe('full+first+second')
})
test('finish releases the ledger but lets its already queued final replacement commit', () => {
  const buffer = createPublishedHydrationBuffer<string>({ current: () => true, exhausted: () => {} })
  buffer.record(value => value + '+live')
  const final = buffer.rebase('full')
  buffer.finish()
  expect(final('preview+live')).toBe('full+live')
})
for (const cause of ['cancel', 'source'] as const) test(`queued replacement checks ${cause} at actual React commit time`, () => {
  let current = true
  const buffer = createPublishedHydrationBuffer<string>({ current: () => current, exhausted: () => {} })
  buffer.record(value => value + '+live')
  const queued = buffer.rebase('full')
  if (cause === 'cancel') buffer.cancel(); else current = false
  expect(queued('confirmed-live')).toBe('confirmed-live')
})
for (const budget of ['bytes', 'updates'] as const) test(`${budget} exhaustion stops only archive rebases and invokes the stop once`, () => {
  let stops = 0
  const buffer = createPublishedHydrationBuffer<string>({ current: () => true, exhausted: () => { stops++ }, maxBytes: budget === 'bytes' ? 300 : 8192, maxUpdates: 2 })
  buffer.record(value => value + 'one')
  const queued = buffer.rebase('full')
  if (budget === 'bytes') buffer.account('汉字😀'); else { buffer.record(value => value + 'two'); buffer.record(value => value + 'three') }
  buffer.account('still live'); buffer.record(value => value + 'still live')
  expect(stops).toBe(1)
  expect(queued('confirmed latest message')).toBe('confirmed latest message')
  expect(buffer.valid()).toBe(false)
})
test('fixed sparse frame positions and anonymous tool identity survive an inserted child page', () => {
  const fence = { tenantId: 'tenant', parentSessionId: 'session', rootSessionId: 'session', parentTurnId: 'turn', rootRunId: 'root',
    attemptId: 'attempt', streamId: 'stream', generation: 'generation', eventSequence: 7, revision: 4, usageRevision: 6 }
  const authority: PublishedChildUsage = { source: 'live-published', clientSource: 1, sessionId: 'session', snapshotId: 'lease', fence,
    revision: 'opaque', scalar: { totalTokens: 0, count: 0, unknown: 0 } }
  const run = { schemaVersion: 1 as const, runId: 'root', sessionId: 'session', turnId: 'turn', userMessageId: 'user', assistantMessageId: 'assistant',
    status: 'running' as const, version: 1, seq: 1, pending: [], createdAt: 123, updatedAt: 123 }
  const input: ChatRecoverySnapshot = { schemaVersion: 1, source: 'live', sessionId: 'session', eventId: 'stream:7', finished: false,
    projection: [{ toolStart: { name: 'anonymous' } }], projectionIndices: [12], history: [], todos: [], changes: [], run, runs: [run] }
  const positions: number[] = []
  const projection = restorePublishedProjection(input.projection, [12], 13, [], new Map(), authority, { positions })
  const first = restoreChatSnapshot({ ...input, projection, projectionIndices: positions }).messages[0].tools[0]
  const second = restoreChatSnapshot({ ...input, projection: [{ content: 'earlier recovered text' }, ...projection], projectionIndices: [2, ...positions] }).messages[0].tools[0]
  expect(first).toMatchObject({ id: 'recovered:root:12', startedAt: 123 })
  expect(second).toEqual(first)
  expect(positions).toEqual([12])
})
