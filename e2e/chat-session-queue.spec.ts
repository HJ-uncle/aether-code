/** Session queue isolation and failed-dispatch recovery; no Electron or engine. */
import { expect, test } from '@playwright/test'
import { clearSessionQueue, moveSessionQueue, removeSessionQueue, restoreSessionQueue,
  sessionQueue, takeSessionQueue, updateSessionQueue } from '../src/renderer/src/core/engine/chat-session-queue'

const item = (id: string, sessionId = 'A') => ({ id, text: id, options: { sessionId }, attachments: [] as string[] })
const ids = (entries: Array<{ id: string }>) => entries.map(entry => entry.id)

test('new session B and B completion cannot read or dispatch the running A queue', () => {
  const a = item('a-next'), queue = [a]
  expect(sessionQueue(queue, 'B')).toEqual([])
  for (const mode of ['serial', 'batch'] as const) {
    const selection = takeSessionQueue(queue, 'B', mode)
    expect(selection.selected).toEqual([])
    expect(selection.remaining).toEqual([a])
  }
  // The hook's authoritative completion gate permits draining only after A is
  // selected and its own run is complete; selection never consumes B's entries.
  const backAtA = takeSessionQueue(queue, 'A', 'serial')
  expect(backAtA.selected).toEqual([a])
  expect(backAtA.remaining).toEqual([])
})

test('serial and merged dispatch select only their session and preserve other queued intent', () => {
  const queue = [item('a1'), item('b1', 'B'), item('a2'), item('b2', 'B')]
  expect(ids(takeSessionQueue(queue, 'A', 'serial').selected)).toEqual(['a1'])
  expect(ids(takeSessionQueue(queue, 'A', 'serial').remaining)).toEqual(['b1', 'a2', 'b2'])
  const batch = takeSessionQueue(queue, 'B', 'batch')
  expect(batch.selected.map(entry => entry.text).join('\n')).toBe('b1\nb2')
  expect(ids(batch.remaining)).toEqual(['a1', 'a2'])
  expect(ids(queue)).toEqual(['a1', 'b1', 'a2', 'b2'])
})

test('failed dispatch restores original queue order without losing later enqueues or edits', () => {
  const queue = [item('a1'), item('b1', 'B'), item('a2'), item('b2', 'B')]
  const batch = takeSessionQueue(queue, 'A', 'batch')
  const editedB = { ...batch.remaining[0], text: 'B was edited while A sent' }
  const later = [...batch.remaining, item('a3'), item('b3', 'B')]
  later[0] = editedB
  const restored = restoreSessionQueue(later, batch)
  expect(ids(restored)).toEqual(['a1', 'b1', 'a2', 'b2', 'a3', 'b3'])
  expect(restored[1]).toBe(editedB)
  expect(ids(later)).toEqual(['b1', 'b2', 'a3', 'b3'])
  expect(restoreSessionQueue(restored, batch)).toEqual(restored)
})

test('failure restoration preserves a newer same-id item and survives removed anchors', () => {
  const queue = [item('b1', 'B'), item('a1'), item('b2', 'B'), item('a2')]
  const batch = takeSessionQueue(queue, 'A', 'batch')
  const edited = { ...queue[1], text: 'updated selection' }
  const restored = restoreSessionQueue([edited, item('a3')], batch)
  expect(ids(restored)).toEqual(['a1', 'a2', 'a3'])
  expect(restored[0]).toBe(edited)
  expect(ids(restoreSessionQueue([item('a3')], batch))).toEqual(['a1', 'a2', 'a3'])
})

test('clear, remove and update never mutate a foreign session, even with a reused id', () => {
  const queue = [item('shared'), item('shared', 'B'), item('a2')]
  expect(clearSessionQueue(queue, 'A')).toEqual([queue[1]])
  expect(removeSessionQueue(queue, 'A', 'shared')).toEqual([queue[1], queue[2]])
  let edits = 0
  const edited = updateSessionQueue(queue, 'B', 'shared', entry => { edits++; return { ...entry, text: 'edited B' } })
  expect(edits).toBe(1)
  expect(edited[0]).toBe(queue[0])
  expect(edited[1].text).toBe('edited B')
  expect(edited[2]).toBe(queue[2])
})

test('visible drag indices reorder only the selected session slots', () => {
  const queue = [item('a1'), item('b1', 'B'), item('a2'), item('b2', 'B'), item('a3')]
  expect(ids(moveSessionQueue(queue, 'A', 2, 0))).toEqual(['a3', 'b1', 'a1', 'b2', 'a2'])
  expect(ids(moveSessionQueue(queue, 'B', 0, 1))).toEqual(['a1', 'b2', 'a2', 'b1', 'a3'])
  expect(moveSessionQueue(queue, 'A', 0, 5)).toEqual(queue)
  expect(moveSessionQueue(queue, 'A', 0.5, 1)).toEqual(queue)
})

test('missing selected session cannot reveal, clear or dispatch any pending item', () => {
  const queue = [item('a1'), item('b1', 'B')]
  for (const session of [null, '']) {
    expect(sessionQueue(queue, session)).toEqual([])
    expect(takeSessionQueue(queue, session, 'batch')).toMatchObject({ selected: [], remaining: queue })
    expect(clearSessionQueue(queue, session)).toEqual(queue)
    expect(removeSessionQueue(queue, session, 'a1')).toEqual(queue)
    expect(moveSessionQueue(queue, session, 0, 1)).toEqual(queue)
  }
})
