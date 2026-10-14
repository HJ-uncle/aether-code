/** Silent task-plan controls: live/end-only payloads, legacy replay, Work
 * counters, child transcripts, and independent snapshots without a renderer. */
import { expect, test } from '@playwright/test'
import type { ChatMessage, ToolActivity } from '../src/renderer/src/core/engine/useChat'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { replayMessages } from '../src/renderer/src/core/engine/chat-history'
import { reducePayload } from '../src/renderer/src/core/engine/chat-payload'
import { restoreChatSnapshot } from '../src/renderer/src/core/engine/chat-recovery'
import { exportSubagentDetails } from '../src/renderer/src/core/engine/subagent-state'
import { isTaskPlanControl, isSilentTaskPlanActivity, isVisibleToolActivity, taskPlanTranscriptRows } from '../src/renderer/src/core/engine/task-plan'
import { workMessageTimeline } from '../src/renderer/src/contrib/work/work-message-timeline'
import { workActivitySummary } from '../src/renderer/src/contrib/work/work-inline-activity-state'
import type { RootRun } from '../src/shared/root-run'
import type { SubagentRun } from '../src/shared/subagent'

const message = (): ChatMessage => ({ id: 'reply', role: 'assistant', content: '', thinking: '', tools: [], items: [], status: 'streaming', createdAt: 1 })
const receipt = (name: string, state: ToolActivity['state'] = 'done'): ToolActivity => ({ id: name, name, state, args: '{}', result: 'ok' })

test('only built-in task-plan identities are silent; failed, cancelled and interrupted controls remain actionable', () => {
  for (const name of ['plan_update', 'todo_create', 'todo_update', 'todo_delete', 'todo_list']) {
    expect(isTaskPlanControl(name)).toBe(true)
    for (const state of ['running', 'done', 'unknown'] as const) expect(isSilentTaskPlanActivity(receipt(name, state))).toBe(true)
    for (const state of ['error', 'cancelled', 'interrupted', 'waiting'] as const) expect(isVisibleToolActivity(receipt(name, state))).toBe(true)
    expect(isVisibleToolActivity({ name, status: 'failed' })).toBe(true)
    expect(isVisibleToolActivity({ name, status: 'succeeded', error: { message: 'store failed' } })).toBe(true)
    expect(isVisibleToolActivity({ name, metadata: { success: false } })).toBe(true)
  }
  for (const name of ['read_file', 'execute_cmd', 'mcp__server__todo_create', 'custom_plan_update', 'todo_create_extra']) {
    expect(isTaskPlanControl(name)).toBe(false)
    expect(isVisibleToolActivity(receipt(name))).toBe(true)
  }
})

test('mixed legacy controls do not inflate Work counts or displace the current real operation', () => {
  const tools = [receipt('todo_create'), receipt('read_file'), receipt('plan_update', 'running'), receipt('todo_list')]
  const input = { ...message(), content: '开始处理。', tools, items: tools.map(tool => ({ kind: 'tool' as const, id: tool.id })) }
  const segments = workMessageTimeline(input)
  expect(segments.map(segment => segment.kind === 'tools' ? segment.tools.map(tool => tool.name) : segment.text)).toEqual([['read_file'], '开始处理。'])
  expect(workActivitySummary(tools)?.label).toBe('已完成 · 读取文件')
  expect(workActivitySummary([receipt('plan_update'), receipt('todo_create')])).toBeNull()
  expect(input.tools).toHaveLength(4)
  expect(input.tools.every(tool => tool.hidden !== true)).toBe(true)
})

test('failed plan end-only payloads become visible receipts without changing the plan or faking completion', () => {
  const failed = reducePayload(message(), { toolEnd: { id: 'plan-failure', name: 'plan_update', args: { plan: [{ step: '验证功能', status: 'in_progress' }] }, success: false, error: 'TASK_PLAN_SAVE_FAILED', output: '保留原计划，请重试' } })
  expect(failed.tools).toHaveLength(1)
  expect(failed.tools[0]).toMatchObject({ state: 'error', error: 'TASK_PLAN_SAVE_FAILED' })
  expect(workActivitySummary(failed.tools)?.state).toBe('error')
  expect(workMessageTimeline(failed)[0]).toMatchObject({ kind: 'tools', tools: [{ name: 'plan_update', state: 'error' }] })
  const successful = reducePayload(message(), { toolEnd: { id: 'legacy-success', name: 'todo_create', success: true, output: 'created' } })
  expect(successful.tools[0].hidden).toBeUndefined()
  expect(workMessageTimeline(successful)).toEqual([])
})

