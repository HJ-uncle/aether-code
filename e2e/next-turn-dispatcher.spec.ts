import { test, expect } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { NextTurnQueueStore } from '../src/main/next-turn-queue-store'
import { NextTurnQueueMutationService, type TrustedQueueAuthorityLease } from '../src/main/next-turn-queue-service'
import { NextTurnDispatcher, type QueueDispatchGateway } from '../src/main/next-turn-dispatcher'
import { WORK_QUEUE_TRANSPORT, canonicalAdmissionJson, freezeQueueRequest, assertFrozenQueueRequest, parseAdmissionContext, parseExactAdmission, type AdmissionContext, type AdmissionRoot, type ExactAdmission } from '../src/main/next-turn-admission-protocol'
import { NextTurnQueueError, type NextTurnQueueEnvelope, type NextTurnQueueScope, type NextTurnQueueEntry } from '../src/shared/next-turn-queue'
import type { WorkQueueDraft } from '../src/shared/work-next-turn-api'
import { queuedDraft } from '../src/renderer/src/contrib/work/work-next-turn-queue'

/** WQ3/WQ4 controlled contracts: real immutable journals; synthetic transport only; no Electron/provider/listener. */
const baseScope: NextTurnQueueScope = { source: { mode: 'embedded', endpoint: '', accountId: 'synthetic-account' }, tenantId: 'synthetic-tenant', namespace: { id: 'synthetic-db', generation: 'one' }, owner: 'work', taskId: 'work-one' }
const initialRoot = (): AdmissionRoot => ({ runId: 'initial', attemptId: 'attempt-initial', version: 1, status: 'running', workspacePaths: [], modelId: 'synthetic-model' })
const draft = (text = 'synthetic instruction'): WorkQueueDraft => ({ draft: { text, revision: 1, mentions: [] }, model: { kind: 'explicit', modelId: 'synthetic-model' }, resources: { skills: { kind: 'inherit' }, mcpServers: { kind: 'none' }, knowledgeBases: { kind: 'inherit' } }, thinking: { kind: 'off' }, attachments: [] })
class Gateway implements QueueDispatchGateway {
  current = true; generation = 'one'; preparations = 0; envelopes = 0; posts: string[] = []; failPost = false; absent = false; malformedReceipt = false
  roots = new Map<string, AdmissionRoot | null>(); admitted = new Map<string, ExactAdmission>()
  prepareGate?: Promise<void>; captureGate?: Promise<void>; envelopeGate?: Promise<void>
  async capture(taskId: string) { await this.captureGate; return { scope: { ...structuredClone(baseScope), taskId, namespace: { ...baseScope.namespace, generation: this.generation } }, generation: this.generation } }
  assertCurrent(lease: TrustedQueueAuthorityLease) { if (!this.current || lease.generation !== this.generation) throw new NextTurnQueueError('AUTHORITY', 'synthetic authority changed') }
  async context(scope: NextTurnQueueScope): Promise<AdmissionContext> {
    if (!this.current || scope.namespace.generation !== this.generation) throw new NextTurnQueueError('AUTHORITY', 'synthetic authority changed')
    const root = this.roots.has(scope.taskId) ? this.roots.get(scope.taskId)! : initialRoot()
    return { protocolVersion: 1, tenantId: scope.tenantId, sessionId: scope.taskId, namespace: scope.namespace, transport: WORK_QUEUE_TRANSPORT,
      root, predecessor: root ? { runId: root.runId, attemptId: root.attemptId, version: root.version } : null }
  }
  async envelope(scope: NextTurnQueueScope, input: WorkQueueDraft): Promise<NextTurnQueueEnvelope> {
    this.envelopes++
    await this.envelopeGate
    if (!(await this.context(scope)).root) throw new NextTurnQueueError('AUTHORITY', 'first turn is not started')
    return { ...input, workspace: { kind: 'local-scratch', identity: 'session:' + scope.taskId }, agent: { primaryAgentId: null, collaborators: [] }, memory: { kind: 'inherit' }, security: { policy: 'engine-session' }, attachments: [] }
  }
  editDraft(envelope: NextTurnQueueEnvelope, value: WorkQueueDraft['draft']) { return { ...structuredClone(envelope), draft: value } }
  async prepare(scope: NextTurnQueueScope, envelope: NextTurnQueueEnvelope) {
    this.preparations++; await this.prepareGate
    return { sessionId: scope.taskId, message: envelope.draft.text, model: envelope.model.kind === 'explicit' ? envelope.model.modelId : 'synthetic-model', thinkingMode: false, mcpServers: [] }
  }
  async submit(_scope: NextTurnQueueScope, wire: string) {
    this.posts.push(wire)
    const body = JSON.parse(wire), root = { ...initialRoot(), runId: 'accepted-' + body.admission.requestKey, attemptId: 'accepted-attempt', status: 'running' as const }
    if (!this.absent) this.admitted.set(body.admission.requestKey, { status: 'accepted', root, receipt: { runId: root.runId, turnId: 'turn', userMessageId: 'user', assistantMessageId: 'anchor' } })
    this.roots.set(body.sessionId, root)
    if (this.failPost) throw new Error('synthetic lost response ACK')
  }
  async receipt(_scope: NextTurnQueueScope, entry: Exclude<NextTurnQueueEntry, { phase: 'pending' }>): Promise<ExactAdmission> {
    if (this.malformedReceipt) throw new NextTurnQueueError('AUTHORITY', 'wrong scoped receipt')
    return this.admitted.get(entry.frozen.requestKey) ?? { status: 'absent' }
  }
}
let fixture: string; const owners: NextTurnDispatcher[] = []
test.beforeEach(async ({}, info) => { fixture = join(process.cwd(), '.e2e-tmp', 'wq3-' + info.testId.replace(/[^a-zA-Z0-9]/g, '-')); await fs.mkdir(fixture, { recursive: true }) })
test.afterEach(async () => { for (const owner of owners.splice(0)) await owner.close(); const boundary = resolve(process.cwd(), '.e2e-tmp'); if (!resolve(fixture).startsWith(boundary + sep)) throw new Error('fixture boundary'); await fs.rm(fixture, { recursive: true, force: true }) })
function create(gateway = new Gateway(), directory = fixture, changed?: (scope: NextTurnQueueScope, revision: number) => void) {
  const store = new NextTurnQueueStore(directory), service = new NextTurnQueueMutationService(store, gateway), driver = new NextTurnDispatcher(service, gateway, changed)
  owners.push(driver); return { gateway, store, service, driver }
}
async function enqueue(driver: NextTurnDispatcher, text = 'one', id = 'item-one', task = baseScope.taskId) {
  const current = await driver.read(task)
  return driver.enqueue(task, current.state.revision, 'operation-' + id, id, draft(text))
}
async function phase(driver: NextTurnDispatcher, expected: string, task = baseScope.taskId) {
  await expect.poll(async () => (await driver.read(task)).state.entries[0]?.phase).toBe(expected)
}
test('running predecessor retains pending; succeeded predecessor durably claims before exactly one POST', async () => {
  const { driver, gateway, store } = create(); await enqueue(driver); await expect.poll(() => gateway.posts.length).toBe(0)
  gateway.roots.set(baseScope.taskId, { ...initialRoot(), status: 'succeeded' }); await driver.reconcile(baseScope.taskId)
  await phase(driver, 'accepted'); const committed = (await store.read(baseScope)).state.entries[0]
  expect(committed.phase).toBe('accepted'); expect(gateway.posts).toHaveLength(1)
  if (committed.phase !== 'pending') expect(committed.frozen.wireBody).toBe(gateway.posts[0])
  await Promise.all([driver.reconcile(baseScope.taskId), driver.reconcile(baseScope.taskId)])
  expect(gateway.posts).toHaveLength(1)
})
test('lost POST acknowledgement remains unknown; receipt reconciliation never re-prepares or re-POSTs accepted work', async () => {
  const { driver, gateway } = create(); gateway.roots.set(baseScope.taskId, { ...initialRoot(), status: 'succeeded' }); gateway.failPost = true
  await enqueue(driver); await phase(driver, 'admission-unknown'); expect((await driver.read(baseScope.taskId)).state.paused).toBe(true)
  gateway.failPost = false; await driver.reconcile(baseScope.taskId, true); await phase(driver, 'accepted')
  expect(gateway.preparations).toBe(1); expect(gateway.posts).toHaveLength(1)
})
test('exact absent retry preserves key, wire bytes, and one preparation; ordinary background never retries', async () => {
  const { driver, gateway } = create(); gateway.roots.set(baseScope.taskId, { ...initialRoot(), status: 'succeeded' }); gateway.absent = true
  await enqueue(driver); await phase(driver, 'admission-unknown'); await driver.reconcile(baseScope.taskId)
  expect(gateway.posts).toHaveLength(1); gateway.absent = false; await driver.reconcile(baseScope.taskId, true)
  await phase(driver, 'accepted'); expect(gateway.preparations).toBe(1); expect(gateway.posts[1]).toBe(gateway.posts[0])
})
test('waiting predecessor is not bypassed; clear and pause leave accepted execution untouched', async () => {
  const { driver, gateway } = create(); gateway.roots.set(baseScope.taskId, { ...initialRoot(), status: 'waiting' }); await enqueue(driver)
  await driver.reconcile(baseScope.taskId); expect(gateway.posts).toHaveLength(0)
  gateway.roots.set(baseScope.taskId, { ...initialRoot(), status: 'succeeded' }); await driver.reconcile(baseScope.taskId); await phase(driver, 'accepted')
  await enqueue(driver, 'two', 'item-two'); const current = await driver.read(baseScope.taskId)
  await driver.mutate(baseScope.taskId, current.state.revision, 'clear', { kind: 'mutate', expectedRevision: current.state.revision, operationId: 'clear', operation: { kind: 'clear-pending', at: Date.now() } })
  expect((await driver.read(baseScope.taskId)).state.entries.map(item => item.phase)).toEqual(['accepted']); expect(gateway.posts).toHaveLength(1)
})
test('failed predecessor pauses; explicit resume authorizes only the exact observed predecessor', async () => {
  const { driver, gateway } = create(); gateway.roots.set(baseScope.taskId, { ...initialRoot(), status: 'failed' }); await enqueue(driver)
  await expect.poll(async () => (await driver.read(baseScope.taskId)).state.paused).toBe(true)
  const current = await driver.read(baseScope.taskId)
  await driver.mutate(baseScope.taskId, current.state.revision, 'resume', { kind: 'mutate', expectedRevision: current.state.revision, operationId: 'resume', operation: { kind: 'resume' } })
  await phase(driver, 'accepted'); expect((await driver.read(baseScope.taskId)).state.resumeAnchor).toBeUndefined()
})
test('terminal failure of accepted task pauses all remaining messages', async () => {
  const { driver, gateway } = create(); gateway.roots.set(baseScope.taskId, { ...initialRoot(), status: 'succeeded' }); await enqueue(driver); await phase(driver, 'accepted')
  await enqueue(driver, 'two', 'item-two'); const state = (await driver.read(baseScope.taskId)).state, entry = state.entries[0]
  if (entry.phase === 'pending') throw new Error('expected frozen')
  const exact = gateway.admitted.get(entry.frozen.requestKey)!
  if (exact.status !== 'accepted') throw new Error('expected accepted')
  exact.root.status = 'failed'; await driver.reconcile(baseScope.taskId)
  const current = (await driver.read(baseScope.taskId)).state
  expect(current.entries.map(item => item.phase)).toEqual(['terminal', 'pending']); expect(current.paused).toBe(true); expect(gateway.posts).toHaveLength(1)
})
test('local ACK-loss replay checks complete input and returns original commit without envelope preparation', async () => {
  const { driver, gateway } = create(); const input = draft('one')
  const first = await driver.enqueue(baseScope.taskId, 0, 'stable-operation', 'stable-item', input)
  const replay = await driver.enqueue(baseScope.taskId, 0, 'stable-operation', 'stable-item', structuredClone(input))
  expect(replay.replayed).toBe(true); expect(replay.receipt).toEqual(first.receipt); expect(gateway.envelopes).toBe(1)
  await expect(driver.enqueue(baseScope.taskId, 0, 'stable-operation', 'stable-item', { ...input, thinking: { kind: 'inherit' } })).rejects.toThrow('another draft')
  expect(gateway.envelopes).toBe(1)
})

