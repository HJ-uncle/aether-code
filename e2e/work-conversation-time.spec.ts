/** Pure turn timestamps: original admissions remain stable across supplements
 * and completion; local-calendar labels survive midnight, month and year changes. */
import { expect, test } from '@playwright/test'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
import type { RootRun } from '../src/shared/root-run'
import { formatWorkConversationTime, workConversationStartedAt } from '../src/renderer/src/contrib/work/work-conversation-time'

function message(id: string, role: ChatMessage['role'], createdAt: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, createdAt, content: '', thinking: '', tools: [], items: [], status: 'done', ...extra }
}

function run(createdAt: number, extra: Partial<RootRun> = {}): RootRun {
  return { schemaVersion: 1, runId: 'root', sessionId: 'session', turnId: 'turn', userMessageId: 'user',
    assistantMessageId: 'assistant', seq: 1, version: 1, status: 'running', pending: [], createdAt, updatedAt: createdAt, ...extra }
}

const followup = { messageId: 'supplement', rootRunId: 'root', turnId: 'turn' }

test('original user time takes priority over root execution and assistant times', () => {
  const startedAt = new Date(2026, 10, 12, 2, 33).getTime()
  const root = run(startedAt - 10_000)
  const messages = [message('user', 'user', startedAt, { run: root }),
    message('assistant', 'assistant', startedAt - 5_000, { run: root })]
  expect(workConversationStartedAt({ messages })).toBe(startedAt)
})

test('supplements and completion never replace the original turn time', () => {
  const startedAt = new Date(2026, 10, 12, 2, 33).getTime()
  const root = run(startedAt), user = message('user', 'user', startedAt)
  const active = [user, message('assistant', 'assistant', startedAt + 1, { run: root, status: 'streaming' })]
  const completed = [user, message('supplement', 'user', startedAt + 60_000, { rootFollowup: followup }),
    message('assistant', 'assistant', startedAt + 120_000, { run: { ...root, status: 'succeeded',
      updatedAt: startedAt + 180_000, finishedAt: startedAt + 180_000 }, endedAt: startedAt + 180_000 })]
  expect(workConversationStartedAt({ messages: active })).toBe(startedAt)
  expect(workConversationStartedAt({ messages: completed })).toBe(startedAt)
})

test('partial history uses the earliest valid durable run time when the original user time is missing', () => {
  const startedAt = new Date(2026, 10, 12, 2, 33).getTime()
  const segments = [message('segment', 'assistant', startedAt + 10_000, { run: run(startedAt + 1_000) }),
    message('assistant', 'assistant', startedAt + 20_000, { run: run(startedAt) })]
  expect(workConversationStartedAt({ messages: segments })).toBe(startedAt)
  expect(workConversationStartedAt({ messages: [message('user', 'user', 0), ...segments] })).toBe(startedAt)
})

test('legacy history falls back to its earliest valid non-supplement message', () => {
  const startedAt = new Date(2026, 10, 12, 2, 33).getTime()
  const messages = [message('supplement', 'user', startedAt - 60_000, { rootFollowup: followup }),
    message('later', 'assistant', startedAt + 30_000), message('earlier', 'assistant', startedAt)]
  expect(workConversationStartedAt({ messages })).toBe(startedAt)
})

test('missing or invalid timestamps are omitted instead of showing epoch or current time', () => {
  expect(workConversationStartedAt({ messages: [] })).toBeNull()
  expect(workConversationStartedAt({ messages: [message('supplement', 'user', Date.now(), { rootFollowup: followup })] })).toBeNull()
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 8_640_000_000_000_001]) {
    expect(workConversationStartedAt({ messages: [message('user', 'user', invalid, { run: run(invalid) })] })).toBeNull()
    expect(formatWorkConversationTime(invalid, new Date(2026, 10, 12))).toBeNull()
  }
  expect(formatWorkConversationTime(null, new Date(2026, 10, 12))).toBeNull()
})

test('today includes a padded 24-hour time and retains the full timestamp for hover and markup', () => {
  const sent = new Date(2026, 10, 12, 2, 33, 4)
  expect(formatWorkConversationTime(sent.getTime(), new Date(2026, 10, 12, 23, 59))).toEqual({
    dateTime: sent.toISOString(), label: '今天 02:33', title: '2026年11月12日 02:33:04'
  })
})

test('yesterday follows the local calendar across midnight, month-end and year-end', () => {
  for (const [today, sent] of [
    [new Date(2026, 10, 12, 0, 1), new Date(2026, 10, 11, 23, 59)],
    [new Date(2026, 2, 1, 12), new Date(2026, 1, 28, 2, 33)],
    [new Date(2027, 0, 1, 12), new Date(2026, 11, 31, 2, 33)],
    [new Date(2026, 2, 9, 0, 1), new Date(2026, 2, 8, 0, 30)]
  ]) {
    const time = `${String(sent.getHours()).padStart(2, '0')}:${String(sent.getMinutes()).padStart(2, '0')}`
    expect(formatWorkConversationTime(sent.getTime(), today)?.label).toBe(`昨天 ${time}`)
  }
})

test('older dates include the month and day, and include the year when it differs', () => {
  const today = new Date(2026, 10, 12, 12)
  expect(formatWorkConversationTime(new Date(2026, 9, 5, 0, 7).getTime(), today)?.label).toBe('10月5日 00:07')
  expect(formatWorkConversationTime(new Date(2025, 11, 31, 23, 59).getTime(), today)?.label).toBe('2025年12月31日 23:59')
})
