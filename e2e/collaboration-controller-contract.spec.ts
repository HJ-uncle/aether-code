// Pure contracts: exact receiver binding, durable unknown, original-key recovery,
// strict envelopes, transport/selection fences and remote bridge allowlisting.
import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import type { EngineRequestInput, EngineRequestResult } from '../src/shared/ipc'
import { CollaborationController, type ControllerConnection, type ControllerEnvironment } from '../src/renderer/src/core/engine/collaboration-controller-core'
import { appendControllerPending, CONTROLLER_OUTBOX_KEY, CONTROLLER_HISTORY_KEY, CONTROLLER_HISTORY_COUNT, CONTROLLER_HISTORY_BYTES, controllerStorageIdentity, parseControllerCapability, parseControllerContext,
  parseControllerOutbox, parseControllerHistory, mergeControllerSaved, controllerSavedStatus, type ControllerPending, type ControllerTarget } from '../src/renderer/src/core/engine/collaboration-contract'
import { remoteRequestError } from '../src/main/engine/protocol'
import { subagentControllerScope } from '../src/renderer/src/contrib/chat/subagent-controller-scope'
import type { RootRun } from '../src/shared/root-run'

const target: ControllerTarget = { rootRunId: 'root', rootSessionId: 'parent', childSessionId: 'child', invocationRunId: 'child-run' }
const connection: ControllerConnection = { source: 7, expectedEngine: { mode: 'embedded', baseUrl: 'http://127.0.0.1:12541', instanceId: 'instance', accountId: 'account' }, toolProfile: 'general' }

test('Code supplement binds each message root and rejects stale or inconsistent owners', () => {
  const run: RootRun = { schemaVersion: 1, runId: 'older-still-active-root', sessionId: 'parent', turnId: 'turn', userMessageId: 'u', assistantMessageId: 'a', version: 1, seq: 1, status: 'succeeded', createdAt: 1, updatedAt: 2, pending: [] }
  expect(subagentControllerScope({ run, runId: run.runId }, 'parent', 7)).toEqual({ source: 7, sessionId: 'parent', rootRunId: run.runId })
  expect(subagentControllerScope({ run }, 'parent', 0)?.source).toBe(0)
  expect(subagentControllerScope({ run }, 'parent', undefined)).toBeUndefined()
  expect(subagentControllerScope({ run }, 'other-session', 7)).toBeUndefined()
  expect(subagentControllerScope({ run, runId: 'newest-root' }, 'parent', 7)).toBeUndefined()
  expect(subagentControllerScope({}, 'parent', 7)).toBeUndefined()
})
function context(invocationRunId = 'child-run'): unknown {
  return { outcome: 'ready', scope: { rootRunId: 'root', rootSessionId: 'parent', rootAttemptId: 'attempt' },
    participants: { entries: [], revision: 4, hasMore: true, nextCursor: 'next' },
    recipient: { participantId: 'child:child', kind: 'child', sessionId: 'child', invocationRunId, admittedSeq: 3, admittedAt: 4 } }
}
function pending(overrides: Partial<ControllerPending> = {}): ControllerPending {
  return { version: 1, expectedEngine: { ...connection.expectedEngine }, storageIdentity: controllerStorageIdentity(connection.expectedEngine),
    rootRunId: 'root', rootSessionId: 'parent', rootAttemptId: 'attempt', childSessionId: 'child', recipientParticipantId: 'child:child',
    recipientInvocationRunId: 'child-run', requestKey: 'key-1', message: '原要求', payloadBytes: 9, createdAt: 1, ...overrides }
}
function receipt(item = pending(), overrides: Record<string, unknown> = {}): unknown {
  return { messageId: 'message', rootRunId: item.rootRunId, rootAttemptId: item.rootAttemptId, senderParticipantId: 'root',
    senderInvocationRunId: 'root', recipientParticipantId: item.recipientParticipantId, requestKey: item.requestKey,
    payloadHash: createHash('sha256').update(item.message).digest('hex'), payloadBytes: item.payloadBytes,
    acceptedSeq: 2, acceptedAt: 3, state: 'queued', ...overrides }
}
function ok(data: unknown): EngineRequestResult<unknown> { return { ok: true, code: 200, message: '', data } }
function fixture() {
  let active = true
  let current = connection
  let sequence = 0
  const values = new Map<string, string>()
  const calls: EngineRequestInput[] = []
  let request: ControllerEnvironment['request'] = async input => {
    if (input.path === '/collaboration/capabilities') return ok({ userControllerMutation: true })
    if (input.path.endsWith('/controller-context')) return ok(context())
    if (input.method === 'POST') return ok({ outcome: 'accepted', receipt: receipt(parseControllerOutbox(values.get(CONTROLLER_OUTBOX_KEY) ?? null)[0]) })
    return { ok: false, code: 404, message: '', data: { outcome: 'not_found', requestKey: input.path.split('/').at(-1) } }
  }
  let locked: Promise<unknown> = Promise.resolve()
  const env: ControllerEnvironment = {
    request: input => { calls.push(input); return request(input) },
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } },
    lock: action => { const next = locked.then(action); locked = next.catch(() => undefined); return next },
    current: captured => { if (JSON.stringify(captured) !== JSON.stringify(current)) throw new Error('stale source/account') },
    notify: () => undefined, uuid: () => `key-${++sequence}`, now: () => 1
  }
  const controller = new CollaborationController(env)
  const selected = (): void => { if (!active) throw new Error('stale selection') }
  return { env, controller, calls, values, selected, setRequest: (value: typeof request) => { request = value },
    setSelected: (value: boolean) => { active = value }, setConnection: (value: ControllerConnection) => { current = value } }
}