test('close ACK waits for attachment preparation, blocks later commit and rejects new operations', async () => {
  const { driver, gateway, store } = create(); let release!: () => void
  gateway.envelopeGate = new Promise<void>(resolve => { release = resolve })
  const operation = driver.enqueue(baseScope.taskId, 0, 'closing-op', 'closing-entry', draft('before close'))
  const outcome = operation.then(() => 'unexpected commit', error => error instanceof Error ? error.message : 'error')
  await expect.poll(() => gateway.envelopes).toBe(1)
  let acknowledged = false; const close = driver.close().then(() => { acknowledged = true })
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); expect(acknowledged).toBe(false)
    await expect(driver.read(baseScope.taskId)).rejects.toThrow('closing')
  } finally { release() }
  expect(await outcome).toContain('closed while preparing'); await close
  expect(acknowledged).toBe(true); expect((await store.read(baseScope)).state.entries).toEqual([]); expect(gateway.posts).toHaveLength(0)
})

test('two preparations are bounded and capacity is released after real local commits', async () => {
  const { driver, gateway } = create(); let release!: () => void
  gateway.envelopeGate = new Promise<void>(resolve => { release = resolve })
  const first = driver.enqueue('work-A', 0, 'operation-A', 'entry-A', draft('A'))
  const second = driver.enqueue('work-B', 0, 'operation-B', 'entry-B', draft('B'))
  await expect.poll(() => gateway.envelopes).toBe(2)
  await expect(driver.enqueue('work-C', 0, 'operation-C', 'entry-C', draft('C'))).rejects.toThrow('准备附件')
  release(); await Promise.all([first, second]); gateway.envelopeGate = undefined
  const third = await driver.enqueue('work-C', 0, 'operation-C', 'entry-C', draft('C'))
  expect(third.state.entries[0].envelope.draft.text).toBe('C'); expect(gateway.envelopes).toBe(3)
})

