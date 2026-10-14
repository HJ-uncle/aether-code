/** Pure UI counts preserve raw transport coverage while hiding silent controls;
 * negotiated v1 never requests v2 history merely because its cache uses a v2 view. */
import { expect, test } from '@playwright/test'
import type { SubagentRunV1 } from '../src/shared/subagent'
import { toSubagentView } from '../src/renderer/src/core/engine/subagent-state'
import { canPageSubagentHistory, subagentToolPresentation } from '../src/renderer/src/contrib/chat/subagent-tool-presentation'

function legacyRun(): SubagentRunV1 {
  return { schemaVersion: 1, runId: 'plan-child', tenantId: 'tenant', rootSessionId: 'parent', parentSessionId: 'parent',
    parentConversationId: 'turn', parentMessageId: 'reply', parentToolCallId: 'dispatch', childSessionId: 'child',
    task: 'Review', description: 'Review', modelId: 'model', status: 'running', lastSeq: 1, createdAt: 1, updatedAt: 1, usage: {},
    toolCalls: [
      { id: 'plan-ok', name: 'plan_update', status: 'succeeded' },
      { id: 'read', name: 'read_file', status: 'running' },
      { id: 'plan-failed', name: 'plan_update', status: 'failed', error: { code: 'STORE_FAILED', message: 'Plan unchanged', retryable: true } },
      { id: 'plan-running', name: 'todo_update', status: 'running' }
    ] }
}

test('full v1 and its real promoted view both count two visible calls and retain all four archive records', () => {
  const legacy = legacyRun(), view = toSubagentView(legacy)
  const before = JSON.stringify({ legacy, view })
  for (const run of [legacy, view]) {
    const display = subagentToolPresentation(run)
    expect(display.complete).toBe(true)
    expect(display.calls.map(call => call.id).sort()).toEqual(['plan-failed', 'read'])
    expect(display.calls.find(call => call.id === 'plan-failed')?.error?.message).toBe('Plan unchanged')
    expect(display.activeCalls).toBe(1)
    expect(display.unseenActiveCount).toBe(0)
    expect(display.countLabel).toBe('2 次调用')
  }
  expect(view.toolCount).toBe(4)
  expect(view.activeToolCount).toBe(2)
  expect(view.coverage.ids).toHaveLength(4)
  expect(JSON.stringify({ legacy, view })).toBe(before)
})

test('a bounded 4100-record view cannot turn its visible sample into a full visible total', () => {
  const legacy = legacyRun()
  legacy.toolCalls = Array.from({ length: 4100 }, (_, index) => ({ id: `tool-${index}`, name: index % 2 ? 'read_file' : 'plan_update', status: 'succeeded' }))
  const view = toSubagentView(legacy), before = JSON.stringify(view), display = subagentToolPresentation(view)
  expect(view.coverage.completeness).toBe('partial')
  expect(view.toolCalls.length).toBeLessThanOrEqual(64)
  expect(display.complete).toBe(false)
  expect(display.historyCount).toBe(4100)
  expect(display.calls.length).toBeLessThan(4100)
  expect(display.countLabel).toBe(`4,100 条历史记录 · 当前显示 ${display.calls.length} 次调用`)
  expect(JSON.stringify(view)).toBe(before)
})

test('true partial v2 keeps total and watermark while distinguishing known silent controls from unseen activity', () => {
  const view = toSubagentView(legacyRun())
  const silent = view.toolCalls.find(call => call.id === 'plan-running')!
  view.toolCalls = [silent]; view.latestActivity = silent; view.toolCount = 4100; view.activeToolCount = 2
  view.coverage = { asOfSeq: 1, toolCount: 4100, includedToolCount: 1, activeToolCount: 2, includedActiveToolCount: 1,
    ids: [silent.id], hasMore: true, truncated: true, completeness: 'partial' }
  const before = JSON.stringify(view), display = subagentToolPresentation(view)
  expect(display.complete).toBe(false)
  expect(display.calls).toEqual([])
  expect(display.activeCalls).toBe(0)
  expect(display.unseenActiveCount).toBe(1)
  expect(display.countLabel).toBe('4,100 条历史记录 · 当前显示 0 次调用')
  expect(view.coverage.asOfSeq).toBe(1)
  expect(view.toolCount).toBe(4100)
  expect(JSON.stringify(view)).toBe(before)
})

test('a complete run with only successful or running plan controls claims no visible operation', () => {
  const legacy = legacyRun()
  legacy.toolCalls = legacy.toolCalls.filter(call => ['plan-ok', 'plan-running'].includes(call.id))
  const display = subagentToolPresentation(toSubagentView(legacy))
  expect(display.complete).toBe(true)
  expect(display.countLabel).toBe('0 次调用')
  expect(display.activeCalls).toBe(0)
  expect(display.unseenActiveCount).toBe(0)
})

test('history uses negotiated server support rather than the local promoted schema version', () => {
  const legacy = legacyRun(), view = toSubagentView(legacy)
  expect(canPageSubagentHistory(view, 1)).toBe(false)
  expect(canPageSubagentHistory(view, null)).toBe(false)
  expect(canPageSubagentHistory(view, 2)).toBe(true)
  expect(canPageSubagentHistory(legacy, 2)).toBe(false)
  expect(canPageSubagentHistory(undefined, 2)).toBe(false)
})
