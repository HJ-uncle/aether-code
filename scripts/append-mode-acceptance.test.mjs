import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { assertCodeQueue, assertContext, assertControllerProvenance, assertDeliveredReceipt, assertEngine, assertFiveCurrent, assertIntegrated, assertNavigationItems, assertNextTurn, assertPending,
  assertReceipt, planFor, queryOriginalReceipt, readCompleteArchive, reserveDispatch, rootInvocationId, runAttempt, sha, waitForSessionQueueEntry, sessionQueueScope, sessionTaskRows } from './append-mode-acceptance.mjs'

const engine = { mode: 'embedded', baseUrl: 'http://127.0.0.1:12542', instanceId: 'instance-A', accountId: 'account-A' }
const owner = { mode: 'work', sessionId: 'session-A', engine }
const run = { runId: 'root-A', attemptId: 'attempt-A', turnId: 'turn-A', sessionId: 'session-A' }
const authority = { tenant_id: 'tenant-A', root_run_id: run.runId, root_attempt_id: run.attemptId, root_session_id: run.sessionId,
  subject_key: sha(JSON.stringify(['account', 'tenant-A', 'account-A'])), subject_kind: 'account', generation: 'generation-A' }
const context = { outcome: 'ready', scope: { rootRunId: run.runId, rootAttemptId: run.attemptId, rootSessionId: run.sessionId },
  recipient: { kind: 'root', participantId: 'root:' + run.runId, invocationRunId: rootInvocationId(run.runId, run.attemptId), sessionId: run.sessionId } }
const pending = (index = 1) => ({ ...context.scope, message: '追加要求-' + index, payloadBytes: Buffer.byteLength('追加要求-' + index), expectedEngine: engine,
  recipientParticipantId: context.recipient.participantId, recipientInvocationRunId: context.recipient.invocationRunId, requestKey: 'request-' + index })
const receipt = item => ({ messageId: 'message-' + item.requestKey, requestKey: item.requestKey, rootRunId: item.rootRunId, rootAttemptId: item.rootAttemptId,
  senderParticipantId: 'controller:' + authority.subject_key, senderInvocationRunId: 'controllerinv:' + sha(JSON.stringify([authority.tenant_id, item.rootRunId, item.rootAttemptId, authority.subject_key])), recipientParticipantId: item.recipientParticipantId,
  payloadHash: sha(item.message), payloadBytes: Buffer.byteLength(item.message), acceptedSeq: Number(item.requestKey.split('-').at(-1)), acceptedAt: 123, state: 'queued' })
const accepted = item => ({ ok: true, code: 200, data: { outcome: 'accepted', receipt: receipt(item) } })
const page = (rows, revision, total = rows.length, totalPages = 1) => ({ ok: true, data: rows, pagination: { total, totalPages }, metadata: { archiveRevision: revision } })
const delivery = item => {
  const encoded = JSON.stringify({ uuid: 'history-' + item.requestKey, sessionId: item.rootSessionId, type: 'user', message: { content: item.message } })
  return { message_id: receipt(item).messageId, root_run_id: item.rootRunId, root_attempt_id: item.rootAttemptId, history_session_id: item.rootSessionId,
    history_message_id: 'history-' + item.requestKey, state: 'integrated', encoded_row: encoded, row_hash: sha(encoded) }
}
const historyRow = item => ({ id: 'history-' + item.requestKey, role: 'user', content: item.message, metadata: { turnId: run.turnId, rootRunId: run.runId,
  collaborationDelivery: { messageId: receipt(item).messageId, recipientInvocationRunId: item.recipientInvocationRunId, source: 'user-controller' } } })
const origin = item => ({ ...authority, message_id: receipt(item).messageId, request_key: item.requestKey, recipient_participant_id: item.recipientParticipantId,
  recipient_invocation_id: item.recipientInvocationRunId, payload_body: item.message, payload_hash: sha(item.message), payload_bytes: item.payloadBytes,
  accepted_at: receipt(item).acceptedAt, sender_id: receipt(item).senderParticipantId, sender_invocation_id: receipt(item).senderInvocationRunId })