test('observer failure cannot reject committed enqueue or block its owned POST', async () => {
  const gateway = new Gateway(); gateway.roots.set(baseScope.taskId, { ...initialRoot(), status: 'succeeded' })
  const { driver } = create(gateway, fixture, () => { throw new Error('synthetic renderer observer failure') })
  const committed = await enqueue(driver); expect(committed.state.entries[0].id).toBe('item-one')
  await phase(driver, 'accepted'); expect(gateway.posts).toHaveLength(1)
})

test('explicit resume is invalidated by a different failed predecessor before claim', async () => {
  const gateway = new Gateway(); gateway.roots.set(baseScope.taskId, { ...initialRoot(), status: 'failed' }); let replace = false
  const { driver } = create(gateway, fixture, () => { if (replace) { replace = false; gateway.roots.set(baseScope.taskId, { ...initialRoot(), version: 2, status: 'failed' }) } })
  await enqueue(driver); await expect.poll(async () => (await driver.read(baseScope.taskId)).state.paused).toBe(true)
  const current = (await driver.read(baseScope.taskId)).state; replace = true
  await driver.mutate(baseScope.taskId, current.revision, 'stale-resume', { kind: 'mutate', expectedRevision: current.revision, operationId: 'stale-resume', operation: { kind: 'resume' } })
  await driver.reconcile(baseScope.taskId)
  const after = (await driver.read(baseScope.taskId)).state; expect(after.paused).toBe(true); expect(after.entries[0].phase).toBe('pending'); expect(gateway.posts).toHaveLength(0)
})
test('concurrent same-task binds share one service capability and concurrent enqueue CAS rejects rather than dropping', async () => {
  const { driver, service } = create(); await Promise.all(Array.from({ length: 8 }, () => driver.read(baseScope.taskId)))
  expect(service.diagnostics().bindings).toBe(1)
  const result = await Promise.allSettled([driver.enqueue(baseScope.taskId, 0, 'a', 'a', draft('A')), driver.enqueue(baseScope.taskId, 0, 'b', 'b', draft('B'))])
  expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1); expect(result.filter(item => item.status === 'rejected')).toHaveLength(1)
  expect((await driver.read(baseScope.taskId)).state.entries).toHaveLength(1)
})
test('task A/B are independent; selecting or querying B never dispatches A into B', async () => {
  const { driver, gateway } = create(); await enqueue(driver, 'A', 'a', 'work-A'); await enqueue(driver, 'B', 'b', 'work-B')
  gateway.roots.set('work-A', { ...initialRoot(), status: 'succeeded' }); await driver.reconcile('work-A')
  await phase(driver, 'accepted', 'work-A'); expect((await driver.read('work-B')).state.entries[0].phase).toBe('pending')
  expect(JSON.parse(gateway.posts[0]).sessionId).toBe('work-A'); expect((await driver.read('work-B')).state.scope.taskId).toBe('work-B')
})

