/** Supplemental user boundaries survive streaming, snapshot replacement and persisted replay. */
import { expect, test } from '@playwright/test'
import type { RootRun } from '../src/shared/root-run'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import type { ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'
import { restoreChatSnapshot } from '../src/renderer/src/core/engine/chat-recovery'
import { applyToolResult } from '../src/renderer/src/core/engine/chat-history'
import { reducePayload } from '../src/renderer/src/core/engine/chat-payload'
import { applyRootRun } from '../src/renderer/src/core/engine/root-run-state'
import { applyProjectedUserMessage, applyProjectedUsage, bindProjectedAssistantId } from '../src/renderer/src/core/engine/chat-timeline'

const run: RootRun = { schemaVersion: 1, runId: 'root', sessionId: 'session', turnId: 'turn', userMessageId: 'user',
  assistantMessageId: 'final', version: 1, seq: 1, status: 'running', createdAt: 100, updatedAt: 110,
  modelId: 'requested', pending: [] }
const user = (id: string, content: string, createdAt: number): EngineHistoryRow => ({ id, role: 'user', content, createdAt,
  conversationId: run.turnId, metadata: { rootRunId: run.runId, turnId: run.turnId } })
const initial = user(run.userMessageId, '初始要求', 100)
const followup = user('followup', '增加 H5 适配', 200)
const history: EngineHistoryRow[] = [initial,
  { id: 'before', role: 'assistant', content: '第一段', reasoningContent: '先分析', createdAt: 120,
    conversationId: run.turnId, metadata: { rootRunId: run.runId }, modelId: 'actual-first',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    toolCall: { id: 'read', name: 'read', args: { path: 'a' } } },
  { role: 'tool', toolCallId: 'read', content: '原工具结果', metadata: { success: true } },
  followup,
  { id: run.assistantMessageId, role: 'assistant', content: '第二段', createdAt: 220,
    conversationId: run.turnId, metadata: { rootRunId: run.runId }, modelId: 'actual-last',
    usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 } }
]
const projection: ChatRecoverySnapshot['projection'] = [
  { userMessage: initial }, { usage: { promptTokens: 30, completionTokens: 13, totalTokens: 43, currentPromptTokens: 25, modelId: 'actual-last' } },
  { thinking: '先分析' }, { content: '第一段' }, { toolCall: { toolCallId: 'read', name: 'read', args: { path: 'a' } } },
  { userMessage: followup }, { content: '第二段' }, { toolResult: { toolCallId: 'read', success: true, output: '最终工具结果' } }
]
const snapshot = (patch: Partial<ChatRecoverySnapshot> = {}): ChatRecoverySnapshot => ({ schemaVersion: 1, source: 'live',
  sessionId: run.sessionId, eventId: 'stream:10', finished: false, projection, run, runs: [run], history, todos: [], changes: [], ...patch })
const contents = (messages: ChatMessage[]) => messages.map(message => [message.role, message.content])

for (const source of ['live', 'persisted-published'] as const) {
  test(`${source} preserves alternating transcript segments, tool ownership, models and exact billing`, () => {
    const current = { ...run, actualModelId: 'actual-last' }
    const state = snapshot({ source, run: current, runs: [current] })
    const restored = restoreChatSnapshot(state).messages
    expect(contents(restored)).toEqual([['user', '初始要求'], ['assistant', '第一段'], ['user', '增加 H5 适配'], ['assistant', '第二段']])
    expect(restored.map(message => message.id)).toEqual(['user', 'before', 'followup', 'final'])
    expect(restored[1]).toMatchObject({ status: 'done', thinking: '先分析', modelId: 'actual-first', usage: { totalTokens: 15 } })
    expect(restored[1].tools).toMatchObject([{ id: 'read', state: 'done', result: '最终工具结果' }])
    expect(restored[3]).toMatchObject({ status: 'streaming', modelId: 'actual-last', usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28, currentPromptTokens: 25 } })
    expect(restored[3].tools).toEqual([])
    expect(restoreChatSnapshot(state).messages).toEqual(restored)
  })
}

