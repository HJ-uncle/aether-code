/** Presentation-only grouping: successful runs retain IDs and chronology;
 * attention states and non-agent content must never disappear into a summary. */
import { expect, test } from '@playwright/test'
import type { ToolActivity } from '../src/renderer/src/core/engine/useChat'
import type { SubagentRunStatus } from '../src/shared/subagent'
import { captureWorkCollaborationMembership, workMessagePresentation } from '../src/renderer/src/contrib/work/work-message-timeline'

function agent(id: string, status: SubagentRunStatus = 'succeeded'): ToolActivity {
  return { id, name: 'subagent', args: '{}', result: '', state: status === 'succeeded' ? 'done' : 'running',
    subagent: { schemaVersion: 1, runId: id, tenantId: 'fixture', rootSessionId: 'parent', parentSessionId: 'parent',
      parentConversationId: 'turn', parentMessageId: 'message', parentToolCallId: id, childSessionId: `child-${id}`,
      task: '审阅文件', description: '审阅', modelId: 'fixture', status, lastSeq: 1, createdAt: 1, updatedAt: 2, usage: {}, toolCalls: [] } }
}

test('25 次完成协作归为一个摘要，保留每个原始工具与执行身份且不修改输入', () => {
  const tools = Array.from({ length: 25 }, (_, index) => agent(`run-${index}`))
  const before = structuredClone(tools)
  const presentation = workMessagePresentation([{ kind: 'tools', key: 'batch', tools }])
  expect(presentation).toEqual([{ kind: 'collaboration', key: 'tool:run-0', tools }])
  expect(presentation[0].kind === 'collaboration' && presentation[0].tools[22]).toBe(tools[22])
  expect(tools).toEqual(before)
})

test('运行等待失败中断和未加载引用保持独立，不用调度完成状态伪造成功', () => {
  const states: SubagentRunStatus[] = ['queued', 'running', 'cancelling', 'blocked', 'failed', 'cancelled', 'interrupted']
  const attention = states.map(status => ({ ...agent(status, status), state: 'done' as const }))
  const unknown = { ...agent('unknown'), subagent: undefined }
  const tools = [agent('a'), agent('b'), ...attention, unknown, agent('c'), agent('d')]
  const presentation = workMessagePresentation([{ kind: 'tools', key: 'batch', tools }])
  expect(presentation.map(item => item.kind)).toEqual(['collaboration', ...attention.map(() => 'tool'), 'tool', 'collaboration'])
  expect(presentation.filter(item => item.kind === 'tool').map(item => item.tool.id)).toEqual([...states, 'unknown'])
})

test('过程中的截图和其他操作断开协作摘要，单次协作保持原位', () => {
  const image: ToolActivity = { id: 'image', name: 'browser_screenshot', args: '{}', state: 'done',
    result: JSON.stringify({ filename: 'page.png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDdwAAAAASUVORK5CYII=' }) }
  const command: ToolActivity = { id: 'command', name: 'exec_command', args: '{}', result: 'ok', state: 'done' }
  const presentation = workMessagePresentation([
    { kind: 'tools', key: 'before', tools: [agent('a'), agent('b')] },
    { kind: 'content', key: 'explanation', text: '接下来检查页面。' },
    { kind: 'tools', key: 'after', tools: [agent('c'), image, agent('d'), command, agent('e')] },
    { kind: 'content', key: 'answer', text: '检查完成。' }
  ])
  expect(presentation.map(item => item.kind)).toEqual(['collaboration', 'process', 'tool', 'process', 'tool', 'process', 'tool', 'answer'])
  expect(presentation.filter(item => item.kind === 'tool').map(item => item.tool.id)).toEqual(['c', 'd', 'e'])
  expect(presentation[3]).toEqual({ kind: 'process', key: 'tool:image', segments: [{ kind: 'tools', key: 'tool:image', tools: [image] }] })
  expect(presentation.at(-1)).toEqual({ kind: 'answer', key: 'answer', text: '检查完成。' })
})

test('用户已阅读的独立卡片在相邻代理完成后仍保持原位，未交互消息继续聚合', () => {
  const initial = workMessagePresentation([{ kind: 'tools', key: 'batch', tools: [agent('a'), agent('b', 'running')] }])
  const membership = captureWorkCollaborationMembership(initial)
  const completed = [agent('a'), agent('b')]
  completed[1].result = '刚完成的最新结果'
  const next = workMessagePresentation([{ kind: 'tools', key: 'batch', tools: completed }], membership)
  expect(next.map(item => [item.kind, item.key])).toEqual([['tool', 'tool:a'], ['tool', 'tool:b']])
  expect(next[1].kind === 'tool' && next[1].tool).toBe(completed[1])
  expect(next[1].kind === 'tool' && next[1].tool.result).toBe('刚完成的最新结果')
  expect(workMessagePresentation([{ kind: 'tools', key: 'batch', tools: completed }]).map(item => item.kind)).toEqual(['collaboration'])
})

test('已交互消息保留两组边界，不吸收组间刚完成或后来加入的代理', () => {
  const initial = workMessagePresentation([{ kind: 'tools', key: 'batch', tools: [
    agent('a'), agent('b'), agent('reading', 'running'), agent('c'), agent('d')
  ] }])
  const membership = captureWorkCollaborationMembership(initial)
  const updated = ['a', 'b', 'reading', 'c', 'd', 'new-a', 'new-b'].map(id => agent(id))
  const next = workMessagePresentation([{ kind: 'tools', key: 'batch', tools: updated }], membership)
  expect(next.map(item => [item.kind, item.key])).toEqual([
    ['collaboration', 'tool:a'], ['tool', 'tool:reading'], ['collaboration', 'tool:c'], ['tool', 'tool:new-a'], ['tool', 'tool:new-b']
  ])
  expect(next.filter(item => item.kind === 'collaboration').map(item => item.tools.map(tool => tool.id))).toEqual([['a', 'b'], ['c', 'd']])
  expect(next[0].kind === 'collaboration' && next[0].tools[1]).toBe(updated[1])
})

test('固定分组不冻结状态，失败或状态缺失的成员仍从完成摘要中露出', () => {
  const initial = workMessagePresentation([{ kind: 'tools', key: 'batch', tools: ['a', 'b', 'c'].map(id => agent(id)) }])
  const membership = captureWorkCollaborationMembership(initial)
  for (const replacement of [agent('b', 'blocked'), { ...agent('b'), subagent: undefined }]) {
    const next = workMessagePresentation([{ kind: 'tools', key: 'batch', tools: [agent('a'), replacement, agent('c')] }], membership)
    expect(next.map(item => item.kind)).toEqual(['tool', 'tool', 'tool'])
    expect(next[1].kind === 'tool' && next[1].tool).toBe(replacement)
  }
})