test('bounded background polling is fair to a third task while the first two accepted roots stay running', async () => {
  const { driver, gateway } = create()
  for (const task of ['work-A', 'work-B', 'work-C']) await enqueue(driver, task, task, task)
  await expect.poll(() => driver.diagnostics().dispatches).toBe(0)
  for (const task of ['work-A', 'work-B', 'work-C']) gateway.roots.set(task, { ...initialRoot(), status: 'succeeded' })
  driver.wakeAll(); await expect.poll(() => gateway.posts.length).toBe(2)
  // Wait for real accepted journals, not a guessed sleep; A/B remain active so fixed map-order polling would starve C.
  await phase(driver, 'accepted', 'work-A'); await phase(driver, 'accepted', 'work-B')
  await expect.poll(() => driver.diagnostics().dispatches).toBe(0)
  driver.wakeAll(); await expect.poll(() => gateway.posts.length).toBe(3)
  await phase(driver, 'accepted', 'work-C')
  expect(gateway.posts.map(wire => JSON.parse(wire).sessionId).sort()).toEqual(['work-A', 'work-B', 'work-C'])
})
test('authoritative source change fences journal mutation; original queue survives', async () => {
  const { driver, gateway, store } = create(); await enqueue(driver); gateway.current = false
  await expect(driver.enqueue(baseScope.taskId, 1, 'new', 'new', draft('new'))).rejects.toThrow('authority changed')
  expect((await store.read(baseScope)).state.entries.map(entry => entry.envelope.draft.text)).toEqual(['one']); expect(gateway.posts).toHaveLength(0)
})
test('pending cancellation during awaited preparation prevents the POST', async () => {
  const { driver, gateway } = create(); let release!: () => void
  gateway.prepareGate = new Promise<void>(resolve => { release = resolve }); gateway.roots.set(baseScope.taskId, { ...initialRoot(), status: 'succeeded' })
  await enqueue(driver); await expect.poll(() => gateway.preparations).toBe(1)
  const current = await driver.read(baseScope.taskId)
  await driver.mutate(baseScope.taskId, current.state.revision, 'remove', { kind: 'mutate', expectedRevision: current.state.revision, operationId: 'remove', operation: { kind: 'remove', id: 'item-one', entryRevision: 1, at: Date.now() } })
  release(); await driver.reconcile(baseScope.taskId)
  expect(gateway.posts).toHaveLength(0); expect((await driver.read(baseScope.taskId)).state.entries).toHaveLength(0)
})
test('restart discovers real journal scopes and converts interrupted claim to unknown before any network retry', async () => {
  const { driver, service, store, gateway } = create(); await enqueue(driver); await driver.close()
  const capabilityOwner = new NextTurnQueueMutationService(store, gateway), capability = await capabilityOwner.bind(baseScope.taskId)
  const state = (await capabilityOwner.read(capability)).state, frozen = freezeQueueRequest(baseScope, { sessionId: baseScope.taskId, message: 'one' }, 1, { runId: 'initial', attemptId: 'attempt-initial', version: 1 })
  await capabilityOwner.transition(capability, state.revision, 'crashed-claim', { kind: 'claim', id: 'item-one', entryRevision: 1, frozen, at: Date.now() }); await capabilityOwner.close()
  const next = create(gateway); expect(await store.listScopes()).toEqual([baseScope]); await next.driver.read(baseScope.taskId); await phase(next.driver, 'admission-unknown')
  expect(gateway.posts).toHaveLength(0); expect(service.diagnostics().closing).toBe(true)
})
test('unknown receipt errors never create another request key or pretend accepted', async () => {
  const { driver, gateway } = create(); gateway.roots.set(baseScope.taskId, { ...initialRoot(), status: 'succeeded' }); gateway.absent = true
  await enqueue(driver); await phase(driver, 'admission-unknown'); gateway.malformedReceipt = true; await driver.reconcile(baseScope.taskId, true)
  expect(gateway.posts).toHaveLength(1); expect((await driver.read(baseScope.taskId)).state.entries[0].phase).toBe('admission-unknown')
})

