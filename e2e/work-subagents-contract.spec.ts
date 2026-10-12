// Pure contracts: child identity, live run reconciliation, continuation request intent.
import { expect, test } from '@playwright/test'
import type { SubagentRun } from '../src/shared/subagent'
import { buildWorkSubagentContinuation, workSubagentRole, workSubagentTools } from '../src/renderer/src/contrib/work/work-subagents'

const run: SubagentRun = {
  schemaVersion: 1, runId: 'child-run', tenantId: 'tenant', rootSessionId: 'parent', parentSessionId: 'parent',
  parentConversationId: 'turn', parentMessageId: 'message', parentToolCallId: 'tool', childSessionId: 'same-child',
  task: 'Review', description: 'Reviewer', modelId: 'fixture', status: 'succeeded', lastSeq: 2,
  createdAt: 1, updatedAt: 2, usage: {}, toolCalls: [], continuation: { role: 'spec-reviewer', readOnly: true }
}
test('Work reconciles one child invocation and excludes other parent sessions', () => {
  const tools = workSubagentTools('parent', [{ id: 'tool', name: 'subagent', args: '{"role":"spec-reviewer"}', result: '', state: 'running' }], [run, { ...run, runId: 'outside', parentSessionId: 'other' }])
  expect(tools).toHaveLength(1)
  expect(tools[0].state).toBe('done')
  expect(tools[0].subagent?.childSessionId).toBe('same-child')
  expect(workSubagentRole(tools[0].args)).toBe('需求审查')
})
test('Work keeps independent run history for repeated use of one child context', () => {
  const tools = workSubagentTools('parent', [], [run, { ...run, runId: 'next-run', parentToolCallId: 'next-tool', resumeFromRunId: run.runId, status: 'running' }])
  expect(tools.map(tool => tool.subagent?.runId)).toEqual(['child-run', 'next-run'])
  expect(tools.map(tool => tool.subagent?.childSessionId)).toEqual(['same-child', 'same-child'])
})
test('continuation binds the original run and preserves punctuation in the user prompt', () => {
  const message = buildWorkSubagentContinuation(run, '  检查 "first"\n然后继续  ')
  expect(JSON.parse(message.slice(message.indexOf('\n') + 1))).toEqual({ resumeRunId: 'child-run', task: '检查 "first"\n然后继续' })
  expect(workSubagentRole('not-json')).toBe('子代理')
})
