/** Synthetic ports and temporary JSONL only: no live windows, models, engine or campaign. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { createVerifiedOfficeSubmit } from '../office-verified-submit.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.e2e-tmp')
// Exercise the product's actual pure contract, not a second handwritten queue schema.
const shared = path.resolve(fixtures, '../src/shared')
const compile = name => ts.transpileModule(fs.readFileSync(path.join(shared, name + '.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const queueExports = {}, stateExports = {}
new Function('exports', compile('next-turn-queue'))(queueExports)
new Function('require', 'exports', compile('next-turn-queue-state'))(name => {
  assert.equal(name, './next-turn-queue'); return queueExports
}, stateExports)
const validateQueueState = stateExports.assertQueueState
const clone = value => structuredClone(value)
const stage = { id: 'synthetic-command', kind: 'test', revision: 'r1', prompt: 'Generate the exact synthetic report.\nDo not dispatch twice.' }
function queueEntry(target, changes = {}) {
  return { id: 'queued-message', revision: 1, createdAt: 1, updatedAt: 1, phase: 'accepted',
    envelope: { draft: { text: stage.prompt, revision: 1, mentions: [] }, model: { kind: 'explicit', modelId: target.modelId },
      workspace: { kind: 'local-workspace', identity: target.workspacePath }, agent: { primaryAgentId: target.agentId, collaborators: [] },
      resources: { skills: { kind: 'inherit' }, mcpServers: { kind: 'inherit' }, knowledgeBases: { kind: 'inherit' } },
      thinking: { kind: 'off' }, memory: { kind: 'inherit' }, security: { policy: 'engine-session' }, attachments: [] },
    frozen: { requestKey: 'queue-request', bodyDigest: 'b'.repeat(64), entryRevision: 1, anchor: null },
    receipt: { runId: 'new-root', turnId: 'new-turn', userMessageId: 'new-user', assistantMessageId: 'new-assistant' }, ...changes }
}
function fixture(options = {}) {
  fs.mkdirSync(fixtures, { recursive: true })
  const root = fs.mkdtempSync(path.join(fixtures, 'verified-admission-'))
  const evidenceDir = path.join(root, 'evidence'), historyRoot = path.join(root, 'state/sessions'), workspace = path.join(root, 'workspace')
  for (const dir of [evidenceDir, path.join(historyRoot, 'tenant_one'), workspace]) fs.mkdirSync(dir, { recursive: true })
  const target = { owner: 'work', active: true, sessionId: 'work-home-one', agentId: 'agent-one', tenantId: 'tenant_one',
    namespace: { id: 'db-one', generation: 'generation-one' }, modelId: 'model-one', workspacePath: workspace,
    newTask: options.newTask === true, engine: { mode: 'embedded', phase: 'ready', adopted: false, instanceId: 'engine-one',
      accountId: 'account-one', pid: 123, buildId: 'sha256:' + 'a'.repeat(64), baseUrl: 'http://127.0.0.1:12345',
      dataDir: path.join(root, 'state/agent.db'), entryPath: path.join(root, 'engine/main.js') } }
  const history = path.join(historyRoot, target.tenantId, target.sessionId + '.jsonl')
  if (!target.newTask) fs.writeFileSync(history, JSON.stringify({ type: 'system', uuid: 'old-message', payload: { content: 'Prior history' } }) + '\n')
  const before = { runId: 'old-root', sessionId: target.sessionId, seq: 5, status: 'succeeded', pending: [],
    serverAdmissionReceipt: { tenantId: target.tenantId, namespace: clone(target.namespace) } }
  const queue = { state: { schemaVersion: 1, scope: { owner: 'work', taskId: target.sessionId, tenantId: target.tenantId,
    namespace: clone(target.namespace), source: { mode: 'embedded', endpoint: '', accountId: target.engine.accountId } },
    revision: 0, paused: false, entries: [], removed: [] } }
  const journal = { schemaVersion: 1, submissions: [], lease: null }
  const counts = { clicks: 0, targetReads: 0, statusReads: 0, queueReads: 0, preparations: 0, composer: 0, saves: 0, starts: [] }
  const controls = { sequence: [...(options.sequence ?? ['new'])], cursor: 0, root: null, row: null, suppressHistory: false,
    mutateRun: options.mutateRun, mutateRow: options.mutateRow, targetChanged: false, readPending: null, persistOnce: false,
    intentPersistenceFailures: 0, firstSuccessfulPublicationSaveHadBinding: null }
  function createRun() {
    const createdAt = Date.now(), run = { runId: 'new-root', sessionId: target.sessionId, turnId: 'new-turn',
      userMessageId: 'new-user', assistantMessageId: 'new-assistant', seq: 6, version: 1, status: 'running',
      modelId: target.modelId, workspacePaths: [workspace], createdAt, updatedAt: createdAt, pending: [],
      requestConfig: { agentId: target.agentId } }
    const seed = { id: run.userMessageId, role: 'user', content: stage.prompt, createdAt,
      conversationId: run.turnId, metadata: { rootRunId: run.runId, turnId: run.turnId } }
    run.serverAdmissionReceipt = { protocolVersion: 1, authority: 'server-root-admission', namespace: clone(target.namespace),
      tenantId: target.tenantId, sessionId: run.sessionId, rootRunId: run.runId, turnId: run.turnId,
      userMessageId: run.userMessageId, assistantMessageId: run.assistantMessageId, attemptId: 'attempt-one',
      rootVersion: 1, rootSequence: run.seq, acceptedAt: createdAt, userSeedDigest: sha(JSON.stringify(seed)), provenance: { kind: 'legacy-chat' } }
    const row = { type: 'user', uuid: run.userMessageId, tenantId: target.tenantId, sessionId: target.sessionId,
      conversationId: run.turnId, payload: { ...seed, tokens: 10 } }
    controls.mutateRun?.(run); controls.mutateRow?.(row)
    controls.root = run; controls.row = row
  }
  function appendUser() { fs.appendFileSync(history, JSON.stringify(controls.row) + '\n') }
  const ports = {
    prepareTarget: async (_role, _stage, settings) => {
      counts.preparations++; counts.starts.push(settings.startRole); const value = clone(target); options.mutatePrepared?.(value); return value
    },
    readTarget: async () => { counts.targetReads++; const value = clone(target); if (controls.targetChanged) value.engine.instanceId = 'other-engine'; return value },
    prepareComposer: async (_role, text) => { counts.composer++; return options.composerText ?? text },
    clickSend: async () => {
      counts.clicks++; createRun()
      if (!controls.suppressHistory) appendUser()
      if (options.extraUser) appendUser()
      if (options.largeTool) fs.appendFileSync(history, JSON.stringify({ type: 'tool', payload: { content: 'A'.repeat(4096) } }) + '\n')
      if (options.changeEngine) controls.targetChanged = true
      if (options.cancelAfterClick) options.cancelAfterClick.abort()
      if (options.clickError) throw new Error('Simulated click response lost; must not replay')
      if (options.onClick) await options.onClick(controls)
    },
    readStatus: async () => {
      counts.statusReads++
      if (!counts.clicks) return { running: false, run: target.newTask ? undefined : clone(before) }
      if (controls.readPending) return controls.readPending
      const label = controls.sequence[Math.min(controls.cursor++, controls.sequence.length - 1)]
      if (label === 'old') return { running: false, run: clone(before) }
      const run = clone(controls.root)
      if (label === 'replacement') { run.runId = 'another-root'; run.serverAdmissionReceipt.rootRunId = run.runId }
      if (label === 'terminal') { run.status = 'succeeded'; run.version = 3; run.finishedAt = Date.now(); run.updatedAt = run.finishedAt }
      return { running: run.status === 'running', run }
    },
    readQueue: async () => { counts.queueReads++; const value = clone(queue); options.mutateQueue?.(value, counts.clicks, target); return value },
    validateQueueState,
    hasCommand: () => options.legacyDuplicate === true,
    persist: () => {
      counts.saves++
      if (journal.submissions[0]?.bindingPublication) {
        if (controls.intentPersistenceFailures < (options.failIntentPersist ?? 0)) {
          controls.intentPersistenceFailures++; throw new Error('Publication intent persistence failed')
        }
        if (controls.firstSuccessfulPublicationSaveHadBinding === null)
          controls.firstSuccessfulPublicationSaveHadBinding = fs.existsSync(path.join(evidenceDir, stage.id + '.verified-binding.json'))
      }
      if (options.failBindingPersist && journal.submissions[0]?.binding && !controls.persistOnce) { controls.persistOnce = true; throw new Error('Journal write failed') }
    },
  }
  const expectedTargets = { pmo: { ...clone(target), sessionId: target.newTask ? undefined : target.sessionId } }
  const config = { ports, journal, expectedTargets, evidenceDir, historyRoot, limits: { totalMs: 2000, operationMs: 100, pollMs: 1, statusReads: 5, ...options.limits } }
  const coordinator = createVerifiedOfficeSubmit(config)
  return { root, target, before, queue, controls, counts, journal, coordinator, config, history, evidenceDir, appendUser,
    close() {
      const resolved = fs.realpathSync(root), parent = fs.realpathSync(fixtures)
      assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase())
      assert.ok(path.basename(resolved).startsWith('verified-admission-'))
      fs.rmSync(resolved, { recursive: true })
    } }
}
async function using(options, execute) { const f = fixture(options); try { await execute(f) } finally { f.close() } }
function binding(f) { return JSON.parse(fs.readFileSync(path.join(f.evidenceDir, stage.id + '.verified-binding.json'), 'utf8')) }
function noBinding(f) { assert.equal(fs.existsSync(path.join(f.evidenceDir, stage.id + '.verified-binding.json')), false) }

test('old → old → new binds one retained new sample and unique persisted user, with one click', () => using({ sequence: ['old', 'old', 'new', 'terminal'] }, async f => {
  const result = await f.coordinator.submit('pmo', stage)
  assert.equal(result.admitted, true); assert.equal(result.runId, 'new-root'); assert.equal(f.counts.clicks, 1)
  const saved = binding(f)
  assert.equal(saved.actualAdmittedRun.runId, 'new-root'); assert.equal(saved.actualAdmittedRun.status, 'running')
  assert.equal(saved.persistedUser.promptSha256, sha(stage.prompt)); assert.equal(saved.persistedUser.seedSha256, f.controls.root.serverAdmissionReceipt.userSeedDigest)
  assert.equal(saved.beforeRunId, 'old-root'); assert.equal(f.journal.lease, null)
  assert.equal(f.journal.submissions[0].observedCandidate.verified, false)
  await assert.rejects(f.coordinator.submit('pmo', stage), /DUPLICATE_COMMAND/)
  assert.equal(f.counts.clicks, 1)
}))

for (const sequence of [['new', 'old'], ['new', 'replacement']]) test('a later root regression/replacement cannot overwrite the retained sample: ' + sequence.join('/'), () => using({ sequence }, async f => {
  const result = await f.coordinator.submit('pmo', stage)
  assert.equal(result.admitted, false); assert.equal(result.phase, 'admission-uncertain'); noBinding(f)
  assert.equal(f.journal.submissions[0].observedCandidate.run.runId, 'new-root')
  assert.equal(f.journal.lease.clickRequested, true); assert.equal(f.counts.clicks, 1)
}))

test('click response lost reconciles from journal after module recreation without a second click', () => using({ clickError: true }, async f => {
  const first = await f.coordinator.submit('pmo', stage)
  assert.equal(first.phase, 'admission-uncertain'); noBinding(f)
  await assert.rejects(f.coordinator.submit('pmo', { ...stage, id: 'next-command' }), /SUBMISSION_LEASE_HELD/)
  const recovered = createVerifiedOfficeSubmit(f.config), result = await recovered.reconcile(stage.id)
  assert.equal(result.admitted, true); assert.equal(f.counts.clicks, 1); assert.equal(f.counts.preparations, 1); assert.equal(f.counts.composer, 1)
}))

test('cancellation after the single click retains lease and supports only read reconciliation', () => {
  const abort = new AbortController()
  return using({ cancelAfterClick: abort }, async f => {
    const result = await f.coordinator.submit('pmo', stage, { signal: abort.signal })
    assert.equal(result.code, 'CANCELLED'); assert.equal(result.clickRequested, true); noBinding(f)
    await assert.rejects(f.coordinator.startRole('sales', { ...stage, id: 'new-command' }), /SUBMISSION_LEASE_HELD/)
    assert.equal((await f.coordinator.reconcile(stage.id)).admitted, true); assert.equal(f.counts.clicks, 1)
  })
})

for (const [name, mutateRun, code] of [
  ['tenant', run => { run.serverAdmissionReceipt.tenantId = 'different-tenant' }, 'RUN_TENANT_OR_PROVENANCE_MISMATCH'],
  ['namespace', run => { run.serverAdmissionReceipt.namespace.generation = 'different-generation' }, 'RUN_NAMESPACE_MISMATCH'],
  ['agent', run => { run.requestConfig.agentId = 'different-agent' }, 'RUN_SELECTION_MISMATCH'],
  ['model', run => { run.modelId = 'different-model' }, 'RUN_SELECTION_MISMATCH'],
  ['receipt user', run => { run.serverAdmissionReceipt.userMessageId = 'wrong-user' }, 'RUN_RECEIPT_IDENTITY_MISMATCH'],
]) test('rejects wrong ' + name + ' without final binding or resend', () => using({ mutateRun }, async f => {
  const result = await f.coordinator.submit('pmo', stage); assert.equal(result.code, code)
  noBinding(f); assert.equal(f.counts.clicks, 1); assert.equal(f.journal.lease.held, true)
}))

test('engine changed during admission is uncertain', () => using({ changeEngine: true }, async f => {
  assert.equal((await f.coordinator.submit('pmo', stage)).code, 'UNEXPECTED_TARGET'); noBinding(f)
}))

for (const [name, options, code] of [
  ['prompt', { mutateRow: row => { row.payload.content += ' changed' } }, 'HISTORY_PROMPT_MISMATCH'],
  ['persisted root', { mutateRow: row => { row.payload.metadata.rootRunId = 'wrong-root' } }, 'HISTORY_ROOT_MISMATCH'],
  ['seed metadata', { mutateRow: row => { row.payload.metadata.extra = true } }, 'HISTORY_SEED_MISMATCH'],
  ['second user', { extraUser: true }, 'HISTORY_USER_AMBIGUOUS'],
]) test('rejects mismatched ' + name + ' in persisted JSONL', () => using(options, async f => {
  assert.equal((await f.coordinator.submit('pmo', stage)).code, code); noBinding(f); assert.equal(f.counts.clicks, 1)
}))

test('history byte overflow is incomplete; only explicit larger read budget permits reconciliation', () => using({ largeTool: true, limits: { historyBytes: 2048 } }, async f => {
  const result = await f.coordinator.submit('pmo', stage)
  assert.equal(result.code, 'HISTORY_BYTE_BUDGET_INCOMPLETE'); noBinding(f)
  assert.equal((await f.coordinator.reconcile(stage.id)).code, 'HISTORY_BYTE_BUDGET_INCOMPLETE')
  assert.equal((await f.coordinator.reconcile(stage.id, { limits: { historyBytes: 8192 } })).admitted, true)
  assert.equal(f.counts.clicks, 1)
}))

test('repeated incomplete history polls obey an aggregate read budget', () => using({ limits: { historyBytes: 2048, historyReadBytes: 1500 } }, async f => {
  f.controls.suppressHistory = true
  const originalClick = f.config.ports.clickSend
  f.config.ports.clickSend = async () => {
    await originalClick()
    fs.appendFileSync(f.history, JSON.stringify({ type: 'tool', payload: { content: 'A'.repeat(1000) } }) + '\n')
  }
  const result = await f.coordinator.submit('pmo', stage)
  assert.equal(result.code, 'HISTORY_TOTAL_READ_BUDGET_INCOMPLETE')
  assert.ok(f.journal.submissions[0].lastHistoryRead.bytes <= 1500); assert.equal(f.counts.clicks, 1); noBinding(f)
}))

test('start-role uses exactly the same submit path and fixed home session before first click', () => using({ newTask: true }, async f => {
  const result = await f.coordinator.startRole('pmo', stage)
  assert.equal(result.admitted, true); assert.deepEqual(f.counts.starts, [true]); assert.equal(f.counts.clicks, 1)
  assert.equal(binding(f).beforeRunId, null); assert.equal(binding(f).target.sessionId, 'work-home-one')
}))

test('legacy submission ledger blocks duplicate replay before any UI port', () => using({ legacyDuplicate: true }, async f => {
  await assert.rejects(f.coordinator.submit('pmo', stage), /DUPLICATE_COMMAND/)
  assert.equal(f.counts.preparations, 0); assert.equal(f.counts.clicks, 0); assert.equal(f.journal.submissions.length, 0)
}))

test('mismatched visible prompt fails before click', () => using({ composerText: 'different text' }, async f => {
  assert.equal((await f.coordinator.submit('pmo', stage)).code, 'COMPOSER_CHANGED_PROMPT')
  assert.equal(f.counts.clicks, 0); noBinding(f)
}))

test('old binding is immutable and prevents dispatch even if the legacy journal was lost', () => using({}, async f => {
  const oldFile = path.join(f.evidenceDir, stage.id + '-binding.json'), original = '{"run":"old-root"}\n'
  fs.writeFileSync(oldFile, original)
  await assert.rejects(f.coordinator.submit('pmo', stage), /EXISTING_COMMAND_EVIDENCE/)
  assert.equal(fs.readFileSync(oldFile, 'utf8'), original); assert.equal(f.counts.clicks, 0); assert.equal(f.counts.preparations, 0)
  noBinding(f)
}))

test('journal failure after final publication recovers existing artifact without rewriting it', () => using({ failBindingPersist: true }, async f => {
  assert.equal((await f.coordinator.submit('pmo', stage)).phase, 'admission-uncertain')
  const file = path.join(f.evidenceDir, stage.id + '.verified-binding.json'), before = fs.readFileSync(file)
  assert.equal((await f.coordinator.reconcile(stage.id)).admitted, true)
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(f.counts.clicks, 1)
}))

test('publication intent must be successfully persisted on recovery before the final file is written', () => using({ failIntentPersist: 2 }, async f => {
  const first = await f.coordinator.submit('pmo', stage)
  assert.equal(first.phase, 'admission-uncertain'); assert.equal(f.controls.intentPersistenceFailures, 2); noBinding(f)
  assert.ok(f.journal.submissions[0].bindingPublication); assert.equal(f.controls.firstSuccessfulPublicationSaveHadBinding, null)
  assert.equal((await f.coordinator.reconcile(stage.id)).admitted, true)
  assert.equal(f.controls.firstSuccessfulPublicationSaveHadBinding, false); assert.equal(f.counts.clicks, 1)
}))

test('recovery rejects any changed byte of a previously published binding', () => using({ failBindingPersist: true }, async f => {
  assert.equal((await f.coordinator.submit('pmo', stage)).phase, 'admission-uncertain')
  const file = path.join(f.evidenceDir, stage.id + '.verified-binding.json'), value = binding(f)
  value.persistedUser.intervalSha256 = '0'.repeat(64); value.persistedUser.startOffset = -1
  value.queue = { invented: true }; value.actualAdmittedRun.status = 'invented-status'
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
  assert.equal((await f.coordinator.reconcile(stage.id)).code, 'EXISTING_BINDING_BYTES_CHANGED')
  assert.equal(f.journal.lease.held, true); assert.equal(f.counts.clicks, 1)
}))

test('frozen publication remains unchanged when later tool rows extend history', () => using({ failBindingPersist: true }, async f => {
  await f.coordinator.submit('pmo', stage)
  const file = path.join(f.evidenceDir, stage.id + '.verified-binding.json'), before = fs.readFileSync(file)
  fs.appendFileSync(f.history, JSON.stringify({ type: 'tool', payload: { content: 'Later tool row' } }) + '\n')
  assert.equal((await f.coordinator.reconcile(stage.id)).admitted, true)
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(f.counts.clicks, 1)
}))

test('self-consistent but unintended UI target is rejected before click', () => using({ mutatePrepared: value => { value.agentId = 'wrong-selected-agent' } }, async f => {
  assert.equal((await f.coordinator.submit('pmo', stage)).code, 'UNEXPECTED_TARGET')
  assert.equal(f.counts.clicks, 0); noBinding(f)
}))

test('a background task identity does not prove the active composer target', () => using({ mutatePrepared: value => { value.active = false } }, async f => {
  assert.equal((await f.coordinator.submit('pmo', stage)).code, 'TARGET_IDENTITY_INVALID')
  assert.equal(f.counts.clicks, 0); noBinding(f)
}))

test('unknown queue state cannot become successful admission', () => using({ mutateQueue: (value, clicked) => {
  if (clicked) value.state.entries.push({ id: 'foreign-entry', revision: 1, phase: 'unknown' })
} }, async f => {
  assert.equal((await f.coordinator.submit('pmo', stage)).code, 'QUEUE_CONTRACT_INVALID'); noBinding(f)
}))

test('a pending timed-out read blocks replacement/reconcile until it drains, without a second click', () => using({ onClick: controls => {
  controls.readPending = new Promise(resolve => { controls.finishRead = resolve })
}, limits: { operationMs: 10 } }, async f => {
  const result = await f.coordinator.submit('pmo', stage)
  assert.equal(result.code, 'OPERATION_TIMEOUT_STATUS'); assert.equal(result.pendingOperations, 1)
  const replacement = createVerifiedOfficeSubmit(f.config)
  await assert.rejects(replacement.reconcile(stage.id), /SUBMISSION_LEASE_HELD/)
  assert.throws(() => createVerifiedOfficeSubmit({ ...f.config, journal: clone(f.journal) }), /JOURNAL_OWNER_CHANGED/)
  f.controls.finishRead({ running: true, run: clone(f.controls.root) }); f.controls.readPending = null
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await replacement.reconcile(stage.id)).admitted, true); assert.equal(f.counts.clicks, 1)
}))

test('history replacement after click is rejected', () => using({ onClick: (_controls) => {} }, async f => {
  f.controls.suppressHistory = true
  const result = await f.coordinator.submit('pmo', stage)
  assert.equal(result.code, 'ADMISSION_OBSERVATION_BUDGET')
  fs.renameSync(f.history, f.history + '.old'); f.appendUser()
  assert.equal((await f.coordinator.reconcile(stage.id)).code, 'HISTORY_REPLACED'); noBinding(f)
}))

test('a durable click intent alone blocks replay after a missing journal', () => using({}, async f => {
  const file = path.join(f.evidenceDir, stage.id + '.verified-click-intent.json')
  fs.writeFileSync(file, '{"clickRequested":true}\n')
  await assert.rejects(f.coordinator.submit('pmo', stage), /EXISTING_COMMAND_EVIDENCE/)
  assert.equal(f.counts.clicks, 0); assert.equal(f.counts.preparations, 0)
}))

test('tampered dispatch evidence cannot be used for read reconciliation', () => using({ clickError: true }, async f => {
  await f.coordinator.submit('pmo', stage)
  fs.appendFileSync(path.join(f.evidenceDir, stage.id + '.verified-dispatch.json'), ' ')
  assert.equal((await f.coordinator.reconcile(stage.id)).code, 'INTENT_CHANGED')
  assert.equal(f.counts.clicks, 1); noBinding(f)
}))

test('new queue receipt must match the same retained run and exact draft', () => using({ mutateQueue: (value, clicked, target) => {
  if (clicked) {
    value.state.revision++
    value.state.entries.push(queueEntry(target, { receipt: { runId: 'new-root', turnId: 'new-turn', userMessageId: 'new-user', assistantMessageId: 'wrong-assistant' } }))
  }
} }, async f => {
  assert.equal((await f.coordinator.submit('pmo', stage)).code, 'QUEUE_RECEIPT_MISMATCH'); noBinding(f)
}))

test('a valid unique queue admission uses the shared schema and matching receipt', () => using({ mutateQueue: (value, clicked, target) => {
  if (clicked) { value.state.revision++; value.state.entries.push(queueEntry(target)) }
} }, async f => {
  assert.equal((await f.coordinator.submit('pmo', stage)).admitted, true)
  assert.equal(binding(f).queue.entries.length, 1); assert.equal(f.counts.clicks, 1)
}))

for (const [name, change] of [
  ['negative revision', value => { value.revision = -1 }],
  ['nonboolean paused', value => { value.paused = 'false' }],
  ['missing removed', value => { delete value.removed }],
]) test('shared queue contract rejects ' + name, () => using({ mutateQueue: value => change(value.state) }, async f => {
  assert.equal((await f.coordinator.submit('pmo', stage)).code, 'QUEUE_CONTRACT_INVALID')
  assert.equal(f.counts.clicks, 0); noBinding(f)
}))

test('valid but regressed queue revision is uncertain', () => using({ mutateQueue: (value, clicked) => {
  value.state.revision = clicked ? 1 : 2
} }, async f => {
  assert.equal((await f.coordinator.submit('pmo', stage)).code, 'QUEUE_REVISION_REGRESSED'); noBinding(f)
}))

test('unprojected fields of existing queue entries cannot silently change', () => using({ mutateQueue: (value, clicked) => {
  if (clicked) value.state.entries[0].envelope.resources.skills = { kind: 'none' }
} }, async f => {
  f.queue.state.entries.push(queueEntry(f.target, { id: 'earlier-queue', phase: 'terminal', outcome: 'succeeded' }))
  assert.equal((await f.coordinator.submit('pmo', stage)).code, 'QUEUE_HISTORY_CHANGED'); noBinding(f)
}))

test('removed records cannot change during a new admission', () => using({ mutateQueue: (value, clicked) => {
  if (clicked) { value.state.revision++; value.state.removed.push({ id: 'removed-command', entryRevision: 1, removedAt: 1 }) }
} }, async f => {
  assert.equal((await f.coordinator.submit('pmo', stage)).code, 'QUEUE_CONTROL_CHANGED'); noBinding(f)
}))
