/** Fixed prefix, partial hydration, authoritative scalar and source races. No Electron or provider. */
import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import type { PublishedChildUsage, PublishedChildReference, PublishedChildIdentity, PublishedChildFence } from '../src/shared/published-child'
import type { RootRun } from '../src/shared/root-run'
import type { ChatMessage, ToolActivity } from '../src/renderer/src/core/engine/useChat'
import type { SubagentRun } from '../src/shared/subagent'
import { advancePublishedChild, normalizePublishedChildReference, parsePublishedProjectionPage, parsePublishedUsage,
  replacePublishedUsage, restorePublishedProjection } from '../src/renderer/src/core/engine/published-child-recovery'
import { createPublishedUsageRefresh, publishedUsageOwner } from '../src/renderer/src/core/engine/published-usage-refresh'
import { createSessionUsageAnchor, sessionUsageTotal } from '../src/renderer/src/contrib/chat/session-usage'
import { attachSubagentRuns } from '../src/renderer/src/core/engine/subagent-state'
import { workSubagentTools, workSubagentGroups } from '../src/renderer/src/contrib/work/work-subagents'
import { restoreChatSnapshot, type ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'
import { durableCancelBody, snapshotRecoveryOutcome } from '../src/renderer/src/core/engine/chat-recovery-loop'
import { preparePublishedSnapshot } from '../src/renderer/src/core/engine/published-snapshot-client'
import { getSubagentCapabilities } from '../src/renderer/src/core/engine/client'
import { getEngineSource, publishEngineSource } from '../src/renderer/src/core/engine/source'
import { createPublishedRecoveryControl } from '../src/renderer/src/core/engine/published-recovery-control'
import { writeFileSync } from 'node:fs'
import { publishedDetailKey, publishedVisibleWindow, rememberPublishedDetail } from '../src/renderer/src/core/engine/published-card-memory'

function fence(patch: Partial<PublishedChildFence> = {}): PublishedChildFence { return {
  tenantId: 'tenant', parentSessionId: 'session', rootSessionId: 'session', parentTurnId: 'turn', rootRunId: 'root',
  attemptId: 'attempt', streamId: 'stream', generation: 'generation', eventSequence: 7, revision: 4, usageRevision: 6, ...patch }
}
function identity(runId = 'child'): PublishedChildIdentity { return { tenantId: 'tenant', runId, parentSessionId: 'session',
  rootSessionId: 'session', parentConversationId: 'turn', parentMessageId: 'assistant', parentToolCallId: 'tool-' + runId,
  childSessionId: 'session-' + runId, createdAt: 1, modelId: 'model', agentName: '审查 Agent' } }
function authority(patch: Partial<PublishedChildUsage> = {}): PublishedChildUsage { return { source: 'live-published', clientSource: 1,
  sessionId: 'session', snapshotId: 'lease', fence: fence(), revision: 'opaque-z', scalar: { totalTokens: 75, count: 80, unknown: 2 }, ...patch } }
function ref(patch: Partial<PublishedChildReference> = {}): PublishedChildReference { return { protocolVersion: 1, source: 1,
  sessionId: 'session', snapshotId: 'lease', fence: fence(), identity: identity(), atSeq: 4, projectionIndex: 2, ...patch } }
function child(runId = 'child', patch: Partial<Extract<SubagentRun, { schemaVersion: 1 }>> = {}): SubagentRun { return { ...identity(runId), schemaVersion: 1,
  task: 'review', description: 'review', status: 'running', lastSeq: 4, updatedAt: 1, toolCalls: [], usage: { totalTokens: 80 }, ...patch } }
function root(patch: Partial<RootRun> = {}): RootRun { return { schemaVersion: 1, runId: 'root', sessionId: 'session', turnId: 'turn',
  userMessageId: 'user', assistantMessageId: 'assistant', status: 'running', version: 1, seq: 1, pending: [], createdAt: 1, updatedAt: 1, ...patch } }
function tool(reference = ref()): ToolActivity { return { id: reference.identity.parentToolCallId, name: 'subagent', state: 'unknown', args: '', result: '', subagentRef: reference } }
function message(tools: ToolActivity[] = [tool()]): ChatMessage { return { id: 'assistant', role: 'assistant', content: '', thinking: '',
  status: 'streaming', createdAt: 1, runId: 'root', conversationId: 'turn', items: tools.map(t => ({ kind: 'tool', id: t.id })), tools,
  publishedChildFence: fence() } }
function snapshot(patch: Partial<ChatRecoverySnapshot> = {}): ChatRecoverySnapshot { return { schemaVersion: 1, source: 'live', sessionId: 'session',
  eventId: 'stream:7', finished: false, run: root(), runs: [root()], history: [], todos: [], changes: [], projection: [{ content: 'prefix' }],
  projectionIndices: [0], subagentProjectionArchive: { protocolVersion: 1, snapshotId: 'lease', totalCount: 1,
    originalProjectionCount: 2, endpoint: '/chat/snapshot/projection' },
  subagentRecovery: wire(authority()), ...patch } }
function wire(value: PublishedChildUsage): unknown { return { protocolVersion: 1, source: value.source, snapshotId: value.snapshotId,
  fence: value.fence, usage: { source: 'authoritative-scalar', revision: value.revision, ...value.scalar } } }
function page(auth = authority()): unknown { return { protocolVersion: 1, snapshotId: auth.snapshotId, fence: auth.fence,
  totalCount: 1, originalProjectionCount: 2, hasMore: false, nextCursor: null,
  entries: [{ projectionIndex: 1, field: 'subagentEvent', runId: 'child', atSeq: 5, sourceAtSeq: 4 }] } }
function bridge(reader: (input: { path: string; query?: Record<string, unknown> }) => Promise<unknown>): void {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { aether: { engine: { request: async (input: { path: string; query?: Record<string, unknown> }) =>
    ({ ok: true, code: 200, data: await reader(input) }) } } } })
}
function ready(): number { publishEngineSource({ mode: 'embedded', baseUrl: '', instanceId: crypto.randomUUID(), phase: 'ready' }); return getEngineSource() }
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

