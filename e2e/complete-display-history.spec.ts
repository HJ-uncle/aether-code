/** Pure display-history hydration: all initial turns commit together, while
 * cancellation, destructive mutations and missing pages cannot publish a mix. */
import { expect, test } from '@playwright/test'
import type { EngineRequestResult } from '../src/shared/ipc'
import { DisplayHistoryUnsupportedError, loadCompleteDisplayHistory } from '../src/renderer/src/core/engine/complete-display-history'
import { cacheDisplayHistory, type DisplayHistoryPage } from '../src/renderer/src/core/engine/display-history'

const sessionId = 'complete-display-session'
const ids = Array.from({ length: 25 }, (_, index) => `user-${String(index + 1).padStart(2, '0')}`)
function page(turnIds: string[], anchor?: string, mutation = 'original', limit = 10): DisplayHistoryPage {
  const start = anchor ? turnIds.indexOf(anchor) : Math.max(0, turnIds.length - limit)
  if (start < 0) throw new Error(`Unknown fixture anchor ${anchor}`)
  const selected = turnIds.slice(start, start + limit)
  return { schemaVersion: 1, grouping: 'root', revision: `${mutation}:${turnIds.length}`, mutationRevision: mutation,
    backend: 'jsonl', completeness: 'complete',
    turns: turnIds.map(userMessageId => ({ userMessageId, conversationId: `turn-${userMessageId}`, preview: userMessageId })),
    loadedTurnIds: selected,
    messages: selected.flatMap(id => [{ id, role: 'user', content: id, conversationId: `turn-${id}` },
      { id: `${id}-answer`, role: 'assistant', content: `${mutation}:${id}`, conversationId: `turn-${id}` }]) }
}
const success = (data: unknown): EngineRequestResult<unknown> => ({ ok: true, code: 200, message: 'ok', data })
const failure = (code: number): EngineRequestResult<unknown> => ({ ok: false, code, message: 'fixture failure', data: null })
function completeCache(turnIds: string[], mutation = 'original') {
  return cacheDisplayHistory(sessionId, page(turnIds, turnIds[0], mutation, turnIds.length))
}

test('loads every initial body serially and returns a single complete candidate', async () => {
  const anchors: Array<string | undefined> = [], previous = cacheDisplayHistory(sessionId, page(ids))
  let requestsInFlight = 0
  const output = await loadCompleteDisplayHistory({ sessionId, previous, current: () => true,
    request: async (anchor, limit) => {
      expect(requestsInFlight++).toBe(0)
      anchors.push(anchor)
      await Promise.resolve()
      requestsInFlight--
      return success(page(ids, anchor, 'original', limit))
    } })
  expect(anchors).toEqual([undefined, ids[0], ids[10]])
  expect(output?.cache.page.turns.map(turn => turn.userMessageId)).toEqual(ids)
  expect([...output!.cache.bodies.keys()].sort()).toEqual([...ids].sort())
  expect(output?.missingAnchor).toBe(false)
  expect([...previous.bodies.keys()]).toEqual(ids.slice(-10))
})

test('an already complete cache only refreshes the tail', async () => {
  const previous = completeCache(ids), anchors: Array<string | undefined> = []
  const output = await loadCompleteDisplayHistory({ sessionId, previous, current: () => true,
    request: async anchor => { anchors.push(anchor); return success(page(ids, anchor)) } })
  expect(anchors).toEqual([undefined])
  expect(output?.cache.bodies.size).toBe(ids.length)
})

test('one thousand turns use the supported ten-turn batch without duplicate page reads', async () => {
  const thousand = Array.from({ length: 1000 }, (_, index) => `large-user-${index}`)
  const anchors: Array<string | undefined> = []
  const output = await loadCompleteDisplayHistory({ sessionId, current: () => true,
    request: async (anchor, limit) => {
      expect(limit).toBe(10)
      anchors.push(anchor)
      return success(page(thousand, anchor, 'original', limit))
    } })
  expect(anchors).toHaveLength(100)
  expect(new Set(anchors).size).toBe(100)
  expect(output?.cache.bodies.size).toBe(1000)
  expect(output?.cache.bodies.get('large-user-0')?.at(-1)?.content).toBe('original:large-user-0')
  expect(output?.cache.bodies.get('large-user-999')?.at(-1)?.content).toBe('original:large-user-999')
})

