/** Pure subagent timing presentation: queue versus execution, current-round
 * identity, frozen published evidence and local timestamp/elapsed formatting.
 * No browser, Electron window or build is required. */
import { expect, test } from '@playwright/test'
import type { ToolActivity } from '../src/renderer/src/core/engine/useChat'
import type { SubagentRunV1 } from '../src/shared/subagent'
import type { PublishedChildReference } from '../src/shared/published-child'
import { formatSubagentElapsed, workSubagentTiming } from '../src/renderer/src/contrib/work/work-subagent-timing'

// Local constructors make the calendar assertions independent of the host's timezone.
const start = new Date(2026, 10, 9, 14, 20, 0).getTime()

function run(patch: Partial<SubagentRunV1> = {}): SubagentRunV1 {
  return {
    schemaVersion: 1, runId: 'current-run', tenantId: 'tenant', rootSessionId: 'parent',
    parentSessionId: 'parent', parentConversationId: 'turn', parentMessageId: 'answer',
    parentToolCallId: 'current-tool', childSessionId: 'child', task: 'Current assignment',
    description: 'Current round', modelId: 'model', status: 'running', lastSeq: 2,
    createdAt: start, updatedAt: start + 1_000, usage: {}, toolCalls: [], ...patch
  }
}

function tool(patch: Partial<ToolActivity> = {}): ToolActivity {
  return { id: 'current-tool', name: 'subagent', args: '{}', result: '', state: 'done', ...patch }
}

function published(current: SubagentRunV1 = run()): PublishedChildReference {
  return {
    protocolVersion: 1, source: 1, sessionId: 'parent', snapshotId: 'snapshot',
    fence: {
      tenantId: 'tenant', parentSessionId: 'parent', rootSessionId: 'parent', parentTurnId: 'turn',
      rootRunId: 'root-run', attemptId: 'attempt', streamId: 'stream', generation: 'generation',
      eventSequence: 3, revision: 2, usageRevision: 1
    },
    identity: {
      tenantId: current.tenantId, runId: current.runId, rootSessionId: current.rootSessionId,
      parentSessionId: current.parentSessionId, parentConversationId: current.parentConversationId,
      parentMessageId: current.parentMessageId, parentToolCallId: current.parentToolCallId,
      childSessionId: current.childSessionId, modelId: current.modelId, createdAt: current.createdAt
    },
    atSeq: 2, projectionIndex: 0
  }
}

test('queued time is waiting, never execution time inferred from the parent tool', () => {
  const current = tool({ state: 'running', startedAt: start - 30_000,
    subagent: run({ status: 'queued' }) })
  expect(workSubagentTiming(current, start + 61_000)).toMatchObject({
    durationText: '排队 1 分 1 秒', durationMs: undefined,
    timestamp: { value: start, text: '14:20 创建' },
    summary: '排队 1 分 1 秒 · 14:20 创建'
  })
  expect(workSubagentTiming(current, start + 81_000).durationText).toBe('排队 1 分 21 秒')
  expect(workSubagentTiming(tool({ ...current, subagent: run({ status: 'queued', createdAt: 0 }) }), start + 61_000))
    .toMatchObject({ durationText: '等待开始', durationMs: undefined, timestamp: undefined })
})

test('running and cancelling rounds advance only from the child execution start', () => {
  for (const status of ['running', 'cancelling'] as const) {
    const current = tool({ startedAt: start - 100_000, finishedAt: start + 9_000,
      subagent: run({ status, startedAt: start + 5_000, durationMs: 999 }) })
    const original = structuredClone(current)
    expect(workSubagentTiming(current, start + 66_000)).toMatchObject({
      durationText: '本轮用时 1 分 1 秒', durationMs: 61_000,
      timestamp: { value: start + 5_000, text: '14:20 开始' }
    })
    expect(workSubagentTiming(current, start + 86_000).durationMs).toBe(81_000)
    expect(current).toEqual(original)
  }
})

