/** Pure Work turn grouping: segmented assistant progress/tools share one process,
 * while the last assistant retains final identity and partial archives keep all source rows intact. */
import { expect, test } from '@playwright/test'
import type { ChatMessage, ToolActivity } from '../src/renderer/src/core/engine/useChat'
import { workConversationEntries, workConversationGroups } from '../src/renderer/src/contrib/work/work-conversation-turns'

const tool: ToolActivity = { id: 'read-input', name: 'read_file', args: '{"path":"input.txt"}', result: 'input contents', state: 'done' }
function message(id: string, role: ChatMessage['role'], text: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, content: text, thinking: '', tools: [], items: text ? [{ kind: 'content', text }] : [],
    status: 'done', createdAt: 10, runId: 'root', conversationId: 'turn', ...overrides }
}
const admission = () => message('user', 'user', '核对输入并给出结论')
const progress = () => message('progress', 'assistant', '先检查输入。')
const operation = () => message('operation', 'assistant', '', { tools: [tool], items: [{ kind: 'tool', id: tool.id }] })
const followup = () => message('supplement', 'user', '补充：请列出依据。', {
  rootFollowup: { messageId: 'delivery', rootRunId: 'root', turnId: 'turn' }
})

test('ordinary assistant iterations share the complete ordered timeline and exact last-assistant identity', () => {
  const last = message('final', 'assistant', '核对完成。', {
    finalResult: { schemaVersion: 1, runId: 'root', turnId: 'turn', sessionId: 'task', assistantMessageId: 'final',
      text: '核对完成。', items: [], publishedAt: 20 }
  })
  const messages = [admission(), progress(), operation(), last], original = structuredClone(messages)
  const group = workConversationGroups(messages)[0], entries = workConversationEntries(group)
  expect(entries).toHaveLength(2)
  expect(entries[0].message).toBe(messages[0])
  expect(entries[1].message).toBe(last)
  expect(entries[1].message.finalResult).toBe(last.finalResult)
  expect(entries[1].message.content).toBe('核对完成。')
  expect(entries[1].key).toBe(`${group.id}:assistant`)
  expect(entries[1].processKey).toBe(group.id)
  expect(entries[1].segments).toEqual([
    { kind: 'content', key: 'user:assistant:0:content:0', text: '先检查输入。' },
    { kind: 'tools', key: 'user:assistant:1:tool:read-input', tools: [tool] },
    { kind: 'content', key: 'user:assistant:2:content:0', text: '核对完成。' }
  ])
  expect(messages).toEqual(original)
})

test('a single assistant keeps the original entry shape and process key', () => {
  const messages = [admission(), message('one', 'assistant', '直接答复。')]
  const group = workConversationGroups(messages)[0], entries = workConversationEntries(group)
  expect(entries).toEqual([
    { key: 'user', message: messages[0], segments: undefined },
    { key: `${group.id}:assistant`, message: messages[1], processKey: group.id,
      segments: [{ kind: 'content', key: 'user:assistant:0:content:0', text: '直接答复。' }] }
  ])
})

test('supplement messages remain chronological inside the shared process without rewriting original rows', () => {
  const supplement = followup(), last = message('final', 'assistant', '依据已补充。')
  const messages = [admission(), progress(), supplement, operation(), last], original = structuredClone(messages)
  const entries = workConversationEntries(workConversationGroups(messages)[0])
  expect(entries.map(entry => entry.message.id)).toEqual(['user', 'final'])
  expect(entries[1].segments?.map(segment => segment.kind)).toEqual(['content', 'followup', 'tools', 'content'])
  expect(entries[1].segments?.[1]).toEqual({ kind: 'followup', key: supplement.id, message: supplement })
  expect(entries[1].segments?.map(segment => segment.key)).toEqual([
    'user:assistant:0:content:0', 'supplement', 'supplement:assistant:0:tool:read-input', 'supplement:assistant:1:content:0'
  ])
  expect(messages).toEqual(original)
})

test('partial archives share their known turn without inventing an admission or repeating an orphan supplement', () => {
  for (const messages of [[progress(), operation()], [followup(), progress(), operation()]]) {
    const original = structuredClone(messages), group = workConversationGroups(messages)[0]
    const entries = workConversationEntries(group)
    const orphanSupplement = messages.find(item => item.role === 'user')
    expect(entries.map(entry => entry.message.id)).toEqual(orphanSupplement ? [orphanSupplement.id, 'operation'] : ['operation'])
    expect(entries.at(-1)?.message).toBe(messages.at(-1))
    expect(entries.at(-1)?.segments?.map(segment => segment.kind)).toEqual(['content', 'tools'])
    expect(entries.at(-1)?.segments?.[0]).toMatchObject({ kind: 'content', text: '先检查输入。' })
    expect(entries.at(-1)?.segments?.[1]).toMatchObject({ kind: 'tools', tools: [tool] })
    expect(entries.at(-1)?.processKey).toBe(group.id)
    if (orphanSupplement) expect(entries[0].message).toBe(orphanSupplement)
    expect(messages).toEqual(original)
  }
})

test('each root keeps its own admission and final owner across adjacent conversation turns', () => {
  const nextUser = message('next-user', 'user', '另一项任务', { runId: 'next-root', conversationId: 'next-turn' })
  const nextAnswer = message('next-answer', 'assistant', '另一项结论', { runId: 'next-root', conversationId: 'next-turn' })
  const groups = workConversationGroups([admission(), progress(), operation(), nextUser, nextAnswer])
  expect(groups).toHaveLength(2)
  expect(workConversationEntries(groups[0]).map(entry => entry.message.id)).toEqual(['user', 'operation'])
  expect(workConversationEntries(groups[1]).map(entry => entry.message.id)).toEqual(['next-user', 'next-answer'])
  const partial = workConversationGroups([progress(), operation(), nextAnswer])
  expect(partial).toHaveLength(2)
  expect(workConversationEntries(partial[0]).map(entry => entry.message.id)).toEqual(['operation'])
  expect(workConversationEntries(partial[1]).map(entry => entry.message.id)).toEqual(['next-answer'])
})

test('unfinished turns retain last-assistant status and waiting user-only rows stay visible', () => {
  for (const status of ['streaming', 'waiting', 'error', 'aborted', 'interrupted'] as const) {
    const last = message('active-tail', 'assistant', '当前说明', { status })
    const entries = workConversationEntries(workConversationGroups([admission(), progress(), operation(), last])[0])
    expect(entries[1].message).toBe(last)
    expect(entries[1].message.status).toBe(status)
    expect(entries[1].segments?.map(segment => segment.kind)).toEqual(['content', 'tools', 'content'])
  }
  const messages = [admission(), followup()]
  expect(workConversationEntries(workConversationGroups(messages)[0]).map(entry => entry.message)).toEqual(messages)
})
