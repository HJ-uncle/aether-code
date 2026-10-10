import { expect, test } from '@playwright/test'
import { loadArchiveWindow, mergeArchiveProjection, type ArchiveWindow } from '../src/renderer/src/core/engine/archive-pages'
import { restoreChatSnapshot } from '../src/renderer/src/core/engine/chat-recovery'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import type { EngineRequestResult } from '../src/shared/ipc'

function responder(rows: EngineHistoryRow[], revision = 'r1', calls: Array<{ current: number; pageSize: number }> = []) {
  return async (current: number, pageSize: number): Promise<EngineRequestResult<EngineHistoryRow[]>> => {
    calls.push({ current, pageSize })
    return { ok: true, code: 200, message: 'ok', data: rows.slice((current - 1) * pageSize, current * pageSize), pagination: { current, pageSize, total: rows.length, totalPages: Math.ceil(rows.length / pageSize) }, metadata: { archiveMessageCount: rows.length, archiveRevision: revision } }
  }
}
const rows = (count: number): EngineHistoryRow[] => Array.from({ length: count }, (_, index) => ({ id: 'message-' + index, role: index % 2 ? 'assistant' : 'user', content: 'original ' + index, conversationId: 'turn-' + Math.floor(index / 2), modelId: index % 3 ? 'kimi-k2.6' : 'MiniMax-M2.5' }))

test('tail-first paging loads every identity in order, each request is bounded, no historical row ceiling', async () => {
  const source = rows(20_201), calls: Array<{ current: number; pageSize: number }> = []
  let window: ArchiveWindow | undefined
  do { window = await loadArchiveWindow(responder(source, 'r1', calls), 'session', window) } while (window.firstPage > 1)
  expect(window.rows.map(row => row.id)).toEqual(source.map(row => row.id))
  expect(window.rows.at(0)?.conversationId).toBe(source[0].conversationId)
  expect(window.rows.at(-1)?.modelId).toBe(source.at(-1)?.modelId)
  expect(calls.every(call => call.pageSize <= 200)).toBe(true)
  expect(calls.slice(0, 2)).toEqual([{ current: 1, pageSize: 1 }, { current: 102, pageSize: 200 }])
  expect((await loadArchiveWindow(responder(source), 'session', window)).rows).toEqual(source)
})
test('same-count edits and deletion/replacement refresh selected pages rather than reuse stale content', async () => {
  const source = rows(601)
  let window = await loadArchiveWindow(responder(source), 'session')
  window = await loadArchiveWindow(responder(source), 'session', window)
  const changed = source.map(row => row.id === 'message-450' ? { ...row, content: 'corrected decision' } : row)
  changed[500] = { id: 'replacement-500', role: 'user', content: 'new replacement', conversationId: 'new-turn' }
  window = await loadArchiveWindow(responder(changed, 'r2'), 'session', window)
  expect(window.firstPage).toBe(2)
  expect(window.rows.find(row => row.id === 'message-450')?.content).toBe('corrected decision')
  expect(window.rows.some(row => row.id === 'message-500')).toBe(false)
  expect(window.rows.some(row => row.id === 'replacement-500')).toBe(true)
})
test('appended turns refresh the visible tail and include exact new model/turn IDs', async () => {
  const source = rows(401)
  const prior = await loadArchiveWindow(responder(source), 'session')
  const updated = [...source, { id: 'new-user', role: 'user', content: 'new task', conversationId: 'new-turn' }, { id: 'new-assistant', role: 'assistant', content: 'reply', modelId: 'glm-5.3', conversationId: 'new-turn' }]
  const window = await loadArchiveWindow(responder(updated, 'r2'), 'session', prior)
  expect(window.rows.at(-2)?.id).toBe('new-user')
  expect(window.rows.at(-1)).toMatchObject({ id: 'new-assistant', conversationId: 'new-turn', modelId: 'glm-5.3' })
})
test('projection merging keeps durable IDs, original tool evidence, and later corrections without summary duplication', () => {
  const raw: EngineHistoryRow[] = [{ id: 'tool-assistant', role: 'assistant', conversationId: 'turn', modelId: 'kimi-k2.6', toolCall: { id: 'tool', name: 'read_file', args: { path: 'src/a.ts' } } }, { id: 'tool-result', role: 'tool', toolCallId: 'tool', content: 'original evidence' }]
  const merged = mergeArchiveProjection(raw, [{ id: 'summary', role: 'system', metadata: { isCompactSummary: true } }, { id: 'user', role: 'user', conversationId: 'turn', content: 'task' }, raw[0], { ...raw[1], content: '[tool result cleared]' }, { id: 'final', role: 'assistant', conversationId: 'turn', modelId: 'glm-5.3', content: 'done' }])
  expect(merged.map(row => row.id)).toEqual(['user', 'tool-assistant', 'tool-result', 'final'])
  const restored = restoreChatSnapshot({ schemaVersion: 1, source: 'persisted', sessionId: 'session', eventId: null, finished: true, projection: [], runs: [], history: merged, todos: [], changes: [] })
  expect(restored.messages.map(row => row.id)).toEqual(['user', 'tool-assistant'])
  expect(restored.messages[1].modelId).toBe('glm-5.3')
  expect(restored.messages[1].tools[0].result).toBe('original evidence')
})
test('changed revision mid-read, partial pages and duplicate IDs fail without mutating prior window', async () => {
  const source = rows(601), prior = await loadArchiveWindow(responder(source), 'session')
  const priorBytes = JSON.stringify(prior)
  const request = responder(source)
  await expect(loadArchiveWindow(async (current, size) => ({ ...await request(current, size), metadata: { archiveMessageCount: source.length, archiveRevision: size === 1 ? 'r1' : 'r2' } }), 'session', prior)).rejects.toThrow('加载期间有更新')
  await expect(loadArchiveWindow(async (current, size) => ({ ...await request(current, size), data: [] }), 'session')).rejects.toThrow('页不完整')
  const duplicates = rows(2); duplicates[1].id = duplicates[0].id
  await expect(loadArchiveWindow(responder(duplicates), 'session')).rejects.toThrow('重复')
  expect(JSON.stringify(prior)).toBe(priorBytes)
})