test('terminal outcomes including needs-user retain their reported duration while waiting', () => {
  for (const status of ['succeeded', 'failed', 'blocked', 'cancelled', 'interrupted'] as const) {
    const current = tool({ state: status === 'blocked' ? 'waiting' : 'done', subagent: run({
      status, startedAt: start, finishedAt: start + 90_000, durationMs: 7_777,
      ...(status === 'blocked' ? { stopReason: 'needs_user' } : {})
    }) })
    const first = workSubagentTiming(current, start + 100_000)
    expect(first).toMatchObject({ durationText: '本轮用时 7 秒', durationMs: 7_777 })
    expect(workSubagentTiming(current, start + 500_000)).toEqual(first)
  }
})

test('missing or invalid terminal duration falls back only to valid ordered start and finish', () => {
  for (const durationMs of [undefined, NaN, Infinity, -1]) {
    const current = tool({ subagent: run({ status: 'failed', startedAt: start + 2_000,
      finishedAt: start + 65_000, durationMs }) })
    expect(workSubagentTiming(current, start + 500_000)).toMatchObject({
      durationText: '本轮用时 1 分 3 秒', durationMs: 63_000
    })
  }
  for (const finishedAt of [undefined, 0, -1, NaN, Infinity, 8.64e15 + 1, start - 1]) {
    expect(workSubagentTiming(tool({ subagent: run({ status: 'failed', startedAt: start,
      finishedAt, updatedAt: start + 65_000 }) }), start + 500_000))
      .toMatchObject({ durationText: '用时未记录', durationMs: undefined })
  }
})

test('a new continuation uses its own tool and run instead of the previous round', () => {
  const previous = tool({ id: 'previous-tool', subagent: run({ runId: 'previous-run',
    parentToolCallId: 'previous-tool', status: 'succeeded', createdAt: start - 100_000,
    startedAt: start - 90_000, finishedAt: start - 10_000, durationMs: 80_000 }) })
  const announcement = tool({ state: 'running', startedAt: start,
    args: JSON.stringify({ resumeRunId: previous.subagent!.runId, task: 'Next assignment' }) })
  expect(workSubagentTiming(announcement, start + 30_000)).toMatchObject({
    durationText: '准备中', durationMs: undefined, timestamp: { value: start, text: '14:20 创建' }
  })
  const current = tool({ ...announcement, subagent: run({ resumeFromRunId: 'previous-run',
    startedAt: start + 10_000 }) })
  expect(workSubagentTiming(current, start + 30_000).durationMs).toBe(20_000)
  expect(workSubagentTiming(previous, start + 30_000).durationMs).toBe(80_000)
})

test('unhydrated and mismatched published references expose only their own creation time', () => {
  const reference = published()
  for (const subagent of [undefined, run({ runId: 'older-run', status: 'succeeded',
    startedAt: start - 90_000, finishedAt: start - 10_000, durationMs: 80_000 })]) {
    const current = tool({ state: 'running', subagentRef: reference, subagent,
      startedAt: start - 50_000, finishedAt: start + 50_000, durationMs: 100_000 })
    expect(workSubagentTiming(current, start + 500_000)).toMatchObject({
      durationText: '用时未记录', durationMs: undefined,
      timestamp: { value: reference.identity.createdAt, text: '14:20 创建' }
    })
  }
})

test('same-run published hydration uses exact recorded duration without a live clock', () => {
  const reference = published()
  const current = tool({ subagentRef: reference, subagent: run({ status: 'succeeded',
    startedAt: start + 5_000, finishedAt: start + 50_000, durationMs: 45_000 }) })
  const result = workSubagentTiming(current, start + 100_000)
  expect(result).toMatchObject({ durationText: '本轮用时 45 秒', durationMs: 45_000,
    timestamp: { value: start + 5_000, text: '14:20 开始' } })
  expect(workSubagentTiming(current, start + 500_000)).toEqual(result)

  const runningSnapshot = tool({ subagentRef: reference,
    subagent: run({ status: 'running', startedAt: start + 5_000, durationMs: 12_000 }) })
  expect(workSubagentTiming(runningSnapshot, start + 500_000).durationMs).toBe(12_000)
  const snapshotWithoutDuration = tool({ subagentRef: reference,
    subagent: run({ status: 'running', startedAt: start + 5_000 }) })
  expect(workSubagentTiming(snapshotWithoutDuration, start + 500_000))
    .toMatchObject({ durationText: '用时未记录', durationMs: undefined })
  const queuedSnapshot = tool({ subagentRef: reference, subagent: run({ status: 'queued' }) })
  expect(workSubagentTiming(queuedSnapshot, start + 500_000))
    .toMatchObject({ durationText: '等待开始', durationMs: undefined })
})

