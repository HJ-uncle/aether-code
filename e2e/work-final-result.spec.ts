/** Explicit final deliveries: identity fences, durable replay, stale display reads and process/answer boundaries. */
import { expect, test } from '@playwright/test'
import { normalizeFinalResult, type FinalResult } from '../src/shared/final-result'
import type { RootRun } from '../src/shared/root-run'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
import { applyFinalResult, applyProjectedFinalResult, finalAnswerForMessage, getMessageFinalResult } from '../src/renderer/src/core/engine/final-result'
import { replayMessages, type EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { applyRootRuns } from '../src/renderer/src/core/engine/root-run-state'
import { cacheDisplayHistory, mergeDisplayHistory, type DisplayHistoryPage } from '../src/renderer/src/core/engine/display-history'
import { workMessagePresentation, workMessageTimeline } from '../src/renderer/src/contrib/work/work-message-timeline'

const run = (turn = 'one', status: RootRun['status'] = 'succeeded'): RootRun => ({ schemaVersion: 1,
  sessionId: 'session', runId: `run-${turn}`, turnId: turn, userMessageId: `user-${turn}`, assistantMessageId: `answer-${turn}`,
  version: 3, seq: 1, status, createdAt: 1, updatedAt: 3, pending: [] })
const result = (turn = 'one'): FinalResult => ({ schemaVersion: 1, sessionId: 'session', turnId: turn,
  runId: `run-${turn}`, assistantMessageId: `answer-${turn}`, text: `完成 ${turn}`, publishedAt: 10,
  items: [{ id: `item-${turn}`, assetId: `asset-${turn}`, path: 'final.png', name: '成品图', mimeType: 'image/png',
    kind: 'image', sha256: 'a'.repeat(64), size: 100 }] })
const message = (turn = 'one', patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: `answer-${turn}`, role: 'assistant',
  runId: `run-${turn}`, conversationId: turn, run: run(turn), content: '', thinking: '', tools: [], items: [], status: 'done', createdAt: 1, ...patch })

test('只有成功根运行的显式清单是成果，普通改动和过程图不自动晋升', () => {
  expect(getMessageFinalResult(message(), 'session')).toBeUndefined()
  const delivered = applyFinalResult(message(), result())
  expect(getMessageFinalResult(delivered, 'session')?.items.map(item => item.assetId)).toEqual(['asset-one'])
  for (const status of ['running', 'waiting', 'failed', 'cancelled', 'interrupted'] as const) {
    expect(getMessageFinalResult({ ...delivered, run: run('one', status) }, 'session')).toBeUndefined()
  }
  expect(getMessageFinalResult({ ...delivered, run: undefined }, 'session')).toBeUndefined()
  expect(getMessageFinalResult(delivered, 'other-session')).toBeUndefined()
  expect(getMessageFinalResult({ ...delivered, status: 'aborted' }, 'session')).toBeUndefined()
})

test('成功历史缺少清单时仍显示正文，被分段的旧assistant不冒充最终答案', () => {
  const pending = message('one', { content: '检查中 ![过程](draft.png)' })
  expect(finalAnswerForMessage(pending, 'session')).toBeUndefined()
  expect(workMessagePresentation(workMessageTimeline(pending), undefined, finalAnswerForMessage(pending, 'session')))
    .toMatchObject([{ kind: 'answer', text: pending.content }])
  const final = applyFinalResult(pending, result())
  expect(finalAnswerForMessage(final, 'session')).toEqual({ text: '完成 one' })
  for (const status of ['succeeded', 'cancelled', 'failed'] as const) {
    const earlier = { ...pending, id: 'segment:before-steering', run: run('one', status) }
    expect(finalAnswerForMessage(earlier, 'session')).toBe(false)
    expect(getMessageFinalResult({ ...earlier, finalResult: result() }, 'session')).toBeUndefined()
  }
  expect(finalAnswerForMessage({ ...pending, run: undefined, runId: undefined }, 'session')).toBeUndefined()
})

