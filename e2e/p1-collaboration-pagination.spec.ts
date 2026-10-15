/** Current P1 contracts: shared archive validation, scoped receipt evidence,
 * pinned cursor progress, disabled communication capabilities and late reads.
 * This fixture performs no model calls and never submits collaboration messages. */
import { expect, test } from '@playwright/test'
import type { EngineRequestInput, EngineRequestResult } from '../src/shared/ipc'
import { checkHistoryPage } from '../src/renderer/src/core/engine/history-page'
import { archiveDisplayHistory, loadArchiveWindow } from '../src/renderer/src/core/engine/archive-pages'
import { loadWorkSubagentTranscript } from '../src/renderer/src/contrib/work/work-subagent-transcript'
import { loadCollaborationInspection, parseCollaborationReceiptPage, collaborationReceiptState, COLLABORATION_RECEIPT_PAGE_SIZE } from '../src/renderer/src/core/engine/collaboration-inspection'
import type { ControllerScope, ControllerTarget, ControllerReceipt } from '../src/renderer/src/core/engine/collaboration-contract'
import { remoteRequestError } from '../src/main/engine/protocol'

const scope: ControllerScope = { rootRunId: 'root', rootAttemptId: 'attempt', rootSessionId: 'session' }
const target: ControllerTarget = { rootRunId: scope.rootRunId, rootSessionId: scope.rootSessionId, childSessionId: 'child', invocationRunId: 'child-run' }
const capability = { protocolVersion: 1, durableQueueReceipts: true, receiptPagination: true, runtimeCommunication: false, mailboxConsumer: false, userControllerMutation: false }
const ok = (data: unknown): EngineRequestResult<unknown> => ({ ok: true, code: 200, message: 'ok', data })
const receipt = (seq: number): ControllerReceipt => ({ messageId: `message-${seq}`, rootRunId: scope.rootRunId, rootAttemptId: scope.rootAttemptId, senderParticipantId: 'root', senderInvocationRunId: 'root', recipientParticipantId: 'child:child',
  requestKey: `nonce-${seq}`, payloadHash: 'a'.repeat(64), payloadBytes: 18, acceptedSeq: seq, acceptedAt: 1234, state: 'queued' })
const context = () => ({ outcome: 'ready', scope, recipient: { participantId: 'child:child', kind: 'child', sessionId: 'child', invocationRunId: 'child-run', admittedSeq: 2, admittedAt: 123 }, participants: { entries: [], revision: 2, hasMore: false } })
const fullPage = () => ({ entries: Array.from({ length: COLLABORATION_RECEIPT_PAGE_SIZE }, (_, index) => receipt(index + 1)), revision: 25, hasMore: true, nextCursor: 'opaque-page-2' })
const history = () => ({ ...ok([{ id: 'row', role: 'user', content: 'original' }]), pagination: { current: 1, pageSize: 1, total: 1, totalPages: 1 }, metadata: { archiveRevision: 'r1', archiveMessageCount: 1 } })

test('archive and child readers share row, revision and exact-size rejection before caching', async () => {
  const invalid = { ...history(), data: [{ id: 'row', role: 'injected-role', content: 'wrong' }] }
  expect(() => checkHistoryPage(invalid, 1, 1, '历史归档')).toThrow('内容格式无效')
  await expect(loadArchiveWindow(async () => invalid, 'session')).rejects.toThrow('内容格式无效')
  const child = { schemaVersion: 1, runId: 'child-run', tenantId: 'tenant', rootSessionId: 'session', parentSessionId: 'session', parentConversationId: 'turn',
    parentMessageId: 'assistant', parentToolCallId: 'call', childSessionId: 'child', modelId: 'model', task: 'test', description: 'test', status: 'succeeded', lastSeq: 1, createdAt: 1, updatedAt: 1, usage: {}, toolCalls: [] }
  await expect(loadWorkSubagentTranscript({ source: 1, parentSessionId: 'session', childSessionId: 'child', runId: 'child-run' }, async input => input.path.startsWith('/subagent/') ? ok(child) : invalid, () => true)).rejects.toThrow('内容格式无效')
  for (const invalidRevision of ['', 2, null, 'x'.repeat(1025)]) expect(() => checkHistoryPage({ ...history(), metadata: { archiveRevision: invalidRevision } }, 1, 1, '历史归档')).toThrow('版本信息无效')
  expect(() => checkHistoryPage({ ...history(), data: [] }, 1, 1, '历史归档')).toThrow('页不完整')
  expect(checkHistoryPage(history(), 1, 1, '历史归档')).toMatchObject({ revision: 'r1', total: 1, rows: [{ id: 'row' }] })
})