test('legacy unknown entry without frozen wire cannot be retried even with an exact absent receipt', async () => {
  const { driver, service, gateway } = create(); await enqueue(driver)
  const owner = await service.bind(baseScope.taskId), state = (await service.read(owner)).state
  const frozen = freezeQueueRequest(baseScope, { sessionId: baseScope.taskId, message: 'one' }, 1, { runId: 'initial', attemptId: 'attempt-initial', version: 1 })
  delete frozen.wireBody
  await service.transition(owner, state.revision, 'legacy-claim', { kind: 'claim', id: 'item-one', entryRevision: 1, frozen, at: Date.now() })
  await driver.reconcile(baseScope.taskId)
  const checked = await driver.reconcile(baseScope.taskId, true)
  expect(checked.state.entries[0].phase).toBe('admission-unknown'); expect(checked.dispatchError).toContain('缺少完整请求'); expect(gateway.posts).toHaveLength(0)
})
test('home/new root never starts from a queued draft', async () => {
  const { driver, gateway } = create(); gateway.roots.set(baseScope.taskId, null)
  await expect(enqueue(driver)).rejects.toThrow('first turn'); expect(gateway.posts).toHaveLength(0)
})
test('frozen canonical body rejects post-claim edits and distinguishes empty, false and omitted', () => {
  const frozen = freezeQueueRequest(baseScope, { sessionId: baseScope.taskId, message: 'one', thinkingMode: false, skills: [] }, 1, null)
  expect(assertFrozenQueueRequest(baseScope, frozen)).toBe(frozen.wireBody)
  const other = freezeQueueRequest(baseScope, { sessionId: baseScope.taskId, message: 'one' }, 1, null)
  expect(other.bodyDigest).not.toBe(frozen.bodyDigest)
  expect(frozen.wireBody).toContain('"message":"one"')
  expect(() => assertFrozenQueueRequest(baseScope, { ...frozen, wireBody: frozen.wireBody!.replace('"message":"one"', '"message":"two"') })).toThrow('integrity')
})
test('canonical JSON rejects accessor, hole, hidden field, undefined, nonfinite and cycle', () => {
  const cycle: { loop?: unknown } = {}; cycle.loop = cycle
  const hidden = Object.defineProperty({}, 'secret', { value: 1 }), accessor = Object.defineProperty({}, 'secret', { get: () => { throw new Error('accessor must not execute') } })
  for (const value of [cycle, hidden, accessor, [1, , 2], { value: undefined }, NaN]) expect(() => canonicalAdmissionJson(value)).toThrow()
})
test('trusted context rejects old context, wrong session, transport, and inconsistent root authority', () => {
  const valid = { protocolVersion: 1, tenantId: 'trusted', sessionId: baseScope.taskId, namespace: baseScope.namespace, predecessor: null, root: null, transport: WORK_QUEUE_TRANSPORT }
  expect(parseAdmissionContext(valid, baseScope.taskId).root).toBeNull()
  for (const bad of [{ ...valid, tenantId: undefined }, { ...valid, sessionId: 'other' }, { ...valid, transport: { ...WORK_QUEUE_TRANSPORT, runLifetime: 'ephemeral' } }, { ...valid, root: initialRoot() }]) expect(() => parseAdmissionContext(bad, baseScope.taskId)).toThrow()
})
test('only exact scoped absent result permits a retry', () => {
  const frozen = freezeQueueRequest(baseScope, { sessionId: baseScope.taskId, message: 'one' }, 1, null)
  const valid = { protocolVersion: 1, status: 'absent', namespace: baseScope.namespace, sessionId: baseScope.taskId, requestKey: frozen.requestKey }
  expect(parseExactAdmission(valid, baseScope, frozen)).toEqual({ status: 'absent' })
  for (const bad of [{ ...valid, namespace: { ...baseScope.namespace, generation: 'other' } }, { ...valid, sessionId: 'other' }, { ...valid, requestKey: 'other' }, { ...valid, status: 'unavailable' }]) expect(() => parseExactAdmission(bad, baseScope, frozen)).toThrow()
})
test('accepted receipt validates selector/body/root IDs and does not confuse anchor with assistant transcript', () => {
  const frozen = freezeQueueRequest(baseScope, { sessionId: baseScope.taskId, message: 'one' }, 1, null)
  const receipt = { protocolVersion: 1, owner: 'work', namespace: baseScope.namespace, predecessor: null, sessionId: baseScope.taskId, requestKey: frozen.requestKey, bodyDigest: frozen.bodyDigest, rootRunId: 'initial', turnId: 'turn', userMessageId: 'user', assistantMessageId: 'anchor' }
  const valid = { protocolVersion: 1, status: 'accepted', receipt,
    run: { runId: 'initial', version: 1, status: 'running', workspacePaths: [], modelId: 'synthetic-model', sessionId: baseScope.taskId, turnId: 'turn', userMessageId: 'user', assistantMessageId: 'anchor' },
    projection: { rootVersion: 1, rootAttemptId: 'initial-attempt', user: { messageId: 'user', state: 'projected' }, assistant: { anchorMessageId: 'anchor', state: 'unwritten' } } }
  expect(parseExactAdmission(valid, baseScope, frozen).status).toBe('accepted')
  for (const bad of [{ ...receipt, bodyDigest: 'a'.repeat(64) }, { ...receipt, owner: 'code' }, { ...receipt, rootRunId: 'other' },
    { ...receipt, namespace: { ...baseScope.namespace, generation: 'other' } }, { ...receipt, predecessor: { runId: 'another-root', attemptId: 'x', version: 1 } },
    { ...receipt, requestKey: 'different-key' }, { ...receipt, assistantMessageId: '' }]) expect(() => parseExactAdmission({ ...valid, receipt: bad }, baseScope, frozen)).toThrow()
  const persisted = { ...valid, run: { ...valid.run, assistantMessageId: 'actual-assistant' },
    projection: { ...valid.projection, assistant: { anchorMessageId: 'anchor', state: 'persisted', messageId: 'actual-assistant' } } }
  const accepted = parseExactAdmission(persisted, baseScope, frozen)
  expect(accepted.status === 'accepted' && accepted.receipt.assistantMessageId).toBe('anchor')
  for (const bad of [{ ...valid, run: { ...valid.run, sessionId: 'other' } }, { ...valid, projection: { ...valid.projection, rootVersion: 2 } },
    { ...persisted, projection: { ...persisted.projection, assistant: { ...persisted.projection.assistant, messageId: 'foreign-assistant' } } }]) expect(() => parseExactAdmission(bad, baseScope, frozen)).toThrow()
})
test('authored mention offsets survive editing; pasted @text is ordinary text', () => {
  const text = '@agent-one do work', mention = { source: 'agent' as const, path: 'agent-one', displayText: 'Agent One', textOffset: 0 }
  expect(queuedDraft(text, [mention], 1).mentions[0].textOffset).toBe(0)
  expect(queuedDraft(text, [], 1).mentions).toEqual([])
  expect(() => queuedDraft('different', [mention], 2)).toThrow('引用位置')
})
test('new queue CSS only references declared theme tokens', async () => {
  const tokens = await fs.readFile('src/renderer/src/assets/tokens.css', 'utf8'), css = await fs.readFile('src/renderer/src/contrib/work/work-next-turn-queue.css', 'utf8')
  const declared = new Set([...tokens.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map(match => match[1]))
  expect([...css.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map(match => match[1]).filter(name => !declared.has(name))).toEqual([])
  expect(css).toContain('max-height: 120px'); expect(css).toContain('scrollbar-gutter: stable')
})

test('idle binding lifecycle opens 1000 inactive tasks within 200 slots without losing earlier task access', async () => {
  const { driver } = create()
  for (let index = 0; index < 1000; index++) {
    const result = await driver.read('idle-' + index)
    expect(result.state.scope.taskId).toBe('idle-' + index); expect(result.state.entries).toEqual([])
    if (index % 100 === 0) expect(driver.diagnostics().bindings).toBeLessThanOrEqual(200)
  }
  expect(driver.diagnostics()).toMatchObject({ bindings: 200, capabilities: 200, evictions: 800, retainedTasks: 0 })
  expect((await driver.read('idle-0')).state.scope.taskId).toBe('idle-0')
  expect(driver.diagnostics()).toMatchObject({ bindings: 200, capabilities: 200, evictions: 801 })
})

test('terminal eviction and real store restart preserve earliest ACK index, exact frozen key and original authored input', async () => {
  const { driver, gateway, store } = create(), input = draft('earliest immutable task')
  const first = await driver.enqueue(baseScope.taskId, 0, 'earliest-ACK', 'earliest-entry', input)
  gateway.roots.set(baseScope.taskId, { ...initialRoot(), status: 'succeeded' }); await driver.reconcile(baseScope.taskId); await phase(driver, 'accepted')
  const accepted = (await driver.read(baseScope.taskId)).state.entries[0]
  if (accepted.phase === 'pending') throw new Error('expected frozen accepted entry')
  const admitted = gateway.admitted.get(accepted.frozen.requestKey)!
  if (admitted.status !== 'accepted') throw new Error('expected exact accepted receipt')
  admitted.root.status = 'succeeded'; await driver.reconcile(baseScope.taskId); await phase(driver, 'terminal')
  const bucket = store.bucketPath(baseScope), files = (await fs.readdir(bucket)).filter(name => /^r\d+\.json$/.test(name))
  const preimages = await Promise.all(files.map(name => fs.readFile(join(bucket, name), 'utf8')))
  for (let index = 0; index < 1000; index++) await driver.read('after-terminal-' + index)
  expect(driver.diagnostics().evictions).toBeGreaterThan(0)
  expect(await Promise.all(files.map(name => fs.readFile(join(bucket, name), 'utf8')))).toEqual(preimages)
  await driver.close()
  const restarted = create(gateway), replay = await restarted.driver.enqueue(baseScope.taskId, 0, 'earliest-ACK', 'earliest-entry', structuredClone(input))
  expect(replay.replayed).toBe(true); expect(replay.receipt).toEqual(first.receipt)
  expect(replay.state.entries[0].phase).toBe('terminal')
  const terminal = replay.state.entries[0]; if (terminal.phase !== 'pending') expect(terminal.frozen).toEqual(accepted.frozen)
  expect(gateway.envelopes).toBe(1); expect(gateway.posts).toHaveLength(1)
  await expect(restarted.driver.enqueue(baseScope.taskId, 0, 'earliest-ACK', 'earliest-entry', { ...input, thinking: { kind: 'inherit' } })).rejects.toThrow('another draft')
  expect(gateway.envelopes).toBe(1)
})

test('paused pending and accepted or unknown tasks survive 1000 inactive binding evictions without another POST', async () => {
  const { driver, gateway } = create()
  const paused = await driver.enqueue('paused-work', 0, 'paused-op', 'paused-entry', draft('paused'))
  await driver.mutate('paused-work', paused.state.revision, 'pause-paused', { kind: 'mutate', expectedRevision: paused.state.revision, operationId: 'pause-paused', operation: { kind: 'pause', reason: 'user pause' } })
  gateway.roots.set('accepted-work', { ...initialRoot(), status: 'succeeded' }); await driver.enqueue('accepted-work', 0, 'accepted-op', 'accepted-entry', draft('accepted')); await phase(driver, 'accepted', 'accepted-work')
  gateway.absent = true; gateway.roots.set('unknown-work', { ...initialRoot(), status: 'succeeded' }); await driver.enqueue('unknown-work', 0, 'unknown-op', 'unknown-entry', draft('unknown')); await phase(driver, 'admission-unknown', 'unknown-work'); gateway.absent = false
  const before = gateway.posts.slice()
  for (let index = 0; index < 1000; index++) await driver.read('inactive-' + index)
  expect((await driver.read('paused-work')).state.entries[0].phase).toBe('pending'); expect((await driver.read('paused-work')).state.paused).toBe(true)
  expect((await driver.read('accepted-work')).state.entries[0].phase).toBe('accepted')
  expect((await driver.read('unknown-work')).state.entries[0].phase).toBe('admission-unknown')
  driver.wakeAll(); await expect.poll(() => driver.diagnostics().dispatches).toBe(0)
  expect(gateway.posts).toEqual(before); expect(driver.diagnostics().capabilities).toBeLessThanOrEqual(200)
})

test('200 paused pending tasks remain retained and capacity cannot evict them merely because polling is inactive', async () => {
  test.setTimeout(60000)
  const { driver, store } = create()
  for (let index = 0; index < 200; index++) {
    const taskId = 'retained-' + index, queued = await driver.enqueue(taskId, 0, 'op-' + index, 'entry-' + index, draft(taskId))
    await driver.mutate(taskId, queued.state.revision, 'pause-' + index, { kind: 'mutate', expectedRevision: queued.state.revision, operationId: 'pause-' + index, operation: { kind: 'pause', reason: 'paused but still owned' } })
  }
  await expect.poll(() => driver.diagnostics().dispatches).toBe(0)
  await expect(driver.read('overflow-task')).rejects.toThrow('retained queue tasks')
  expect(driver.diagnostics()).toMatchObject({ bindings: 200, capabilities: 200, evictions: 0 })
  const scopes = await store.listScopes(); expect(scopes).toHaveLength(200)
  expect((await driver.read('retained-0')).state.entries[0].phase).toBe('pending')
})

test('foreground attachment preparation retains its idle binding while another task needs capacity', async () => {
  const { driver, gateway } = create()
  for (let index = 0; index < 200; index++) await driver.read('slot-' + index)
  let release!: () => void; gateway.envelopeGate = new Promise<void>(resolve => { release = resolve })
  const prepared = driver.enqueue('slot-0', 0, 'retained-preparation', 'prepared-entry', draft('prepare while capacity changes'))
  await expect.poll(() => gateway.envelopes).toBe(1)
  try { expect((await driver.read('overflow-task')).state.scope.taskId).toBe('overflow-task') }
  finally { release() }
  const ack = await prepared; expect(ack.state.entries[0].id).toBe('prepared-entry')
  expect((await driver.read('slot-0')).state.entries[0].envelope.draft.text).toBe('prepare while capacity changes')
  expect(driver.diagnostics().capabilities).toBeLessThanOrEqual(200)
})

test('eviction rechecks retention after held disk verification before releasing an idle job', async () => {
  const { driver, gateway, store } = create()
  for (let index = 0; index < 200; index++) await driver.read('slot-' + index)
  const originalRead = store.read.bind(store); let releaseCheck!: () => void, checking = false
  const checkGate = new Promise<void>(resolve => { releaseCheck = resolve })
  store.read = async scope => { if (scope.taskId === 'slot-0' && !checking) { checking = true; await checkGate }; return originalRead(scope) }
  const overflow = driver.read('overflow-task'); await expect.poll(() => checking).toBe(true)
  let releasePrepare!: () => void; gateway.envelopeGate = new Promise<void>(resolve => { releasePrepare = resolve })
  const prepared = driver.enqueue('slot-0', 0, 'verification-race', 'race-entry', draft('retain during verification'))
  await expect.poll(() => gateway.envelopes).toBe(1)
  try { releaseCheck(); expect((await overflow).state.scope.taskId).toBe('overflow-task') }
  finally { releaseCheck(); releasePrepare() }
  const ack = await prepared; expect(ack.state.entries[0].id).toBe('race-entry')
})

test('real corrupt idle journal blocks its eviction and remains an explicit failure instead of an empty task', async () => {
  const { driver, store } = create()
  const pending = await driver.enqueue('corrupt-idle', 0, 'corrupt-op', 'corrupt-entry', draft('retain exact journal'))
  await driver.mutate('corrupt-idle', pending.state.revision, 'remove-corrupt', { kind: 'mutate', expectedRevision: pending.state.revision, operationId: 'remove-corrupt', operation: { kind: 'remove', id: 'corrupt-entry', entryRevision: 1, at: Date.now() } })
  await expect.poll(() => driver.diagnostics().dispatches).toBe(0)
  for (let index = 0; index < 199; index++) await driver.read('normal-idle-' + index)
  const scope = { ...structuredClone(baseScope), taskId: 'corrupt-idle' }, bucket = store.bucketPath(scope), record = join(bucket, 'r0000000000.json')
  await fs.writeFile(record, '{"corruption":"owned fixture"}')
  expect((await driver.read('overflow-task')).state.entries).toEqual([])
  await expect(driver.read('corrupt-idle')).rejects.toThrow()
  expect(await fs.readFile(record, 'utf8')).toBe('{"corruption":"owned fixture"}')
  expect(driver.diagnostics().evictions).toBe(1)
})

test('close joins the owned held idle verification and prevents post-close eviction or new binding ACK', async () => {
  const { driver, store } = create()
  for (let index = 0; index < 200; index++) await driver.read('slot-' + index)
  const originalRead = store.read.bind(store); let release!: () => void, checking = false
  const gate = new Promise<void>(resolve => { release = resolve })
  store.read = async scope => { if (scope.taskId === 'slot-0') { checking = true; await gate }; return originalRead(scope) }
  const result = driver.read('overflow-task').then(value => ({ ok: true, value }), error => ({ ok: false, message: error instanceof Error ? error.message : 'error' }))
  await expect.poll(() => checking).toBe(true)
  let ack = false; const close = driver.close().then(() => { ack = true })
  try { await new Promise<void>(resolve => setImmediate(resolve)); expect(ack).toBe(false) } finally { release() }
  expect(await result).toMatchObject({ ok: false }); await close
  expect(driver.diagnostics()).toMatchObject({ bindings: 0, capabilities: 0, evictions: 0, retainedTasks: 0, evicting: false, closing: true })
})

test('authority change during idle capacity verification rejects the old caller before creating a capability for the new scope', async () => {
  const { driver, gateway, store } = create()
  for (let index = 0; index < 200; index++) await driver.read('slot-' + index)
  const originalRead = store.read.bind(store); let release!: () => void, checking = false
  const gate = new Promise<void>(resolve => { release = resolve })
  store.read = async scope => { if (scope.taskId === 'slot-0') { checking = true; await gate }; return originalRead(scope) }
  const result = driver.read('changed-task').then(value => ({ ok: true, value }), error => ({ ok: false, message: error instanceof Error ? error.message : 'error' }))
  await expect.poll(() => checking).toBe(true)
  gateway.generation = 'new-generation'; release()
  expect(await result).toMatchObject({ ok: false })
  expect(driver.diagnostics()).toMatchObject({ evictions: 1, capabilities: 199 }); expect(gateway.posts).toHaveLength(0)
})

test('expected authority lease forbids a changed namespace before any new service capability exists', async () => {
  const { gateway, service } = create(), expected = await gateway.capture('scope-race')
  // Same lease generation but changed namespace simulates a database swap within an engine connection.
  const originalCapture = gateway.capture.bind(gateway)
  gateway.capture = async taskId => { const lease = await originalCapture(taskId); lease.scope.namespace = { id: 'different-db', generation: 'one' }; return lease }
  await expect(service.bind('scope-race', expected)).rejects.toThrow('before capability binding')
  expect(service.diagnostics().bindings).toBe(0)
})

test('new engine scope can replace obsolete idle leases without moving or deleting the previous scope journal', async () => {
  const { driver, gateway, store } = create()
  const queued = await driver.enqueue(baseScope.taskId, 0, 'old-identity-op', 'old-identity-entry', draft('old scope retained'))
  await driver.mutate(baseScope.taskId, queued.state.revision, 'old-identity-remove', { kind: 'mutate', expectedRevision: queued.state.revision, operationId: 'old-identity-remove', operation: { kind: 'remove', id: 'old-identity-entry', entryRevision: 1, at: Date.now() } })
  await expect.poll(() => driver.diagnostics().dispatches).toBe(0)
  for (let index = 0; index < 199; index++) await driver.read('old-idle-' + index)
  const old = await store.findCommitted(baseScope, 'old-identity-op')
  gateway.generation = 'new-generation'
  expect((await driver.read('new-scope-task')).state.scope.namespace.generation).toBe('new-generation')
  expect((await store.findCommitted(baseScope, 'old-identity-op'))?.receipt).toEqual(old?.receipt)
  expect((await store.read(baseScope)).state.removed[0].id).toBe('old-identity-entry')
  expect(driver.diagnostics()).toMatchObject({ evictions: 1, capabilities: 200 }); expect(gateway.posts).toHaveLength(0)
})

test('idle verification observes a real second-owner disk commit and keeps it automatically dispatchable', async () => {
  const { driver, gateway, store } = create()
  for (let index = 0; index < 200; index++) await driver.read('slot-' + index)
  const other = new NextTurnQueueMutationService(store, gateway)
  try {
    const capability = await other.bind('slot-0'), scope = { ...structuredClone(baseScope), taskId: 'slot-0' }
    const envelope = await gateway.envelope(scope, draft('second owner committed task'))
    await other.mutate(capability, 0, 'second-owner-op', { kind: 'enqueue', id: 'second-owner-entry', envelope, at: Date.now() })
    gateway.roots.set('slot-0', { ...initialRoot(), status: 'succeeded' })
    expect((await driver.read('overflow-task')).state.entries).toEqual([])
    driver.wakeAll()
    await expect.poll(async () => (await store.read(scope)).state.entries[0].phase).toBe('accepted')
    expect(gateway.posts).toHaveLength(1); expect(JSON.parse(gateway.posts[0]).sessionId).toBe('slot-0')
  } finally { await other.close() }
})
