/** Pure contract regression: bounded v2 views, exact seq deltas, tenant/turn isolation and cache pagination. */
import { expect, test } from '@playwright/test'
import type {
  SubagentDeltaEvent,
  SubagentRunView,
  SubagentToolSummary
} from '../src/shared/subagent'
import {
  boundSubagentView,
  mergeSubagentRun,
  normalizeSubagentRun,
  reduceSubagentDelta,
  reduceSubagentEvent,
  reduceSubagentRun,
  subagentResidentBytes,
  SUBAGENT_VIEW_MAX_BYTES
} from '../src/renderer/src/core/engine/subagent-state'
import {
  forgetSubagentSession,
  getSubagentCacheStats,
  getSubagentRuns,
  ingestSubagentEventResult,
  ingestSubagentRun,
  refreshSubagentRuns,
  restartSubagentDirectory,
  subscribeSubagents
} from '../src/renderer/src/core/engine/subagent-store'

function tool(
  id: string,
  revisionSeq = 100,
  status: SubagentToolSummary['status'] = 'succeeded'
): SubagentToolSummary {
  return {
    id,
    name: 'read_file',
    args: { path: `${id}.txt` },
    status,
    revisionSeq,
    ordinal: Number(id.replace(/\D/g, '')) || 1,
    detailRef: `detail-${id}`,
    detailTruncated: false
  }
}

function view(
  calls: SubagentToolSummary[] = [],
  total = calls.length,
  patch: Partial<SubagentRunView> = {}
): SubagentRunView {
  const active = calls.filter((call) => call.status === 'running').length
  return {
    schemaVersion: 2,
    view: 'summary',
    runId: 'run-1',
    tenantId: 'tenant-1',
    rootSessionId: 'root-1',
    parentSessionId: 'parent-1',
    parentConversationId: 'turn-1',
    parentMessageId: 'msg-1',
    parentToolCallId: 'dispatch-1',
    childSessionId: 'child-1',
    task: 'Investigate',
    description: '诊断',
    modelId: 'test-model',
    status: 'running',
    lastSeq: 100,
    createdAt: 1000,
    updatedAt: 2000,
    usage: { totalTokens: 42 },
    toolCalls: calls,
    toolCount: total,
    activeToolCount: active,
    coverage: {
      asOfSeq: 100,
      toolCount: total,
      includedToolCount: calls.length,
      activeToolCount: active,
      includedActiveToolCount: active,
      ids: calls.map((call) => call.id),
      hasMore: calls.length < total,
      truncated: calls.length < total,
      completeness: calls.length === total ? 'complete' : 'partial'
    },
    ...patch
  }
}

function delta(seq: number, patch: Partial<SubagentDeltaEvent> = {}): SubagentDeltaEvent {
  const run = view()
  return {
    schemaVersion: 2,
    kind: 'usage.updated',
    runId: run.runId,
    seq,
    baseSeq: seq - 1,
    identity: {
      tenantId: run.tenantId,
      rootSessionId: run.rootSessionId,
      parentSessionId: run.parentSessionId,
      parentConversationId: run.parentConversationId,
      parentMessageId: run.parentMessageId,
      parentToolCallId: run.parentToolCallId,
      childSessionId: run.childSessionId
    },
    headerPatch: { lastSeq: seq, updatedAt: seq + 1000 },
    ...patch
  }
}

test.afterEach(() => {
  forgetSubagentSession('parent-1')
})

test('4100 tools retain the latest running activity with exact totals and bounded coverage', () => {
  const calls = Array.from({ length: 4100 }, (_, index) =>
    tool(`tool-${index + 1}`, index + 1, index === 4099 ? 'running' : 'succeeded')
  )
  const raw = view(calls, 4100, {
    lastSeq: 5000,
    latestActivity: calls[4099],
    coverage: {
      asOfSeq: 5000,
      toolCount: 4100,
      activeToolCount: 1,
      includedToolCount: 4100,
      includedActiveToolCount: 1,
      ids: calls.map((call) => call.id),
      hasMore: false,
      truncated: false,
      completeness: 'complete'
    }
  })
  const normalized = normalizeSubagentRun(raw) as SubagentRunView
  expect(normalized.toolCalls.length).toBeLessThanOrEqual(64)
  expect(normalized.toolCalls.map((call) => call.id)).toContain('tool-4100')
  expect(normalized.latestActivity?.id).toBe('tool-4100')
  expect(normalized.coverage).toMatchObject({
    toolCount: 4100,
    activeToolCount: 1,
    hasMore: true,
    truncated: true,
    completeness: 'partial'
  })
  expect(normalized.coverage.ids).toEqual(normalized.toolCalls.map((call) => call.id))
  expect(subagentResidentBytes(normalized)).toBeLessThanOrEqual(SUBAGENT_VIEW_MAX_BYTES)
})