for (const resident of [1, 16, 64]) test(`authority 75/80 ignores ${resident} resident details and later hydration`, () => {
  const auth = authority(), initial = [message(Array.from({ length: resident }, (_, index) => ({ ...tool(ref({ identity: identity(String(index)) })), subagent: child(String(index)) }))) ]
  const anchor = createSessionUsageAnchor(initial, { totalTokens: 12 }, undefined, [], auth)
  expect(sessionUsageTotal(initial, anchor)).toMatchObject({ total: 87, subagentTotal: 75, unknownSubagents: 2 })
  const hydrated = [message(Array.from({ length: 80 }, (_, index) => ({ ...tool(ref({ identity: identity(String(index)) })), subagent: child(String(index), { usage: { totalTokens: 500 } }) }))) ]
  expect(sessionUsageTotal(hydrated, anchor)).toMatchObject({ total: 87, subagentTotal: 75, unknownSubagents: 2 })
  expect(anchor?.alignedChildren).toBeUndefined()
})
test('opaque revisions accept same-owner newer fence, reject stale and same revision conflict', () => {
  const before = authority(), after = authority({ revision: 'opaque-a', fence: fence({ eventSequence: 8, revision: 5, usageRevision: 7 }), scalar: { totalTokens: 80, count: 80, unknown: 0, finishedAt: 100 } })
  expect(replacePublishedUsage(before, after, { source: 1, sessionId: 'session', fullRestore: false })).toEqual(after)
  expect(() => replacePublishedUsage(after, before, { source: 1, sessionId: 'session', fullRestore: false })).toThrow('stale_usage')
  expect(() => replacePublishedUsage(before, authority({ scalar: { totalTokens: 76, count: 80, unknown: 2 } }), { source: 1, sessionId: 'session', fullRestore: false })).toThrow('same_revision_conflict')
})
test('owner changes require explicit full restore, source/session mismatches never sneak in', () => {
  const other = authority({ fence: fence({ attemptId: 'next' }) })
  expect(() => replacePublishedUsage(authority(), other, { source: 1, sessionId: 'session', fullRestore: false })).toThrow('owner_changed')
  expect(replacePublishedUsage(authority(), other, { source: 1, sessionId: 'session', fullRestore: true })).toEqual(other)
  expect(() => parsePublishedUsage(wire(authority()), 1, 'other')).toThrow('foreign_session')
})
test('unknown and finishedAt change only through authoritative refresh', () => {
  const before = authority(), anchored = createSessionUsageAnchor([message()], { totalTokens: 12 }, undefined, [], before)
  const after = { ...anchored!, publishedChildren: authority({ revision: 'after', scalar: { totalTokens: 80, count: 80, unknown: 0, finishedAt: 123 } }) }
  expect(sessionUsageTotal([message()], after)).toMatchObject({ total: 92, unknownSubagents: 0, endedAt: 123 })
})
test('sparse projection restores sourceAtSeq and keeps records unloaded', () => {
  const auth = authority(), entries = parsePublishedProjectionPage(page(), auth, 2).entries
  const frames = restorePublishedProjection([{ content: 'first' }], [0], 2, entries, new Map([['child', { identity: identity(), atSeq: 5 }]]), auth)
  expect(frames.map(frame => frame.content ?? frame.publishedChild?.atSeq)).toEqual(['first', 4])
  expect(frames[1].subagentEvent).toBeUndefined()
  expect(normalizePublishedChildReference(frames[1].publishedChild)?.identity).toEqual(identity())
})
test('duplicate refs, missing original slot and foreign fence fail explicitly', () => {
  const entries = parsePublishedProjectionPage(page(), authority(), 2).entries, identities = new Map([['child', { identity: identity(), atSeq: 5 }]])
  expect(() => restorePublishedProjection([], [], 2, [...entries, ...entries], identities, authority())).toThrow('duplicate_projection_ref')
  expect(() => restorePublishedProjection([], [], 2, [{ ...entries[0], field: 'toolResult', nested: 'subagent' }], identities, authority())).toThrow('missing_original_tool_slot')
  expect(() => parsePublishedProjectionPage(page(authority({ fence: fence({ generation: 'other' }) })), authority(), 2)).toThrow('invalid_projection_page')
})
test('latest mutable cache cannot overwrite fixed card or Work activity', () => {
  const old = message(), latest = child('child', { lastSeq: 50, status: 'succeeded' })
  expect(attachSubagentRuns([old], [latest])).toEqual([old])
  const work = workSubagentTools('session', old.tools, [latest])
  expect(work).toHaveLength(1); expect(work[0].subagent).toBeUndefined(); expect(work[0].subagentRef?.atSeq).toBe(4)
  expect(workSubagentGroups('session', old.tools, [latest])[0]).toMatchObject({ label: '审查 Agent', modelId: 'model', childSessionId: 'session-child', active: false })
})
test('verified SSE continuation releases matching card and continues, old/foreign events do not', () => {
  const initial = [message()], first = child('child', { lastSeq: 5 })
  for (const scope of [{ source: 2, sessionId: 'session', eventId: 'stream:8' }, { source: 1, sessionId: 'session', eventId: 'other:8' }, { source: 1, sessionId: 'session', eventId: 'stream:7' }])
    expect(advancePublishedChild(initial, first, scope)).toBe(initial)
  const next = advancePublishedChild(initial, first, { source: 1, sessionId: 'session', eventId: 'stream:8' })
  expect(next[0].tools[0].subagentRef).toBeUndefined(); expect(next[0].tools[0].subagent?.lastSeq).toBe(5)
  const finished = advancePublishedChild(next, child('child', { lastSeq: 6, status: 'succeeded' }), { source: 1, sessionId: 'session', eventId: 'stream:9' })
  expect(finished[0].tools[0].state).toBe('done')
})
test('repeated child evidence becomes one dispatch card with latest exact position', () => {
  const restored = restoreChatSnapshot(snapshot({ projection: [{ content: 'prefix' }, { publishedChild: ref() }, { publishedChild: ref({ atSeq: 5, projectionIndex: 3 }) }], publishedUsage: authority() }))
  expect(restored.messages[0].tools).toHaveLength(1)
  expect(restored.messages[0].tools[0].subagentRef?.atSeq).toBe(5)
})
test('durable terminal execution stops old prefix running spinner and cancels only current execution', () => {
  const saved = snapshot({ source: 'persisted-published', executionRun: root({ status: 'succeeded', finishedAt: 4 }), finished: true })
  expect(snapshotRecoveryOutcome(saved)).toBe('idle')
  expect(durableCancelBody('session', saved.executionRun ?? saved.run)).toBeNull()
  expect(restoreChatSnapshot(saved).messages[0].status).toBe('done')
})
test('usage refresh is single flight through terminal request and preserves confirmed authority', async () => {
  let resolve!: (usage: PublishedChildUsage) => void, current = authority(), reads = 0, time = 0, active = 0, maximum = 0
  const scope = { source: 1, sessionId: 'session', viewEpoch: 1, historyEpoch: 1, owner: publishedUsageOwner(current) }
  const refresher = createPublishedUsageRefresh({ current: () => true, authority: () => current, now: () => time,
    read: () => { reads++; active++; maximum = Math.max(maximum, active); return new Promise<PublishedChildUsage>(done => { resolve = value => { active--; done(value) } }) },
    accept: (_scope, value) => { current = value }, pending: () => {}, ownerChanged: () => {} })
  const first = refresher.request(scope); await tick()
  time = 60_000; for (let i = 0; i < 10; i++) void refresher.request(scope, true)
  expect(reads).toBe(1)
  resolve(authority({ revision: 'next', scalar: { totalTokens: 80, count: 80, unknown: 0 } })); await first; await tick()
  expect(reads).toBe(2); expect(maximum).toBe(1); expect(current.scalar.totalTokens).toBe(80)
  resolve(current); await tick()
})
test('stale source and failed usage refresh retain confirmed scalar and report pending', async () => {
  let scopeCurrent = true, current = authority(), notices: Array<string | null> = [], reads = 0, time = 0
  const scope = { source: 1, sessionId: 'session', viewEpoch: 1, historyEpoch: 1, owner: publishedUsageOwner(current) }
  const refresher = createPublishedUsageRefresh({ current: () => scopeCurrent, authority: () => current, now: () => time,
    read: async () => { reads++; throw new Error('offline') }, accept: (_scope, value) => { current = value }, pending: (_scope, value) => { notices.push(value) }, ownerChanged: () => {} })
  await refresher.request(scope)
  expect(current.scalar.totalTokens).toBe(75); expect(notices).toEqual(['用量统计待同步；当前显示上次确认的数值'])
  time = 1000; await refresher.request(scope); expect(reads).toBe(1)
  time = 5000; await refresher.request(scope); expect(reads).toBe(2)
  scopeCurrent = false; await refresher.request(scope, true); expect(reads).toBe(2)
})
test('old in-flight response cannot clear or overwrite a new history owner', async () => {
  let done!: (value: PublishedChildUsage) => void, current = authority(), accepted = 0
  const scope = { source: 1, sessionId: 'session', viewEpoch: 1, historyEpoch: 1, owner: publishedUsageOwner(current) }
  const refresher = createPublishedUsageRefresh({ current: () => true, authority: () => current,
    read: () => new Promise(resolve => { done = resolve }), accept: (_scope, value) => { accepted++; current = value }, pending: () => {}, ownerChanged: () => {} })
  const operation = refresher.request(scope); await tick(); refresher.clear(); current = authority({ fence: fence({ attemptId: 'next' }) })
  done(authority({ revision: 'old-late', scalar: { totalTokens: 900, count: 90, unknown: 0 } })); await operation
  expect(accepted).toBe(0); expect(current.scalar.totalTokens).toBe(75)
})
test('mock IPC preparation reads only fixed token projection and lookup, never inventory', async () => {
  const source = ready(), auth = authority({ clientSource: source }), requests: Array<{ path: string; query?: Record<string, unknown> }> = []
  bridge(async input => { requests.push(input); return input.path.endsWith('/projection') ? page(auth) : { snapshotId: 'lease', fence: auth.fence, item: { identity: identity(), atSeq: 5 } } })
  const restored = await preparePublishedSnapshot(snapshot({ subagentRecovery: wire(auth) }), source, () => {})
  expect(restored.projection[1].publishedChild?.atSeq).toBe(4)
  expect(requests.map(item => item.path)).toEqual(['/chat/snapshot/projection', '/chat/snapshot/children/child'])
  expect(requests.every(item => item.query?.snapshotId === 'lease' && item.query.childRecoveryProtocol === 1)).toBe(true)
})
test('mock IPC repeated cursor and source switch stop preparation instead of latest fallback', async () => {
  const source = ready(), auth = authority({ clientSource: source }); let count = 0
  bridge(async input => { if (!input.path.endsWith('/projection')) return { snapshotId: 'lease', fence: auth.fence, item: { identity: identity(), atSeq: 5 } }
    count++; if (count === 1) return { ...(page(auth) as Record<string, unknown>), hasMore: true, nextCursor: 'same', totalCount: 2 }
    return { ...(page(auth) as Record<string, unknown>), entries: [{ projectionIndex: 0, field: 'subagentEvent', runId: 'child', atSeq: 5 }], hasMore: true, nextCursor: 'same', totalCount: 2 } })
  await expect(preparePublishedSnapshot(snapshot({ subagentRecovery: wire(auth), subagentProjectionArchive: { ...snapshot().subagentProjectionArchive!, totalCount: 2 } }), source, () => {})).rejects.toThrow('repeated_projection_cursor')
  count = 0; bridge(async () => { count++; ready(); return page(auth) })
  await expect(preparePublishedSnapshot(snapshot({ subagentRecovery: wire(auth) }), source, () => {})).rejects.toThrow('引擎连接已变化')
  expect(count).toBe(1)
})
for (const corrupt of ['none', 'chunk-hash', 'whole-hash', 'positions', 'size'] as const) test(`body archive ${corrupt} is fully verified before restoring exact Unicode content`, async () => {
  const source = ready(), auth = authority({ clientSource: source })
  const encoded = JSON.stringify({ streamId: 'stream', eventId: 'stream:7', projection: [{ content: '汉字😀'.repeat(25) }], projectionIndices: corrupt === 'positions' ? [10] : [0] })
  const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
  const body = { protocolVersion: 1 as const, source: 'sealed-current-turn' as const, endpoint: '/chat/snapshot/body' as const,
    sha256: corrupt === 'whole-hash' ? '0'.repeat(64) : sha256(encoded), byteLength: Buffer.byteLength(encoded) + (corrupt === 'size' ? 1 : 0),
    chunkCount: 1, originalProjectionCount: 1, originalCurrentTurnComplete: true, previewComplete: false as const }
  const raw = snapshot({ projection: [{ content: 'preview' }], projectionIndices: [0], bodyArchive: body, subagentRecovery: wire(auth),
    subagentProjectionArchive: { protocolVersion: 1, snapshotId: 'lease', totalCount: 0, originalProjectionCount: 1, endpoint: '/chat/snapshot/projection' } })
  bridge(async input => input.path.endsWith('/body') ? { protocolVersion: 1, snapshotId: 'lease', fence: auth.fence, part: 0,
    nextPart: null, archive: body, chunk: encoded, chunkDigest: corrupt === 'chunk-hash' ? '0'.repeat(64) : sha256(encoded) }
    : { protocolVersion: 1, snapshotId: 'lease', fence: auth.fence, totalCount: 0, originalProjectionCount: 1, entries: [], nextCursor: null, hasMore: false })
  if (corrupt === 'none') {
    const restored = await preparePublishedSnapshot(raw, source, () => {})
    expect(restored.projection[0].content).toBe('汉字😀'.repeat(25)); expect(restored.currentTurnComplete).toBe(true)
  } else await expect(preparePublishedSnapshot(raw, source, () => {})).rejects.toThrow(corrupt === 'positions' ? 'invalid_projection_position' : 'body_archive_corrupt')
})
for (const flags of [undefined, false, 0, 1]) test(`legacy capability flag ${flags} only enables exact numeric all-three advertisement`, async () => {
  ready(); bridge(async () => ({ schemaVersion: 2, eventVersions: [2], views: ['summary'], toolPagination: true,
    eventPagination: true, detailChunks: true, exactWatermarks: true, boundedSnapshotChildren: flags,
    publishedChildRecovery: flags, authoritativeChildUsage: flags }))
  expect((await getSubagentCapabilities()).childRecovery).toBe(flags === 1)
})
test('invalid advertised capability and auth failure do not silently fall back', async () => {
  ready(); bridge(async () => ({ schemaVersion: 2, eventVersions: [2], views: ['summary'], toolPagination: true,
    eventPagination: true, detailChunks: true, exactWatermarks: true, boundedSnapshotChildren: true }))
  await expect(getSubagentCapabilities()).rejects.toThrow('恢复能力协议无效')
  ready(); Object.defineProperty(globalThis, 'window', { configurable: true, value: { aether: { engine: { request: async () => ({ ok: false, code: 401, message: 'expired' }) } } } })
  await expect(getSubagentCapabilities()).rejects.toThrow('expired')
})
for (const unique of [80, 4096]) test(`4096 fixed references with ${unique} child identities restore progressively with finite read concurrency`, async ({}, testInfo) => {
  const source = ready(), auth = authority({ clientSource: source }), totalCount = 4096, counts: number[] = [], visibleCounts: number[] = []
  let calls = 0, active = 0, maximum = 0
  const started = performance.now(), cpu = process.cpuUsage(), rss = process.memoryUsage().rss
  bridge(async input => {
    calls++; active++; maximum = Math.max(maximum, active)
    await tick(); active--
    expect(input.query?.snapshotId).toBe('lease')
    if (input.path.endsWith('/projection')) {
      const offset = input.query?.cursor ? Number(String(input.query.cursor).slice(1)) : 0
      return { protocolVersion: 1, snapshotId: 'lease', fence: auth.fence, totalCount, originalProjectionCount: totalCount + 1,
        entries: Array.from({ length: 64 }, (_, index) => ({ projectionIndex: offset + index + 1, field: 'subagentEvent',
          runId: String((offset + index) % unique), atSeq: 5, sourceAtSeq: 4 })),
        hasMore: offset + 64 < totalCount, nextCursor: offset + 64 < totalCount ? 'c' + (offset + 64) : null }
    }
    return { snapshotId: 'lease', fence: auth.fence, item: { identity: identity(input.path.split('/').at(-1)), atSeq: 5 } }
  })
  const restored = await preparePublishedSnapshot(snapshot({ subagentRecovery: wire(auth), subagentProjectionArchive: {
    protocolVersion: 1, snapshotId: 'lease', totalCount, originalProjectionCount: totalCount + 1, endpoint: '/chat/snapshot/projection' } }), source, () => {}, {
    progress: (preview, state) => { counts.push(state.loadedReferences); visibleCounts.push(restoreChatSnapshot(preview).messages[0].tools.length) }
  })
  expect(maximum).toBeLessThanOrEqual(4); expect(calls).toBe(64 + unique)
  expect(counts.slice(0, 2)).toEqual([0, 64]); expect(visibleCounts[1]).toBe(64)
  expect(restored.projection).toHaveLength(4097); expect(restoreChatSnapshot(restored).messages[0].tools).toHaveLength(unique)
  const used = process.cpuUsage(cpu)
  writeFileSync(testInfo.outputPath(`client-4096-${unique}-performance.json`), JSON.stringify({ at: new Date().toISOString(), references: totalCount, identities: unique,
    calls, maximumConcurrency: maximum, wallMs: performance.now() - started, cpuMs: (used.user + used.system) / 1000,
    rssBefore: rss, rssAfter: process.memoryUsage().rss, scope: 'mock IPC source contracts; no backend or renderer claim' }, null, 2))
})
test('cancelling after first reference page reads no later cursor and never posts executor cancellation', async () => {
  const source = ready(), auth = authority({ clientSource: source }), control = createPublishedRecoveryControl(), requests: string[] = []
  bridge(async input => { requests.push(input.path); return input.path.endsWith('/projection') ? { ...(page(auth) as Record<string, unknown>),
    totalCount: 2, hasMore: true, nextCursor: 'later' } : { snapshotId: 'lease', fence: auth.fence, item: { identity: identity(), atSeq: 5 } } })
  await expect(preparePublishedSnapshot(snapshot({ subagentRecovery: wire(auth), subagentProjectionArchive: { ...snapshot().subagentProjectionArchive!, totalCount: 2 } }), source, () => {}, {
    signal: control.signal, progress: (_preview, state) => { if (state.loadedReferences === 1) control.cancel() }
  })).rejects.toThrow('已暂停记录恢复')
  expect(requests).toEqual(['/chat/snapshot/projection', '/chat/snapshot/children/child'])
})
test('large body reads stay behind explicit open and are cancellable while retaining preview', async () => {
  const source = ready(), auth = authority({ clientSource: source }), control = createPublishedRecoveryControl(), requests: string[] = []
  const encoded = JSON.stringify({ streamId: 'stream', eventId: 'stream:7', projection: [{ content: 'full body' }], projectionIndices: [0] })
  const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
  const body = { protocolVersion: 1 as const, source: 'sealed-current-turn' as const, endpoint: '/chat/snapshot/body' as const, sha256: sha(encoded),
    byteLength: Buffer.byteLength(encoded), chunkCount: 1, originalProjectionCount: 1, originalCurrentTurnComplete: true, previewComplete: false as const }
  bridge(async input => { requests.push(input.path); return input.path.endsWith('/body') ? { protocolVersion: 1, snapshotId: 'lease', fence: auth.fence,
    part: 0, nextPart: null, archive: body, chunk: encoded, chunkDigest: sha(encoded) } : { protocolVersion: 1, snapshotId: 'lease', fence: auth.fence,
      totalCount: 0, originalProjectionCount: 1, entries: [], nextCursor: null, hasMore: false } })
  let bodyReady!: () => void; const shown = new Promise<void>(resolve => { bodyReady = resolve })
  const operation = preparePublishedSnapshot(snapshot({ subagentRecovery: wire(auth), bodyArchive: body,
    subagentProjectionArchive: { protocolVersion: 1, snapshotId: 'lease', totalCount: 0, originalProjectionCount: 1, endpoint: '/chat/snapshot/projection' } }), source, () => {}, {
    signal: control.signal, waitForBody: control.waitForBody, progress: (preview, state) => {
      if (state.phase === 'body-ready') { expect(preview.projection[0].content).toBe('prefix'); expect(preview.currentTurnComplete).toBe(false); bodyReady() }
    }
  })
  await shown; await tick(); expect(requests).toEqual(['/chat/snapshot/projection'])
  control.requestBody(); const full = await operation
  expect(full.projection[0].content).toBe('full body'); expect(requests).toEqual(['/chat/snapshot/projection', '/chat/snapshot/body'])
  const paused = createPublishedRecoveryControl(), waiting = paused.waitForBody(); paused.cancel(); await expect(waiting).rejects.toThrow('已暂停记录恢复')
})