test('inspection is read-only and preserves the engine capability distinction', async () => {
  const calls: EngineRequestInput[] = []
  const result = await loadCollaborationInspection(target, async input => {
    calls.push(input)
    if (input.path.endsWith('/capabilities')) return ok(capability)
    if (input.path.endsWith('/controller-context')) return ok(context())
    return ok({ entries: [receipt(1)], revision: 1, hasMore: false })
  }, () => {})
  expect(result.capabilities).toEqual(capability)
  expect(collaborationReceiptState(result.page.entries[0])).toBe('已持久接纳 · 未提供消费确认')
  expect(calls.map(input => input.method)).toEqual(['GET', 'GET', 'GET'])
  expect(calls[2]).toMatchObject({ path: '/collaboration/roots/root/participants/child%3Achild/receipts', query: { rootAttemptId: 'attempt', rootSessionId: 'session', limit: 24 } })
  expect(calls.some(input => input.body !== undefined || input.path.endsWith('/messages'))).toBe(false)
  const extra = parseCollaborationReceiptPage({ entries: [{ ...receipt(1), body: 'do not retain raw body', arbitraryDetail: 'x'.repeat(500_000) }], revision: 1, hasMore: false }, scope, 'child:child')
  expect(extra.entries[0]).toEqual(receipt(1))
})

test('next page pins attempt/revision and rejects repeated cursor, identity and sequence conflicts', async () => {
  const first = await loadCollaborationInspection(target, async input => input.path.endsWith('/capabilities') ? ok(capability) : input.path.endsWith('/controller-context') ? ok(context()) : ok(fullPage()), () => {})
  const calls: EngineRequestInput[] = []
  const second = await loadCollaborationInspection(target, async input => { calls.push(input); return ok({ entries: [receipt(25)], revision: 25, hasMore: false }) }, () => {}, first)
  expect(calls).toHaveLength(1)
  expect(calls[0].query?.cursor).toBe('opaque-page-2')
  expect(second.pageNumber).toBe(2)
  expect(second.page.entries.map(item => item.acceptedSeq)).toEqual([25])
  for (const malformed of [
    { entries: [receipt(25)], revision: 26, hasMore: false },
    { entries: [receipt(24)], revision: 25, hasMore: false },
    { entries: [{ ...receipt(25), rootAttemptId: 'foreign' }], revision: 25, hasMore: false },
    { ...fullPage(), nextCursor: 'opaque-page-2' },
    { entries: [receipt(25)], revision: 25, hasMore: true, nextCursor: 'page-3' },
    { entries: [receipt(25)], revision: 25, hasMore: false, nextCursor: 'unexpected' }
    , { entries: [], revision: 25, hasMore: false }
  ]) expect(() => parseCollaborationReceiptPage(malformed, scope, 'child:child', first.page)).toThrow()
  const original = JSON.stringify(first)
  await expect(loadCollaborationInspection({ ...target, invocationRunId: 'other-child' }, async () => { throw new Error('must not request') }, () => {}, first)).rejects.toThrow('页已切换')
  expect(JSON.stringify(first)).toBe(original)
})