test('recent completion of ordinal 1 wins over tools created more recently', () => {
  const calls = Array.from({ length: 200 }, (_, index) => tool(`tool-${index + 1}`, index + 1))
  calls[0] = { ...calls[0], revisionSeq: 5000, finishedAt: 5000 }
  const bounded = boundSubagentView(view(calls, 200, { lastSeq: 5000, latestActivity: calls[0] }))
  expect(bounded.toolCalls[0].id).toBe('tool-1')
  expect(bounded.latestActivity?.revisionSeq).toBe(5000)
})

test('same-seq overlapping pages merge coverage without duplicate IDs or usage', () => {
  const first = view([tool('tool-1'), tool('tool-2')], 5)
  const second = view([tool('tool-2'), tool('tool-3'), tool('tool-4'), tool('tool-5')], 5)
  const merged = mergeSubagentRun(first, second) as SubagentRunView
  expect(new Set(merged.toolCalls.map((call) => call.id)).size).toBe(5)
  expect(merged.usage.totalTokens).toBe(42)
  expect(merged.coverage).toMatchObject({
    includedToolCount: 5,
    hasMore: false,
    completeness: 'complete'
  })
  expect(normalizeSubagentRun(merged)?.lastSeq).toBe(100)
  const repeated = mergeSubagentRun(merged, second) as SubagentRunView
  expect(repeated.toolCalls.length).toBe(5)
  expect(repeated.usage.totalTokens).toBe(42)
})

test('an older tool revision at the same run watermark cannot replace a completed tool', () => {
  const previous = view([tool('tool-1', 100), tool('tool-2', 100, 'running')], 2, {
    latestActivity: tool('tool-1', 100)
  })
  const stale = view([tool('tool-1', 99, 'running')], 2, {
    activeToolCount: 1,
    latestActivity: tool('tool-1', 99, 'running'),
    coverage: {
      asOfSeq: 100,
      toolCount: 2,
      includedToolCount: 1,
      activeToolCount: 1,
      includedActiveToolCount: 1,
      ids: ['tool-1'],
      hasMore: true,
      truncated: true,
      completeness: 'partial'
    }
  })
  const merged = mergeSubagentRun(previous, stale) as SubagentRunView
  expect(merged.toolCalls.find((call) => call.id === 'tool-1')).toMatchObject({
    status: 'succeeded',
    revisionSeq: 100
  })
  expect(merged.latestActivity?.revisionSeq).toBe(100)
})

test('same-seq scalar and tool conflicts require recovery instead of last-write wins', () => {
  const first = view([tool('tool-1')])
  expect(
    reduceSubagentRun(first, view([tool('tool-1')], 1, { usage: { totalTokens: 43 } }))
  ).toMatchObject({ status: 'invalid', run: first })
  expect(reduceSubagentRun(first, view([tool('tool-1')], 1, { status: 'failed' })).status).toBe(
    'invalid'
  )
  expect(reduceSubagentRun(first, view([{ ...tool('tool-1'), status: 'running' }])).status).toBe(
    'invalid'
  )
})

test('coverage validates exact watermark, counts, identity and version before any merge', () => {
  const raw = view([tool('tool-1')])
  expect(
    normalizeSubagentRun({ ...raw, coverage: { ...raw.coverage, asOfSeq: 99 } })
  ).toBeUndefined()
  expect(
    normalizeSubagentRun({ ...raw, coverage: { ...raw.coverage, includedToolCount: 2 } })
  ).toBeUndefined()
  expect(
    normalizeSubagentRun({ ...raw, coverage: { ...raw.coverage, ids: ['other'] } })
  ).toBeUndefined()
  expect(normalizeSubagentRun({ ...raw, schemaVersion: 3 })).toBeUndefined()
  expect(normalizeSubagentRun({ ...raw, usage: { totalTokens: -1 } })).toBeUndefined()
  expect(
    reduceSubagentDelta(
      raw,
      delta(101, { headerPatch: { lastSeq: 101, usage: { totalTokens: -1 } } })
    ).status
  ).toBe('invalid')
  for (const change of [
    { tenantId: 'other' },
    { parentConversationId: 'other' },
    { rootSessionId: 'other' }
  ]) {
    expect(reduceSubagentRun(raw, { ...raw, ...change }).status).toBe('invalid')
  }
})

