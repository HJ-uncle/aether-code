/** Current engine StreamBus/SSE envelope: invalid evidence never advances a cursor or mutates a transcript. */
import { expect, test } from '@playwright/test'
import { parseSseBlock } from '../src/main/engine/sse'
import { inspectStreamCursor, parseEngineStreamCursor } from '../src/shared/stream-event'
import { reducedEventCursor } from '../src/renderer/src/core/engine/chat-recovery-loop'
import { streamRecoveryNoticeText } from '../src/renderer/src/core/engine/stream-recovery-notice'

test('real StreamBus cursor accepts exact zero and safe integer sequences only', () => {
  expect(parseEngineStreamCursor('a270e1f7-540c-43a4-a0c1-8927031ed81d:0')).toEqual({ streamId: 'a270e1f7-540c-43a4-a0c1-8927031ed81d', sequence: 0 })
  for (const value of ['bus:-1', 'bus:01', 'bus:1.1', 'bus:1x', 'bus:9007199254740992', 'bus:Infinity', ':1', 'bad bus:1', '', null]) {
    expect(parseEngineStreamCursor(value), String(value)).toBeNull()
  }
})

test('same sequence is deduplicated, but a different producer cannot enter the active subscription', () => {
  expect(inspectStreamCursor('first:5', 'first:5')).toBe('duplicate')
  expect(inspectStreamCursor('first:5', 'first:4')).toBe('duplicate')
  expect(inspectStreamCursor('first:5', 'second:6')).toBe('foreign')
  expect(inspectStreamCursor('first:5', 'first:6')).toBe('forward')
})

test('filtered engine control frames do not create an invented retention gap', () => {
  // sse-sink skips unknown controls while StreamBus still sequences them.
  expect(inspectStreamCursor('bus:3', 'bus:7')).toBe('forward')
  expect(inspectStreamCursor('bus:3')).toBe('untracked')
})

test('malformed wire data requests recovery without disclosing raw model or tool bytes', () => {
  for (const data of ['{broken secret', 'null', '[]', '"text"', 'false']) {
    const frame = parseSseBlock(`id: bus:7\ndata: ${data}`)
    expect(frame).toEqual({ type: 'snapshot-required', reason: 'invalid-event' })
    expect(JSON.stringify(frame)).not.toContain('secret')
  }
  expect(parseSseBlock('id: bus:NaN\ndata: {"content":"wrong"}')).toEqual({ type: 'snapshot-required', reason: 'invalid-cursor' })
})

test('in-band replay expiry uses the same recovery envelope as HTTP 40902', () => {
  expect(parseSseBlock('data: {"code":"snapshot_required","error":"slow reader"}')).toEqual({ type: 'snapshot-required', reason: 'retention-gap' })
  expect(parseSseBlock(': ping 123')).toBeNull()
  expect(parseSseBlock('data: [DONE]')).toEqual({ type: 'done', eventId: undefined })
})

test('bad frame cannot make its following valid frame conceal unconsumed evidence', () => {
  let consumed: string | null = 'bus:3'
  const frames = [parseSseBlock('id: bus:4\ndata: {bad'), parseSseBlock('id: bus:5\ndata: {"content":"later"}')]
  const applied: string[] = []
  let snapshotNeeded = false
  for (const event of frames) {
    if (!event || snapshotNeeded) continue
    if (event.type === 'snapshot-required') { snapshotNeeded = true; continue }
    if (event.type !== 'payload' || inspectStreamCursor(consumed, event.eventId) !== 'forward') continue
    if (event.payload.content) applied.push(event.payload.content)
    consumed = reducedEventCursor(consumed, event.eventId, 'applied')
  }
  expect(snapshotNeeded).toBe(true)
  expect(consumed).toBe('bus:3')
  expect(applied).toEqual([])
})

test('recovery notice distinguishes work in progress, restored evidence and blocked recovery', () => {
  const notice = { reason: 'retention-gap' as const, restored: false }
  expect(streamRecoveryNoticeText(notice, { phase: 'connecting', failures: 0 })).toContain('正在从引擎快照重新同步')
  expect(streamRecoveryNoticeText(notice, { phase: 'retrying', failures: 1 })).toContain('暂时无法读取恢复快照')
  expect(streamRecoveryNoticeText({ ...notice, restored: true }, { phase: 'attached', failures: 0 })).toBe('实时更新已从引擎快照恢复。')
  expect(streamRecoveryNoticeText({ ...notice, restored: true }, { phase: 'connecting', failures: 0 })).toContain('正在重新连接实时更新')
  expect(streamRecoveryNoticeText(notice, { phase: 'blocked', failures: 1 })).toContain('同步未完成')
  expect(streamRecoveryNoticeText(null, { phase: 'blocked', failures: 1 })).toBeNull()
})