test('terminal receipt resolves its original key without forwarding to a new invocation', async () => {
  for (const state of ['interrupted', 'rejected'] as const) {
    const f = fixture(), original = pending()
    f.values.set(CONTROLLER_OUTBOX_KEY, JSON.stringify([original]))
    f.setRequest(async () => ok({ outcome: 'accepted', receipt: receipt(original, { state, reason: 'target_invocation_finished_before_consumption' }) }))
    const result = await f.controller.reconcile(connection, original, f.selected)
    expect(result).toMatchObject({ outcome: 'accepted', receipt: { state, reason: 'target_invocation_finished_before_consumption' } })
    expect(f.controller.records()).toEqual([])
    const restored = new CollaborationController(f.env).drafts()
    expect(restored).toHaveLength(1); expect(restored[0]).toMatchObject({ requestKey: original.requestKey, message: original.message, receipt: { state } })
    expect(f.calls).toHaveLength(1); expect(f.calls[0].method).toBe('GET')
    expect(f.calls[0].path).toContain('/controller-receipts/key-1')
  }
})

test('terminal draft persistence failure or false readback cannot erase the original unknown', async () => {
  for (const mode of ['throw', 'no-write'] as const) {
    const f = fixture(), original = pending(), setItem = f.env.storage.setItem
    f.values.set(CONTROLLER_OUTBOX_KEY, JSON.stringify([original]))
    f.env.storage.setItem = (key, value) => { if (key === CONTROLLER_HISTORY_KEY) { if (mode === 'throw') throw new Error('disk unavailable'); return }; setItem(key, value) }
    f.setRequest(async () => ok({ outcome: 'accepted', receipt: receipt(original, { state: 'interrupted', reason: 'target_invocation_finished_before_consumption' }) }))
    expect(await f.controller.reconcile(connection, original, f.selected)).toMatchObject({ outcome: 'accepted', localRecordRetained: true, receipt: { state: 'interrupted' } })
    expect(new CollaborationController(f.env).records()).toEqual([original])
    expect(f.controller.drafts()).toEqual([]); expect(f.calls.filter(call => call.method === 'POST')).toEqual([])
  }
})

test('explicit discard removes only the selected known-terminal draft without dispatching', async () => {
  const f = fixture(), original = pending(), second = pending({ requestKey: 'second', childSessionId: 'second-child', recipientParticipantId: 'child:second-child' })
  const drafts = [original, second].map(item => ({ ...item, kind: 'accepted', receipt: receipt(item, { state: 'interrupted' }) }))
  f.values.set(CONTROLLER_HISTORY_KEY, JSON.stringify(drafts))
  await f.controller.discardDraft(connection, f.controller.drafts()[0], f.selected)
  expect(f.controller.drafts().map(item => item.requestKey)).toEqual(['second']); expect(f.calls).toEqual([])
  f.setSelected(false)
  await expect(f.controller.discardDraft(connection, f.controller.drafts()[0], f.selected)).rejects.toThrow('stale selection')
  expect(f.controller.drafts()).toHaveLength(1)
})