test('versioned deltas reject gaps and malformed bases, and validate every identity including duplicate frames', () => {
  const previous = view([], 0)
  expect(reduceSubagentDelta(previous, delta(102))).toMatchObject({ status: 'gap', run: previous })
  expect(reduceSubagentDelta(previous, delta(101, { baseSeq: 99 })).status).toBe('invalid')
  expect(reduceSubagentDelta(undefined, delta(101))).toMatchObject({ status: 'gap' })
  expect(
    reduceSubagentDelta(
      previous,
      delta(101, { identity: { ...delta(101).identity, tenantId: 'other' } })
    ).status
  ).toBe('invalid')
  expect(
    reduceSubagentDelta(
      previous,
      delta(100, { identity: { ...delta(100).identity, parentConversationId: 'other' } })
    ).status
  ).toBe('invalid')
  const applied = reduceSubagentDelta(
    previous,
    delta(101, { headerPatch: { lastSeq: 101, usage: { totalTokens: 52 } } })
  )
  expect(applied.status).toBe('applied')
  expect(applied.run?.lastSeq).toBe(101)
  expect(applied.run?.usage.totalTokens).toBe(52)
  expect(
    reduceSubagentDelta(
      applied.run,
      delta(101, { headerPatch: { lastSeq: 101, usage: { totalTokens: 52 } } })
    ).status
  ).toBe('verified-duplicate')
  expect(
    reduceSubagentDelta(
      applied.run,
      delta(101, { headerPatch: { lastSeq: 101, usage: { totalTokens: 53 } } })
    ).status
  ).toBe('invalid')
})

test('creation delta seeds only an exact initial header and subsequent tools use keyed revisions', () => {
  const initial = view([], 0, {
    lastSeq: 1,
    usage: {},
    coverage: {
      asOfSeq: 1,
      toolCount: 0,
      activeToolCount: 0,
      includedToolCount: 0,
      includedActiveToolCount: 0,
      ids: [],
      hasMore: false,
      truncated: false,
      completeness: 'complete'
    }
  })
  const { toolCalls: _calls, coverage: _coverage, ...header } = initial
  const seeded = reduceSubagentDelta(
    undefined,
    delta(1, { kind: 'created', header, headerPatch: { lastSeq: 1 } })
  )
  expect(seeded.status).toBe('applied')
  const started = reduceSubagentDelta(
    seeded.run,
    delta(2, {
      kind: 'tool.started',
      toolUpsert: tool('tool-1', 2, 'running'),
      headerPatch: { lastSeq: 2, toolCount: 1, activeToolCount: 1 }
    })
  )
  const ended = reduceSubagentDelta(
    started.run,
    delta(3, {
      kind: 'tool.completed',
      toolUpsert: tool('tool-1', 3),
      headerPatch: { lastSeq: 3, toolCount: 1, activeToolCount: 0 }
    })
  )
  expect(ended.run?.toolCalls).toMatchObject([
    { id: 'tool-1', status: 'succeeded', revisionSeq: 3 }
  ])
  expect((ended.run as SubagentRunView).coverage).toMatchObject({
    includedToolCount: 1,
    toolCount: 1,
    includedActiveToolCount: 0
  })
})

test('a legacy v2 checkpoint is explicit, identity-bound and can bridge a delta gap', () => {
  const previous = view([], 0, { lastSeq: 50 })
  const checkpoint = {
    schemaVersion: 2,
    kind: 'snapshot',
    runId: 'run-1',
    seq: 100,
    view: view([tool('tool-1')])
  }
  const result = reduceSubagentEvent(previous, checkpoint)
  expect(result.status).toBe('applied')
  expect(result.run?.lastSeq).toBe(100)
  expect(reduceSubagentEvent(previous, { ...checkpoint, seq: 99 }).status).toBe('invalid')
  expect(
    reduceSubagentEvent(previous, {
      ...checkpoint,
      view: { ...checkpoint.view, tenantId: 'foreign' }
    }).status
  ).toBe('invalid')
})