test('terminal receipt pages reach their pinned revision while sparse global sequences remain valid', () => {
  expect(() => parseCollaborationReceiptPage({ entries: [receipt(1)], revision: 2, hasMore: false }, scope, 'child:child')).toThrow('分页信息无效')
  expect(() => parseCollaborationReceiptPage({ entries: [], revision: 2, hasMore: false }, scope, 'child:child')).toThrow('分页信息无效')
  expect(() => parseCollaborationReceiptPage({ ...fullPage(), revision: 24 }, scope, 'child:child')).toThrow('分页信息无效')
  expect(parseCollaborationReceiptPage({ entries: [receipt(5), receipt(15)], revision: 15, hasMore: false }, scope, 'child:child').entries.map(item => item.acceptedSeq)).toEqual([5, 15])
  expect(parseCollaborationReceiptPage({ entries: [], revision: 0, hasMore: false }, scope, 'child:child').entries).toEqual([])
})

test('legacy root archive replaces one page after same-count edits and remains navigable in both directions', async () => {
  let epoch = 'old'
  const calls: Array<[number, number]> = []
  const request = async (current: number, pageSize: number): Promise<EngineRequestResult<import('../src/renderer/src/core/engine/chat-history').EngineHistoryRow[]>> => {
    calls.push([current, pageSize])
    if (pageSize === 200) epoch = `edit-${current}`
    const rows = Array.from({ length: 601 }, (_, index) => ({ id: `row-${index}`, role: 'user', content: `${epoch}:${index}` }))
    return { ok: true, code: 200, message: 'ok', data: rows.slice((current - 1) * pageSize, current * pageSize), pagination: { current, pageSize, total: rows.length, totalPages: Math.ceil(rows.length / pageSize) }, metadata: { archiveMessageCount: rows.length, backend: 'sqlite' } }
  }
  let window = await loadArchiveWindow(request, 'session')
  expect(window).toMatchObject({ firstPage: 4, lastPage: 4, total: 601 })
  const seen = new Set(window.rows.map(row => row.id))
  while (window.firstPage > 1) {
    calls.length = 0
    window = await loadArchiveWindow(request, 'session', window, 'older')
    expect(calls).toEqual([[1, 1], [window.firstPage, 200]])
    expect(window.firstPage).toBe(window.lastPage)
    expect(window.rows.every(row => String(row.content).startsWith(`edit-${window.firstPage}:`))).toBe(true)
    expect(window.rows.length).toBeLessThanOrEqual(200)
    window.rows.forEach(row => seen.add(row.id))
  }
  expect(seen.size).toBe(601)
  for (let current = 2; current <= 4; current++) {
    window = await loadArchiveWindow(request, 'session', window, 'newer')
    expect(window.firstPage).toBe(current)
    expect(window.lastPage).toBe(current)
  }
  window = await loadArchiveWindow(request, 'session', window, 'older')
  expect(archiveDisplayHistory(window, [{ id: 'snapshot-other-epoch', role: 'assistant', content: 'must not merge' }])).toEqual(window.rows)
  expect((await loadArchiveWindow(request, 'session', window, 'latest')).rows.map(row => row.id)).toEqual(['row-600'])
})