test('module source exposes explicit launch only, no implicit CLI/model execution on import', () => {
  const source = readFileSync(fileURLToPath(new URL('./append-mode-acceptance.mjs', import.meta.url)), 'utf8')
  assert.match(source, /if \(!new URL\(import\.meta\.url\)\.search && !new URL\(import\.meta\.url\)\.hash && process\.argv\[1\]/)
  assert.match(source, /export async function start/)
  assert.ok(!source.includes('fakeProvider'))
})

test('cache-busted helper import cannot run CLI when argv points at the same script', () => {
  const target = new URL('./append-mode-acceptance.mjs', import.meta.url)
  for (const suffix of ['?source=recovery-proof', '#audit-proof']) {
    // Invalid CLI input ensures even a regressed guard fails before any launch.
    const source = `process.argv=[process.execPath,${JSON.stringify(fileURLToPath(target))},'--__import_guard_probe'];await import(${JSON.stringify(target.href + suffix)});console.log('IMPORTED_WITHOUT_CLI');`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'IMPORTED_WITHOUT_CLI')
  }
})

test('exact root context refuses changed session, attempt and invocation', () => {
  assert.equal(assertContext(context, owner, run), context)
  for (const [key, value] of [['rootRunId', 'other-root'], ['rootAttemptId', 'next-attempt'], ['rootSessionId', 'other-session']])
    assert.throws(() => assertContext({ ...context, scope: { ...context.scope, [key]: value } }, owner, run))
  assert.throws(() => assertContext({ ...context, recipient: { ...context.recipient, invocationRunId: 'later-root' } }, owner, run))
  assert.throws(() => assertContext({ ...context, recipient: { ...context.recipient, invocationRunId: run.runId } }, owner, run))
  assert.throws(() => assertContext({ ...context, recipient: { ...context.recipient, participantId: 'root' } }, owner, run))
})

test('actual round-1 root invocation matches production hash, not UUID', () => {
  const observed = { runId: '035b8713-5134-4399-b099-fddc7323c5b0', attemptId: '865190c7-b88a-407f-ab60-178f4b1e5497',
    sessionId: 'work-home-36466bf7-5f11-4540-a709-636988381d6a', turnId: '50e8b90c-559c-4bce-bc2c-32699d66d675' }
  const observedInvocation = 'rootinv:3547d25d56777e067d186ad6e36932a4fdbdbf6b462104fe21902d95aa973a8b'
  assert.equal(rootInvocationId(observed.runId, observed.attemptId), observedInvocation)
  const observedContext = { outcome: 'ready', scope: { rootRunId: observed.runId, rootAttemptId: observed.attemptId, rootSessionId: observed.sessionId },
    recipient: { kind: 'root', participantId: 'root:' + observed.runId, invocationRunId: observedInvocation, sessionId: observed.sessionId } }
  assert.doesNotThrow(() => assertContext(observedContext, { ...owner, sessionId: observed.sessionId }, observed))
  assert.throws(() => assertContext({ ...observedContext, recipient: { ...observedContext.recipient, invocationRunId: rootInvocationId(observed.runId, 'foreign-attempt') } }, { ...owner, sessionId: observed.sessionId }, observed))
})

test('public root attempts come from admission receipts; missing private attempt is not fabricated', () => {
  const { attemptId, ...publicRun } = run
  const receiptRun = { ...publicRun, serverAdmissionReceipt: { attemptId, rootRunId: run.runId, sessionId: run.sessionId, turnId: run.turnId } }
  assert.equal(runAttempt(receiptRun), attemptId)
  assert.doesNotThrow(() => assertContext(context, owner, receiptRun))
  assert.throws(() => assertContext({ ...context, scope: { ...context.scope, rootAttemptId: 'other' } }, owner, receiptRun))
  assert.equal(runAttempt(publicRun), undefined)
  assert.doesNotThrow(() => assertContext(context, owner, publicRun))
  assert.throws(() => assertContext({ ...context, scope: { ...context.scope, rootAttemptId: undefined } }, owner, publicRun))
})

