/** Inline Work activity: durable job states, mixed-result summaries and
 * session-relative targets, without relying on a renderer or live model. */
import { expect, test } from '@playwright/test'
import type { ToolActivity } from '../src/renderer/src/core/engine/useChat'
import type { SubagentRun } from '../src/shared/subagent'
import type { CommandJobSnapshot } from '../src/shared/command-job'
import { workActivityState, workActivitySummary } from '../src/renderer/src/contrib/work/work-inline-activity-state'

const tool = (id: string, state: ToolActivity['state'] = 'done'): ToolActivity => ({
  id, state, name: 'read_file', args: '{"path":"src/feature.ts"}', result: 'export const answer = 42'
})
const child = (status: SubagentRun['status']): SubagentRun => ({
  schemaVersion: 1, runId: 'child-run', tenantId: 'desktop', rootSessionId: 'root',
  parentSessionId: 'root', parentConversationId: 'turn', parentMessageId: 'message',
  parentToolCallId: 'dispatch', childSessionId: 'child', task: 'Review', description: 'Review',
  modelId: 'provider-model', status, lastSeq: 1, createdAt: 1, updatedAt: 2, usage: {}, toolCalls: []
})
const job = (status: CommandJobSnapshot['status']): CommandJobSnapshot => ({
  schemaVersion: 1, jobId: 'job', sessionId: 'root', ownerSessionId: 'root', version: 1,
  command: 'node', args: ['test.cjs'], cwd: 'D:/project', background: true, status,
  createdAt: 1, updatedAt: 2, cursor: 0, earliestCursor: 0, exitCode: null, signal: null
})

test('后台命令与子代理的执行状态优先于已完成的派发回执', () => {
  const background = { ...tool('dispatch'), name: 'execute_cmd', commandJob: job('running') }
  const collaborator = { ...tool('child-dispatch'), name: 'subagent', subagent: child('running') }
  expect(workActivityState(background)).toBe('running')
  expect(workActivityState(collaborator)).toBe('running')
  const summary = workActivitySummary([tool('finished'), background, collaborator])
  expect(summary?.tool.id).toBe('child-dispatch')
  expect(summary?.label).toContain('1/3 已完成')
  expect(summary?.state).toBe('running')
  expect(workActivityState({ ...background, commandJob: job('cancelled') })).toBe('cancelled')
  expect(workActivityState({ ...collaborator, subagent: child('failed') })).toBe('error')
})

test('组内失败与取消不能被最后一个成功工具掩盖；活跃操作优先展示', () => {
  const summary = workActivitySummary([tool('failed', 'error'), tool('succeeded')])
  expect(summary?.state).toBe('error')
  expect(summary?.tool.id).toBe('failed')
  expect(summary?.label).toContain('1/2 已完成')
  expect(summary?.label).not.toMatch(/^已完成/)
  expect(workActivitySummary([tool('failed', 'error'), tool('active', 'waiting')])?.tool.id).toBe('active')
  expect(workActivitySummary([tool('cancelled', 'cancelled'), tool('done')])?.state).toBe('cancelled')
  expect(workActivitySummary([])).toBeNull()
  expect(workActivitySummary([tool('a'), tool('b')])?.label).toContain('已完成 2 项操作')
})

test('摘要使用任务工作目录，不闪现流式未完成参数', () => {
  const input = { ...tool('a'), args: '{"path":"D:/project/src/feature.ts"}' }
  expect(workActivitySummary([input], 'D:/project')?.target).toBe('src/feature.ts')
  expect(workActivitySummary([{ ...input, args: '{"path":' }], 'D:/project')?.target).toBe('')
})
