/** Real-model Code/Work append acceptance. Import has no I/O or launch side effects.
 * --start launches one isolated controller, but sends no prompt. --run explicitly
 * launches and runs both modes. Fresh profile/workspace are required each time.
 * POST /work or /code attempts a phase once; uncertain UI sends are never replayed.
 * The deterministic window helper supplies time, not fake model responses.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const sha = value => createHash('sha256').update(value).digest('hex')
const sleep = ms => new Promise(done => setTimeout(done, ms))
const turnId = row => row.metadata?.turnId || row.conversationId
const engineFields = ['mode', 'baseUrl', 'instanceId', 'accountId']
const expectedEngine = engine => Object.fromEntries(engineFields.map(key => [key, engine[key]]))
const terminal = value => !value?.running && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(value?.run?.status)
const text = (value, name) => assert.ok(typeof value === 'string' && value.trim(), name + ' required')
const scopeOf = value => ({ rootRunId: value.rootRunId, rootAttemptId: value.rootAttemptId, rootSessionId: value.rootSessionId })
export const runAttempt = run => run?.serverAdmissionReceipt?.attemptId ?? run?.admissionReceipt?.attemptId ?? run?.attemptId
/** Mirrors engine core/collaboration/store.ts rootInvocationId, not rootRunId. */
export function rootInvocationId(rootRunId, rootAttemptId) {
  text(rootRunId, 'rootRunId'); text(rootAttemptId, 'rootAttemptId')
  return 'rootinv:' + sha(JSON.stringify([rootRunId, rootAttemptId]))
}

export const acceptanceMatrix = Object.freeze([
  'Five current messages: one durable receipt and integrated history row per message, same root/attempt/turn.',
  'One next message: Work and Code main-owned durable queue, then independent root/turn; never executed in current root.',
  'Navigate away/back and reload while next-turn is still pending, then reload completed history: exact session and no duplicates.',
  'New stop run: real stop button, terminal cancellation, no implicit retry or extra root.',
  'Unknown submission: query only original requestKey; no blind resend or replacement key.',
])

export function assertEngine(actual, expected) {
  assert.deepEqual(expectedEngine(actual || {}), expectedEngine(expected), 'ENGINE_IDENTITY_CHANGED')
}

export function assertContext(context, owner, run) {
  assert.equal(context?.outcome, 'ready')
  assert.equal(run.sessionId, owner.sessionId, 'ROOT_SESSION_CHANGED')
  assert.equal(context.scope?.rootRunId, run.runId, 'ROOT_SCOPE_CHANGED')
  assert.equal(context.scope?.rootSessionId, owner.sessionId, 'ROOT_SCOPE_CHANGED')
  text(context.scope?.rootAttemptId, 'controller-context rootAttemptId')
  if (runAttempt(run) !== undefined) assert.equal(context.scope.rootAttemptId, runAttempt(run), 'ROOT_ATTEMPT_CHANGED')
  assert.equal(context.recipient?.kind, 'root')
  assert.equal(context.recipient.participantId, 'root:' + run.runId, 'ROOT_PARTICIPANT_CHANGED')
  assert.equal(context.recipient.sessionId, owner.sessionId)
  assert.equal(context.recipient.invocationRunId, rootInvocationId(run.runId, context.scope.rootAttemptId), 'ROOT_INVOCATION_CHANGED')
  if (run.serverAdmissionReceipt) {
    for (const [field, expected] of Object.entries({ rootRunId: run.runId, sessionId: run.sessionId, turnId: run.turnId, userMessageId: run.userMessageId }))
      assert.equal(run.serverAdmissionReceipt[field], expected, 'ROOT_ADMISSION_IDENTITY_CHANGED:' + field)
  }
  return context
}

export function assertReceipt(receipt, pending) {
  for (const key of ['messageId', 'requestKey', 'rootRunId', 'rootAttemptId', 'senderParticipantId', 'senderInvocationRunId', 'recipientParticipantId']) text(receipt?.[key], 'receipt.' + key)
  for (const key of ['rootRunId', 'rootAttemptId', 'requestKey', 'recipientParticipantId']) assert.equal(receipt[key], pending[key], 'RECEIPT_IDENTITY_MISMATCH:' + key)
  // A human controller is its own authenticated producer, not the root agent.
  // Sender IDs are server-issued subject digests, not "root"/rootRunId.
  assert.equal(receipt.payloadHash, sha(pending.message), 'RECEIPT_PAYLOAD_CHANGED')
  assert.equal(receipt.payloadBytes, Buffer.byteLength(pending.message))
  assert.ok(Number.isSafeInteger(receipt.acceptedSeq) && receipt.acceptedSeq >= 0)
  assert.ok(Number.isSafeInteger(receipt.acceptedAt) && receipt.acceptedAt >= 0)
  assert.ok(['queued', 'rejected', 'interrupted'].includes(receipt.state))
  return receipt
}

export function assertPending(pending, owner, context, message) {
  assertEngine(pending.expectedEngine, owner.engine)
  assert.deepEqual(scopeOf(pending), context.scope, 'PENDING_SCOPE_CHANGED')
  assert.equal(pending.message, message)
  assert.equal(pending.payloadBytes, Buffer.byteLength(message))
  assert.equal(pending.recipientParticipantId, context.recipient.participantId)
  assert.equal(pending.recipientInvocationRunId, context.recipient.invocationRunId)
  text(pending.requestKey, 'requestKey')
  return pending
}

/** Reads are the only allowed recovery action, including a genuine not_found. */
export async function queryOriginalReceipt(request, pending, engine, mode) {
  assertEngine(engine, pending.expectedEngine)
  const response = await request({ method: 'GET', path: `/collaboration/roots/${encodeURIComponent(pending.rootRunId)}/controller-receipts/${encodeURIComponent(pending.requestKey)}`,
    query: { rootAttemptId: pending.rootAttemptId, rootSessionId: pending.rootSessionId }, expectedEngine: expectedEngine(engine), toolProfile: mode === 'code' ? 'code' : 'general' })
  if (response?.ok && response.data?.outcome === 'accepted') return { outcome: 'accepted', receipt: assertReceipt(response.data.receipt, pending) }
  if (response?.code === 404 && response.data?.outcome === 'not_found' && response.data.requestKey === pending.requestKey) return { outcome: 'not_found', requestKey: pending.requestKey }
  return { outcome: 'unknown', requestKey: pending.requestKey, code: response?.code, reason: response?.message || 'Receipt is not yet authoritative' }
}