test('engine fence includes account, process instance, endpoint and mode', () => {
  assert.doesNotThrow(() => assertEngine(engine, engine))
  for (const field of Object.keys(engine)) assert.throws(() => assertEngine({ ...engine, [field]: 'different' }, engine))
  assert.doesNotThrow(() => assertEngine({ ...engine, accountId: null }, { ...engine, accountId: null }))
})

test('pending record ties exact message to scope, recipient and current connection', () => {
  const item = pending()
  assert.equal(assertPending(item, owner, context, item.message), item)
  for (const altered of [{ ...item, message: 'other' }, { ...item, rootAttemptId: 'other' }, { ...item, recipientInvocationRunId: 'other' },
    { ...item, expectedEngine: { ...engine, accountId: 'other' } }]) assert.throws(() => assertPending(altered, owner, context, item.message))
})

test('receipt identity and payload cannot be changed under the same key', () => {
  const item = pending(), original = receipt(item)
  assert.equal(assertReceipt(original, item), original)
  for (const altered of [{ ...original, requestKey: 'new' }, { ...original, payloadHash: sha('other') }, { ...original, payloadBytes: 0 },
    { ...original, rootAttemptId: 'other' }, { ...original, recipientParticipantId: 'child' }, { ...original, acceptedSeq: NaN }])
    assert.throws(() => assertReceipt(altered, item))
})

test('unknown and then accepted receipt recovery uses GET for original key only', async () => {
  const item = pending(), calls = []
  const request = async input => { calls.push(input); return calls.length === 1 ? { ok: false, code: 503, data: { outcome: 'unknown' } } : accepted(item) }
  assert.equal((await queryOriginalReceipt(request, item, engine, 'work')).outcome, 'unknown')
  assert.equal((await queryOriginalReceipt(request, item, engine, 'work')).outcome, 'accepted')
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.method, 'GET'); assert.equal(call.path, '/collaboration/roots/root-A/controller-receipts/request-1')
    assert.deepEqual(call.query, { rootAttemptId: 'attempt-A', rootSessionId: 'session-A' }); assert.equal(call.body, undefined)
  }
})

test('ambiguous click cannot be attempted again even when local outbox was not recorded', () => {
  const intent = { sessionId: run.sessionId, runId: run.runId, mode: 'work', delivery: 'current', messageSha256: sha('原要求') }
  const journal = [reserveDispatch([], intent)]
  assert.throws(() => reserveDispatch(journal, intent), /ALREADY_ATTEMPTED/)
  assert.throws(() => reserveDispatch(journal, { ...intent, delivery: 'next', runId: 'new-run' }), /ALREADY_ATTEMPTED/)
  assert.doesNotThrow(() => reserveDispatch(journal, { ...intent, sessionId: 'different-session' }))
})

test('a real not_found does not trigger a resend and malformed not_found stays unknown', async () => {
  const item = pending(), calls = []
  const request = async input => { calls.push(input); return { ok: false, code: 404, data: { outcome: 'not_found', requestKey: item.requestKey } } }
  assert.equal((await queryOriginalReceipt(request, item, engine, 'code')).outcome, 'not_found')
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].toolProfile, 'code')
  assert.equal((await queryOriginalReceipt(async () => ({ ok: false, code: 404, data: { outcome: 'not_found', requestKey: 'wrong' } }), item, engine, 'code')).outcome, 'unknown')
})

test('engine identity changes are rejected before any receipt request', async () => {
  let requests = 0
  await assert.rejects(queryOriginalReceipt(async () => { requests++; return accepted(pending()) }, pending(), { ...engine, accountId: 'foreign' }, 'work'))
  assert.equal(requests, 0)
})