test('missing and invalid timestamps do not fabricate dates or a duration', () => {
  expect(workSubagentTiming(tool(), start)).toEqual({ durationText: '用时未记录', durationMs: undefined,
    timestamp: undefined, summary: '用时未记录' })
  for (const invalid of [0, -1, NaN, Infinity, -Infinity, 8.64e15 + 1]) {
    expect(workSubagentTiming(tool({ subagent: run({ status: 'failed', createdAt: invalid,
      startedAt: invalid, finishedAt: invalid, durationMs: NaN }) }), start))
      .toEqual({ durationText: '用时未记录', durationMs: undefined, timestamp: undefined, summary: '用时未记录' })
    expect(workSubagentTiming(tool({ subagent: run({ startedAt: start }) }), invalid))
      .toMatchObject({ durationText: '等待开始', durationMs: undefined })
  }
  // A known child with no start must not inherit the parent invocation's start.
  expect(workSubagentTiming(tool({ startedAt: start - 20_000, subagent: run() }), start + 10_000))
    .toMatchObject({ durationText: '等待开始', durationMs: undefined, timestamp: { value: start, text: '14:20 创建' } })
})

test('zero execution time differs from a round that never started', () => {
  expect(workSubagentTiming(tool({ subagent: run({ status: 'succeeded', startedAt: start,
    finishedAt: start, durationMs: 0 }) }), start + 50_000))
    .toMatchObject({ durationText: '本轮用时 不足 1 秒', durationMs: 0 })
  expect(workSubagentTiming(tool({ subagent: run({ status: 'cancelled', finishedAt: start + 50_000,
    durationMs: 0 }) }), start + 90_000))
    .toMatchObject({ durationText: '未开始', durationMs: undefined })
  expect(workSubagentTiming(tool({ subagent: run({ status: 'failed', durationMs: 1_500 }) }), start))
    .toMatchObject({ durationText: '本轮用时 1 秒', durationMs: 1_500 })
})

test('clock skew clamps active and queued elapsed time to zero', () => {
  expect(workSubagentTiming(tool({ subagent: run({ startedAt: start + 5_000 }) }), start))
    .toMatchObject({ durationText: '本轮用时 不足 1 秒', durationMs: 0 })
  expect(workSubagentTiming(tool({ subagent: run({ status: 'queued', createdAt: start + 5_000 }) }), start))
    .toMatchObject({ durationText: '排队 不足 1 秒', durationMs: undefined })
})

test('timestamps distinguish today, another day and another year while retaining exact machine time', () => {
  const cases = [
    { value: new Date(2026, 10, 9, 9, 4, 5).getTime(), text: '09:04 开始', full: '开始时间 2026/11/09 09:04:05' },
    { value: new Date(2026, 10, 8, 9, 4, 5).getTime(), text: '11/08 09:04 开始', full: '开始时间 2026/11/08 09:04:05' },
    { value: new Date(2025, 11, 31, 9, 4, 5).getTime(), text: '2025/12/31 09:04 开始', full: '开始时间 2025/12/31 09:04:05' }
  ]
  for (const { value, text, full } of cases) {
    const result = workSubagentTiming(tool({ subagent: run({ status: 'succeeded', createdAt: value - 1_000,
      startedAt: value, durationMs: 1_000 }) }), start)
    expect(result.timestamp).toEqual({ value, dateTime: new Date(value).toISOString(), text, full })
    expect(result.summary).toBe(`本轮用时 1 秒 · ${text}`)
  }
})

test('elapsed formatting remains compact through second, minute and hour boundaries', () => {
  for (const [milliseconds, text] of [
    [0, '不足 1 秒'], [999, '不足 1 秒'], [1_000, '1 秒'], [59_999, '59 秒'],
    [60_000, '1 分'], [61_000, '1 分 1 秒'], [3_599_000, '59 分 59 秒'],
    [3_600_000, '1 小时'], [3_601_000, '1 小时 1 秒'], [3_661_000, '1 小时 1 分 1 秒'],
    [11_006_000, '3 小时 3 分 26 秒'], [90_000_000, '25 小时']
  ] as const) expect(formatSubagentElapsed(milliseconds)).toBe(text)
})