export async function readCompleteArchive(read, sessionId, pageSize = 100) {
  const first = await read('/conversation/archive', { sessionId, current: 1, pageSize })
  assert.ok(first.ok && Array.isArray(first.data) && first.pagination, 'ARCHIVE_ENVELOPE_INVALID')
  const { total, totalPages } = first.pagination, revision = first.metadata?.archiveRevision
  assert.ok(Number.isSafeInteger(total) && total >= 0 && Number.isSafeInteger(totalPages) && totalPages >= 0)
  assert.ok(revision !== undefined && revision !== null, 'ARCHIVE_REVISION_REQUIRED')
  assert.ok(totalPages <= 1000, 'ARCHIVE_PAGE_BUDGET_EXCEEDED')
  const pages = [first], rows = [...first.data]
  for (let current = 2; current <= totalPages; current++) {
    const page = await read('/conversation/archive', { sessionId, current, pageSize })
    assert.ok(page.ok && Array.isArray(page.data), 'ARCHIVE_PAGE_INVALID')
    assert.equal(page.metadata?.archiveRevision, revision, 'ARCHIVE_CHANGED_DURING_READ')
    assert.equal(page.pagination?.total, total, 'ARCHIVE_TOTAL_CHANGED')
    assert.equal(page.pagination?.totalPages, totalPages, 'ARCHIVE_PAGE_COUNT_CHANGED')
    pages.push(page); rows.push(...page.data)
  }
  assert.equal(rows.length, total, 'INCOMPLETE_ARCHIVE')
  for (const row of rows) { text(row.id, 'history id'); if (row.sessionId !== undefined) assert.equal(row.sessionId, sessionId, 'FOREIGN_HISTORY_SESSION') }
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length, 'DUPLICATE_HISTORY_ID')
  return { sessionId, revision, total, pages, rows }
}

export function assertIntegrated({ pending, receipt, deliveries, history, firstRun }) {
  assertReceipt(receipt, pending)
  assert.equal(receipt.state, 'queued', 'RECEIPT_TERMINAL_WITHOUT_CONSUMPTION')
  const matches = deliveries.filter(row => row.message_id === receipt.messageId && row.root_run_id === pending.rootRunId && row.root_attempt_id === pending.rootAttemptId && row.history_session_id === pending.rootSessionId)
  assert.equal(matches.length, 1, 'DELIVERY_MISSING_OR_DUPLICATE')
  const row = matches[0]
  assert.equal(row.state, 'integrated', 'ACCEPTANCE_IS_NOT_INTEGRATION')
  assert.equal(sha(row.encoded_row), row.row_hash, 'DELIVERY_HASH_CHANGED')
  const decoded = JSON.parse(row.encoded_row)
  assert.equal(decoded.uuid, row.history_message_id)
  assert.equal(decoded.sessionId, pending.rootSessionId)
  const rows = history.filter(item => item.id === row.history_message_id)
  assert.equal(rows.length, 1, 'INTEGRATED_HISTORY_MISSING_OR_DUPLICATE')
  assert.equal(rows[0].role, 'user')
  assert.equal(rows[0].content, pending.message, 'INTEGRATED_CONTENT_CHANGED')
  assert.ok(!Object.hasOwn(rows[0], 'modelInputContent'), 'PRIVATE_MODEL_ENVELOPE_EXPOSED')
  assert.equal(rows[0].metadata?.rootRunId, pending.rootRunId)
  assert.equal(rows[0].metadata?.collaborationDelivery?.messageId, receipt.messageId)
  assert.equal(rows[0].metadata?.collaborationDelivery?.recipientInvocationRunId, pending.recipientInvocationRunId)
  assert.equal(rows[0].metadata?.collaborationDelivery?.source, 'user-controller')
  assert.equal(turnId(rows[0]), firstRun.turnId, 'APPEND_MOVED_TO_ANOTHER_TURN')
  return row
}

export function assertControllerProvenance({ pending, receipt, origin, authority }) {
  assertReceipt(receipt, pending)
  assert.ok(origin && authority, 'CONTROLLER_PROVENANCE_MISSING')
  for (const key of ['tenant_id', 'root_run_id', 'root_attempt_id', 'root_session_id', 'subject_key', 'subject_kind', 'generation'])
    assert.equal(origin[key], authority[key], 'CONTROLLER_AUTHORITY_CHANGED:' + key)
  for (const [key, expected] of Object.entries({ root_run_id: pending.rootRunId, root_attempt_id: pending.rootAttemptId,
    root_session_id: pending.rootSessionId, message_id: receipt.messageId, request_key: pending.requestKey,
    recipient_participant_id: pending.recipientParticipantId, recipient_invocation_id: pending.recipientInvocationRunId,
    payload_body: pending.message, payload_hash: receipt.payloadHash, payload_bytes: receipt.payloadBytes, accepted_at: receipt.acceptedAt }))
    assert.equal(origin[key], expected, 'CONTROLLER_ORIGIN_CHANGED:' + key)
  assert.equal(origin.recipient_invocation_id, rootInvocationId(pending.rootRunId, pending.rootAttemptId))
  assert.equal(origin.sender_id, 'controller:' + authority.subject_key)
  assert.equal(origin.sender_invocation_id, 'controllerinv:' + sha(JSON.stringify([authority.tenant_id, pending.rootRunId, pending.rootAttemptId, authority.subject_key])))
  assert.equal(receipt.senderParticipantId, origin.sender_id)
  assert.equal(receipt.senderInvocationRunId, origin.sender_invocation_id)
  return origin
}

export function assertDeliveredReceipt(receipt, pending, delivery) {
  assertReceipt(receipt, pending)
  assert.equal(receipt.delivery?.state, 'integrated', 'SERVER_DELIVERY_NOT_INTEGRATED')
  assert.equal(receipt.delivery.historyMessageId, delivery.history_message_id, 'SERVER_DELIVERY_HISTORY_CHANGED')
  assert.ok(Number.isSafeInteger(receipt.delivery.integratedAt) && receipt.delivery.integratedAt >= 0, 'SERVER_DELIVERY_TIME_INVALID')
  return receipt
}

export function assertFiveCurrent(records) {
  assert.equal(records.length, 5)
  assert.equal(new Set(records.map(row => row.pending.requestKey)).size, 5, 'DUPLICATE_REQUEST_KEY')
  assert.equal(new Set(records.map(row => row.receipt.messageId)).size, 5, 'DUPLICATE_MESSAGE_ID')
  records.forEach((row, i) => {
    assertReceipt(row.receipt, row.pending)
    assert.deepEqual(scopeOf(row.pending), scopeOf(records[0].pending))
    if (i) assert.ok(row.receipt.acceptedSeq > records[i - 1].receipt.acceptedSeq, 'ACCEPTANCE_ORDER_CHANGED')
  })
}

