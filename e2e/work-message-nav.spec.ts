/** Pure Work navigation contracts: complete-turn identities, bounded history
 * windows, stale targets and readable previews without protocol metadata. */
import { expect, test } from '@playwright/test'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
import { workNavigationTarget, workNavigationTurns, type WorkNavigationGroup } from '../src/renderer/src/contrib/work/work-message-nav'
import { WORK_MESSAGE_WINDOW_SIZE, workMessageRange } from '../src/renderer/src/contrib/work/work-view-performance'

function message(id: string, role: ChatMessage['role'], content = id): ChatMessage {
  return { id, role, content, thinking: '', tools: [], items: [], status: 'done', createdAt: 1 }
}

const messages = Array.from({ length: 1_000 }, (_, index) => message(`m-${index}`, index % 2 ? 'assistant' : 'user'))
const groups: WorkNavigationGroup[] = Array.from({ length: 500 }, (_, index) => ({
  id: `turn-${index}`, startIndex: index * 2, messages: messages.slice(index * 2, index * 2 + 2)
}))

test('navigation can reach every loaded turn while retaining the bounded message window', () => {
  for (const group of groups) {
    const target = workNavigationTarget(messages, groups, group.id)
    expect(target).not.toBeNull()
    const range = workMessageRange(messages, target!.firstId)
    expect(range.start).toBeLessThanOrEqual(group.startIndex)
    expect(range.end).toBeGreaterThan(group.startIndex)
    expect(range.end - range.start).toBeLessThanOrEqual(WORK_MESSAGE_WINDOW_SIZE)
  }
  expect(workNavigationTarget(messages, groups, 'turn-0')).toEqual({ turnId: 'turn-0', firstId: 'm-0' })
  expect(workNavigationTarget(messages, groups, 'turn-499')).toEqual({ turnId: 'turn-499', firstId: 'm-940' })
})

test('opening an older turn stays anchored when the live tail grows', () => {
  const target = workNavigationTarget(messages, groups, 'turn-50')!
  const before = workMessageRange(messages, target.firstId)
  const after = workMessageRange([...messages, message('new-user', 'user'), message('new-answer', 'assistant')], target.firstId)
  expect(before.start).toBe(100)
  expect(after).toEqual({ ...before, newer: before.newer + 2 })
})

test('deleted, non-user and empty-history targets cannot redirect to an unrelated turn', () => {
  expect(workNavigationTarget(messages, groups, 'deleted-turn')).toBeNull()
  expect(workNavigationTarget([], groups, 'turn-0')).toBeNull()
  expect(workNavigationTarget(messages, [{ id: 'orphan', startIndex: 1, messages: [messages[1]] }], 'orphan')).toBeNull()
})

test('navigation preserves Work group identities and uses readable user text or attachment names', () => {
  const user = message('user', 'user', '  第一行\n 第二行  ')
  const attachment = { ...message('attachment', 'user', ''), attachments: [{ path: 'report.pdf', name: '报告.pdf', type: 'application/pdf', size: 12 }] }
  expect(workNavigationTurns([
    { id: 'orphan', startIndex: 0, messages: [message('intro', 'assistant')] },
    { id: 'turn:conversation:one', startIndex: 1, messages: [user, message('reply', 'assistant')] },
    { id: 'turn:run:two', startIndex: 3, messages: [attachment] }
  ])).toEqual([
    { id: 'turn:conversation:one', message: user, preview: '第一行 第二行' },
    { id: 'turn:run:two', message: attachment, preview: '报告.pdf' }
  ])
})