test('legacy history stays exportable while replay and transcript show only failed plan controls and ordinary work', () => {
  const rows: EngineHistoryRow[] = [
    { id: 'assistant-plan', role: 'assistant', content: '先整理步骤。', toolCall: { id: 'plan', name: 'plan_update', args: { plan: [{ step: '整理步骤', status: 'pending' }] } } },
    { id: 'plan-ok', role: 'tool', toolCallId: 'plan', success: true, content: 'ok' },
    { id: 'assistant-list', role: 'assistant', toolCall: { id: 'list', name: 'todo_list' } },
    { id: 'list-ok', role: 'tool', toolCallId: 'list', metadata: { success: true }, content: 'list' },
    { id: 'assistant-fail', role: 'assistant', toolCall: { id: 'failure', name: 'todo_update' } },
    { id: 'fail', role: 'tool', toolCallId: 'failure', metadata: { success: false, error: 'write failed' }, content: 'retry' },
    { id: 'assistant-read', role: 'assistant', toolCall: { id: 'read', name: 'read_file' } },
    { id: 'read-result', role: 'tool', toolCallId: 'read', success: true, content: 'source' }
  ]
  const replay = replayMessages(rows)
  expect(replay[0].tools.map(tool => tool.name)).toEqual(['plan_update', 'todo_list', 'todo_update', 'read_file'])
  expect(replay[0].tools.filter(isVisibleToolActivity).map(tool => tool.name)).toEqual(['todo_update', 'read_file'])
  const displayed = taskPlanTranscriptRows(rows)
  expect(displayed.map(row => row.id)).toEqual(['assistant-plan', 'assistant-fail', 'fail', 'assistant-read', 'read-result'])
  expect(displayed[0]).toMatchObject({ content: '先整理步骤。', toolCall: undefined })
  expect(rows[0].toolCall?.name).toBe('plan_update')
  expect(taskPlanTranscriptRows([{ id: 'pending', role: 'assistant', toolCall: { id: 'incomplete', name: 'plan_update' } }])).toEqual([])
  expect(taskPlanTranscriptRows([{ id: 'paged-ok', role: 'tool', toolCallId: 'prior-page', metadata: { toolName: 'plan_update', success: true }, content: 'saved' }])).toEqual([])
  expect(taskPlanTranscriptRows([{ id: 'paged-failure', role: 'tool', toolCallId: 'prior-page', metadata: { toolName: 'plan_update', success: false }, content: 'retry' }]).map(row => row.id)).toEqual(['paged-failure'])
})

test('subagent tool counts use the same semantics without erasing audit or export records', () => {
  const run: SubagentRun = { schemaVersion: 1, runId: 'child', tenantId: 'tenant', rootSessionId: 'root', parentSessionId: 'root', parentToolCallId: 'dispatch', parentConversationId: 'turn', parentMessageId: 'message', childSessionId: 'child-session', task: 'review', description: 'Review', modelId: 'model', status: 'running', lastSeq: 1, createdAt: 1, updatedAt: 2, usage: {}, toolCalls: [
    { id: 'silent', name: 'plan_update', status: 'succeeded', args: { plan: [{ step: 'review', status: 'pending' }] }, output: 'created' },
    { id: 'reading', name: 'read_file', status: 'running' },
    { id: 'failed', name: 'todo_update', status: 'failed', error: { code: 'STORE_FAILED', message: 'storage unavailable', retryable: true } }
  ] }
  expect(run.toolCalls.filter(isVisibleToolActivity).map(call => call.id)).toEqual(['reading', 'failed'])
  expect(exportSubagentDetails({ ...receipt('subagent'), subagent: run })).toContain('更新任务计划')
  expect(exportSubagentDetails({ ...receipt('subagent'), subagent: run })).toContain('storage unavailable')
  expect(run.toolCalls).toHaveLength(3)
})

test('independent todo snapshots restore live and persisted plans; run success never marks unfinished steps done', () => {
  const run: RootRun = { schemaVersion: 1, runId: 'run', sessionId: 'session', turnId: 'turn', userMessageId: 'user', assistantMessageId: 'reply', seq: 1, version: 1, status: 'running', modelId: 'model', pending: [], workspacePaths: [], createdAt: 1, updatedAt: 2 }
  const todos = [{ id: 'step', title: '验证功能', status: 'in_progress' as const, priority: 'medium' as const }]
  const restored = restoreChatSnapshot({ schemaVersion: 1, source: 'live', sessionId: 'session', eventId: null, finished: false, history: [], runs: [run], run, projection: [{ todo: { todos } }, { content: '处理中。' }], todos: [], changes: [] })
  expect(restored.todos).toEqual(todos)
  expect(restored.messages[0].tools).toEqual([])
  const terminal = restoreChatSnapshot({ schemaVersion: 1, source: 'persisted', sessionId: 'session', eventId: null, finished: true, history: [], runs: [{ ...run, status: 'succeeded' }], projection: [], todos, changes: [] })
  expect(terminal.todos[0].status).toBe('in_progress')
  const cleared = restoreChatSnapshot({ schemaVersion: 1, source: 'live', sessionId: 'session', eventId: null, finished: false, history: [], runs: [run], run, projection: [{ todo: { todos: [] } }], todos, changes: [] })
  expect(cleared.todos).toEqual([])
})