export function assertNextTurn({ history, firstRun, nextRun, message, roots }) {
  assert.equal(firstRun.sessionId, nextRun.sessionId)
  assert.notEqual(firstRun.runId, nextRun.runId, 'QUEUE_DID_NOT_CREATE_NEW_ROOT')
  assert.notEqual(firstRun.turnId, nextRun.turnId, 'QUEUE_DID_NOT_CREATE_NEW_TURN')
  const matches = history.filter(row => row.role === 'user' && row.content === message)
  assert.equal(matches.length, 1, 'NEXT_HISTORY_MISSING_OR_DUPLICATE')
  assert.equal(turnId(matches[0]), nextRun.turnId)
  if (nextRun.userMessageId !== undefined) assert.equal(matches[0].id, nextRun.userMessageId, 'NEXT_USER_SEED_ID_CHANGED')
  assert.equal(matches[0].metadata?.rootRunId, nextRun.runId)
  assert.equal(roots.length, 2, 'UNEXPECTED_ROOT_ADMISSION')
  assert.ok(roots.every(row => row.session_id === firstRun.sessionId))
  assert.deepEqual(new Set(roots.map(row => row.run_id)), new Set([firstRun.runId, nextRun.runId]))
}

export async function auditPublicMessages(page, owner, history) {
  const users = history.filter(row => row.role === 'user')
  await page.waitForFunction(input => {
    const surface = document.querySelector('#mode-' + input.mode)
    const selector = input.mode === 'work' ? '.work-message--user[data-message-id]' : '.message--user[data-message-id]'
    const ids = new Set([...(surface?.querySelectorAll(selector) || [])].map(element => element.getAttribute('data-message-id')))
    return input.ids.every(id => ids.has(id))
  }, { mode: owner.mode, ids: users.map(row => row.id) }, { timeout: 30000 })
  const observed = await page.evaluate(mode => {
    const surface = document.querySelector('#mode-' + mode)
    const selector = mode === 'work' ? '.work-message--user[data-message-id]' : '.message--user[data-message-id]'
    const messages = [...surface.querySelectorAll(selector)].map(element => ({ id: element.getAttribute('data-message-id'), content: element.querySelector('.message__bubble-content')?.textContent }))
    const navigation = [...surface.querySelectorAll('.chat__nav-dot')].map(element => {
      let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber$'))]
      return { id: fiber?.key, title: element.getAttribute('title'), label: element.getAttribute('aria-label') }
    })
    return { messages, navigation }
  }, owner.mode)
  assert.equal(new Set(observed.messages.map(row => row.id)).size, observed.messages.length, 'DUPLICATE_USER_MESSAGE_DOM_ID')
  for (const user of users) {
    assert.ok(!Object.hasOwn(user, 'modelInputContent'), 'PRIVATE_MODEL_ENVELOPE_EXPOSED')
    const matches = observed.messages.filter(row => row.id === user.id)
    assert.equal(matches.length, 1, 'PUBLIC_USER_MESSAGE_NOT_RENDERED:' + user.id)
    assert.equal(matches[0].content, user.content, 'PUBLIC_USER_BUBBLE_CHANGED:' + user.id)
  }
  if (owner.mode === 'code') {
    assert.equal(new Set(observed.navigation.map(row => row.id)).size, observed.navigation.length, 'DUPLICATE_NAVIGATION_ID')
    for (const nav of observed.navigation) {
      const user = users.find(row => row.id === nav.id)
      assert.ok(user, 'NAVIGATION_DOES_NOT_REFERENCE_USER_ID')
      assert.equal(nav.title, user.content.replace(/\s+/g, ' ').slice(0, 60), 'NAVIGATION_PREVIEW_CHANGED')
      assert.equal(nav.label, '跳转到：' + nav.title)
    }
    assert.ok(observed.navigation.length >= 2, 'CODE_NAVIGATION_MISSING')
    observed.hoverNavigation = await auditCodeNavigation(page, owner, users)
  }
  return observed
}

export function assertNavigationItems(items, users) {
  assert.equal(items.length, users.length, 'NAVIGATION_LIST_COUNT_CHANGED')
  assert.equal(new Set(items.map(row => row.id)).size, items.length, 'DUPLICATE_NAVIGATION_LIST_ID')
  for (const [index, item] of items.entries()) {
    assert.equal(item.id, users[index].id, 'NAVIGATION_LIST_ORDER_OR_ID_CHANGED')
    assert.equal(item.preview, users[index].content.replace(/\s+/g, ' ').slice(0, 60), 'NAVIGATION_LIST_PREVIEW_CHANGED')
  }
}

/** Actual hover list, not the dots' title attributes. Leave it open for QA shot. */
export async function auditCodeNavigation(page, owner, users) {
  assert.equal(owner.mode, 'code')
  const surface = page.locator('#mode-code'), nav = surface.getByRole('navigation', { name: '消息导航', exact: true })
  assert.equal(await nav.count(), 1)
  await nav.hover()
  const list = nav.locator('.chat__nav-list')
  await list.waitFor({ state: 'visible', timeout: 10000 })
  await list.hover()
  const readItems = () => list.locator('.chat__nav-item').evaluateAll(elements => elements.map(element => {
    const fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber$'))]
    return { id: fiber?.key, preview: element.querySelector('.chat__nav-item-text')?.textContent, active: element.getAttribute('aria-current') === 'true' }
  }))
  const items = await readItems(); assertNavigationItems(items, users)
  const target = users.find(row => row.metadata?.collaborationDelivery?.source === 'user-controller')
  assert.ok(target, 'APPEND_MESSAGE_REQUIRED_FOR_NAVIGATION_PROBE')
  const index = items.findIndex(row => row.id === target.id)
  await list.locator('.chat__nav-item').nth(index).click()
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const jumped = await page.evaluate(id => {
    const surface = document.querySelector('#mode-code'), region = surface.querySelector('.chat__messages')
    const message = [...surface.querySelectorAll('.message--user[data-message-id]')].find(element => element.getAttribute('data-message-id') === id)
    const active = [...surface.querySelectorAll('.chat__nav-dot[aria-current="true"]')].map(element => element[Object.keys(element).find(key => key.startsWith('__reactFiber$'))]?.key)
    const box = message?.getBoundingClientRect(), viewport = region?.getBoundingClientRect()
    return { id, active, messageTop: box?.top, messageBottom: box?.bottom, regionTop: viewport?.top, regionBottom: viewport?.bottom,
      visible: Boolean(box && viewport && box.bottom > viewport.top && box.top < viewport.bottom && box.right > viewport.left && box.left < viewport.right) }
  }, target.id)
  assert.ok(jumped.visible, 'NAVIGATION_TARGET_NOT_IN_SCROLL_VIEW:' + JSON.stringify(jumped))
  assert.deepEqual(jumped.active, [target.id], 'NAVIGATION_ACTIVE_TARGET_CHANGED:' + JSON.stringify(jumped))
  await nav.hover(); await list.waitFor({ state: 'visible', timeout: 10000 }); await list.hover()
  const after = await readItems(); assertNavigationItems(after, users)
  return { items, jumped, after, hovered: true, clickedAppend: target.id, leftOpenForScreenshot: true }
}