test('explicit local tracking removal neither cancels nor resends and preserves other unknowns', async () => {
  const f = fixture(), original = pending(), other = pending({ requestKey: 'other-key', childSessionId: 'other-child', recipientParticipantId: 'child:other-child' })
  f.values.set(CONTROLLER_OUTBOX_KEY, JSON.stringify([original, other]))
  await f.controller.forgetTracking(connection, original, f.selected)
  expect(f.controller.records()).toEqual([other]); expect(f.calls).toEqual([])
  f.setSelected(false); await expect(f.controller.forgetTracking(connection, other, f.selected)).rejects.toThrow('stale selection')
  expect(f.controller.records()).toEqual([other])
})

test('exact context recipient may be outside the first participants page', () => {
  expect(parseControllerContext(context(), target).recipient.invocationRunId).toBe('child-run')
  expect(() => parseControllerContext(context('next-invocation'), target)).toThrow('切换工作轮次')
})
test('context cannot substitute a guessed root, attempt, sender or child', () => {
  for (const invalid of [null, {}, { ...(context() as object), recipient: undefined },
    { ...(context() as object), scope: { rootRunId: 'other', rootSessionId: 'parent', rootAttemptId: 'a' } },
    { ...(context() as object), participants: { entries: [], revision: -1, hasMore: false } }])
    expect(() => parseControllerContext(invalid, target)).toThrow()
})
test('capability is a strict boolean and false does not expose mutations', async () => {
  expect(parseControllerCapability({ userControllerMutation: false })).toBe(false)
  for (const value of [{}, { userControllerMutation: 1 }, { userControllerMutation: 'true' }, null]) expect(() => parseControllerCapability(value)).toThrow()
  const f = fixture(); f.setRequest(async () => ok({ userControllerMutation: false }))
  await expect(f.controller.submit(connection, target, '原要求', f.selected)).rejects.toThrow('尚未启用')
  expect(f.calls.filter(item => item.method === 'POST')).toHaveLength(0)
})
test('new send persists exact scope, invocation, key and text before one POST', async () => {
  const f = fixture()
  const result = await f.controller.submit(connection, target, '原要求', f.selected)
  expect(result.outcome).toBe('accepted')
  const post = f.calls.find(item => item.method === 'POST')!
  expect(post.body).toEqual({ recipientParticipantId: 'child:child', recipientInvocationRunId: 'child-run', message: '原要求', requestKey: 'key-1' })
  expect(post.query).toEqual({ rootAttemptId: 'attempt', rootSessionId: 'parent' })
  expect(post.expectedEngine).toEqual(connection.expectedEngine)
  expect(f.controller.records()).toEqual([])
})
test('the real anonymous engine account null is a valid isolated connection', async () => {
  const f = fixture(), anonymous = { ...connection, expectedEngine: { ...connection.expectedEngine, accountId: null } }
  f.setConnection(anonymous)
  expect((await f.controller.submit(anonymous, target, '原要求', f.selected)).outcome).toBe('accepted')
  expect(f.calls.find(item => item.method === 'POST')?.expectedEngine?.accountId).toBeNull()
  expect(controllerStorageIdentity(anonymous.expectedEngine)).not.toBe(controllerStorageIdentity(connection.expectedEngine))
})
test('transport unknown survives a new controller and only queries the original key', async () => {
  const f = fixture()
  f.setRequest(async input => input.method === 'POST' ? Promise.reject(new Error('lost connection'))
    : input.path.endsWith('controller-context') ? ok(context()) : ok({ userControllerMutation: true }))
  expect((await f.controller.submit(connection, target, '原要求', f.selected)).outcome).toBe('unknown')
  const record = new CollaborationController(f.env).records()[0]
  expect(record.requestKey).toBe('key-1')
  f.setRequest(async () => ({ ok: false, code: 404, message: '', data: { outcome: 'not_found', requestKey: 'key-1' } }))
  expect((await f.controller.reconcile(connection, record, f.selected)).outcome).toBe('not_found')
  expect(f.calls.at(-1)?.path).toBe('/collaboration/roots/root/controller-receipts/key-1')
  expect(f.controller.records()).toHaveLength(1)
  expect(f.calls.filter(item => item.method === 'POST')).toHaveLength(1)
})
test('unknown blocks a new key or a second request to this child', async () => {
  const f = fixture(); f.values.set(CONTROLLER_OUTBOX_KEY, JSON.stringify([pending()]))
  await expect(f.controller.submit(connection, target, '别的要求', f.selected)).rejects.toThrow('先核对原请求')
  expect(f.calls.filter(item => item.method === 'POST')).toHaveLength(0)
})
test('explicit retry rechecks original receipt and exact context before same-key POST', async () => {
  const f = fixture(); f.values.set(CONTROLLER_OUTBOX_KEY, JSON.stringify([pending()]))
  expect((await f.controller.retry(connection, pending(), f.selected)).outcome).toBe('accepted')
  expect(f.calls.map(item => item.method)).toEqual(['GET', 'GET', 'GET', 'POST'])
  expect(f.calls[0].path).toContain('/controller-receipts/key-1')
  expect(f.calls.at(-1)?.body).toEqual({ recipientParticipantId: 'child:child', recipientInvocationRunId: 'child-run', message: '原要求', requestKey: 'key-1' })
})
test('receipt accepted during recovery prevents another POST', async () => {
  const f = fixture(); f.values.set(CONTROLLER_OUTBOX_KEY, JSON.stringify([pending()]))
  f.setRequest(async () => ok({ outcome: 'accepted', receipt: receipt() }))
  expect((await f.controller.retry(connection, pending(), f.selected)).outcome).toBe('accepted')
  expect(f.calls).toHaveLength(1); expect(f.controller.records()).toEqual([])
})
test('unknown, malformed not_found and query failure never retry', async () => {
  for (const response of [ok({ outcome: 'unknown' }), { ok: false, code: 503, message: '暂不可用', data: null },
    { ok: false, code: 404, message: '', data: { outcome: 'not_found', requestKey: 'other' } },
    ok({ outcome: 'not_found', requestKey: 'key-1' })]) {
    const f = fixture(); f.values.set(CONTROLLER_OUTBOX_KEY, JSON.stringify([pending()])); f.setRequest(async () => response)
    await expect(f.controller.retry(connection, pending(), f.selected)).rejects.toThrow()
    expect(f.calls.filter(item => item.method === 'POST')).toHaveLength(0); expect(f.controller.records()).toHaveLength(1)
  }
})
test('new local instance can query but cannot resend the saved request', async () => {
  const f = fixture(); const next = { ...connection, source: 8, expectedEngine: { ...connection.expectedEngine, instanceId: 'new-instance' } }
  f.setConnection(next); f.values.set(CONTROLLER_OUTBOX_KEY, JSON.stringify([pending()]))
  expect((await f.controller.reconcile(next, pending(), f.selected)).outcome).toBe('not_found')
  await expect(f.controller.retry(next, pending(), f.selected)).rejects.toThrow('只能核对')
  expect(f.calls.filter(item => item.method === 'POST')).toHaveLength(0)
})
test('another account or endpoint cannot query or send the saved request', async () => {
  const f = fixture(); const next = { ...connection, source: 8, expectedEngine: { ...connection.expectedEngine, accountId: 'other' } }
  f.setConnection(next)
  await expect(f.controller.reconcile(next, pending(), f.selected)).rejects.toThrow('其他引擎或账号')
  expect(f.calls).toHaveLength(0)
})
test('child continuation or root attempt change between lookup and retry blocks delivery', async () => {
  for (const changed of [context('next-run'), { ...(context() as object), scope: { rootRunId: 'root', rootSessionId: 'parent', rootAttemptId: 'next-attempt' } }]) {
    const f = fixture(); f.values.set(CONTROLLER_OUTBOX_KEY, JSON.stringify([pending()]))
    f.setRequest(async input => input.path.endsWith('/controller-context') ? ok(changed) : input.path.endsWith('/capabilities')
      ? ok({ userControllerMutation: true }) : { ok: false, code: 404, message: '', data: { outcome: 'not_found', requestKey: 'key-1' } })
    await expect(f.controller.retry(connection, pending(), f.selected)).rejects.toThrow()
    expect(f.calls.filter(item => item.method === 'POST')).toHaveLength(0)
  }
})
test('selection changed while context is in flight cannot persist or POST', async () => {
  const f = fixture(); f.setRequest(async input => {
    if (input.path.endsWith('/controller-context')) { f.setSelected(false); return ok(context()) }
    return ok({ userControllerMutation: true })
  })
  await expect(f.controller.submit(connection, target, '原要求', f.selected)).rejects.toThrow('stale selection')
  expect(f.controller.records()).toEqual([]); expect(f.calls.filter(item => item.method === 'POST')).toHaveLength(0)
})
test('late accepted response cannot clear unknown in a different selection', async () => {
  const f = fixture(); f.setRequest(async input => {
    if (input.method === 'POST') { f.setSelected(false); return ok({ outcome: 'accepted', receipt: receipt() }) }
    return input.path.endsWith('/controller-context') ? ok(context()) : ok({ userControllerMutation: true })
  })
  await expect(f.controller.submit(connection, target, '原要求', f.selected)).rejects.toThrow('stale selection')
  expect(f.controller.records()).toHaveLength(1)
})
test('late response from replaced source cannot remove its persisted record', async () => {
  const f = fixture(); f.setRequest(async input => {
    if (input.method === 'POST') { f.setConnection({ ...connection, source: 8 }); return ok({ outcome: 'accepted', receipt: receipt() }) }
    return input.path.endsWith('/controller-context') ? ok(context()) : ok({ userControllerMutation: true })
  })
  await expect(f.controller.submit(connection, target, '原要求', f.selected)).rejects.toThrow('stale source')
  expect(f.controller.records()).toHaveLength(1)
})
test('receipt body hash, payload bytes, receiver and scope must all match', async () => {
  for (const change of [{ payloadHash: '0'.repeat(64) }, { payloadBytes: 2 }, { recipientParticipantId: 'child:other' },
    { requestKey: 'other' }, { rootAttemptId: 'other' }, { acceptedSeq: -1 }, { state: 'processed' }]) {
    const f = fixture(); f.values.set(CONTROLLER_OUTBOX_KEY, JSON.stringify([pending()])); f.setRequest(async () => ok({ outcome: 'accepted', receipt: receipt(pending(), change) }))
    await expect(f.controller.reconcile(connection, pending(), f.selected)).rejects.toThrow()
    expect(f.controller.records()).toHaveLength(1)
  }
})
test('business refusal clears unknown while preserving caller input', async () => {
  const f = fixture(); const draft = '原要求'
  f.setRequest(async input => input.method === 'POST' ? { ok: false, code: 409, message: '本轮已结束', data: null }
    : input.path.endsWith('/controller-context') ? ok(context()) : ok({ userControllerMutation: true }))
  await expect(f.controller.submit(connection, target, draft, f.selected)).rejects.toThrow('本轮已结束')
  expect(draft).toBe('原要求'); expect(f.controller.records()).toEqual([])
})
test('unrecognized POST response stays unknown instead of pretending rejected', async () => {
  const f = fixture(); f.setRequest(async input => input.method === 'POST' ? ok({ outcome: 'accepted', receipt: {} })
    : input.path.endsWith('/controller-context') ? ok(context()) : ok({ userControllerMutation: true }))
  await expect(f.controller.submit(connection, target, '原要求', f.selected)).rejects.toThrow('回执无效')
  expect(f.controller.records()).toHaveLength(1)
})
test('storage failure prevents first dispatch and never drops another unknown', async () => {
  const f = fixture(); f.env.storage.setItem = () => { throw new Error('QuotaExceededError') }
  await expect(f.controller.submit(connection, target, '原要求', f.selected)).rejects.toThrow('QuotaExceededError')
  expect(f.calls.filter(item => item.method === 'POST')).toHaveLength(0)
})
test('verified queued receipt stays accepted when local journal cleanup fails', async () => {
  const f = fixture(), write = f.env.storage.setItem
  f.env.storage.setItem = (key, value) => { if (value === '[]') throw new Error('cleanup failed'); write(key, value) }
  const result = await f.controller.submit(connection, target, '原要求', f.selected)
  expect(result).toMatchObject({ outcome: 'accepted', localRecordRetained: true, receipt: { state: 'queued' } })
  expect(f.controller.records()).toHaveLength(1); expect(f.calls.filter(item => item.method === 'POST')).toHaveLength(1)
})
test('a selection change immediately after persistence leaves a recoverable record without POST', async () => {
  const f = fixture(); f.env.notify = () => f.setSelected(false)
  await expect(f.controller.submit(connection, target, '原要求', f.selected)).rejects.toThrow('stale selection')
  expect(f.controller.records()).toHaveLength(1); expect(f.calls.filter(item => item.method === 'POST')).toHaveLength(0)
})
test('bounded outbox refuses new records without evicting unresolved requests', async () => {
  const records = Array.from({ length: 16 }, (_, i) => pending({ requestKey: `old-${i}`, childSessionId: `old-${i}`, recipientParticipantId: `child:old-${i}` }))
  const f = fixture(); f.values.set(CONTROLLER_OUTBOX_KEY, JSON.stringify(records))
  await expect(f.controller.submit(connection, target, '原要求', f.selected)).rejects.toThrow('数量无效')
  expect(f.controller.records()).toEqual(records); expect(f.calls.filter(item => item.method === 'POST')).toHaveLength(0)
  expect(() => appendControllerPending([pending()], pending({ message: '其他', payloadBytes: 6 }))).toThrow('冻结')
})
test('corrupt, oversized and duplicate journals are not erased or reused', () => {
  for (const raw of ['{bad', '{}', JSON.stringify([pending(), pending()]), JSON.stringify([pending({ payloadBytes: 0 })]), ' '.repeat(400000)])
    expect(() => parseControllerOutbox(raw)).toThrow()
})
test('concurrent sends to the same child serialize persistence and dispatch once', async () => {
  const f = fixture(); let resolvePost: (() => void) | undefined
  const gate = new Promise<void>(resolve => { resolvePost = resolve })
  f.setRequest(async input => {
    if (input.method === 'POST') { await gate; return ok({ outcome: 'accepted', receipt: receipt() }) }
    return input.path.endsWith('/controller-context') ? ok(context()) : ok({ userControllerMutation: true })
  })
  const first = f.controller.submit(connection, target, '原要求', f.selected)
  const second = f.controller.submit(connection, target, '第二条', f.selected)
  await expect(second).rejects.toThrow('先核对原请求'); resolvePost!(); await first
  expect(f.calls.filter(item => item.method === 'POST')).toHaveLength(1)
})
test('remote bridge accepts only the controller read and send methods', () => {
  for (const path of ['/collaboration/capabilities', '/collaboration/roots/root/controller-context', '/collaboration/roots/root/controller-receipts/key'])
    expect(remoteRequestError('remote', 'GET', path)).toBeNull()
  expect(remoteRequestError('remote', 'POST', '/collaboration/roots/root/messages')).toBeNull()
  for (const [method, path] of [['DELETE', '/collaboration/roots/root/messages'], ['POST', '/collaboration/capabilities'], ['GET', '/collaboration/roots/root/messages'], ['POST', '/collaboration/roots/root/controller-context']])
    expect(remoteRequestError('remote', method, path)).not.toBeNull()
})