test('terminal header cancels resident active tools with exact revision and detail watermark', () => {
  const previous = view([tool('tool-1', 100, 'running')], 1, {
    latestActivity: tool('tool-1', 100, 'running')
  })
  const result = reduceSubagentDelta(
    previous,
    delta(101, {
      kind: 'finished',
      headerPatch: {
        lastSeq: 101,
        updatedAt: 2100,
        finishedAt: 2100,
        status: 'cancelled',
        activeToolCount: 0
      }
    })
  )
  expect(result.status).toBe('applied')
  expect(result.run?.toolCalls[0]).toMatchObject({
    id: 'tool-1',
    status: 'cancelled',
    revisionSeq: 101,
    finishedAt: 2100
  })
  expect((result.run as SubagentRunView).latestActivity?.detailRef).toContain('atSeq=101')
  expect((result.run as SubagentRunView).coverage).toMatchObject({
    activeToolCount: 0,
    includedActiveToolCount: 0
  })
  expect(
    reduceSubagentDelta(previous, delta(101, { headerPatch: { lastSeq: 101, activeToolCount: 0 } }))
      .status
  ).toBe('invalid')
})

test('late progress cannot revive terminal run or tool, legal usage still advances once', () => {
  const previous = view([tool('tool-1')], 1, {
    status: 'cancelled',
    finishedAt: 2000,
    usage: { totalTokens: 50 }
  })
  const next = reduceSubagentDelta(
    previous,
    delta(101, {
      kind: 'tool.started',
      toolUpsert: tool('tool-1', 101, 'running'),
      headerPatch: {
        lastSeq: 101,
        status: 'running',
        toolCount: 1,
        activeToolCount: 1,
        usage: { totalTokens: 60 }
      }
    })
  )
  expect(next.status).toBe('invalid')
  expect(next.run?.status).toBe('cancelled')
  expect(next.run?.finishedAt).toBe(2000)
  expect(next.run?.toolCalls[0].status).toBe('succeeded')
  expect(next.run?.usage.totalTokens).toBe(50)
  const usage = reduceSubagentDelta(
    previous,
    delta(101, { headerPatch: { lastSeq: 101, usage: { totalTokens: 60 } } })
  )
  expect(usage.status).toBe('applied')
  expect(usage.run?.status).toBe('cancelled')
  expect(usage.run?.usage.totalTokens).toBe(60)
})

test('large multibyte previews remain valid objects within a UTF-8 byte budget', () => {
  const large = tool('tool-1')
  large.args = { message: '你好🙂'.repeat(100000), nested: { text: 'text'.repeat(100000) } }
  large.output = '你好🙂'.repeat(100000)
  const normalized = normalizeSubagentRun(view([large])) as SubagentRunView
  expect(normalized.toolCalls[0].detailTruncated).toBe(true)
  expect(typeof normalized.toolCalls[0].args).toBe('object')
  expect(() => JSON.parse(JSON.stringify(normalized.toolCalls[0].args))).not.toThrow()
  expect(new TextEncoder().encode(normalized.toolCalls[0].output).byteLength).toBeLessThanOrEqual(
    2048
  )
  expect(normalized.toolCalls[0].output?.endsWith('\uD83D')).toBe(false)
  expect(subagentResidentBytes(normalized)).toBeLessThanOrEqual(SUBAGENT_VIEW_MAX_BYTES)
})

test('paging preserves absent children; a complete head removes old terminal views but retains active ones', async () => {
  ingestSubagentRun(view([], 0))
  ingestSubagentRun(
    view([], 0, { runId: 'run-2', childSessionId: 'child-2', parentToolCallId: 'dispatch-2' })
  )
  ingestSubagentRun(
    view([], 0, { runId: 'run-3', childSessionId: 'child-3', parentToolCallId: 'dispatch-3', status: 'succeeded' })
  )
  let complete = false
  const original = globalThis.window
  Object.assign(globalThis, {
    window: {
      aether: {
        engine: {
          request: async (input: { path: string }) => ({
            ok: true,
            code: 0,
            data:
              input.path === '/subagent/capabilities'
                ? {
                    schemaVersion: 2,
                    eventVersions: [2],
                    views: ['summary'],
                    toolPagination: true,
                    eventPagination: true,
                    detailChunks: true,
                    exactWatermarks: true
                  }
                : input.path === '/subagent/runs/run-1' ? view([], 0)
                : input.path === '/subagent/runs/run-2' ? view([], 0, {
                    runId: 'run-2', childSessionId: 'child-2', parentToolCallId: 'dispatch-2'
                  }) : {
                    schemaVersion: 2,
                    runs: [view([], 0)],
                    revision: 'revision-1',
                    listComplete: complete,
                    hasMore: !complete,
                    nextCursor: complete ? undefined : 'next'
                  }
          })
        }
      }
    }
  })
  try {
    await refreshSubagentRuns('parent-1')
    expect(
      getSubagentRuns('parent-1')
        .map((run) => run.runId)
        .sort()
    ).toEqual(['run-1', 'run-2', 'run-3'])
    complete = true
    // Explicit directory actions are distinct from the five-second background
    // cadence. Absence is never proof that an active child has stopped.
    await restartSubagentDirectory('parent-1')
    expect(getSubagentRuns('parent-1').map((run) => run.runId).sort()).toEqual(['run-1', 'run-2'])
  } finally {
    Object.assign(globalThis, { window: original })
  }
})