test('legacy child archive replaces edited pages without losing older/newer navigation or ownership checks', async () => {
  const child = { schemaVersion: 1, runId: 'child-run', tenantId: 'tenant', rootSessionId: 'session', parentSessionId: 'session', parentConversationId: 'turn',
    parentMessageId: 'assistant', parentToolCallId: 'call', childSessionId: 'child', modelId: 'model', task: 'test', description: 'test', status: 'succeeded', lastSeq: 1, createdAt: 1, updatedAt: 1, usage: {}, toolCalls: [] }
  const calls: EngineRequestInput[] = []
  const request = async (input: EngineRequestInput): Promise<EngineRequestResult<unknown>> => {
    calls.push(input)
    if (input.path.startsWith('/subagent/')) return ok(child)
    const current = Number(input.query?.current), pageSize = Number(input.query?.pageSize)
    const rows = Array.from({ length: 151 }, (_, index) => ({ id: `row-${index}`, role: 'user', content: `epoch-${current}-${pageSize}:${index}` }))
    return { ...ok(rows.slice((current - 1) * pageSize, current * pageSize)), pagination: { current, pageSize, total: rows.length, totalPages: Math.ceil(rows.length / pageSize) }, metadata: { archiveMessageCount: rows.length, backend: 'sqlite' } }
  }
  const identity = { source: 1, parentSessionId: 'session', childSessionId: 'child', runId: 'child-run' }
  let window = await loadWorkSubagentTranscript(identity, request, () => true)
  const seen = new Set(window.rows.map(row => row.id))
  while (window.firstPage > 1) {
    calls.length = 0
    window = await loadWorkSubagentTranscript(identity, request, () => true, window, 'older')
    expect(calls.map(call => [call.path, call.query?.current, call.query?.pageSize])).toEqual([
      ['/subagent/runs/child-run', undefined, undefined], ['/conversation/archive', '1', '1'], ['/conversation/archive', String(window.firstPage), '50']
    ])
    expect(window.rows.every(row => String(row.content).startsWith(`epoch-${window.firstPage}-50:`))).toBe(true)
    expect(window.firstPage).toBe(window.lastPage)
    expect(window.rows.length).toBeLessThanOrEqual(50)
    window.rows.forEach(row => seen.add(row.id))
  }
  expect(seen.size).toBe(151)
  window = await loadWorkSubagentTranscript(identity, request, () => true, window, 'newer')
  expect(window).toMatchObject({ firstPage: 2, lastPage: 2 })
  window = await loadWorkSubagentTranscript(identity, request, () => true, window, 'refresh')
  expect(window.rows.map(row => row.id)).toEqual(['row-150'])
})

test('foreign receipt ownership, duplicate IDs and fabricated delivered states are never displayed', () => {
  for (const entries of [
    [{ ...receipt(1), recipientParticipantId: 'child:foreign' }],
    [{ ...receipt(1), rootRunId: 'other-root' }],
    [receipt(1), { ...receipt(2), messageId: receipt(1).messageId }],
    [{ ...receipt(1), state: 'delivered' }],
    [{ ...receipt(1), payloadHash: 'not-a-digest' }],
    [{ ...receipt(1), acceptedSeq: 3 }]
  ]) expect(() => parseCollaborationReceiptPage({ entries, revision: 2, hasMore: false }, scope, 'child:child')).toThrow()
})

test('unavailable capabilities or closed live scope do not invent an attempt or request receipts', async () => {
  for (const data of [{ ...capability, receiptPagination: false }, { protocolVersion: 1, userControllerMutation: true }]) {
    const calls: EngineRequestInput[] = []
    await expect(loadCollaborationInspection(target, async input => { calls.push(input); return ok(data) }, () => {})).rejects.toThrow()
    expect(calls.map(input => input.path)).toEqual(['/collaboration/capabilities'])
  }
  const calls: EngineRequestInput[] = []
  await expect(loadCollaborationInspection(target, async input => { calls.push(input); return input.path.endsWith('/capabilities') ? ok(capability) : { ok: false, code: 409, message: 'closed', data: null } }, () => {})).rejects.toThrow('当前工作轮次已结束')
  expect(calls).toHaveLength(2)
})

test('selection or account changes after an awaited response stop the read before the next request', async () => {
  let current = true
  const calls: EngineRequestInput[] = []
  await expect(loadCollaborationInspection(target, async input => { calls.push(input); current = false; return ok(capability) }, () => { if (!current) throw new Error('selection changed') })).rejects.toThrow('selection changed')
  expect(calls).toHaveLength(1)
})

test('the new remote inspection route is GET-only and cannot broaden mutation access', () => {
  const path = '/api/v1/collaboration/roots/root/participants/child%3Achild/receipts'
  expect(remoteRequestError('remote', 'GET', path)).toBeNull()
  expect(remoteRequestError('remote', 'POST', path)).not.toBeNull()
  expect(remoteRequestError('remote', 'DELETE', path)).not.toBeNull()
  expect(remoteRequestError('remote', 'GET', '/api/v1/collaboration/roots/root/participants/child/receipts/extra')).not.toBeNull()
})