test('cancelling between pages returns no candidate and leaves the visible cache untouched', async () => {
  const previous = cacheDisplayHistory(sessionId, page(ids)), anchors: Array<string | undefined> = []
  let active = true
  const output = await loadCompleteDisplayHistory({ sessionId, previous, current: () => active,
    request: async anchor => {
      anchors.push(anchor)
      if (anchor) active = false
      return success(page(ids, anchor))
    } })
  expect(output).toBeNull()
  expect(anchors).toEqual([undefined, ids[0]])
  expect([...previous.bodies.keys()]).toEqual(ids.slice(-10))
})

test('a mutation during hydration restarts once without mixing old and new bodies', async () => {
  const previous = cacheDisplayHistory(sessionId, page(ids)), anchors: Array<string | undefined> = []
  const output = await loadCompleteDisplayHistory({ sessionId, previous, current: () => true,
    request: async anchor => {
      anchors.push(anchor)
      return success(page(ids, anchor, anchors.length === 1 ? 'original' : 'edited'))
    } })
  expect(anchors).toEqual([undefined, ids[0], undefined, ids[10]])
  expect(output?.cache.bodies.size).toBe(ids.length)
  expect([...output!.cache.bodies.values()].flatMap(body => body.filter(message => message.role === 'assistant').map(message => message.content)))
    .toEqual(expect.arrayContaining(ids.map(id => `edited:${id}`)))
  expect([...previous.bodies.values()].flatMap(body => body.filter(message => message.role === 'assistant').map(message => message.content)))
    .toEqual(ids.slice(-10).map(id => `original:${id}`))
})

test('continuous destructive changes stop after one restart', async () => {
  let calls = 0
  await expect(loadCompleteDisplayHistory({ sessionId, current: () => true,
    request: async anchor => success(page(ids, anchor, `mutation-${++calls}`)) }))
    .rejects.toThrow('历史记录在加载期间有更新')
  expect(calls).toBe(4)
})

test('newly appended tail turns do not keep an opening history read alive indefinitely', async () => {
  const initial = ids.slice(0, 14), anchors: Array<string | undefined> = []
  const output = await loadCompleteDisplayHistory({ sessionId, current: () => true,
    request: async anchor => {
      anchors.push(anchor)
      return success(page(anchor ? ids.slice(0, 15) : initial, anchor))
    } })
  expect(anchors).toEqual([undefined, ids[0]])
  expect([...output!.cache.bodies.keys()].sort()).toEqual([...initial].sort())
  expect(output?.cache.page.turns.map(turn => turn.userMessageId)).toEqual(ids.slice(0, 15))
})

test('a page that omits its requested body fails instead of looping or publishing partial history', async () => {
  let calls = 0
  await expect(loadCompleteDisplayHistory({ sessionId, current: () => true,
    request: async () => { calls++; return success(page(ids)) } }))
    .rejects.toThrow('完整对话记录格式不正确')
  expect(calls).toBe(2)
})

test('an index cannot silently lose an initial turn without changing its mutation epoch', async () => {
  let calls = 0
  const previous = cacheDisplayHistory(sessionId, page(ids))
  await expect(loadCompleteDisplayHistory({ sessionId, previous, current: () => true,
    request: async anchor => { calls++; return success(page(anchor ? ids.slice(0, -1) : ids, anchor)) } }))
    .rejects.toThrow('历史记录在加载期间发生变化')
  expect(calls).toBe(2)
  expect(previous.bodies.has(ids.at(-1)!)).toBe(true)
})

test('a deleted requested anchor refreshes the full index but still reports that navigation failed', async () => {
  const anchors: Array<string | undefined> = []
  const output = await loadCompleteDisplayHistory({ sessionId, userMessageId: 'deleted', current: () => true,
    request: async anchor => {
      anchors.push(anchor)
      return anchor === 'deleted' ? failure(40400) : success(page(ids, anchor))
    } })
  expect(anchors).toEqual(['deleted', undefined, ids[0], ids[10]])
  expect(output?.missingAnchor).toBe(true)
  expect(output?.cache.bodies.size).toBe(ids.length)
})

test('unsupported display history remains distinguishable from a missing anchor', async () => {
  let calls = 0
  await expect(loadCompleteDisplayHistory({ sessionId, current: () => true,
    request: async () => { calls++; return failure(404) } })).rejects.toBeInstanceOf(DisplayHistoryUnsupportedError)
  expect(calls).toBe(1)
})