test('late next page cannot publish across a view epoch or conflict with the fixed total', async () => {
  const source = ready(), auth = authority({ clientSource: source }); let current = true, pages = 0, emitted = 0
  bridge(async input => {
    if (!input.path.endsWith('/projection')) return { snapshotId: 'lease', fence: auth.fence, item: { identity: identity(), atSeq: 5 } }
    pages++
    if (pages === 2) { current = false; return { ...(page(auth) as Record<string, unknown>), entries: [], totalCount: 2 } }
    return { ...(page(auth) as Record<string, unknown>), totalCount: 2, hasMore: true, nextCursor: 'second' }
  })
  const input = snapshot({ subagentRecovery: wire(auth), subagentProjectionArchive: { ...snapshot().subagentProjectionArchive!, totalCount: 2 } })
  await expect(preparePublishedSnapshot(input, source, () => { if (!current) throw Error('view epoch changed') }, {
    progress: () => { emitted++ }
  })).rejects.toThrow('view epoch changed')
  expect(pages).toBe(2); expect(emitted).toBe(2)
  bridge(async () => ({ ...(page(auth) as Record<string, unknown>), totalCount: 3 }))
  await expect(preparePublishedSnapshot(input, source, () => {})).rejects.toThrow('projection_count_conflict')
})