test('queued ACK keeps original key and text through restart for explicit GET of a later terminal result', async () => {
  const f = fixture()
  await f.controller.submit(connection, target, '原要求', f.selected)
  expect(f.controller.records()).toEqual([])
  const restarted = new CollaborationController(f.env), saved = restarted.history()[0]
  expect(saved).toMatchObject({ kind: 'accepted', message: '原要求', requestKey: 'key-1', receipt: { state: 'queued' } })
  expect(restarted.drafts()).toEqual([])
  f.setRequest(async () => ok({ outcome: 'accepted', receipt: receipt(saved, { state: 'interrupted', reason: 'target_invocation_finished_before_consumption' }) }))
  expect(await restarted.inspectHistory(connection, saved, f.selected)).toMatchObject({ receipt: { state: 'interrupted' } })
  const secondRestart = new CollaborationController(f.env)
  expect(secondRestart.drafts()[0]).toMatchObject({ message: '原要求', requestKey: 'key-1' })
  expect(controllerSavedStatus(secondRestart.history()[0])).toBe('本轮结束前未读取，原文已保留')
  expect(f.calls.filter(item => item.method === 'POST')).toHaveLength(1)
  expect(f.calls.at(-1)).toMatchObject({ method: 'GET', path: '/collaboration/roots/root/controller-receipts/key-1', query: { rootAttemptId: 'attempt', rootSessionId: 'parent' } })
})

