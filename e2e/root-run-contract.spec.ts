/** D3 stable message ownership, durable request identity and honest root/tool outcomes. */
import { expect, test } from '@playwright/test'
import type { RootRun } from '../src/shared/root-run'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
import { applyRootRun, applyRootRuns, finishTransport, mergeRootRun } from '../src/renderer/src/core/engine/root-run-state'
import { buildToolResponse, normalizeRunPending } from '../src/renderer/src/core/engine/pending'
import { finishTool, replayMessages } from '../src/renderer/src/core/engine/chat-history'

function run(patch: Partial<RootRun> = {}): RootRun {
  return { schemaVersion: 1, runId: 'run-2', sessionId: 'session', turnId: 'turn-2', userMessageId: 'server-user-2',
    assistantMessageId: 'server-assistant-2', seq: 2, version: 1, status: 'running', createdAt: 1000, updatedAt: 1100,
    modelId: 'original-model', workspacePaths: ['original-workspace'], pending: [], ...patch }
}
function message(id: string, role: 'user' | 'assistant', patch: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, content: role === 'user' ? '继续' : '', thinking: '', tools: [], items: [], status: role === 'user' ? 'done' : 'streaming', createdAt: 1000, ...patch }
}
test('同正文只回填明确optimistic IDs，后续assistant ID变化仍归原run', () => {
  const initial = [message('user-1', 'user'), message('assistant-1', 'assistant'), message('local-user-2', 'user'), message('local-assistant-2', 'assistant')]
  const bound = applyRootRun(initial, run(), { userId: 'local-user-2', assistantId: 'local-assistant-2' })
  expect(bound.map(item => item.id)).toEqual(['user-1', 'assistant-1', 'server-user-2', 'server-assistant-2'])
  expect(bound[2].conversationId).toBe('turn-2')
  expect(bound[0].conversationId).toBeUndefined()
  const finished = applyRootRun(bound, run({ version: 2, assistantMessageId: 'final-assistant', status: 'failed', error: { message: 'provider failed' } }))
  expect(finished[3]).toMatchObject({ id: 'final-assistant', runId: 'run-2', status: 'error', error: 'provider failed' })
  expect(finished[1]).toEqual(initial[1])
})
test('旧version不能将已完成轮次复活', () => {
  const ended = run({ version: 4, status: 'succeeded' })
  expect(mergeRootRun(ended, run({ version: 3 }))).toBe(ended)
  expect(applyRootRun([message('server-assistant-2', 'assistant', { run: ended, runId: ended.runId, status: 'done' })], run())[0].status).toBe('done')
})
test('传输done或失败不伪造业务成功，等待状态与最终失败保留', () => {
  expect(finishTransport(message('a', 'assistant', { run: run() })).status).toBe('interrupted')
  expect(finishTransport(message('a', 'assistant'), 'connection lost')).toMatchObject({ status: 'error', error: 'connection lost' })
  const waiting = message('a', 'assistant', { status: 'waiting', run: run({ status: 'waiting' }) })
  expect(finishTransport(waiting).status).toBe('waiting')
  const failed = message('a', 'assistant', { status: 'error', error: 'provider failed', run: run({ status: 'failed' }) })
  expect(finishTransport(failed)).toBe(failed)
})
test('历史恢复缺少assistant行时仍根据run重建等待卡并保留request ID', () => {
  const waiting = run({ status: 'waiting', pending: [{ requestId: 'request-7', kind: 'ask', toolCallId: 'call-3', toolName: 'ask_user', args: { question: '输入目标分支' }, status: 'pending' }] })
  const restored = applyRootRuns(replayMessages([{ id: waiting.userMessageId, role: 'user', content: '继续', conversationId: waiting.turnId }]), [waiting])
  expect(restored).toHaveLength(2)
  expect(restored[0].conversationId).toBe(waiting.turnId)
  expect(restored[1]).toMatchObject({ id: waiting.assistantMessageId, status: 'waiting', modelId: 'original-model', pending: { requestId: 'request-7', runId: waiting.runId } })
  expect(buildToolResponse(restored[1].pending!, ['feature'])).toEqual({ requestId: 'request-7', runId: waiting.runId, toolCallId: 'call-3', name: 'ask_user', output: 'feature' })
})
test('不同请求ID即使同toolcall也保留审批记录，拒绝不可显示放行', () => {
  const item = { requestId: 'request', kind: 'permission' as const, toolCallId: 'call', toolName: 'write_file', args: { path: 'file' }, status: 'answered' as const, output: 'rejected' }
  const pending = normalizeRunPending(item, 'run')!
  expect(pending).toMatchObject({ requestId: 'request', toolCallId: 'call', status: 'answered', output: 'rejected' })
  const restored = applyRootRun([message('server-user-2','user'), message('server-assistant-2','assistant')], run({ status:'succeeded', pending:[item] }))
  expect(restored[1].pending).toBeUndefined()
  expect(restored[1].interactions?.[0].output).toBe('rejected')
})
test('工具waiting/interrupted/cancelled及预览、耗时、metadata同形回放', () => {
  const previous = { id: 'tool', name: 'read_file', args: '{}', result: '', state: 'running' as const }
  for (const status of ['waiting', 'interrupted', 'cancelled'] as const) {
    expect(finishTool(previous, { status, outputPreview: 'short output', durationMs: 27, metadata: { source: 'fixture' } })).toMatchObject({ state: status, result: 'short output', durationMs: 27, metadata: { source: 'fixture' } })
  }
  const replayed = replayMessages([{ role: 'assistant', id: 'a', toolCall: { id:'tool',name:'read_file' } }, { role:'tool',toolCallId:'tool',content:'',metadata:{status:'failed',outputPreview:'failed preview',durationMs:14,error:'missing'} }])
  expect(replayed[0].tools[0]).toMatchObject({ state:'error',result:'failed preview',durationMs:14,error:'missing' })
  expect(replayMessages([{role:'assistant',toolCall:{id:'unsettled',name:'write_file'}}])[0].tools[0].state).toBe('unknown')
})

test('批准应答仅代表已批准，工具收到结果前不能显示成功；取消等待不留运行占位', () => {
  const pending = { requestId: 'approval', kind: 'permission' as const, toolCallId: 'write', toolName: 'write_file', args: {}, status: 'answered' as const, output: 'approved' }
  const assistant = message('server-assistant-2', 'assistant', { tools: [{id:'write',name:'write_file',args:'{}',result:'',state:'waiting'}] })
  expect(applyRootRun([assistant], run({pending:[pending]}))[0].tools[0].state).toBe('running')
  expect(applyRootRun([assistant], run({status:'cancelled',pending:[{...pending,status:'pending'}]}))[0].tools[0].state).toBe('cancelled')
})