/** Read only React key, never title matching or calling component handlers. */
export function workTaskRows() {
  return [...document.querySelectorAll('#mode-work .work-sidebar__task')].map((element, index) => {
    const key = Object.keys(element).find(name => name.startsWith('__reactFiber$'))
    return { index, sessionId: key ? element[key]?.key : null, visible: element.getClientRects().length > 0 }
  })
}

export function codeQueueSnapshot() {
  const element = document.querySelector('#mode-code .session-tray')
  let fiber = element?.[Object.keys(element).find(key => key.startsWith('__reactFiber$'))]
  for (let depth = 0; fiber && depth < 32; depth++, fiber = fiber.return) {
    const props = fiber.memoizedProps
    if (typeof props?.sessionId === 'string' && Array.isArray(props.queue)) return { durability: 'renderer-projection', sessionId: props.sessionId,
      entries: props.queue.map(row => ({ id: row.id, text: row.text, sessionId: row.options?.sessionId })) }
  }
  return null
}

export function assertCodeQueue(queue, sessionId, message) {
  assert.equal(queue?.sessionId, sessionId, 'CODE_QUEUE_WRONG_SESSION')
  assert.ok(Array.isArray(queue.entries), 'CODE_QUEUE_UNAVAILABLE')
  const matches = queue.entries.filter(entry => entry.text === message)
  assert.equal(matches.length, 1, 'CODE_QUEUE_MISSING_OR_DUPLICATE')
  text(matches[0].id, 'Code queue entry ID')
  // SessionTray exposes QueuedMessage (id/text/attachments), not SendOptions.
  // Its owning sessionId is authoritative; inspect options only if available.
  if (matches[0].sessionId !== undefined) assert.equal(matches[0].sessionId, sessionId, 'CODE_QUEUE_ENTRY_FOREIGN_SESSION')
  return queue
}

export function workQueueScope(owner, run) {
  const receipt = run.serverAdmissionReceipt ?? run.admissionReceipt
  text(receipt?.tenantId, 'admitted queue tenantId')
  text(receipt?.namespace?.id, 'admitted queue namespace.id')
  text(receipt?.namespace?.generation, 'admitted queue namespace.generation')
  return { source: { mode: owner.engine.mode, endpoint: owner.engine.mode === 'embedded' ? '' : new URL(owner.engine.baseUrl).href.replace(/\/+$/, ''), accountId: owner.engine.accountId ?? null },
    tenantId: receipt.tenantId, namespace: receipt.namespace, owner: owner.mode === 'code' ? 'code' : 'work', taskId: owner.sessionId }
}

/** Clicking Enqueue precedes its async durable commit. r0 is an observation,
 * never evidence that the intended message is missing permanently or accepted. */
export async function waitForWorkQueueEntry({ read, scope, message, onObservation = () => {}, timeoutMs = 20000, now = Date.now, pause = sleep }) {
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 20000, 'QUEUE_WAIT_MUST_BE_BOUNDED')
  const startedAt = now(), observations = []
  while (now() - startedAt <= timeoutMs) {
    let response, timer
    try {
      response = await Promise.race([read(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('NEXT_QUEUE_READ_WAIT_BUDGET_EXCEEDED; no resend')), Math.max(1, timeoutMs - (now() - startedAt)))
      })])
    } catch (error) {
      observations.push({ elapsedMs: now() - startedAt, readError: String(error.message || error) })
      await onObservation({ startedAt, elapsedMs: now() - startedAt, observations })
      throw error
    } finally { clearTimeout(timer) }
    const elapsedMs = now() - startedAt
    const observation = { elapsedMs, response }; observations.push(observation)
    await onObservation({ startedAt, elapsedMs, observations })
    assert.equal(response?.ok, true, 'PERSISTED_NEXT_QUEUE_READ_FAILED:' + JSON.stringify(response))
    const state = response.value?.state
    assert.deepEqual(state?.scope, scope, 'NEXT_QUEUE_SCOPE_CHANGED')
    assert.ok(Number.isSafeInteger(state.revision) && state.revision >= 0 && Array.isArray(state.entries), 'NEXT_QUEUE_STATE_INVALID')
    const matches = state.entries.filter(entry => entry.envelope?.draft?.text === message)
    assert.ok(matches.length <= 1, 'NEXT_QUEUE_DUPLICATE_TARGET')
    if (matches.length === 1) {
      assert.ok(elapsedMs <= timeoutMs, 'NEXT_QUEUE_COMMIT_EXCEEDED_WAIT_BUDGET')
      text(matches[0].id, 'next queue entry id')
      assert.equal(matches[0].phase, 'pending', 'NEXT_QUEUE_RAN_BEFORE_CURRENT_WINDOW_RELEASE')
      return { response, elapsedMs, observations }
    }
    if (elapsedMs >= timeoutMs) break
    await pause(Math.min(200, timeoutMs - elapsedMs))
  }
  throw new Error('NEXT_QUEUE_TARGET_NOT_COMMITTED_WITHIN_20_SECONDS; no resend')
}

/** Reservation is persisted before a click; a timeout cannot authorize a replay. */
export function reserveDispatch(operations, item) {
  assert.ok(!operations.some(previous => previous.kind === 'dispatch-attempt' && previous.sessionId === item.sessionId
    && previous.messageSha256 === item.messageSha256), 'DISPATCH_ALREADY_ATTEMPTED_QUERY_ORIGINAL_RECEIPT')
  return { at: Date.now(), kind: 'dispatch-attempt', ...item }
}

export async function auditFollowupPopover(page, owner, messages) {
  const surface = page.locator('#mode-' + owner.mode), button = surface.getByRole('button', { name: '补充记录 ' + messages.length + ' 条', exact: true })
  assert.equal(await button.count(), 1, 'FOLLOWUP_HISTORY_BUTTON_MISSING')
  const composer = surface.locator('.input-composer').filter({ visible: true })
  assert.equal(await composer.count(), 1)
  const before = await composer.boundingBox()
  await button.click()
  const panel = page.getByRole('dialog', { name: '补充记录', exact: true })
  await panel.waitFor({ state: 'visible', timeout: 10000 })
  const after = await composer.boundingBox(), rows = panel.locator('.root-followup-history__item')
  assert.ok(Math.abs(after.height - before.height) <= 2, 'HISTORY_EXPANDED_COMPOSER_HEIGHT')
  assert.equal(await rows.count(), messages.length)
  assert.equal(await panel.locator('details[open]').count(), 0, 'HISTORY_DEFAULT_EXPANDED')
  const bounds = await panel.evaluate(element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight } })
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.right <= bounds.width + 1 && bounds.bottom <= bounds.height + 1, 'HISTORY_POPOVER_OUTSIDE_VIEWPORT')
  await rows.first().locator('summary').click()
  assert.equal(await rows.first().locator('pre').innerText(), messages.at(-1))
  await panel.press('Escape')
  await panel.waitFor({ state: 'hidden', timeout: 10000 })
  assert.ok(await button.evaluate(element => document.activeElement === element), 'HISTORY_FOCUS_NOT_RESTORED')
  await button.focus(); await button.press('Enter'); await panel.waitFor({ state: 'visible', timeout: 10000 })
  await page.getByRole('tab', { name: owner.mode === 'work' ? 'Code 开发' : 'Work 办公', exact: true }).click()
  await panel.waitFor({ state: 'hidden', timeout: 10000 })
  await selectExactSession(page, owner)
  return { before, after, bounds, messages: messages.length, checked: ['collapsed-default', 'stable-composer-height', 'viewport-bounds', 'full-original-text', 'Escape', 'focus-return', 'Enter-open', 'mode-switch-close'] }
}

