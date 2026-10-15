// Pure contracts: durable child identity, independent rounds, honest running and legacy states.
import { expect, test } from '@playwright/test'
import type { SubagentRun } from '../src/shared/subagent'
import { formatWorkSubagentDuration, resolveWorkSubagentGroup, workSubagentGroups, workSubagentName, workSubagentStats } from '../src/renderer/src/contrib/work/work-subagents'

function child(overrides: Partial<SubagentRun> = {}): SubagentRun {
  return {
    schemaVersion: 1, runId: 'run-one', tenantId: 'tenant', rootSessionId: 'parent', parentSessionId: 'parent',
    parentConversationId: 'turn-one', parentMessageId: 'message-one', parentToolCallId: 'call-one', childSessionId: 'review-context',
    task: 'Review accessibility', description: 'Review the form', modelId: 'model-one', status: 'succeeded', lastSeq: 3,
    createdAt: 10, updatedAt: 20, usage: {}, toolCalls: [], continuation: { role: 'spec-reviewer', readOnly: true },
    ...overrides
  }
}

test('three rounds form one durable child, retain all output and use newest round for continuation', () => {
  const first = child({ resultSummary: 'First review' })
  const second = child({ runId: 'run-two', parentToolCallId: 'call-two', resumeFromRunId: first.runId, createdAt: 30, updatedAt: 40, resultSummary: 'Second review' })
  const third = child({ runId: 'run-three', parentToolCallId: 'call-three', resumeFromRunId: second.runId, createdAt: 50, updatedAt: 60, status: 'running', partialOutput: 'Third review in progress' })
  const groups = workSubagentGroups('parent', [], [third, first, second])
  expect(groups).toHaveLength(1)
  expect(groups[0].childSessionId).toBe('review-context')
  expect(groups[0].label).toBe('需求审查')
  expect(groups[0].active).toBe(true)
  expect(groups[0].latest.subagent?.runId).toBe('run-three')
  expect(groups[0].tools.map(tool => tool.result)).toEqual(['Third review in progress', 'Second review', 'First review'])
})

test('late updates to an old round cannot replace the newest continuation context', () => {
  const groups = workSubagentGroups('parent', [], [child({ updatedAt: 500 }), child({ runId: 'new', parentToolCallId: 'new-call', resumeFromRunId: 'run-one', createdAt: 30, updatedAt: 40 })])
  expect(groups[0].latest.subagent?.runId).toBe('new')
})

test('child rows keep creation order when live updates change their timestamps', () => {
  const first = child({ childSessionId: 'first-context', runId: 'first', parentToolCallId: 'first-call', createdAt: 10, updatedAt: 100 })
  const second = child({ childSessionId: 'second-context', runId: 'second', parentToolCallId: 'second-call', createdAt: 20, updatedAt: 200 })
  const third = child({ childSessionId: 'third-context', runId: 'third', parentToolCallId: 'third-call', createdAt: 30, updatedAt: 300 })
  const initial = workSubagentGroups('parent', [], [first, second, third])
  const afterUpdates = workSubagentGroups('parent', [], [
    { ...third, updatedAt: 9000 },
    { ...first, updatedAt: 10000 },
    { ...second, updatedAt: 11000 }
  ])
  expect(initial.map(group => group.childSessionId)).toEqual(['first-context', 'second-context', 'third-context'])
  expect(afterUpdates.map(group => group.childSessionId)).toEqual(initial.map(group => group.childSessionId))
})

test('same named agents remain independent while foreign parents and legacy states are isolated', () => {
  const groups = workSubagentGroups('parent', [
    { id: 'legacy', name: 'subagent', args: '{}', result: 'Unverified legacy output', state: 'unknown' },
    { id: 'ordinary', name: 'read_file', args: '{}', result: '', state: 'done' }
  ], [child(), child({ childSessionId: 'second-context', runId: 'second', parentToolCallId: 'second-call', status: 'running' }), child({ parentSessionId: 'other', runId: 'outside', parentToolCallId: 'outside-call' })])
  expect(groups).toHaveLength(3)
  expect(groups.filter(group => group.active)).toHaveLength(1)
  expect(groups.find(group => group.key === 'legacy:legacy')?.latest.state).toBe('unknown')
  expect(groups.filter(group => group.label === '需求审查')).toHaveLength(2)
  expect(groups.flatMap(group => group.tools).some(tool => tool.id === 'outside-call')).toBe(false)
})