test('accepted but not integrated cannot pass model consumption audit', () => {
  const item = pending(), input = { pending: item, receipt: receipt(item), deliveries: [delivery(item)], history: [historyRow(item)], firstRun: run }
  assert.doesNotThrow(() => assertIntegrated(input))
  for (const deliveries of [[], [{ ...delivery(item), state: 'pending' }], [delivery(item), delivery(item)], [{ ...delivery(item), state: 'suppressed' }]])
    assert.throws(() => assertIntegrated({ ...input, deliveries }))
  assert.throws(() => assertIntegrated({ ...input, receipt: { ...receipt(item), state: 'interrupted' } }))
})

test('integration hash, session, unique history and turn all matter', () => {
  const item = pending(), input = { pending: item, receipt: receipt(item), deliveries: [delivery(item)], history: [historyRow(item)], firstRun: run }
  assert.throws(() => assertIntegrated({ ...input, deliveries: [{ ...delivery(item), row_hash: 'invalid' }] }))
  assert.throws(() => assertIntegrated({ ...input, deliveries: [{ ...delivery(item), history_session_id: 'other' }] }))
  assert.throws(() => assertIntegrated({ ...input, history: [] }))
  assert.throws(() => assertIntegrated({ ...input, history: [historyRow(item), historyRow(item)] }))
  assert.throws(() => assertIntegrated({ ...input, history: [{ ...historyRow(item), metadata: { turnId: 'next-turn' } }] }))
  assert.throws(() => assertIntegrated({ ...input, history: [{ ...historyRow(item), content: '[用户追加指令]\n' + item.message }] }))
  assert.throws(() => assertIntegrated({ ...input, history: [{ ...historyRow(item), modelInputContent: item.message }] }))
})

test('controller sender and recipient must match independent SQL authority and origin', () => {
  const item = pending(), input = { pending: item, receipt: receipt(item), origin: origin(item), authority }
  assert.doesNotThrow(() => assertControllerProvenance(input))
  assert.throws(() => assertControllerProvenance({ ...input, receipt: { ...input.receipt, senderParticipantId: 'root' } }))
  assert.throws(() => assertControllerProvenance({ ...input, origin: { ...input.origin, recipient_invocation_id: run.runId } }))
  assert.throws(() => assertControllerProvenance({ ...input, authority: { ...authority, subject_key: 'forged' } }))
  assert.throws(() => assertControllerProvenance({ ...input, origin: { ...input.origin, payload_body: 'changed' } }))
})

test('public integrated receipt must match independently checked history identity', () => {
  const item = pending(), row = delivery(item), reported = { ...receipt(item), delivery: { state: 'integrated', historyMessageId: row.history_message_id, integratedAt: 123 } }
  assert.doesNotThrow(() => assertDeliveredReceipt(reported, item, row))
  assert.throws(() => assertDeliveredReceipt(receipt(item), item, row))
  assert.throws(() => assertDeliveredReceipt({ ...reported, delivery: { state: 'pending' } }, item, row))
  assert.throws(() => assertDeliveredReceipt({ ...reported, delivery: { ...reported.delivery, historyMessageId: 'other' } }, item, row))
  assert.throws(() => assertDeliveredReceipt({ ...reported, delivery: { ...reported.delivery, integratedAt: undefined } }, item, row))
})

test('five current inputs require unique keys/receipts and strict accepted sequence', () => {
  const records = Array.from({ length: 5 }, (_, i) => { const item = pending(i + 1); return { pending: item, receipt: receipt(item) } })
  assert.doesNotThrow(() => assertFiveCurrent(records))
  assert.throws(() => assertFiveCurrent(records.slice(0, 4)))
  assert.throws(() => assertFiveCurrent([records[0], ...records.slice(0, 4)]))
  assert.throws(() => assertFiveCurrent([...records].reverse()))
  assert.throws(() => assertFiveCurrent(records.map((row, i) => i === 4 ? { ...row, receipt: { ...row.receipt, messageId: records[0].receipt.messageId } } : row)))
})