export async function selectExactSession(page, owner) {
  const surface = page.locator('#mode-' + owner.mode)
  await page.getByRole('tab', { name: owner.mode === 'code' ? 'Code 开发' : 'Work 办公', exact: true }).click()
  if (owner.mode === 'work') {
    const rows = await page.evaluate(workTaskRows), matching = rows.filter(row => row.visible && row.sessionId === owner.sessionId)
    assert.equal(matching.length, 1, 'EXACT_WORK_SESSION_NOT_IN_RECENT_LIST')
    const button = surface.locator('.work-sidebar__task').nth(matching[0].index)
    assert.equal(await button.evaluate(element => element[Object.keys(element).find(key => key.startsWith('__reactFiber$'))]?.key), owner.sessionId, 'WORK_ROW_CHANGED_BEFORE_CLICK')
    await button.click()
  } else {
    const connection = await page.evaluate(() => window.aether.browser.getConnection())
    if (connection.sessionId !== owner.sessionId) {
      const history = surface.getByRole('button', { name: '会话历史', exact: true })
      if (await history.getAttribute('aria-pressed') !== 'true') await history.click()
      const row = surface.locator('[data-session-id=' + JSON.stringify(owner.sessionId) + ']').filter({ visible: true })
      assert.equal(await row.count(), 1, 'EXACT_CODE_SESSION_MISSING'); await row.click()
    }
  }
  await page.waitForFunction(sessionId => window.aether.browser.getConnection().then(value => value.sessionId === sessionId), owner.sessionId, { timeout: 20000 })
}

export async function assertActiveOwner(page, owner) {
  const observed = await page.evaluate(async input => {
    const engine = await window.aether.engine.getSnapshot(), connection = await window.aether.browser.getConnection()
    const surface = document.querySelector('#mode-' + input.mode)
    const editors = [...(surface?.querySelectorAll('.input-composer__input[role="textbox"]') || [])].filter(element => element.getClientRects().length)
    let task = null
    if (input.mode === 'work') {
      let fiber = editors[0]?.[Object.keys(editors[0] || {}).find(key => key.startsWith('__reactFiber$'))]
      for (let depth = 0; fiber && depth < 48; depth++, fiber = fiber.return) if (fiber.memoizedProps?.controller?.activeTask) { const active = fiber.memoizedProps.controller.activeTask; task = { id: active.id, modelId: active.modelId, workspacePath: active.workspacePath }; break }
    }
    return { engine, connection, visible: surface?.getAttribute('aria-hidden') === 'false', editors: editors.length, task }
  }, owner)
  assertEngine(observed.engine, owner.engine)
  assert.equal(observed.connection.sessionId, owner.sessionId, 'ACTIVE_SESSION_CHANGED')
  assert.ok(observed.visible); assert.equal(observed.editors, 1, 'COMPOSER_AMBIGUOUS')
  if (owner.mode === 'work') {
    assert.equal(observed.task?.id, owner.sessionId, 'WORK_CONTROLLER_CHANGED')
    if (owner.modelId) assert.ok([owner.modelId, owner.modelRecordId].filter(Boolean).includes(observed.task.modelId), 'WORK_MODEL_SELECTION_CHANGED')
    if (owner.workspace) assert.equal(resolve(observed.task.workspacePath).toLowerCase(), resolve(owner.workspace).toLowerCase())
  }
  return observed
}

export const probeSource = String.raw`import assert from 'node:assert/strict';
import {existsSync,writeFileSync,appendFileSync} from 'node:fs';
import {dirname,join} from 'node:path'; import {fileURLToPath} from 'node:url';
const folder=dirname(fileURLToPath(import.meta.url)); const [action,mode,label]=process.argv.slice(2);
assert.ok(['code','work'].includes(mode)); assert.ok(/^[a-z0-9-]+$/.test(label));
const record=event=>appendFileSync(join(folder,mode+'.jsonl'),JSON.stringify({at:Date.now(),event,label,pid:process.pid})+'\n');
if(action==='window'){
 writeFileSync(join(folder,mode+'-'+label+'-started.json'),JSON.stringify({pid:process.pid,at:Date.now()}),{flag:'wx'}); record('started');
 const deadline=Date.now()+90000;
 while(!existsSync(join(folder,mode+'-'+label+'-release.json'))){assert.ok(Date.now()<deadline,'Supervisor window timed out');await new Promise(done=>setTimeout(done,200));}
 record('released'); console.log(JSON.stringify({mode,label,released:true}));
}else if(action==='mark'){
 writeFileSync(join(folder,mode+'-'+label+'.json'),JSON.stringify({at:Date.now(),pid:process.pid}),{flag:'wx'});record('mark');console.log(JSON.stringify({mode,label,created:true}));
}else throw new Error('Unknown action');
`

export function planFor(mode) {
  assert.ok(['code', 'work'].includes(mode))
  const command = (action, label) => `execute_cmd，command="node", args=["append-validation/probe.mjs","${action}","${mode}","${label}"], timeoutMs=120000, background=false`
  return {
    initial: `真实追加测试，只操作 append-validation/，禁止子代理、安装依赖和修改 probe.mjs 或标记文件。第一步调用 ${command('window', 'initial')}。它等待监督者通过真实界面追加要求；不要绕过。命令返回后先按收到顺序执行用户本轮新增要求，然后调用 ${command('mark', 'original-complete')}。最后简洁列出实际完成的标记。`,
    current: Array.from({ length: 5 }, (_, i) => `本轮追加 ${i + 1}/5：窗口返回后，按用户追加顺序、在 original-complete 前调用一次 ${command('mark', 'current-' + (i + 1))}。不得重复或直接伪造标记。`),
    next: `这是排到下一轮的独立消息。只调用一次 ${command('mark', 'next')}，不要重复上一轮命令，然后简洁回复。`,
    stop: `真实停止验证，只操作 append-validation/。第一步调用 ${command('window', 'stop')}，不要改脚本，不要启动后台或子代理；若命令返回再回复。`,
  }
}