test('status is active until cancellation is confirmed, preserving completed round output', () => {
  const completed = child({ resultSummary: 'Prior output' })
  const cancelling = child({ runId: 'next', parentToolCallId: 'next-call', status: 'cancelling', createdAt: 30, updatedAt: 40 })
  const active = workSubagentGroups('parent', [], [completed, cancelling])[0]
  expect(active.active).toBe(true)
  const stopped = workSubagentGroups('parent', [], [completed, { ...cancelling, status: 'cancelled', lastSeq: 4 }])[0]
  expect(stopped.active).toBe(false)
  expect(stopped.tools[1].result).toBe('Prior output')
})

test('agent display name takes precedence over role and task description', () => {
  const run = { ...child(), agentName: '前端工程师' }
  expect(workSubagentName({ id: run.parentToolCallId, name: 'subagent', args: '{}', result: '', state: 'done', subagent: run })).toBe('前端工程师')
  expect(workSubagentName({ id: 'description', name: 'subagent', args: '{}', result: '', state: 'done', subagent: child({ continuation: undefined }) })).toBe('Review the form')
})

test('preparation uses the selected Agent description and its open detail resolves to the arriving child', () => {
  const pending = { id: 'call-one', name: 'subagent', args: '{"agentId":"frontend","description":"前端工程师 · 协作任务"}', result: '', state: 'running' as const, startedAt: 10 }
  const preparing = workSubagentGroups('parent', [pending], [])
  expect(preparing[0].label).toBe('前端工程师 · 协作任务')
  const selectedKey = preparing[0].key
  const started = workSubagentGroups('parent', [pending], [child({ agentId: 'frontend', agentName: '前端工程师', status: 'running' })])
  expect(started).toHaveLength(1)
  expect(resolveWorkSubagentGroup(started, selectedKey)?.key).toBe('child:review-context')
  expect(resolveWorkSubagentGroup(started, selectedKey)?.label).toBe('前端工程师')
  expect(resolveWorkSubagentGroup(started, 'legacy:unrelated-call')).toBeUndefined()
})

test('a continuation announcement joins the existing context before its new run snapshot arrives', () => {
  const groups = workSubagentGroups('parent', [{ id: 'next-call', name: 'subagent', args: '{"resumeRunId":"run-one","description":"前端工程师 · 协作任务"}', result: '', state: 'running', startedAt: 30 }], [child({ agentName: '前端工程师' })])
  expect(groups).toHaveLength(1)
  expect(groups[0].childSessionId).toBe('review-context')
  expect(groups[0].label).toBe('前端工程师')
  expect(groups[0].active).toBe(true)
  expect(groups[0].latest.id).toBe('next-call')
  expect(groups[0].tools).toHaveLength(2)
  expect(resolveWorkSubagentGroup(groups, 'legacy:next-call')?.key).toBe('child:review-context')
})

test('row stats expose real model, bounded tool counts, latest tool and deterministic duration', () => {
  const groups = workSubagentGroups('parent', [], [child({
    status: 'running', modelId: 'reasoning-model', startedAt: 1000, updatedAt: 2500,
    toolCalls: [{ id: 'read', name: 'read_file', args: {}, status: 'succeeded', startedAt: 1000, finishedAt: 1500 },
      { id: 'search', name: 'search', args: {}, status: 'running', startedAt: 2000 }]
  })])
  const stats = workSubagentStats(groups[0], 4000)
  expect(stats).toMatchObject({ modelId: 'reasoning-model', status: 'running', runId: 'run-one', startedAt: 1000, updatedAt: 2500, durationMs: 3000, toolCount: 2, activeToolCount: 1, pending: false })
  expect(stats.latestTool).toMatchObject({ name: 'search', status: 'running' })
  expect(formatWorkSubagentDuration(stats.durationMs)).toBe('3 秒')
})

test('queued preparation reports pending without inventing model or duration', () => {
  const groups = workSubagentGroups('parent', [{ id: 'queued-call', name: 'subagent', args: '{}', result: '', state: 'running', startedAt: 100 }], [])
  const stats = workSubagentStats(groups[0], 5000)
  expect(stats).toMatchObject({ status: 'running', toolCount: 0, activeToolCount: 0, pending: true })
  expect(stats.modelId).toBe('')
  expect(stats.durationMs).toBe(4900)
})

test('continuation announcement keeps the previous round from masquerading as current', () => {
  const groups = workSubagentGroups('parent', [{ id: 'next-call', name: 'subagent', args: '{"resumeRunId":"run-one"}', result: '', state: 'running', startedAt: 3000 }], [child({ startedAt: 1000, finishedAt: 2000 })])
  const stats = workSubagentStats(groups[0], 4500)
  expect(stats).toMatchObject({ pending: true, startedAt: 3000, durationMs: 1500 })
  expect(stats.latestTool).toBeUndefined()
})