test('known receipt transitions never claim consumption or roll a terminal state back to queued', async () => {
  const f = fixture(), original = pending()
  const saved = (state: string, reason?: string) => parseControllerHistory(JSON.stringify([{ ...original, kind: 'accepted', receipt: receipt(original, { state, ...(reason ? { reason } : {}) }) }]))[0]
  const queued = saved('queued'), terminal = saved('interrupted', 'target_invocation_finished_before_consumption')
  expect(controllerSavedStatus(queued)).toBe('已接纳（不代表已执行）')
  expect(controllerSavedStatus(saved('interrupted', 'engine_stopped'))).not.toContain('未读取')
  expect(mergeControllerSaved(terminal, queued)).toEqual(terminal)
  expect(() => mergeControllerSaved(terminal, saved('rejected'))).toThrow('不一致')
  const changed = parseControllerHistory(JSON.stringify([{ ...original, kind: 'accepted', receipt: receipt(original, { messageId: 'another-message' }) }]))[0]
  expect(() => mergeControllerSaved(queued, changed)).toThrow('身份')
  f.values.set(CONTROLLER_HISTORY_KEY, JSON.stringify([terminal])); f.setRequest(async () => ok({ outcome: 'accepted', receipt: receipt(original) }))
  expect(await f.controller.inspectHistory(connection, terminal, f.selected)).toEqual(terminal)
  expect(f.controller.history()[0]).toEqual(terminal); expect(f.calls.every(item => item.method === 'GET')).toBe(true)
})