test('archived outer tool slot stays a thin preview then restores only its exact original body', async () => {
  const source = ready(), auth = authority({ clientSource: source }), control = createPublishedRecoveryControl()
  const encoded = JSON.stringify({ streamId: 'stream', eventId: 'stream:7', projection: [{ content: 'full' },
    { toolResult: { id: 'tool-child', name: 'subagent', result: 'exact original' } }], projectionIndices: [0, 1] })
  const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
  const body = { protocolVersion: 1 as const, source: 'sealed-current-turn' as const, endpoint: '/chat/snapshot/body' as const,
    sha256: sha(encoded), byteLength: Buffer.byteLength(encoded), chunkCount: 1, originalProjectionCount: 2,
    originalCurrentTurnComplete: false, previewComplete: false as const }
  const phases: string[] = []
  bridge(async input => input.path.endsWith('/projection') ? { ...(page(auth) as Record<string, unknown>),
    entries: [{ projectionIndex: 1, field: 'toolResult', nestedLocations: ['metadata.subagent'], runId: 'child', atSeq: 5, sourceAtSeq: 4 }] }
    : input.path.endsWith('/body') ? { protocolVersion: 1, snapshotId: 'lease', fence: auth.fence, part: 0, nextPart: null,
      archive: body, chunk: encoded, chunkDigest: sha(encoded) }
      : { snapshotId: 'lease', fence: auth.fence, item: { identity: identity(), atSeq: 5 } })
  const restored = await preparePublishedSnapshot(snapshot({ subagentRecovery: wire(auth), bodyArchive: body }), source, () => {}, {
    waitForBody: control.waitForBody, progress: (preview, state) => {
      phases.push(state.phase)
      if (state.phase === 'body-ready') { expect(preview.projection[1].publishedChild?.atSeq).toBe(4); expect(preview.projection[1].toolResult).toBeUndefined(); control.requestBody() }
    }
  })
  expect(phases.at(-1)).toBe('retained'); expect(phases).not.toContain('complete'); expect(restored.currentTurnComplete).toBe(false)
  expect(restored.projection[1].publishedChild).toBeUndefined()
  expect(restored.projection[1].toolResult).toMatchObject({ result: 'exact original', publishedChild: { atSeq: 4 } })
})

