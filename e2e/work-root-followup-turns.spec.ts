import { expect, test } from '@playwright/test'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
import { workConversationGroups, workConversationEntries, workConversationComplete } from '../src/renderer/src/contrib/work/work-conversation-turns'
import { workGroupedDisplayTurns, workNavigationTurns } from '../src/renderer/src/contrib/work/work-message-nav'
import { workMessagePresentation } from '../src/renderer/src/contrib/work/work-message-timeline'
import { summarizeTurnUsage } from '../src/renderer/src/contrib/chat/turn-usage'

const message = (id: string, role: ChatMessage['role'], extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, role, runId: 'run', conversationId: 'turn', content: id, thinking: '', tools: [], items: [], status: 'done', createdAt: 1, ...extra
})
const supplement = (id: string): ChatMessage => message(id, 'user', { rootFollowup: { messageId: id, rootRunId: 'run', turnId: 'turn' } })

test('多次补充保留原顺序、过程身份和一份用量，下一轮保持独立', () => {
  const root = message('prompt', 'user'), first = message('first', 'assistant', { usage: { totalTokens: 110 } })
  const before = workConversationEntries(workConversationGroups([root, first])[0])
  const rows = [root, { ...first, id: 'segment:run:before:补充一' }, supplement('补充一'), message('middle', 'assistant', { usage: { totalTokens: 220 } }),
    supplement('补充二'), message('final', 'assistant', { usage: { totalTokens: 55 } }),
    message('next-prompt', 'user', { runId: 'next', conversationId: 'next-turn' }), message('next-answer', 'assistant', { runId: 'next', conversationId: 'next-turn' })]
  const original = JSON.stringify(rows)
  const groups = workConversationGroups(rows)
  expect(groups.map(group => group.id)).toEqual(['message:prompt', 'message:next-prompt'])
  const entries = workConversationEntries(groups[0])
  expect(entries).toHaveLength(2)
  expect(entries[1].key).toBe(before[1].key)
  expect(entries[1].processKey).toBe(before[1].processKey)
  expect(entries[1].segments![0].key).toBe(before[1].segments![0].key)
  expect(entries[1].message.id).toBe('final')
  expect(entries[1].segments?.map(segment => segment.kind === 'followup' ? segment.message.content : segment.kind === 'content' ? segment.text : segment.kind))
    .toEqual(['first', '补充一', 'middle', '补充二', 'final'])
  const presentation = workMessagePresentation(entries[1].segments!, undefined, { text: 'final' })
  expect(presentation.map(segment => segment.kind)).toEqual(['process', 'answer'])
  expect(summarizeTurnUsage(groups[0].messages)?.tokens).toBe(385)
  expect(JSON.stringify(rows)).toBe(original)
})

test('普通用户、身份冲突及缺失父轮的补充不会被吞并', () => {
  const root = message('root', 'user')
  expect(workConversationGroups([root, message('ordinary', 'user')])).toHaveLength(2)
  expect(workConversationGroups([root, { ...supplement('foreign'), runId: 'foreign' }])).toHaveLength(2)
  const orphan = workConversationGroups([supplement('orphan'), message('answer', 'assistant')])[0]
  expect(workConversationEntries(orphan).map(entry => entry.message.id)).toEqual(['orphan', 'answer'])
})

test('旧索引只隐藏已归入可见父轮的补充，不产生重复导航或丢失孤立项', () => {
  const groups = workConversationGroups([message('root', 'user'), message('a', 'assistant'), supplement('extra'), message('b', 'assistant')])
  const index = ['root', 'extra', 'unloaded'].map(id => ({ userMessageId: id, preview: id, conversationId: 'turn' }))
  expect(workGroupedDisplayTurns(groups, index)?.map(turn => turn.userMessageId)).toEqual(['root', 'unloaded'])
  expect(workNavigationTurns(groups, index).map(turn => turn.message.id)).toEqual(['root', 'unloaded'])
  const orphan = workConversationGroups([supplement('extra'), message('b', 'assistant')])
  expect(workGroupedDisplayTurns(orphan, index)).toEqual(index)
  expect(workGroupedDisplayTurns(groups, index, ['root'])?.map(turn => turn.userMessageId)).toEqual(['root', 'extra', 'unloaded'])
  expect(workConversationComplete(groups[0], index, ['root'])).toBe(false)
  expect(workConversationComplete(groups[0], index, ['root', 'extra', 'unloaded'])).toBe(true)
})