test('production store has a combined 4MiB resident ceiling and gaps leave confirmed state unchanged', () => {
  const calls = Array.from({ length: 64 }, (_, index) => ({
    ...tool(`tool-${index + 1}`),
    output: 'x'.repeat(2048)
  }))
  for (let index = 0; index < 80; index++)
    ingestSubagentRun(
      view(calls, 64, {
        runId: `run-${index}`,
        status: 'succeeded',
        parentToolCallId: `dispatch-${index}`,
        childSessionId: `child-${index}`,
        latestActivity: calls[63]
      })
    )
  expect(getSubagentCacheStats().residentBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
  ingestSubagentRun(view([], 0))
  const gap = ingestSubagentEventResult(delta(102))
  expect(gap.status).toBe('gap')
  expect(getSubagentRuns('parent-1').find((run) => run.runId === 'run-1')?.lastSeq).toBe(100)
})

test('forgetting a session invalidates an in-flight list response instead of resurrecting children', async () => {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  let requested = false
  const original = globalThis.window
  Object.assign(globalThis, {
    window: {
      aether: {
        engine: {
          request: async (input: { path: string }) => {
            if (input.path === '/subagent/capabilities')
              return {
                ok: true,
                code: 0,
                data: {
                  schemaVersion: 2,
                  eventVersions: [2],
                  views: ['summary'],
                  toolPagination: true,
                  eventPagination: true,
                  detailChunks: true,
                  exactWatermarks: true
                }
              }
            requested = true
            await wait
            return {
              ok: true,
              code: 0,
              data: { schemaVersion: 2, runs: [view([], 0)], listComplete: true, hasMore: false }
            }
          }
        }
      }
    }
  })
  try {
    const pending = refreshSubagentRuns('parent-1')
    await expect.poll(() => requested).toBe(true)
    forgetSubagentSession('parent-1')
    release()
    await pending
    expect(getSubagentRuns('parent-1')).toEqual([])
  } finally {
    release()
    Object.assign(globalThis, { window: original })
  }
})

test('verified duplicate deltas do not notify subscribers or rebuild the run', () => {
  const before = ingestSubagentRun(view([], 0))
  let notifications = 0
  const unsubscribe = subscribeSubagents(() => {
    notifications++
  })
  try {
    const duplicate = ingestSubagentEventResult(delta(100, { headerPatch: { lastSeq: 100 } }))
    expect(duplicate.status).toBe('verified-duplicate')
    expect(duplicate.run).toBe(before)
    expect(notifications).toBe(0)
  } finally {
    unsubscribe()
  }
})

test('active overload pages older samples before evicting latest summaries and preserves accurate active totals', () => {
  const calls = Array.from({ length: 64 }, (_, index) => ({
    ...tool(`tool-${index + 1}`, 100, 'running'),
    output: 'x'.repeat(2048)
  }))
  for (let index = 0; index < 60; index++)
    ingestSubagentRun(
      view(calls, 64, {
        runId: `active-${index}`,
        parentToolCallId: `dispatch-${index}`,
        childSessionId: `child-${index}`,
        latestActivity: calls[63],
        activeToolCount: 64
      })
    )
  expect(getSubagentCacheStats().residentBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
  expect(getSubagentRuns('parent-1')).toHaveLength(60)
  for (const run of getSubagentRuns('parent-1') as SubagentRunView[]) {
    expect(run.status).toBe('running')
    expect(run.latestActivity?.id).toBe('tool-64')
    expect(run.activeToolCount).toBe(64)
    expect(run.coverage.includedActiveToolCount).toBeLessThanOrEqual(32)
  }
})