test('next queue must form a new root and turn with one exact user message', () => {
  const nextRun = { ...run, runId: 'root-next', turnId: 'turn-next' }, message = '独立下一轮'
  const history = [{ id: 'next-u', role: 'user', content: message, metadata: { rootRunId: nextRun.runId, turnId: nextRun.turnId } }]
  const roots = [run, nextRun].map(row => ({ session_id: row.sessionId, run_id: row.runId }))
  const input = { history, message, roots, firstRun: run, nextRun }
  assert.doesNotThrow(() => assertNextTurn(input))
  assert.throws(() => assertNextTurn({ ...input, nextRun: run }))
  assert.throws(() => assertNextTurn({ ...input, nextRun: { ...nextRun, turnId: run.turnId } }))
  assert.throws(() => assertNextTurn({ ...input, history: [...history, ...history] }))
  assert.throws(() => assertNextTurn({ ...input, roots: [...roots, roots[0]] }))
})

test('archive verifies all pages and preserves exact session and revision', async () => {
  const calls = [], rows = [{ id: 'one', sessionId: run.sessionId }, { id: 'two', sessionId: run.sessionId }]
  const result = await readCompleteArchive(async (path, query) => { calls.push({ path, query }); return page([rows[query.current - 1]], 'rev', 2, 2) }, run.sessionId, 1)
  assert.deepEqual(result.rows, rows); assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.query.sessionId === run.sessionId))
  await assert.rejects(readCompleteArchive(async (_path, query) => page([rows[query.current - 1]], query.current, 2, 2), run.sessionId), /ARCHIVE_CHANGED/)
})

test('archive rejects incomplete, duplicate, foreign and revisionless evidence', async () => {
  for (const response of [page([{ id: 'one' }], 'rev', 2, 1), page([{ id: 'one' }, { id: 'one' }], 'rev'),
    page([{ id: 'one', sessionId: 'foreign' }], 'rev'), page([{ id: 'one' }], undefined)])
    await assert.rejects(readCompleteArchive(async () => response, run.sessionId))
})

test('Work selection is by the real component session key, independent of duplicated titles', () => {
  const prior = globalThis.document
  globalThis.document = { querySelectorAll: () => [{ title: '相同标题', '__reactFiber$test': { key: 'session-A' }, getClientRects: () => [1] },
    { title: '相同标题', '__reactFiber$test': { key: 'session-B' }, getClientRects: () => [1] }] }
  try { assert.deepEqual(sessionTaskRows().map(row => row.sessionId), ['session-A', 'session-B']) }
  finally { if (prior === undefined) delete globalThis.document; else globalThis.document = prior }
})

test('both plans use five unique short inputs and segregated mode markers', () => {
  for (const mode of ['work', 'code']) {
    const plan = planFor(mode)
    assert.equal(plan.current.length, 5); assert.equal(new Set(plan.current).size, 5)
    assert.ok(plan.current.every((message, i) => message.includes('current-' + (i + 1)) && message.includes('"' + mode + '"')))
    assert.match(plan.next, /下一轮/); assert.match(plan.stop, /真实停止/)
  }
})

test('public Code queue ownership comes from SessionTray, not absent SendOptions', () => {
  const queue = { sessionId: run.sessionId, entries: [{ id: 'queued-1', text: '下一轮' }] }
  assert.doesNotThrow(() => assertCodeQueue(queue, run.sessionId, '下一轮'))
  assert.throws(() => assertCodeQueue({ ...queue, sessionId: 'foreign' }, run.sessionId, '下一轮'))
  assert.throws(() => assertCodeQueue({ ...queue, entries: [{ ...queue.entries[0], sessionId: 'foreign' }] }, run.sessionId, '下一轮'))
  assert.throws(() => assertCodeQueue({ ...queue, entries: [queue.entries[0], queue.entries[0]] }, run.sessionId, '下一轮'))
})