test('fixed details reject stale seq foreign identity and lease; visible cards stay bounded after navigation', () => {
  let memory = new Map<string, SubagentRun>()
  const scope = { source: 1, sessionId: 'session' }
  const old = ref(), exact = child()
  memory = rememberPublishedDetail(memory, exact, old, scope)
  expect(memory.size).toBe(1)
  for (const [run, reference, owner] of [[child('child', { lastSeq: 5 }), old, scope], [child('foreign'), old, scope],
    [exact, old, { source: 2, sessionId: 'session' }], [exact, old, { source: 1, sessionId: 'other' }]] as const)
    expect(rememberPublishedDetail(new Map(), run, reference, owner).size).toBe(0)
  expect(memory.has(publishedDetailKey(ref({ snapshotId: 'new-lease' })))).toBe(false)
  for (let index = 0; index < 80; index++) memory = rememberPublishedDetail(memory, child(String(index)), ref({ identity: identity(String(index)) }), scope)
  expect(memory.size).toBe(64); expect(memory.has(publishedDetailKey(old))).toBe(false)
  const huge = child('huge', { partialOutput: 'x'.repeat(8 * 1024 * 1024) })
  expect(rememberPublishedDetail(new Map(), huge, ref({ identity: identity('huge') }), scope).size).toBe(0)
  const items = Array.from({ length: 4096 }, (_, index) => index)
  for (let end = 64; end <= 4096; end += 64) {
    const window = publishedVisibleWindow(items, end)
    expect(window.items).toHaveLength(64); expect(window.items[0]).toBe(end - 64); expect(window.items.at(-1)).toBe(end - 1)
  }
  expect(publishedVisibleWindow(items, 64).items[0]).toBe(0)
})