/** Controller remains owned by root. No request is sent until an explicit method. */
export function createAppendPhases(controller) {
  const { page, state } = controller
  const folder = join(state.workspace, 'append-validation'), output = join(state.evidence, 'append-validation')
  assert.ok(!existsSync(folder) && !existsSync(output), 'FRESH_APPEND_FIXTURE_REQUIRED')
  mkdirSync(folder); mkdirSync(output); writeFileSync(join(folder, 'probe.mjs'), probeSource, { flag: 'wx' })
  const outcomes = {}, attempted = new Set(), operations = [], timings = []
  const persist = (name, value) => writeFileSync(join(output, name + '.json'), JSON.stringify(value, null, 2))
  const event = value => { operations.push({ at: Date.now(), ...value }); persist('operations', operations) }
  const ownerFor = mode => ({ ...state.roles[mode === 'work' ? 'product' : 'development'], mode, engine: expectedEngine(state.engine), modelId: state.modelId, modelRecordId: state.modelRecordId, workspace: state.workspace })
  const roleFor = mode => mode === 'work' ? 'product' : 'development'
  const request = input => page.evaluate(value => window.aether.engine.request(value), input)
  const read = async (owner, path, query = {}) => {
    const response = await request({ method: 'GET', path, query, expectedEngine: owner.engine, toolProfile: owner.mode === 'code' ? 'code' : 'general' })
    assert.ok(response.ok, `READ_FAILED:${path}:${response.code}:${response.message}`); return response
  }
  const status = async owner => (await read(owner, '/chat/status', { sessionId: owner.sessionId })).data
  const wait = async (label, check, timeout = 180000) => {
    const began = Date.now()
    while (Date.now() - began < timeout) { const value = await check(); if (value) { timings.push({ label, ms: Date.now() - began }); persist('timings', timings); return value } await sleep(250) }
    throw new Error('TIMEOUT:' + label + '; no automatic resend, stop or retry')
  }
  const records = () => page.evaluate(() => [...JSON.parse(localStorage.getItem('aether.collaboration-controller-outbox.v1') || '[]'), ...JSON.parse(localStorage.getItem('aether.collaboration-controller-results.v1') || '[]')])
  const ensureRun = async (owner, run) => {
    await assertActiveOwner(page, owner)
    const current = await status(owner)
    assert.equal(current.run?.status, 'running', 'RUN_NO_LONGER_RUNNING')
    for (const key of ['runId', 'turnId', 'sessionId']) assert.equal(current.run[key], run[key], 'RUN_CHANGED:' + key)
    if (runAttempt(run) !== undefined) assert.equal(runAttempt(current.run), runAttempt(run), 'RUN_ATTEMPT_CHANGED')
  }
  const clickSend = async (owner, run, message, delivery) => {
    await selectExactSession(page, owner); await ensureRun(owner, run)
    const surface = page.locator('#mode-' + owner.mode), selector = surface.getByRole('combobox', { name: '发送方式', exact: true })
    await wait(owner.mode + '-send-mode-ready', async () => await selector.count() === 1 && await selector.isEnabled(), 20000)
    await selector.selectOption(delivery)
    const editor = surface.locator('.input-composer__input[role="textbox"]').filter({ visible: true })
    assert.equal(await editor.count(), 1); await editor.fill(message)
    const button = surface.getByRole('button', { name: delivery === 'current' ? '立即补充' : '排到下一轮', exact: true }).filter({ visible: true })
    assert.equal(await button.count(), 1)
    await wait(owner.mode + '-send-enabled', () => button.isEnabled(), 20000)
    await ensureRun(owner, run)
    event(reserveDispatch(operations, { mode: owner.mode, sessionId: owner.sessionId, runId: run.runId, delivery, messageSha256: sha(message) }))
    await button.click({ timeout: 10000 })
  }
  const current = async (owner, run, message) => {
    const context = assertContext((await read(owner, `/collaboration/roots/${encodeURIComponent(run.runId)}/controller-context`, { rootSessionId: owner.sessionId })).data, owner, run)
    assert.ok(!(await records()).some(row => row.message === message && row.rootSessionId === owner.sessionId), 'APPEND_ALREADY_ATTEMPTED')
    await clickSend(owner, run, message, 'current')
    const pending = await wait('durable-renderer-record', async () => {
      const matches = (await records()).filter(row => row.message === message && row.rootRunId === run.runId && row.rootSessionId === owner.sessionId)
      assert.ok(matches.length <= 1, 'DUPLICATE_RENDERER_RECORD')
      return matches[0] ? assertPending(matches[0], owner, context, message) : null
    }, 20000)
    persist(owner.mode + '-' + pending.requestKey, { context, pending })
    const accepted = await wait('original-key-server-receipt', async () => {
      const result = await queryOriginalReceipt(request, pending, owner.engine, owner.mode)
      event({ kind: 'receipt-read', requestKey: pending.requestKey, outcome: result.outcome })
      return result.outcome === 'accepted' ? result : null
    }, 20000)
    assert.equal(accepted.receipt.state, 'queued', 'APPEND_REFUSED_OR_INTERRUPTED')
    return { pending, receipt: accepted.receipt }
  }
  const dbEvidence = async owner => {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(state.profile, 'engine', 'state', 'agent.db'), { readOnly: true })
    try {
      db.exec('PRAGMA query_only=ON'); db.exec('BEGIN')
      return { roots: db.prepare('SELECT session_id,run_id,turn_id,state FROM root_runs WHERE session_id=? ORDER BY rowid').all(owner.sessionId),
        deliveries: db.prepare('SELECT * FROM collaboration_jsonl_deliveries WHERE history_session_id=?').all(owner.sessionId),
        controllerOrigins: db.prepare('SELECT * FROM collaboration_controller_origins WHERE root_session_id=?').all(owner.sessionId),
        controllerAuthorities: db.prepare('SELECT * FROM collaboration_controller_roots WHERE root_session_id=?').all(owner.sessionId) }
    } finally { db.close() }
  }
  const archive = owner => readCompleteArchive((path, query) => read(owner, path, query), owner.sessionId)
  const phase = async mode => {
    assert.ok(['work', 'code'].includes(mode)); assert.ok(!attempted.has(mode), 'PHASE_ALREADY_ATTEMPTED_QUERY_EVIDENCE')
    attempted.add(mode); outcomes[mode] = { state: 'running', startedAt: Date.now() }; persist('outcomes', outcomes)
    try {
      assert.equal(sha(readFileSync(join(folder, 'probe.mjs'))), sha(probeSource), 'PROBE_CHANGED')
      const plan = planFor(mode); persist(mode + '-plan', plan)
      assert.ok(!state.roles[roleFor(mode)].sessionId, 'FRESH_MODE_SESSION_REQUIRED')
      await controller.send({ id: 'append-' + mode + '-initial', role: roleFor(mode), text: plan.initial })
      const owner = ownerFor(mode); text(owner.sessionId, 'sessionId')
      await selectExactSession(page, owner); await assertActiveOwner(page, owner)
      await wait(mode + '-window', () => existsSync(join(folder, mode + '-initial-started.json')))
      const first = (await status(owner)).run; assert.equal(first.status, 'running')
      assert.ok([state.modelId, state.modelRecordId].filter(Boolean).includes(first.modelId), 'REQUESTED_MODEL_CHANGED')
      if (first.actualModelId !== undefined) assert.equal(first.actualModelId, state.modelId, 'ACTUAL_MODEL_CHANGED')
      const initialHistory = await archive(owner)
      assert.equal(initialHistory.rows.filter(row => row.id === first.userMessageId && row.role === 'user' && row.content === plan.initial && turnId(row) === first.turnId).length, 1, 'INITIAL_PROMPT_OWNER_UNVERIFIED')
      const accepted = []
      for (const message of plan.current) accepted.push(await current(owner, first, message))
      assertFiveCurrent(accepted); persist(mode + '-accepted', accepted)
      await clickSend(owner, first, plan.next, 'next')
      const queueObservation = await waitForWorkQueueEntry({
        read: () => page.evaluate(({ mode, input }) => (mode === 'work' ? window.aether.workQueue : window.aether.codeQueue).invoke(input), {
          mode, input: { taskId: owner.sessionId, expectedEngine: owner.engine, action: { kind: 'read' } }
        }),
        scope: workQueueScope(owner, first), message: plan.next,
        onObservation: observation => persist(mode + '-next-queue-observations', observation)
      })
      timings.push({ label: mode + '-next-queue-committed', ms: queueObservation.elapsedMs, observations: queueObservation.observations.length }); persist('timings', timings)
      const queue = queueObservation.response
      persist(mode + '-next-queue', queue)
      assert.equal(queue.ok, true, 'PERSISTED_NEXT_QUEUE_READ_FAILED:' + JSON.stringify(queue))
      assert.equal(queue.value.state.scope.taskId, owner.sessionId, 'NEXT_QUEUE_WRONG_SESSION')
      assert.equal(queue.value.state.entries.filter(entry => entry.envelope.draft.text === plan.next).length, 1, 'NEXT_QUEUE_MISSING_OR_DUPLICATE')
      const popover = await auditFollowupPopover(page, owner, plan.current); persist(mode + '-popover', popover)
      await page.reload()
      await wait(mode + '-pending-reload-engine', async () => (await page.evaluate(() => window.aether.engine.getSnapshot())).phase === 'ready', 90000)
      await selectExactSession(page, owner)
      await assertActiveOwner(page, owner)
      const restoredQueue = await page.evaluate(({ mode, input }) => (mode === 'work' ? window.aether.workQueue : window.aether.codeQueue).invoke(input), {
        mode, input: { taskId: owner.sessionId, expectedEngine: owner.engine, action: { kind: 'read' } }
      })
      assert.equal(restoredQueue.ok, true, 'PENDING_QUEUE_RELOAD_FAILED')
      assert.deepEqual(restoredQueue.value.state.entries, queue.value.state.entries, 'PENDING_QUEUE_CHANGED_DURING_RELOAD')
      persist(mode + '-pending-reload-queue', restoredQueue)
      await ensureRun(owner, first)
      await controller.screenshot({ name: 'append-' + mode + '-queued' })
      writeFileSync(join(folder, mode + '-initial-release.json'), JSON.stringify({ at: Date.now(), supervisorReleased: true }), { flag: 'wx' })
      event({ kind: 'supervisor-window-release', mode })
      await wait(mode + '-terminal-and-next', async () => existsSync(join(folder, mode + '-next.json')) && terminal(await status(owner)))
      const next = (await status(owner)).run, full = await archive(owner), db = await dbEvidence(owner)
      assert.equal(next.status, 'succeeded'); assertNextTurn({ history: full.rows, firstRun: first, nextRun: next, message: plan.next, roots: db.roots })
      const firstState = JSON.parse(db.roots.find(row => row.run_id === first.runId).state)
      assert.equal(firstState.status, 'succeeded')
      assert.equal(firstState.attemptId, accepted[0].pending.rootAttemptId, 'DURABLE_ROOT_ATTEMPT_CHANGED')
      const delivered = []
      for (const item of accepted) {
        const delivery = assertIntegrated({ ...item, deliveries: db.deliveries, history: full.rows, firstRun: first })
        const server = await queryOriginalReceipt(request, item.pending, owner.engine, owner.mode)
        assert.equal(server.outcome, 'accepted')
        assertControllerProvenance({ pending: item.pending, receipt: server.receipt,
          origin: db.controllerOrigins.find(row => row.message_id === server.receipt.messageId),
          authority: db.controllerAuthorities.find(row => row.root_run_id === item.pending.rootRunId && row.root_attempt_id === item.pending.rootAttemptId) })
        delivered.push(assertDeliveredReceipt(server.receipt, item.pending, delivery))
      }
      persist(mode + '-delivered-server-receipts', delivered)
      const refreshed = await wait(mode + '-automatic-delivery-refresh', async () => {
        const matching = (await records()).filter(row => accepted.some(item => item.pending.requestKey === row.requestKey))
        assert.ok(matching.length <= 5, 'DUPLICATE_LOCAL_DELIVERY_RECORD')
        return matching.length === 5 && matching.every(row => row.kind === 'accepted' && row.receipt.delivery?.state === 'integrated') ? matching : null
      }, 20000)
      persist(mode + '-automatic-delivery-refresh', refreshed)
      const journal = readFileSync(join(folder, mode + '.jsonl'), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
      assert.deepEqual(journal.filter(row => row.event === 'mark').map(row => row.label), ['current-1', 'current-2', 'current-3', 'current-4', 'current-5', 'original-complete', 'next'])
      const calls = full.rows.filter(row => row.toolCall?.name === 'execute_cmd' && basename(String(row.toolCall.args?.args?.[0]).replaceAll('\\', '/')) === 'probe.mjs')
      assert.equal(calls.length, 8, 'UNEXPECTED_OR_DUPLICATE_MODEL_PROBE_CALL')
      for (const label of ['current-1', 'current-2', 'current-3', 'current-4', 'current-5', 'original-complete', 'next']) {
        const matches = calls.filter(row => JSON.stringify(row.toolCall.args.args.slice(1)) === JSON.stringify(['mark', mode, label]))
        assert.equal(matches.length, 1); assert.equal(turnId(matches[0]), label === 'next' ? next.turnId : first.turnId)
      }
      persist(mode + '-archive', full); persist(mode + '-db', db)
      await page.reload()
      await wait(mode + '-reload-engine', async () => (await page.evaluate(() => window.aether.engine.getSnapshot())).phase === 'ready', 90000)
      await selectExactSession(page, owner)
      await assertActiveOwner(page, owner)
      const reloaded = await archive(owner)
      assert.deepEqual(reloaded.rows.map(row => [row.id, row.role, row.content]), full.rows.map(row => [row.id, row.role, row.content]), 'RELOAD_LOST_OR_DUPLICATED_HISTORY')
      const publicUi = await auditPublicMessages(page, owner, reloaded.rows); persist(mode + '-public-user-messages', publicUi)
      await controller.screenshot({ name: 'append-' + mode + '-reloaded' })
      // The second send uses an already verified owner; never the legacy title selector.
      const editor = page.locator('#mode-' + mode + ' .input-composer__input[role="textbox"]').filter({ visible: true })
      await editor.fill(plan.stop); await editor.press('Enter')
      event({ kind: 'stop-probe-start-click', mode, sessionId: owner.sessionId })
      await wait(mode + '-stop-draft-accepted', async () => (await editor.innerText()).trim() === '', 20000)
      await wait(mode + '-stop-window', () => existsSync(join(folder, mode + '-stop-started.json')))
      const beforeStop = (await status(owner)).run; await ensureRun(owner, beforeStop)
      const stop = mode === 'code' ? page.locator('#mode-code .input-composer__stop').filter({ visible: true }) : page.locator('#mode-work').getByRole('button', { name: '停止任务', exact: true }).filter({ visible: true }).first()
      await wait(mode + '-stop-control-ready', async () => await stop.count() === 1 && await stop.isEnabled(), 20000)
      await stop.click()
      await wait(mode + '-stopped', async () => terminal(await status(owner)))
      const stopped = (await status(owner)).run; assert.equal(stopped.runId, beforeStop.runId); assert.equal(stopped.status, 'cancelled')
      assert.equal((await dbEvidence(owner)).roots.length, 3, 'STOP_CREATED_UNEXPECTED_ROOT')
      const finalArchive = await archive(owner); persist(mode + '-final-archive', finalArchive)
      assert.equal(sha(readFileSync(join(folder, 'probe.mjs'))), sha(probeSource), 'PROBE_CHANGED')
      outcomes[mode] = { state: 'passed', sessionId: owner.sessionId, first, next, stopped, accepted, delivered, historyCount: finalArchive.total, journal, popover,
        queueDurability: 'main-process journal; pending entries preserved through renderer reload before consumption',
        evidence: 'Real model, UI composer, engine receipts, SQLite integration, complete archive, execute_cmd file effects. No fake provider or fault injection. DOM screenshots are not native screen QA.' }
      persist('outcomes', outcomes); return outcomes[mode]
    } catch (error) {
      await controller.screenshot({ name: 'append-' + mode + '-failed' }).catch(() => {})
      persist(mode + '-failed-ui', await controller.uiState().catch(() => null))
      const failedOwner = ownerFor(mode)
      if (failedOwner.sessionId) persist(mode + '-failed-queue', await page.evaluate(async ({ mode, sessionId, engine }) => ({
        queue: await (mode === 'work' ? window.aether.workQueue : window.aether.codeQueue).invoke({ taskId: sessionId, expectedEngine: engine, action: { kind: 'read' } }),
        visibleQueueText: Array.from(document.querySelectorAll('#mode-' + mode + ' .session-tray, #mode-' + mode + ' .work-next-turn')).filter(element => element.getClientRects().length).map(element => element.textContent)
      }), failedOwner).catch(cause => ({ error: String(cause.message) })))
      outcomes[mode] = { ...outcomes[mode], state: 'failed', error: String(error.stack || error), failedAt: Date.now() }; persist('outcomes', outcomes); throw error
    }
  }
  return { phase, outcomes, operations, timings, output, current, archive, dbEvidence }
}