test('explicit refusal is durable without fabricating an accepted receipt', async () => {
  for (const code of [400, 403, 404, 409, 413, 429]) {
    const f = fixture()
    f.setRequest(async input => input.method === 'POST' ? { ok: false, code, message: 'explicit refusal', data: null }
      : input.path.endsWith('/controller-context') ? ok(context()) : ok({ userControllerMutation: true }))
    await expect(f.controller.submit(connection, target, '拒绝后的原文', f.selected)).rejects.toThrow('explicit refusal')
    const restarted = new CollaborationController(f.env), saved = restarted.history()[0]
    expect(restarted.records()).toEqual([]); expect(saved).toMatchObject({ kind: 'refused', message: '拒绝后的原文', rejection: { code, message: 'explicit refusal' } })
    expect('receipt' in saved).toBe(false)
    expect(restarted.drafts()).toEqual([saved])
    const count = f.calls.length
    await expect(restarted.inspectHistory(connection, saved, f.selected)).rejects.toThrow('没有排队回执')
    expect(f.calls).toHaveLength(count)
  }
})

test('known-result write failure never erases the unknown for ACK or explicit refusal', async () => {
  for (const response of ['accepted', 'refused']) for (const failure of ['throw', 'false-readback']) {
    const f = fixture(), write = f.env.storage.setItem
    f.env.storage.setItem = (key, value) => { if (key === CONTROLLER_HISTORY_KEY) { if (failure === 'throw') throw new Error('known-result quota'); return }; write(key, value) }
    if (response === 'refused') f.setRequest(async input => input.method === 'POST' ? { ok: false, code: 409, message: 'refused', data: null }
      : input.path.endsWith('/controller-context') ? ok(context()) : ok({ userControllerMutation: true }))
    if (response === 'accepted') expect(await f.controller.submit(connection, target, '原要求', f.selected)).toMatchObject({ outcome: 'accepted', localRecordRetained: true })
    else await expect(f.controller.submit(connection, target, '原要求', f.selected)).rejects.toThrow()
    expect(new CollaborationController(f.env).records()[0]).toMatchObject({ message: '原要求', requestKey: 'key-1' })
    expect(f.controller.history()).toEqual([])
    expect(f.calls.filter(item => item.method === 'POST')).toHaveLength(1)
  }
})

