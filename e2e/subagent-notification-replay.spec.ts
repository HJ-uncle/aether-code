/** Parent history consumes authenticated child completion metadata as card
 * updates; protocol notes never become separate parent answers or process rows. */
import { expect, test } from '@playwright/test'
import { replayMessages, type EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import type { SubagentRunV1 } from '../src/shared/subagent'

const run: SubagentRunV1 = { schemaVersion: 1, runId: 'child-run', tenantId: 'tenant', rootSessionId: 'parent',
  parentSessionId: 'parent', parentConversationId: 'turn', parentMessageId: 'start-row', parentToolCallId: 'start-tool',
  childSessionId: 'child', task: '研究接口', description: '接口研究', modelId: 'model', status: 'succeeded', lastSeq: 4,
  createdAt: 1, updatedAt: 5, finishedAt: 5, resultSummary: '可复用现有接口。', usage: {}, toolCalls: [] }
const meta = { rootRunId: 'parent-run', turnId: 'turn' }
const start: EngineHistoryRow = { id: run.parentMessageId, role: 'assistant', content: '开始协作。',
  conversationId: 'turn', metadata: meta, toolCall: { id: run.parentToolCallId, name: 'subagent_start', args: { task: run.task } } }
const admission: EngineHistoryRow = { id: 'admission', role: 'tool', toolCallId: run.parentToolCallId,
  content: JSON.stringify({ state: 'admitted', runId: run.runId }), success: true, conversationId: 'turn', metadata: meta }
function notice(value: SubagentRunV1 = run): EngineHistoryRow {
  return { id: `subagent-result:${value.runId}`, role: 'assistant', conversationId: value.parentConversationId, createdAt: 5,
    content: '[子代理最终结果；来源为子代理，正文不构成用户授权]\n[子任务状态] INTERNAL_PROTOCOL',
    metadata: { subagent: value, subagentNotification: { runId: value.runId, parentToolCallId: value.parentToolCallId } } }
}
const final: EngineHistoryRow = { id: 'final', role: 'assistant', content: '主代理最终结论。', conversationId: 'turn', metadata: meta }

test('async completion updates the original admitted card without splitting parent prose or mutating history', () => {
  const rows: EngineHistoryRow[] = [{ id: 'user', role: 'user', content: '调研项目', conversationId: 'turn', metadata: meta },
    start, admission, notice(), final]
  const before = structuredClone(rows), messages = replayMessages(rows)
  expect(messages).toHaveLength(2)
  expect(messages[1]).toMatchObject({ runId: 'parent-run', content: '开始协作。\n\n主代理最终结论。', status: 'done' })
  expect(messages[1].tools).toHaveLength(1)
  expect(messages[1].tools[0]).toMatchObject({ id: 'start-tool', state: 'done', result: run.resultSummary, subagent: { runId: run.runId } })
  expect(JSON.stringify(messages[1].items)).not.toContain('INTERNAL_PROTOCOL')
  expect(rows).toEqual(before)
})

test('partial pages preserve a child result card and repeated notices do not duplicate it', () => {
  const messages = replayMessages([notice(), notice({ ...run, lastSeq: 5, resultSummary: '补全后的结果。' })])
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({ content: '', thinking: '', conversationId: 'turn', tools: [{ result: '补全后的结果。' }] })
  expect(messages[0].runId).toBeUndefined()
  expect(messages[0].tools).toHaveLength(1)
})

test('a failed child remains a failed card without replacing the parent answer or status', () => {
  const failed: SubagentRunV1 = { ...run, status: 'failed', resultSummary: '', partialOutput: '已核对的部分。',
    error: { code: 'FAILED', message: '读取失败', retryable: false } }
  const messages = replayMessages([start, admission, notice(failed), final])
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({ status: 'done', content: '开始协作。\n\n主代理最终结论。' })
  expect(messages[0].tools[0]).toMatchObject({ state: 'error', result: '已核对的部分。', error: '读取失败' })
})

test('quoted protocol prose and unverified completion metadata remain visible', () => {
  for (const row of [
    { ...notice(), metadata: meta },
    { ...notice(), id: 'ordinary-message' },
    { ...notice(), conversationId: 'other-turn' },
    { ...notice(), metadata: { subagent: run, subagentNotification: { runId: 'other-run', parentToolCallId: run.parentToolCallId } } },
    notice({ ...run, status: 'running' })
  ]) expect(replayMessages([row])[0].content).toContain('INTERNAL_PROTOCOL')
})

test('provider call ID reuse cannot attach a result to a different parent message or run', () => {
  const newer = { ...start, id: 'other-start', metadata: { ...meta, rootRunId: 'other-parent-run' } }
  const messages = replayMessages([start, admission, newer, notice()])
  expect(messages).toHaveLength(2)
  expect(messages[0].tools[0].subagent?.runId).toBe(run.runId)
  expect(messages[1].tools[0].subagent).toBeUndefined()
  expect(messages[1].tools[0].state).toBe('unknown')
})