test('8 MiB Unicode body yields finite pages and reuses preview while verifying all chunks', async ({}, testInfo) => {
  test.setTimeout(30_000)
  const source = ready(), auth = authority({ clientSource: source }), sha = (value: string): string => createHash('sha256').update(value).digest('hex')
  const content = '汉😀'.repeat(1_197_000)
  const encoded = JSON.stringify({ streamId: 'stream', eventId: 'stream:7', projection: [{ content }], projectionIndices: [0] })
  expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(8 * 1024 * 1024); expect(Buffer.byteLength(encoded)).toBeGreaterThan(8_000_000)
  const chunks: string[] = []
  for (let offset = 0; offset < encoded.length;) {
    let end = Math.min(encoded.length, offset + 8192)
    if (end < encoded.length && encoded.charCodeAt(end - 1) >= 0xd800 && encoded.charCodeAt(end - 1) <= 0xdbff) end--
    chunks.push(encoded.slice(offset, end)); offset = end
  }
  const body = { protocolVersion: 1 as const, source: 'sealed-current-turn' as const, endpoint: '/chat/snapshot/body' as const,
    sha256: sha(encoded), byteLength: Buffer.byteLength(encoded), chunkCount: chunks.length, originalProjectionCount: 1,
    originalCurrentTurnComplete: true, previewComplete: false as const }
  let requests = 0, firstPreview: ChatRecoverySnapshot | undefined
  bridge(async input => {
    requests++
    if (input.path.endsWith('/projection')) return { protocolVersion: 1, snapshotId: 'lease', fence: auth.fence, entries: [],
      totalCount: 0, originalProjectionCount: 1, hasMore: false, nextCursor: null }
    const part = Number(input.query?.part)
    return { protocolVersion: 1, snapshotId: 'lease', fence: auth.fence, part, nextPart: part + 1 < chunks.length ? part + 1 : null,
      archive: body, chunk: chunks[part], chunkDigest: sha(chunks[part]) }
  })
  const cpu = process.cpuUsage(), rss = process.memoryUsage().rss, started = performance.now()
  const restored = await preparePublishedSnapshot(snapshot({ subagentRecovery: wire(auth), bodyArchive: body,
    subagentProjectionArchive: { ...snapshot().subagentProjectionArchive!, totalCount: 0, originalProjectionCount: 1 } }), source, () => {}, {
    progress: (preview, state) => { if (state.phase === 'body-ready') firstPreview = preview
      if (state.phase === 'body') expect(preview).toBe(firstPreview) }
  })
  expect(restored.projection[0].content).toBe(content); expect(requests).toBe(1 + chunks.length)
  const used = process.cpuUsage(cpu)
  writeFileSync(testInfo.outputPath('client-8mib-body-performance.json'), JSON.stringify({ at: new Date().toISOString(), bodyBytes: body.byteLength, chunks: chunks.length,
    requests, wallMs: performance.now() - started, cpuMs: (used.user + used.system) / 1000, rssBefore: rss, rssAfter: process.memoryUsage().rss,
    scope: 'mock IPC source contracts only; no backend or renderer claim' }, null, 2))
})