test('迟到结果回到所属运行，重复帧不复制，下一轮不继承同路径图片', () => {
  const initial = [message('one'), message('two')]
  const updated = applyProjectedFinalResult(initial, result('one'))
  expect(updated[0].finalResult?.items[0].path).toBe('final.png')
  expect(updated[1].finalResult).toBeUndefined()
  expect(applyProjectedFinalResult(updated, result('one'))).toBe(updated)
  const two = applyProjectedFinalResult(updated, result('two'))
  expect(two.map(item => item.finalResult?.items[0].assetId)).toEqual(['asset-one', 'asset-two'])
  expect(applyProjectedFinalResult(two, { ...result(), sessionId: 'foreign' })).toBe(two)
  expect(applyFinalResult(initial[1], result())).toBe(initial[1])
})

test('清单无效或重复身份整体拒绝，纯文字结果保留显式空清单', () => {
  const good = result()
  expect(normalizeFinalResult({ ...good, items: [] })).toMatchObject({ text: '完成 one', items: [] })
  for (const bad of [
    { ...good, items: [good.items[0], good.items[0]] },
    { ...good, items: [{ ...good.items[0], sha256: 'unknown' }] },
    { ...good, items: [{ ...good.items[0], mimeType: 'text/plain' }] },
    { ...good, turnId: '' }, { ...good, publishedAt: NaN }
  ]) expect(normalizeFinalResult(bad)).toBeUndefined()
})

const rows = (final?: FinalResult): EngineHistoryRow[] => [
  { id: 'user-one', role: 'user', content: '请制作成品', conversationId: 'one', metadata: { rootRunId: 'run-one' } },
  { id: 'step-one', role: 'assistant', content: '先生成草稿', conversationId: 'one', metadata: { rootRunId: 'run-one' },
    toolCall: { id: 'draft', name: 'execute_cmd', args: {} } },
  { id: 'tool-one', role: 'tool', toolCallId: 'draft', content: 'draft.png / test.log', conversationId: 'one' },
  { id: 'answer-one', role: 'assistant', content: '完成 one', conversationId: 'one',
    metadata: { rootRunId: 'run-one', ...(final ? { finalResult: final } : {}) } }
]
const page = (messages: EngineHistoryRow[]): DisplayHistoryPage => ({ schemaVersion: 1,
  turns: [{ userMessageId: 'user-one', conversationId: 'one', preview: '请制作成品' }], messages,
  loadedTurnIds: ['user-one'], revision: 'r1', mutationRevision: 'm1', backend: 'jsonl', completeness: 'complete' })

test('完整历史和快照回放保留明确交付，旧显示页不能覆盖刚收到的结果', () => {
  const published = result()
  const replayed = applyRootRuns(replayMessages(rows(published)), [run()])
  expect(getMessageFinalResult(replayed[1], 'session')).toEqual(published)
  expect(replayed[1].tools[0].result).toBe('draft.png / test.log')
  const oldCache = cacheDisplayHistory('session', page(rows()))
  const merged = mergeDisplayHistory(oldCache, replayed, new Set(), [run()])
  expect(getMessageFinalResult(merged[1], 'session')).toEqual(published)
  const live = applyRootRuns(replayMessages(rows()), [run('one', 'running')])
  const freshCache = cacheDisplayHistory('session', page(rows(published)))
  const restored = mergeDisplayHistory(freshCache, live, new Set(['user-one']), [run('one', 'running')])
  expect(restored[1].finalResult).toEqual(published)
  expect(getMessageFinalResult(restored[1], 'session')).toBeUndefined()
})

test('明确最终正文只显示一次，进度文字和过程图留在过程里', () => {
  const input = message('one', { items: [{ kind: 'content', text: '生成中 ![草稿](draft.png)' },
    { kind: 'tool', id: 'tool' }, { kind: 'content', text: '完成 one' }],
    tools: [{ id: 'tool', name: 'execute_cmd', args: '{}', result: 'test.log', state: 'done' }] })
  const view = workMessagePresentation(workMessageTimeline(input), undefined, { text: '完成 one' })
  expect(view.filter(item => item.kind === 'answer')).toEqual([{ kind: 'answer', key: 'final-result', text: '完成 one' }])
  expect(view.filter(item => item.kind === 'process')).toMatchObject([{ segments: [
    { kind: 'content', text: '生成中 ![草稿](draft.png)' }, { kind: 'tools' }
  ] }])
  expect(workMessagePresentation(workMessageTimeline(input), undefined, false).some(item => item.kind === 'answer')).toBe(false)
  const unfinished = workMessageTimeline({ ...input, items: input.items.slice(0, 2) })
  expect(workMessagePresentation(unfinished).some(item => item.kind === 'answer')).toBe(false)
})