test('hover navigation requires each exact plain-text preview and unique ordered IDs', () => {
  const users = [{ id: 'u1', content: '需求一\n真实正文' }, { id: 'u2', content: '合法 JSON {"rootRunId":"用户自己写的内容"}' }]
  const items = users.map(row => ({ id: row.id, preview: row.content.replace(/\s+/g, ' ').slice(0, 60) }))
  assert.doesNotThrow(() => assertNavigationItems(items, users))
  assert.throws(() => assertNavigationItems(items.slice(0, 1), users))
  assert.throws(() => assertNavigationItems([items[0], items[0]], users))
  assert.throws(() => assertNavigationItems([...items].reverse(), users))
  assert.throws(() => assertNavigationItems([{ ...items[0], preview: '[用户追加指令] ' + items[0].preview }, items[1]], users))
})

test('Work next read waits for a committed target while preserving empty r0 observations', async () => {
  const scope = { source: { mode: 'embedded', endpoint: '', accountId: engine.accountId }, tenantId: 'tenant', namespace: { id: 'ns', generation: 'generation' }, owner: 'work', taskId: owner.sessionId }
  const row = { id: 'queued', phase: 'pending', envelope: { draft: { text: '下一轮' } } }
  let count = 0, elapsed = 0
  const saved = []
  const result = await waitForSessionQueueEntry({ scope, message: '下一轮', now: () => elapsed, pause: async ms => { elapsed += ms },
    read: async () => ({ ok: true, value: { state: { scope, revision: count++, entries: count < 3 ? [] : [row] } } }),
    onObservation: value => saved.push(structuredClone(value)) })
  assert.equal(result.response.value.state.revision, 2)
  assert.equal(result.elapsedMs, 400); assert.equal(result.observations.length, 3)
  assert.equal(saved[0].observations[0].response.value.state.entries.length, 0)
  assert.equal(saved.at(-1).observations.length, 3)
})

test('Work next read never swallows errors, foreign scope or duplicate target', async () => {
  const scope = { owner: 'work', taskId: owner.sessionId }, row = { id: 'queued', phase: 'pending', envelope: { draft: { text: '下一轮' } } }
  for (const response of [{ ok: false, code: 'CORRUPT', message: 'actual product failure' },
    { ok: true, value: { state: { scope: { ...scope, taskId: 'foreign' }, revision: 0, entries: [] } } },
    { ok: true, value: { state: { scope, revision: 1, entries: [row, row] } } }]) {
    let calls = 0, writes = 0
    await assert.rejects(waitForSessionQueueEntry({ scope, message: '下一轮', read: async () => { calls++; return response },
      onObservation: () => { writes++ }, pause: async () => assert.fail('must fail immediately') }))
    assert.equal(calls, 1); assert.equal(writes, 1)
  }
})

test('Work next read times out without mutation and derives complete admitted scope', async () => {
  const scope = sessionQueueScope(owner, { serverAdmissionReceipt: { tenantId: 'tenant-A', namespace: { id: 'ns-A', generation: 'generation-A' } } })
  assert.deepEqual(scope, { source: { mode: 'embedded', endpoint: '', accountId: engine.accountId }, owner: 'work', taskId: owner.sessionId,
    tenantId: 'tenant-A', namespace: { id: 'ns-A', generation: 'generation-A' } })
  let elapsed = 0, calls = 0
  await assert.rejects(waitForSessionQueueEntry({ scope, message: 'missing', timeoutMs: 400, now: () => elapsed, pause: async ms => { elapsed += ms },
    read: async () => { calls++; return { ok: true, value: { state: { scope, revision: 0, entries: [] } } } } }), /NOT_COMMITTED/)
  assert.equal(elapsed, 400); assert.equal(calls, 3)
})

test('a stalled Work IPC read cannot exceed the total wait budget or hide its observation', async () => {
  const observed = []; let calls = 0
  await assert.rejects(waitForSessionQueueEntry({ scope: {}, message: 'target', timeoutMs: 10,
    read: () => { calls++; return new Promise(() => {}) }, onObservation: value => observed.push(value) }), /WAIT_BUDGET_EXCEEDED/)
  assert.equal(calls, 1); assert.match(observed[0].observations[0].readError, /WAIT_BUDGET_EXCEEDED/)
})