test('live boundary is idempotent and later tool completion updates its original segment', () => {
  let messages = applyProjectedUserMessage([], initial, run)
  messages[1] = reducePayload(messages[1], { content: '第一段' })
  messages[1] = reducePayload(messages[1], { toolCall: { toolCallId: 'read', name: 'read', args: {} } })
  messages = applyProjectedUsage(messages, { promptTokens: 10, completionTokens: 5, totalTokens: 15, modelId: 'actual-first' }, run.runId)
  messages = applyProjectedUserMessage(messages, followup, run)
  messages = applyProjectedUserMessage(messages, followup, run)
  expect(messages).toHaveLength(4)
  expect(new Set(messages.map(message => message.id)).size).toBe(4)
  expect(messages[1]).toMatchObject({ content: '第一段', status: 'done', usage: { totalTokens: 15 } })
  messages[3] = reducePayload(messages[3], { content: '第二段' })
  messages = applyProjectedUsage(messages, { promptTokens: 30, completionTokens: 13, totalTokens: 43, currentPromptTokens: 25, modelId: 'actual-last' }, run.runId)
  messages = applyToolResult(messages, { toolCallId: 'read', success: true, output: 'late' }, run.runId)
  expect(messages[1].tools[0].result).toBe('late')
  expect(messages[3].tools).toEqual([])
  expect(messages[3]).toMatchObject({ content: '第二段', usage: { totalTokens: 28 }, modelId: 'actual-last' })
  const ids = messages.map(message => message.id)
  messages = bindProjectedAssistantId(messages, run.runId, 'durable-final')
  expect(messages.map(message => message.id)).toEqual([...ids.slice(0, 3), 'durable-final'])
  messages = applyRootRun(messages, { ...run, assistantMessageId: 'durable-final', version: 2, status: 'failed', error: 'fail' })
  expect(messages.filter(message => message.error)).toHaveLength(1)
  expect(messages[1]).toMatchObject({ id: ids[1], status: 'done' })
  expect(messages[3]).toMatchObject({ status: 'error', error: 'fail' })
})

test('legacy aggregate splits only exact historical prefixes and retains already persisted tools and usage', () => {
  const legacy = projection.filter(frame => frame.userMessage?.id !== followup.id)
  const restored = restoreChatSnapshot(snapshot({ projection: legacy })).messages
  expect(contents(restored)).toEqual([['user', '初始要求'], ['assistant', '第一段'], ['user', '增加 H5 适配'], ['assistant', '第二段']])
  expect(restored[1].tools[0].result).toBe('最终工具结果')
  expect(restored[3].tools).toEqual([])
  expect(restored[1].usage).toMatchObject({ totalTokens: 15 })
  expect(restored[3].usage).toMatchObject({ totalTokens: 28 })
})

test('a history append before publication preserves the newest boundary without moving completed output after it', () => {
  const next = user('followup-2', '再增加键盘操作', 300)
  const restored = restoreChatSnapshot(snapshot({ history: [...history, next] })).messages
  expect(contents(restored)).toEqual([['user', '初始要求'], ['assistant', '第一段'], ['user', '增加 H5 适配'], ['assistant', '第二段'], ['user', '再增加键盘操作'], ['assistant', '']])
  expect(new Set(restored.map(message => message.id)).size).toBe(restored.length)
  expect(restored.at(-1)?.usage).toMatchObject({ totalTokens: 0 })
})

test('new projected boundary survives history lag and does not claim unrelated later runs', () => {
  const later = { id: 'later-user', role: 'user', content: 'other', conversationId: 'other-turn', metadata: { rootRunId: 'other-root' } }
  const restored = restoreChatSnapshot(snapshot({ history: [initial, later] })).messages
  expect(contents(restored)).toEqual([['user', '初始要求'], ['assistant', '第一段'], ['user', '增加 H5 适配'], ['assistant', '第二段'], ['user', 'other']])
  expect(restored.at(-1)?.runId).toBe('other-root')
  expect(restored[1].tools).toHaveLength(1)
})

test('five delivered supplements retain repeated text exactly once per segment and persisted replay order', () => {
  const rows: EngineHistoryRow[] = [initial]
  const frames: ChatRecoverySnapshot['projection'] = [{ userMessage: initial }]
  for (let index = 0; index < 5; index++) {
    rows.push({ id: `segment-${index}`, role: 'assistant', content: '同样的进展', conversationId: run.turnId,
      metadata: { rootRunId: run.runId }, createdAt: 120 + index * 2 })
    frames.push({ content: '同样的进展' })
    const row = user(`supplement-${index}`, `第 ${index + 1} 个要求`, 121 + index * 2)
    rows.push(row); frames.push({ userMessage: row })
  }
  rows.push({ id: run.assistantMessageId, role: 'assistant', content: '交付', conversationId: run.turnId, metadata: { rootRunId: run.runId }, createdAt: 150 })
  frames.push({ content: '交付' })
  const live = restoreChatSnapshot(snapshot({ history: rows, projection: frames })).messages
  const persisted = restoreChatSnapshot(snapshot({ source: 'persisted', history: rows, projection: [] })).messages
  expect(contents(live)).toEqual(contents(persisted))
  expect(live.map(message => message.id)).toEqual(persisted.map(message => message.id))
  expect(new Set(live.map(message => message.id)).size).toBe(12)
  expect(live.filter(message => message.status === 'streaming')).toHaveLength(1)
})