test('saved receipt query cannot resurrect an explicitly removed record', async () => {
  const f = fixture(); await f.controller.submit(connection, target, '原要求', f.selected)
  const saved = f.controller.history()[0]
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  f.setRequest(async () => { await gate; return ok({ outcome: 'accepted', receipt: receipt(saved, { state: 'interrupted' }) }) })
  const inflight = f.controller.inspectHistory(connection, saved, f.selected)
  await f.controller.removeHistory(connection, saved, f.selected); release()
  await expect(inflight).rejects.toThrow('已移除')
  expect(f.controller.history()).toEqual([]); expect(f.calls.filter(item => item.method === 'POST')).toHaveLength(1)
})

test('late terminal update prevents a stale remove from deleting newer evidence', async () => {
  const f = fixture(); await f.controller.submit(connection, target, '原要求', f.selected)
  const saved = f.controller.history()[0]
  f.setRequest(async () => ok({ outcome: 'accepted', receipt: receipt(saved, { state: 'interrupted' }) }))
  await f.controller.inspectHistory(connection, saved, f.selected)
  await expect(f.controller.removeHistory(connection, saved, f.selected)).rejects.toThrow('已更新')
  expect(f.controller.history()[0]).toMatchObject({ receipt: { state: 'interrupted' } })
})

