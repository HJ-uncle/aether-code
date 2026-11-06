/** Pure collaborator list presentation: actual assigned work, continuation
 * announcements and scoped search before display pagination. No Electron. */
import { expect, test } from '@playwright/test'
import type { SubagentRun } from '../src/shared/subagent'
import { workSubagentGroups } from '../src/renderer/src/contrib/work/work-subagents'
import { searchWorkSubagentGroups, workSubagentTaskSummary } from '../src/renderer/src/contrib/work/work-subagent-list-presentation'

function child(index: number, overrides: Partial<SubagentRun> = {}): SubagentRun {
  return {
    schemaVersion: 1, runId: `run-${index}`, tenantId: 'tenant', rootSessionId: 'parent', parentSessionId: 'parent',
    parentConversationId: 'turn', parentMessageId: 'message', parentToolCallId: `call-${index}`, childSessionId: `child-${index}`,
    task: `检查第 ${index} 项`, description: '检查', agentName: `Agent ${index}`, modelId: 'model', status: 'succeeded',
    lastSeq: 1, createdAt: index, updatedAt: index, usage: {}, toolCalls: [], ...overrides
  }
}

test('list summaries describe the actual assignment with compact whitespace', () => {
  const groups = workSubagentGroups('parent', [], [child(1, { task: '  检查登录表单\n 和键盘导航  ', description: '重复角色标签', resultSummary: '工具输出不得替代任务' })])
  expect(workSubagentTaskSummary(groups[0])).toBe('检查登录表单 和键盘导航')
  expect(searchWorkSubagentGroups(groups, '工具输出')).toEqual([])
  expect(searchWorkSubagentGroups(groups, 'model')).toEqual([])
})

test('a pending continuation shows its new assignment instead of a completed prior round', () => {
  const previous = child(1, { task: '先前已完成的任务' })
  const groups = workSubagentGroups('parent', [{
    id: 'new-announcement', name: 'subagent', state: 'running', startedAt: 10,
    args: JSON.stringify({ resumeRunId: previous.runId, task: '复核新加入的无障碍修改' }), result: ''
  }], [previous])
  expect(groups).toHaveLength(1)
  expect(workSubagentTaskSummary(groups[0])).toBe('复核新加入的无障碍修改')
  expect(searchWorkSubagentGroups(groups, '先前')).toEqual([])
})

test('search covers loaded off-page rows and preserves stable identities and order', () => {
  const groups = workSubagentGroups('parent', [], Array.from({ length: 127 }, (_, index) => child(index + 1)))
  const matches = searchWorkSubagentGroups(groups, 'AGENT 127')
  expect(matches.map(group => group.childSessionId)).toEqual(['child-127'])
  expect(matches[0]).toBe(groups[126])
  const named = searchWorkSubagentGroups(groups, '检查 12')
  expect(named.map(group => group.childSessionId)).toEqual(['child-12', 'child-112', 'child-120', 'child-121', 'child-122', 'child-123', 'child-124', 'child-125', 'child-126', 'child-127'])
  expect(searchWorkSubagentGroups(groups, '  ')).toEqual(groups)
  expect(searchWorkSubagentGroups(groups, '未载入的任务')).toEqual([])
  expect(groups).toHaveLength(127)
})

test('legacy malformed input stays readable without inventing task text', () => {
  const groups = workSubagentGroups('parent', [{ id: 'legacy', name: 'subagent', state: 'unknown', args: '{broken', result: '不可信的结果摘要' }], [])
  expect(workSubagentTaskSummary(groups[0])).toBe('')
  expect(searchWorkSubagentGroups(groups, '结果摘要')).toEqual([])
  expect(searchWorkSubagentGroups(groups, '协作代理')).toEqual(groups)
})
