/** Pure result selection: current turn ownership, successful roots only,
 * duplicate replay and text-only rounds. No changed path is promoted to delivery. */
import { expect, test } from '@playwright/test'
import type { FinalResult } from '../src/shared/final-result'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
import { workFinalResultCatalog } from '../src/renderer/src/contrib/work/work-final-results'

const sessionId = 'session'
const result = (turn: string, publishedAt: number, withFile = true): FinalResult => ({
  schemaVersion: 1, sessionId, turnId: turn, runId: `run-${turn}`, assistantMessageId: `assistant-${turn}`, text: `结果 ${turn}`, publishedAt,
  items: withFile ? [{ id: `file-${turn}`, name: 'report.md', path: 'D:/workspace/report.md', mimeType: 'text/markdown',
    size: 1, sha256: 'a'.repeat(64), assetId: `asset-${turn}`, kind: 'file' }] : []
})
const message = (id: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id, role: 'assistant', content: '', thinking: '', tools: [], items: [], status: 'done', createdAt: 1, ...patch
})
const user = (turn: string) => message(`user-${turn}`, { role: 'user', content: `请求 ${turn}`, conversationId: turn })
const answer = (value: FinalResult): ChatMessage => message(value.assistantMessageId, { finalResult: value, runId: value.runId, conversationId: value.turnId,
  run: { schemaVersion: 1, sessionId, runId: value.runId, turnId: value.turnId, userMessageId: `user-${value.turnId}`,
    assistantMessageId: value.assistantMessageId, version: 1, seq: 1, status: 'succeeded', createdAt: 1, updatedAt: 2, pending: [] } })

test('本轮明确交付为默认，同路径历史版本单独保留', () => {
  const first = result('first', 1), second = result('second', 2)
  const catalog = workFinalResultCatalog([user('first'), answer(first), user('second'), answer(second)], sessionId)
  expect(catalog.current?.runId).toBe(second.runId)
  expect(catalog.results.map(entry => entry.items[0].assetId)).toEqual(['asset-second', 'asset-first'])
  expect(catalog.currentKey).toBe('user-second')
})

test('新一轮尚未完成时不把上一轮交付当作当前成果', () => {
  const first = result('first', 1)
  const catalog = workFinalResultCatalog([user('first'), answer(first), user('second'), message('stream', { status: 'streaming' })], sessionId)
  expect(catalog.current).toBeUndefined()
  expect(catalog.results.map(entry => entry.runId)).toEqual([first.runId])
})

test('纯文字本轮不回退上一轮文件清单', () => {
  const first = result('first', 1), second = result('second', 2, false)
  const catalog = workFinalResultCatalog([user('first'), answer(first), user('second'), answer(second)], sessionId)
  expect(catalog.current).toEqual(second)
  expect(catalog.current?.items).toEqual([])
})

test('运行中、失败、取消、其他会话均不展示发布记录', () => {
  const value = result('first', 1)
  for (const status of ['running', 'waiting', 'failed', 'cancelled', 'interrupted'] as const) {
    const entry = answer(value)
    entry.run = { ...entry.run!, status }
    expect(workFinalResultCatalog([user('first'), entry], sessionId).results).toEqual([])
  }
  const foreign = answer(value)
  foreign.finalResult = { ...value, sessionId: 'other' }
  expect(workFinalResultCatalog([foreign], sessionId).results).toEqual([])
})

test('同一根run重复回放只保留一份清单，晚到旧轮不抢占本轮', () => {
  const first = result('first', 99), second = result('second', 2)
  const catalog = workFinalResultCatalog([user('first'), answer(first), answer(first), user('second'), answer(second)], sessionId)
  expect(catalog.results).toHaveLength(2)
  expect(catalog.current).toEqual(second)
  const replayed = workFinalResultCatalog([user('first'), answer(first), user('second'), answer(first)], sessionId)
  expect(replayed.current).toBeUndefined()
})

test('分页未加载用户消息时不把更早的成果填给当前未完成根run', () => {
  const first = result('first', 1)
  const catalog = workFinalResultCatalog([answer(first), message('latest', { runId: 'new-run', status: 'streaming' })], sessionId)
  expect(catalog.current).toBeUndefined()
  expect(catalog.results).toEqual([first])
})

test('旧历史工具写成功与普通回复不能自动晋升为交付清单', () => {
  const entry = message('legacy', { content: '已经完成 report.md', tools: [{ id: 'write', name: 'write_file', args: '{}', result: '已写入', state: 'done',
    change: { id: 'change', path: 'report.md', kind: 'write', oldContent: null, newContent: 'done', truncated: false, status: 'kept', createdAt: 1 } }] })
  expect(workFinalResultCatalog([user('legacy'), entry], sessionId).results).toEqual([])
})