test('known history is bounded without silently evicting earlier keys or unresolved sends', async () => {
  const f = fixture(), history = Array.from({ length: CONTROLLER_HISTORY_COUNT }, (_, index) => {
    const original = pending({ requestKey: 'saved-' + index, rootRunId: 'older-root-' + index })
    return { ...original, kind: 'accepted', receipt: receipt(original) }
  })
  f.values.set(CONTROLLER_HISTORY_KEY, JSON.stringify(history))
  expect(await f.controller.submit(connection, target, '原要求', f.selected)).toMatchObject({ outcome: 'accepted', localRecordRetained: true })
  expect(f.controller.records()).toHaveLength(1); expect(f.controller.history()).toHaveLength(CONTROLLER_HISTORY_COUNT)
  expect(f.controller.history().map(item => item.requestKey)).toEqual(history.map(item => item.requestKey))
  expect(() => parseControllerHistory(' '.repeat(CONTROLLER_HISTORY_BYTES + 1))).toThrow('容量')
  expect(() => parseControllerHistory(JSON.stringify([...history, history[0]]))).toThrow('数量')
})

test('new supplement keeps older exact and cross-root records; clearing a draft keeps its receipt', async () => {
  const f = fixture(), old = pending({ requestKey: 'old', rootRunId: 'older-root', recipientInvocationRunId: 'older-invocation' })
  const prior = pending({ requestKey: 'prior' })
  f.values.set(CONTROLLER_HISTORY_KEY, JSON.stringify([old, prior].map(item => ({ ...item, kind: 'accepted', receipt: receipt(item, { state: 'interrupted' }) }))))
  await f.controller.submit(connection, target, '原要求', f.selected)
  expect(f.controller.history().map(item => item.requestKey)).toEqual(['old', 'prior', 'key-1'])
  const draft = f.controller.drafts().find(item => item.requestKey === 'prior')!
  await f.controller.discardDraft(connection, draft, f.selected)
  expect(f.controller.history().find(item => item.requestKey === 'prior')).toMatchObject({ draftDismissed: true, message: '原要求' })
  const newest = f.controller.history().find(item => item.requestKey === 'key-1')!
  await f.controller.removeHistory(connection, newest, f.selected)
  expect(f.controller.drafts().map(item => item.requestKey)).toEqual(['old'])
  expect(f.controller.history().map(item => item.requestKey)).toEqual(['old', 'prior'])
  expect(f.calls.filter(item => item.method === 'POST')).toHaveLength(1)
})

test('history cannot be queried by a different account or applied after selection changes', async () => {
  const f = fixture(); await f.controller.submit(connection, target, '原要求', f.selected)
  const saved = f.controller.history()[0], other = { ...connection, expectedEngine: { ...connection.expectedEngine, accountId: 'other' } }
  f.setConnection(other); const count = f.calls.length
  await expect(f.controller.inspectHistory(other, saved, f.selected)).rejects.toThrow('其他引擎或账号'); expect(f.calls).toHaveLength(count)
  f.setConnection(connection); f.setRequest(async () => { f.setSelected(false); return ok({ outcome: 'accepted', receipt: receipt(saved, { state: 'interrupted' }) }) })
  await expect(f.controller.inspectHistory(connection, saved, f.selected)).rejects.toThrow('stale selection')
  expect(f.controller.history()[0]).toMatchObject({ receipt: { state: 'queued' } })
})