test('only the last segment owns a pending interaction after root replay', () => {
  const waiting: RootRun = { ...run, status: 'waiting', pending: [{ requestId: 'request', toolCallId: 'ask', toolName: 'ask_user',
    kind: 'ask', args: { question: '继续？' }, status: 'pending' }] }
  const restored = restoreChatSnapshot(snapshot({ run: waiting, runs: [waiting] })).messages
  expect(restored.filter(message => message.pending)).toHaveLength(1)
  expect(restored[1].status).toBe('done')
  expect(restored[3]).toMatchObject({ status: 'waiting', pending: { requestId: 'request' } })
})

test('split roots keep pending requests only in the tail and answered history only with its original tool', () => {
  let messages = applyProjectedUserMessage([], initial, run)
  for (const id of ['old-answered', 'old-pending']) messages[1] = reducePayload(messages[1], {
    toolCall: { toolCallId: id, name: 'ask_user', args: { question: id } }
  })
  messages = applyProjectedUserMessage(messages, followup, run)
  messages[3] = reducePayload(messages[3], { toolCall: { toolCallId: 'tail-answered', name: 'ask_user', args: {} } })
  // A tool with the same ID in another root cannot claim this root's history.
  const foreign: ChatMessage = { ...messages[1], id: 'foreign', runId: 'foreign-root', conversationId: 'foreign-turn',
    tools: [{ ...messages[1].tools[0], id: 'without-own-tool' }], run: undefined }
  messages.unshift(foreign)
  const waiting: RootRun = { ...run, status: 'waiting', pending:
    ['old-answered', 'old-pending', 'tail-answered', 'without-own-tool'].map(id => ({
      requestId: `request:${id}`, toolCallId: id, toolName: 'ask_user', kind: 'ask', args: { question: id },
      status: id === 'old-pending' ? 'pending' : 'answered', ...(id === 'old-pending' ? {} : { output: 'yes' })
    })) }
  const restored = applyRootRun(messages, waiting)
  expect(restored[0]).toBe(foreign)
  expect(restored[2].interactions?.map(item => item.requestId)).toEqual(['request:old-answered'])
  expect(restored[4].interactions?.map(item => item.requestId)).toEqual([
    'request:old-pending', 'request:tail-answered', 'request:without-own-tool'
  ])
  expect(restored[2].pending).toBeUndefined()
  expect(restored[4].pending?.requestId).toBe('request:old-pending')
  expect(restored.flatMap(message => message.interactions ?? []).filter(item => item.status === 'pending')).toHaveLength(1)

  const answered: RootRun = { ...waiting, version: 2, status: 'running', pending: waiting.pending.map(item =>
    item.status === 'pending' ? { ...item, status: 'answered', output: 'continue' } : item) }
  const resumed = applyRootRun(restored, answered)
  expect(resumed[2].interactions?.map(item => item.requestId)).toEqual(['request:old-answered', 'request:old-pending'])
  expect(resumed[4].interactions?.map(item => item.requestId)).toEqual(['request:tail-answered', 'request:without-own-tool'])
  const requestIds = resumed.flatMap(message => message.interactions ?? []).map(item => item.requestId)
  expect(requestIds).toHaveLength(4)
  expect(new Set(requestIds).size).toBe(4)
  expect(applyRootRun(resumed, answered)).toEqual(resumed)
})

test('foreign and hidden user frames cannot create timeline boundaries or consume persisted text', () => {
  const messages = applyProjectedUserMessage([], initial, run)
  expect(applyProjectedUserMessage(messages, { ...followup, metadata: { turnId: 'foreign-turn' } }, run)).toBe(messages)
  expect(applyProjectedUserMessage(messages, { ...followup, isSidechain: true }, run)).toBe(messages)
  const restored = restoreChatSnapshot(snapshot({
    history: [...history.slice(0, 2), { id: 'hidden', role: 'assistant', content: 'SIDECHAIN', isSidechain: true,
      conversationId: run.turnId, metadata: { rootRunId: run.runId } }, ...history.slice(2)],
    projection: projection.filter(frame => frame.userMessage?.id !== followup.id)
  })).messages
  expect(contents(restored)).toEqual([['user', '初始要求'], ['assistant', '第一段'], ['user', '增加 H5 适配'], ['assistant', '第二段']])
})