export async function start(options = {}) {
  const { launchController } = await import('./four-role-acceptance.mjs')
  const controller = await launchController({ root: 'D:/trust-test/append-mode-acceptance-20261104', ...options })
  const phases = createAppendPhases(controller), token = randomBytes(32).toString('hex')
  let active = false
  const server = createServer(async (incoming, outgoing) => {
    const respond = (code, data) => { outgoing.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); outgoing.end(JSON.stringify(data)) }
    if (incoming.headers.origin || incoming.headers['x-controller-token'] !== token || incoming.headers.host !== `127.0.0.1:${server.address().port}`) return respond(403, { error: 'Local control authorization required' })
    try {
      if (incoming.method === 'GET' && incoming.url === '/status') return respond(200, { active, outcomes: phases.outcomes, timings: phases.timings })
      if (incoming.method !== 'POST' || !['/work', '/code', '/close'].includes(incoming.url)) return respond(404, { error: 'Unknown operation' })
      if (active) return respond(409, { error: 'Phase active; inspect /status' })
      if (incoming.url === '/close') { respond(200, { closing: true }); server.close(); await controller.close(); return }
      active = true
      try { respond(200, await phases.phase(incoming.url.slice(1))) } finally { active = false }
    } catch (error) { respond(500, { error: String(error.message) }) }
  })
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const controlPath = join(controller.state.root, 'append-control.json')
  writeFileSync(controlPath, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token, pid: process.pid, evidence: phases.output }, null, 2))
  console.log(JSON.stringify({ ready: true, controlPath, modelRequestsOnStart: 0 }))
  return { controller, phases, server }
}

// Cache-busted audit imports can name the same file as argv[1]. fileURLToPath
// drops the query/hash, so pathname equality alone would launch a second app.
if (!new URL(import.meta.url).search && !new URL(import.meta.url).hash && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), run = argv.includes('--run'), launch = argv.includes('--start')
  assert.ok(!(run && launch), 'Choose --start or --run')
  const { parseArguments } = await import('./four-role-acceptance.mjs')
  const options = parseArguments(argv.filter(value => value !== '--run'))
  if (run || launch) {
    const app = await start(options)
    if (run) {
      try {
        for (const mode of ['work', 'code']) {
          try { await app.phases.phase(mode) }
          catch { process.exitCode = 1 }
        }
        console.log(JSON.stringify(app.phases.outcomes))
      }
      finally { app.server.close(); await app.controller.close() }
    }
  } else console.log(JSON.stringify({ launched: false, modelRequests: 0, matrix: acceptanceMatrix, usage: '--start or --run with --app-entry --engine-entry --root --round' }, null, 2))
}
