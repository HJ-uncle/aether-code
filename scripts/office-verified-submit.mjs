/** Offline-installable campaign submission coordinator. Importing never starts a runner.
 * Ports are the existing owned UI/GET adapters; readTarget/readQueue must be observational.
 * In particular, a fresh Work queue IPC binding can recover state: it is not a pure reader.
 * No port may reconcile/retry a queue, invoke /chat, or use POST admission/receipt.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const sha = value => createHash('sha256').update(value).digest('hex')
const clone = value => structuredClone(value)
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted'])
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value)
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
class AdmissionError extends Error { constructor(code) { super(code); this.code = code } }
const need = (condition, code) => { if (!condition) throw new AdmissionError(code) }
const equal = (a, b, code) => { try { assert.deepEqual(a, b) } catch { throw new AdmissionError(code) } }
const codeOf = error => error instanceof AdmissionError ? error.code : 'PORT_OR_IO_FAILED'
const defaults = Object.freeze({ totalMs: 90000, operationMs: 15000, pollMs: 250, statusReads: 360,
  historyBytes: 4 * 1024 * 1024, historyReadBytes: 16 * 1024 * 1024, historyRows: 10000, queueEntries: 2048, artifactBytes: 2 * 1024 * 1024 })
function budgets(overrides = {}) {
  need(Object.keys(overrides).every(key => key in defaults), 'UNKNOWN_BUDGET')
  const value = { ...defaults, ...overrides }
  for (const [key, amount] of Object.entries(value)) need(Number.isSafeInteger(amount) && amount > 0, 'INVALID_' + key.toUpperCase())
  need(value.totalMs <= 120000 && value.operationMs <= 30000 && value.pollMs <= 10000 && value.statusReads <= 1000
    && value.historyBytes <= 32 * 1024 * 1024 && value.historyReadBytes <= 128 * 1024 * 1024 && value.historyRows <= 100000
    && value.queueEntries <= 2048 && value.artifactBytes <= 8 * 1024 * 1024, 'EXCESSIVE_BUDGET')
  return value
}
function canonicalDirectory(directory) {
  need(path.isAbsolute(directory) && samePath(fs.realpathSync(directory), directory), 'REDIRECTED_DIRECTORY')
  need(fs.statSync(directory).isDirectory(), 'NOT_DIRECTORY')
  return path.resolve(directory)
}
function identity(stat) { return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs } }
function readRange(fd, offset, length) {
  const bytes = Buffer.alloc(length)
  for (let done = 0; done < length;) {
    const count = fs.readSync(fd, bytes, done, length - done, offset + done)
    need(count > 0, 'HISTORY_SHORT_READ'); done += count
  }
  return bytes
}
function historyFile(target, historyRoot) {
  need(id(target.tenantId) && id(target.sessionId), 'INVALID_HISTORY_IDENTITY')
  need(samePath(historyRoot, path.join(path.dirname(target.engine.dataDir), 'sessions')), 'HISTORY_ENGINE_PATH_MISMATCH')
  canonicalDirectory(historyRoot)
  const directory = path.join(historyRoot, target.tenantId)
  canonicalDirectory(directory)
  return path.join(directory, target.sessionId + '.jsonl')
}
export function captureHistoryCheckpoint(target, historyRoot) {
  const file = historyFile(target, historyRoot)
  if (!fs.existsSync(file)) {
    need(target.newTask === true, 'EXISTING_HISTORY_MISSING')
    return { path: file, exists: false, startOffset: 0, boundaryOffset: 0, boundarySha256: sha('') }
  }
  need(samePath(fs.realpathSync(file), file), 'HISTORY_REDIRECTED')
  const fd = fs.openSync(file, 'r')
  try {
    const before = fs.fstatSync(fd); need(before.isFile(), 'HISTORY_NOT_FILE')
    const length = Math.min(before.size, 4096), offset = before.size - length, bytes = readRange(fd, offset, length)
    need(!bytes.length || bytes.at(-1) === 10, 'HISTORY_BOUNDARY_INCOMPLETE')
    const after = fs.statSync(file)
    equal(identity(before), identity(after), 'HISTORY_REPLACED')
    need(after.size === before.size && after.mtimeMs === before.mtimeMs, 'HISTORY_CHANGED_BEFORE_CLICK')
    return { path: file, exists: true, ...identity(before), startOffset: before.size, boundaryOffset: offset, boundarySha256: sha(bytes) }
  } finally { fs.closeSync(fd) }
}
/** Reads every byte in the bounded appended interval; no row truncation or base64 filtering. */
export function readPersistedAdmission(checkpoint, target, run, promptSha256, historyRoot, limits = defaults, meter = { bytes: 0 }) {
  limits = budgets(limits)
  const file = historyFile(target, historyRoot)
  need(samePath(file, checkpoint.path), 'HISTORY_PATH_CHANGED')
  if (!fs.existsSync(file)) return { state: 'pending', reason: 'HISTORY_NOT_PROJECTED' }
  need(samePath(fs.realpathSync(file), file), 'HISTORY_REDIRECTED')
  const fd = fs.openSync(file, 'r')
  try {
    const before = fs.fstatSync(fd); need(before.isFile(), 'HISTORY_NOT_FILE')
    if (checkpoint.exists) equal(identity(before), { dev: checkpoint.dev, ino: checkpoint.ino, birthtimeMs: checkpoint.birthtimeMs }, 'HISTORY_REPLACED')
    need(before.size >= checkpoint.startOffset, 'HISTORY_TRUNCATED')
    const length = before.size - checkpoint.startOffset
    need(length <= limits.historyBytes, 'HISTORY_BYTE_BUDGET_INCOMPLETE')
    const readBytes = length + checkpoint.startOffset - checkpoint.boundaryOffset
    need(meter.bytes + readBytes <= limits.historyReadBytes, 'HISTORY_TOTAL_READ_BUDGET_INCOMPLETE')
    meter.bytes += readBytes
    equal(sha(readRange(fd, checkpoint.boundaryOffset, checkpoint.startOffset - checkpoint.boundaryOffset)), checkpoint.boundarySha256, 'HISTORY_BOUNDARY_CHANGED')
    const bytes = readRange(fd, checkpoint.startOffset, length), after = fs.statSync(file)
    equal(identity(before), identity(after), 'HISTORY_REPLACED')
    need(after.size >= before.size && samePath(fs.realpathSync(file), file), 'HISTORY_CHANGED_DURING_READ')
    if (!bytes.length || bytes.at(-1) !== 10) return { state: 'pending', reason: 'HISTORY_INTERVAL_INCOMPLETE' }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), lines = text.split('\n').filter(Boolean)
    need(lines.length <= limits.historyRows, 'HISTORY_ROW_BUDGET_INCOMPLETE')
    const rows = lines.map(line => JSON.parse(line)), users = rows.filter(row => row.type === 'user')
    if (!users.length) return { state: 'pending', reason: 'HISTORY_USER_NOT_PROJECTED' }
    need(users.length === 1, 'HISTORY_USER_AMBIGUOUS')
    const user = users[0], payload = user.payload, receipt = run.serverAdmissionReceipt
    need(user.sessionId === target.sessionId && user.tenantId === target.tenantId && user.uuid === run.userMessageId, 'HISTORY_OWNER_MISMATCH')
    need(payload?.id === run.userMessageId && payload.role === 'user' && typeof payload.content === 'string', 'HISTORY_USER_INVALID')
    need(payload.metadata?.rootRunId === run.runId && payload.metadata?.turnId === run.turnId && payload.conversationId === run.turnId, 'HISTORY_ROOT_MISMATCH')
    need(sha(payload.content) === promptSha256, 'HISTORY_PROMPT_MISMATCH')
    const seed = { id: payload.id, role: payload.role, content: payload.content, createdAt: payload.createdAt,
      conversationId: payload.conversationId, metadata: payload.metadata }
    need(payload.createdAt === receipt.acceptedAt && sha(JSON.stringify(seed)) === receipt.userSeedDigest, 'HISTORY_SEED_MISMATCH')
    return { state: 'verified', path: file, ...identity(before), startOffset: checkpoint.startOffset, endOffset: before.size,
      bytes: length, rows: rows.length, intervalSha256: sha(bytes), userMessageId: user.uuid, promptSha256,
      seedSha256: receipt.userSeedDigest, snapshotSemantics: 'Complete bounded interval at opened file size; later appends are possible' }
  } finally { fs.closeSync(fd) }
}
function targetIdentity(value) {
  need(value?.owner === 'work' && value.active === true && id(value.sessionId) && id(value.agentId) && id(value.tenantId), 'TARGET_IDENTITY_INVALID')
  need(typeof value.modelId === 'string' && value.modelId && path.isAbsolute(value.workspacePath), 'TARGET_SELECTION_INVALID')
  need(id(value.namespace?.id) && id(value.namespace?.generation), 'TARGET_NAMESPACE_INVALID')
  const engine = value.engine
  need(engine?.mode === 'embedded' && engine.phase === 'ready' && engine.adopted === false
    && id(engine.instanceId) && id(engine.accountId) && Number.isSafeInteger(engine.pid) && engine.pid > 0
    && /^sha256:[a-f0-9]{64}$/.test(engine.buildId) && /^http:\/\/127\.0\.0\.1:\d+$/.test(engine.baseUrl)
    && path.isAbsolute(engine.dataDir) && path.isAbsolute(engine.entryPath), 'TARGET_ENGINE_INVALID')
  return { owner: value.owner, active: true, sessionId: value.sessionId, agentId: value.agentId, tenantId: value.tenantId,
    namespace: clone(value.namespace), modelId: value.modelId, workspacePath: path.resolve(value.workspacePath),
    engine: Object.fromEntries(['mode', 'phase', 'adopted', 'instanceId', 'accountId', 'pid', 'buildId', 'baseUrl', 'dataDir', 'entryPath'].map(key => [key, engine[key]])) }
}
function queueSnapshot(value, target, limits, validate) {
  need(value && !value.dispatchError && value.state?.schemaVersion === 1 && Array.isArray(value.state.entries), 'QUEUE_UNKNOWN')
  const queue = value.state
  try { need(validate(clone(queue), clone(queue.scope)) === undefined, 'QUEUE_VALIDATOR_NOT_SYNCHRONOUS') }
  catch { throw new AdmissionError('QUEUE_CONTRACT_INVALID') }
  equal(queue.scope, { owner: 'work', taskId: target.sessionId, tenantId: target.tenantId, namespace: target.namespace,
    source: { mode: 'embedded', endpoint: '', accountId: target.engine.accountId } }, 'QUEUE_SCOPE_MISMATCH')
  need(queue.entries.length <= limits.queueEntries && Number.isSafeInteger(queue.revision) && queue.revision >= 0, 'QUEUE_BUDGET_OR_REVISION')
  need(new Set(queue.entries.map(entry => entry.id)).size === queue.entries.length, 'QUEUE_DUPLICATE')
  const entries = queue.entries.map(entry => {
    need(id(entry.id) && Number.isSafeInteger(entry.revision) && entry.revision >= 1, 'QUEUE_ENTRY_INVALID')
    need(['pending', 'dispatching', 'admission-unknown', 'accepted', 'terminal'].includes(entry.phase), 'QUEUE_PHASE_UNKNOWN')
    return { id: entry.id, revision: entry.revision, phase: entry.phase, outcome: entry.outcome ?? null, fullEntrySha256: sha(JSON.stringify(entry)),
      draftSha256: typeof entry.envelope?.draft?.text === 'string' ? sha(entry.envelope.draft.text) : null,
      receipt: entry.receipt ? clone(entry.receipt) : null }
  })
  return { scope: clone(queue.scope), revision: queue.revision, paused: queue.paused, entries,
    fullStateSha256: sha(JSON.stringify(queue)), removedSha256: sha(JSON.stringify(queue.removed)),
    pauseReasonSha256: sha(JSON.stringify(queue.pauseReason ?? null)), resumeAnchorSha256: sha(JSON.stringify(queue.resumeAnchor ?? null)) }
}
function validateQueue(before, after, run, promptSha256) {
  need(after.revision >= before.revision, 'QUEUE_REVISION_REGRESSED')
  for (const key of ['paused', 'removedSha256', 'pauseReasonSha256', 'resumeAnchorSha256']) equal(after[key], before[key], 'QUEUE_CONTROL_CHANGED')
  const previous = new Map(before.entries.map(entry => [entry.id, entry]))
  for (const entry of before.entries) equal(after.entries.find(item => item.id === entry.id), entry, 'QUEUE_HISTORY_CHANGED')
  const added = after.entries.filter(entry => !previous.has(entry.id))
  need(added.length <= 1, 'QUEUE_ADMISSION_AMBIGUOUS')
  if (added.length) {
    need(after.revision > before.revision, 'QUEUE_ADMISSION_REVISION_UNCHANGED')
    const entry = added[0]
    need(['accepted', 'terminal'].includes(entry.phase) && entry.draftSha256 === promptSha256, 'QUEUE_ADMISSION_UNCONFIRMED')
    equal(entry.receipt, { runId: run.runId, turnId: run.turnId, userMessageId: run.userMessageId, assistantMessageId: run.assistantMessageId }, 'QUEUE_RECEIPT_MISMATCH')
    if (entry.phase === 'terminal') need(terminal.has(entry.outcome), 'QUEUE_OUTCOME_UNKNOWN')
  } else equal(after.fullStateSha256, before.fullStateSha256, 'QUEUE_STATE_CHANGED_WITHOUT_ADMISSION')
}
function runIdentity(run) {
  return { runId: run.runId, sessionId: run.sessionId, turnId: run.turnId, userMessageId: run.userMessageId,
    assistantMessageId: run.assistantMessageId, modelId: run.modelId, agentId: run.requestConfig?.agentId,
    seq: run.seq, serverAdmissionReceipt: clone(run.serverAdmissionReceipt) }
}
function verifyRun(run, record) {
  const target = record.target, receipt = run?.serverAdmissionReceipt
  need(run && id(run.runId) && run.runId !== record.beforeRunId && run.sessionId === target.sessionId, 'RUN_IDENTITY_MISMATCH')
  need(run.modelId === target.modelId && (run.actualModelId == null || run.actualModelId === target.modelId)
    && run.requestConfig?.agentId === target.agentId, 'RUN_SELECTION_MISMATCH')
  need(Array.isArray(run.workspacePaths) && run.workspacePaths.length === 1 && samePath(run.workspacePaths[0], target.workspacePath), 'RUN_WORKSPACE_MISMATCH')
  need(receipt?.protocolVersion === 1 && receipt.authority === 'server-root-admission', 'RUN_RECEIPT_MISSING')
  need(receipt.tenantId === target.tenantId && receipt.provenance?.kind === 'legacy-chat', 'RUN_TENANT_OR_PROVENANCE_MISMATCH')
  equal(receipt.namespace, target.namespace, 'RUN_NAMESPACE_MISMATCH')
  for (const key of ['sessionId', 'turnId', 'userMessageId', 'assistantMessageId']) need(id(run[key]) && receipt[key] === run[key], 'RUN_RECEIPT_IDENTITY_MISMATCH')
  need(receipt.rootRunId === run.runId && id(receipt.attemptId) && digest(receipt.userSeedDigest), 'RUN_RECEIPT_INVALID')
  need(receipt.rootVersion === 1 && Number.isSafeInteger(run.version) && run.version >= receipt.rootVersion
    && Number.isSafeInteger(run.seq) && run.seq > (record.beforeSequence ?? 0) && receipt.rootSequence === run.seq
    && Number.isFinite(receipt.acceptedAt) && receipt.acceptedAt === run.createdAt
    && receipt.acceptedAt >= record.clickRequestedAt, 'RUN_ADMISSION_ORDER_INVALID')
  return clone(run)
}
function projectedRun(run) {
  return { ...runIdentity(run), status: run.status, version: run.version, createdAt: run.createdAt,
    updatedAt: run.updatedAt, finishedAt: run.finishedAt ?? null, actualModelId: run.actualModelId ?? null,
    workspacePaths: clone(run.workspacePaths), requestConfig: { agentId: run.requestConfig.agentId } }
}

/** Journal and persist must survive runner recovery. Never replace them after a click.
 * prepareTarget/readTarget return {owner,sessionId,agentId,tenantId,namespace,modelId,
 * workspacePath,engine,newTask}; engine pins include actual build/PID/dataDir.
 * prepareComposer returns the exact visible text. clickSend must do exactly one click.
 * readQueue is a caller-provided strictly observational snapshot of the trusted Work scope.
 * hasCommand checks legacy role submissions as well, preventing replay across implementations.
 */
export function createVerifiedOfficeSubmit({ ports, journal, expectedTargets, evidenceDir, historyRoot, limits: initialLimits = {} }) {
  for (const name of ['prepareTarget', 'readTarget', 'prepareComposer', 'clickSend', 'readStatus', 'readQueue', 'validateQueueState', 'hasCommand', 'persist'])
    need(typeof ports?.[name] === 'function', 'MISSING_PORT_' + name)
  need(journal?.schemaVersion === 1 && Array.isArray(journal.submissions), 'INVALID_JOURNAL')
  need(expectedTargets && typeof expectedTargets === 'object' && !Array.isArray(expectedTargets), 'EXPECTED_TARGETS_MISSING')
  const intendedTargets = clone(expectedTargets)
  const limits = budgets(initialLimits), directory = canonicalDirectory(evidenceDir), histories = canonicalDirectory(historyRoot)
  // Reinstalling a factory in the same process must join its existing operations.
  // This is initialized only on explicit installation, never by importing the module.
  const ownerKey = Symbol.for('aether.office.verified-submit.owners.v1')
  const owners = globalThis[ownerKey] ??= new Map(), ownerId = directory.toLowerCase()
  let runtime = owners.get(ownerId)
  if (!runtime) { runtime = { journal, active: false, pendingOperations: 0 }; owners.set(ownerId, runtime) }
  need(runtime.journal === journal, 'JOURNAL_OWNER_CHANGED')
  const persist = () => { const value = ports.persist(journal); need(!value || typeof value.then !== 'function', 'PERSIST_MUST_BE_SYNCHRONOUS') }
  const readQueueSnapshot = (value, target, budget) => queueSnapshot(value, target, budget, ports.validateQueueState)
  const expectedTarget = (role, value) => {
    const intended = intendedTargets[role]
    need(intended && typeof intended === 'object', 'EXPECTED_ROLE_MISSING')
    const actual = targetIdentity(value), expected = targetIdentity({ ...intended, owner: 'work', active: true,
      sessionId: intended.sessionId ?? value.sessionId })
    equal(actual, expected, 'UNEXPECTED_TARGET')
    return actual
  }
  const artifact = (name, value, budget) => {
    canonicalDirectory(directory)
    const bytes = JSON.stringify(value, null, 2) + '\n'; need(Buffer.byteLength(bytes) <= budget.artifactBytes, 'ARTIFACT_BYTE_BUDGET')
    const file = path.join(directory, name); fs.writeFileSync(file, bytes, { flag: 'wx' })
    return { path: file, sha256: sha(bytes), bytes: Buffer.byteLength(bytes) }
  }
  const boundary = async (record, read) => {
    const current = await read('target', () => ports.readTarget(record.role, record.target.sessionId))
    equal(expectedTarget(record.role, current), targetIdentity(record.target), 'TARGET_CHANGED')
  }
  const verifyIntent = (record, budget) => {
    expectedTarget(record.role, record.target)
    for (const [key, suffix] of [['dispatch', '.verified-dispatch.json'], ['clickIntent', '.verified-click-intent.json']]) {
      const reference = record[key], expected = path.join(directory, record.id + suffix)
      need(reference && samePath(reference.path, expected) && samePath(fs.realpathSync(expected), expected), 'INTENT_PATH_CHANGED')
      need(fs.statSync(expected).size <= budget.artifactBytes, 'INTENT_BUDGET')
      const bytes = fs.readFileSync(expected); need(sha(bytes) === reference.sha256, 'INTENT_CHANGED')
      const value = JSON.parse(bytes.toString('utf8'))
      if (key === 'dispatch') {
        need(value.id === record.id && value.role === record.role && sha(value.prompt) === record.promptSha256
          && value.promptSha256 === record.promptSha256 && value.beforeRunId === record.beforeRunId, 'DISPATCH_CHANGED')
        equal(value.target, record.target, 'DISPATCH_TARGET_CHANGED')
        equal(value.history, record.history, 'DISPATCH_HISTORY_CHANGED')
        equal(value.beforeQueue, record.beforeQueue, 'DISPATCH_QUEUE_CHANGED')
      } else need(value.commandId === record.id && value.dispatch?.sha256 === record.dispatch.sha256
        && value.clickRequestedAt === record.clickRequestedAt, 'CLICK_INTENT_CHANGED')
    }
  }
  const operations = (budget, signal, deadline = Date.now() + budget.totalMs) => {
    const check = () => { need(!signal?.aborted, 'CANCELLED'); need(Date.now() < deadline, 'ADMISSION_DEADLINE') }
    const read = async (label, operation) => {
      check(); let timer; runtime.pendingOperations++
      const work = Promise.resolve().then(operation)
      work.then(() => { runtime.pendingOperations-- }, () => { runtime.pendingOperations-- })
      try { return await Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AdmissionError('OPERATION_TIMEOUT_' + label.toUpperCase())), Math.min(budget.operationMs, deadline - Date.now()))
      })]) } finally { clearTimeout(timer) }
    }
    return { check, read, deadline, pause: async () => { check(); await new Promise(resolve => setTimeout(resolve, Math.min(budget.pollMs, deadline - Date.now()))) } }
  }
  const observe = async (record, budget, signal, deadline) => {
    verifyIntent(record, budget)
    const { read, check, pause } = operations(budget, signal, deadline)
    const meter = record.lastHistoryRead = { bytes: 0, limit: budget.historyReadBytes }
    let candidate = record.observedCandidate ? clone(record.observedCandidate.run) : null
    for (let attempts = 0; attempts < budget.statusReads; attempts++) {
      check(); await boundary(record, read)
      const status = await read('status', () => ports.readStatus(record.target.sessionId))
      if (!status?.run || status.run.runId === record.beforeRunId) {
        need(!candidate, 'OBSERVED_ROOT_REGRESSED'); await pause(); continue
      }
      const observed = verifyRun(status.run, record)
      if (candidate) equal(runIdentity(observed), runIdentity(candidate), 'OBSERVED_ROOT_REPLACED')
      else {
        candidate = observed
        record.observedCandidate = { run: projectedRun(observed), observedAt: new Date().toISOString(), verified: false }
        persist()
      }
      const proof = readPersistedAdmission(record.history, record.target, candidate, record.promptSha256, histories, budget, meter)
      if (proof.state !== 'verified') { await pause(); continue }
      const queue = readQueueSnapshot(await read('queue', () => ports.readQueue(record.target.sessionId)), record.target, budget)
      validateQueue(record.beforeQueue, queue, candidate, record.promptSha256)
      await boundary(record, read)
      // This final response checks identity only; it must never replace the retained admission sample.
      const finalStatus = await read('final-status', () => ports.readStatus(record.target.sessionId))
      equal(runIdentity(verifyRun(finalStatus?.run, record)), runIdentity(candidate), 'FINAL_ROOT_CHANGED')
      check(); need(runtime.pendingOperations === 0, 'OPERATIONS_STILL_PENDING')
      const actualAdmittedRun = projectedRun(candidate), recordedAt = new Date().toISOString()
      const binding = { schemaVersion: 1, commandId: record.id, role: record.role, recordedAt,
        dispatch: record.dispatch, clickIntent: record.clickIntent, promptSha256: record.promptSha256,
        beforeRunId: record.beforeRunId, target: record.target, actualAdmittedRun, persistedUser: proof,
        queue, noAutomaticRetry: true }
      const bindingPath = path.join(directory, record.id + '.verified-binding.json')
      if (!record.bindingPublication) {
        need(!fs.existsSync(bindingPath), 'EXISTING_BINDING_WITHOUT_PUBLICATION_INTENT')
        const text = JSON.stringify(binding, null, 2) + '\n'
        need(Buffer.byteLength(text) <= budget.artifactBytes, 'ARTIFACT_BYTE_BUDGET')
        record.bindingPublication = { text, bytes: Buffer.byteLength(text), sha256: sha(text) }
        // The complete immutable payload is durable before its create-only publication.
        persist()
      }
      const publication = record.bindingPublication
      need(typeof publication.text === 'string' && Buffer.byteLength(publication.text) === publication.bytes
        && publication.bytes <= budget.artifactBytes && sha(publication.text) === publication.sha256, 'PUBLICATION_INTENT_CHANGED')
      const frozen = JSON.parse(publication.text), frozenProof = frozen.persistedUser
      need(frozen.commandId === record.id && frozen.role === record.role && frozen.dispatch?.sha256 === record.dispatch.sha256
        && frozen.clickIntent?.sha256 === record.clickIntent.sha256 && frozen.promptSha256 === record.promptSha256
        && frozen.beforeRunId === record.beforeRunId, 'PUBLICATION_COMMAND_CHANGED')
      equal(targetIdentity(frozen.target), targetIdentity(record.target), 'PUBLICATION_TARGET_CHANGED')
      equal(runIdentity(frozen.actualAdmittedRun), runIdentity(candidate), 'PUBLICATION_RUN_CHANGED')
      need(frozenProof?.path === proof.path && frozenProof.startOffset === proof.startOffset && Number.isSafeInteger(frozenProof.endOffset)
        && frozenProof.endOffset <= proof.endOffset && frozenProof.bytes === frozenProof.endOffset - frozenProof.startOffset
        && frozenProof.bytes > 0 && frozenProof.bytes <= budget.historyBytes && frozenProof.userMessageId === proof.userMessageId
        && frozenProof.promptSha256 === proof.promptSha256 && frozenProof.seedSha256 === proof.seedSha256, 'PUBLICATION_HISTORY_CHANGED')
      equal(identity(frozenProof), identity(proof), 'PUBLICATION_HISTORY_REPLACED')
      need(samePath(fs.realpathSync(proof.path), proof.path), 'PUBLICATION_HISTORY_REDIRECTED')
      const frozenFd = fs.openSync(proof.path, 'r')
      try {
        need(meter.bytes + frozenProof.bytes <= budget.historyReadBytes, 'HISTORY_TOTAL_READ_BUDGET_INCOMPLETE')
        meter.bytes += frozenProof.bytes
        equal(identity(fs.fstatSync(frozenFd)), identity(proof), 'PUBLICATION_HISTORY_REPLACED')
        need(sha(readRange(frozenFd, frozenProof.startOffset, frozenProof.bytes)) === frozenProof.intervalSha256, 'PUBLICATION_INTERVAL_CHANGED')
        equal(identity(fs.statSync(proof.path)), identity(proof), 'PUBLICATION_HISTORY_REPLACED')
      } finally { fs.closeSync(frozenFd) }
      // An earlier persistence failure can leave this intent only in memory.
      // Every publication/recovery must durably save it again before touching the final file.
      persist(); check()
      canonicalDirectory(directory)
      if (fs.existsSync(bindingPath)) {
        need(samePath(fs.realpathSync(bindingPath), bindingPath) && fs.statSync(bindingPath).size <= budget.artifactBytes, 'EXISTING_BINDING_INVALID')
        const bytes = fs.readFileSync(bindingPath)
        need(bytes.length === publication.bytes && sha(bytes) === publication.sha256, 'EXISTING_BINDING_BYTES_CHANGED')
      } else fs.writeFileSync(bindingPath, publication.text, { flag: 'wx' })
      const written = { path: bindingPath, sha256: publication.sha256, bytes: publication.bytes }
      Object.assign(record, { phase: 'admitted', runId: candidate.runId, actualAdmittedRun: frozen.actualAdmittedRun, binding: written,
        admittedAt: recordedAt, completedAt: recordedAt, errorCode: null })
      journal.lease = null; persist()
      return { admitted: true, id: record.role, commandId: record.id, sessionId: record.target.sessionId,
        runId: candidate.runId, binding: written, clickCount: 1 }
    }
    throw new AdmissionError('ADMISSION_OBSERVATION_BUDGET')
  }
  const failure = (record, error) => {
    Object.assign(record, { phase: record.clickRequested ? 'admission-uncertain' : 'preparation-failed',
      errorCode: codeOf(error), lastObservedAt: new Date().toISOString() })
    // Never release a click lease on failure/cancellation, including late port completion.
    journal.lease = { commandId: record.id, role: record.role, held: true, clickRequested: record.clickRequested }
    try { persist() } catch { record.persistenceFailed = true }
    return { admitted: false, commandId: record.id, phase: record.phase, code: record.errorCode,
      clickRequested: record.clickRequested, pendingOperations: runtime.pendingOperations, noAutomaticRetry: true }
  }
  const submit = async (role, stage, options = {}) => {
    need(!runtime.active && runtime.pendingOperations === 0 && !journal.lease, 'SUBMISSION_LEASE_HELD')
    need(id(role) && id(stage?.id) && typeof stage.prompt === 'string' && stage.prompt.length, 'SUBMISSION_INVALID')
    need(!journal.submissions.some(item => item.id === stage.id) && ports.hasCommand(stage.id) === false, 'DUPLICATE_COMMAND')
    for (const suffix of ['-binding.json', '-prompt.json', '.verified-dispatch.json', '.verified-click-intent.json', '.verified-binding.json'])
      need(!fs.existsSync(path.join(directory, stage.id + suffix)), 'EXISTING_COMMAND_EVIDENCE')
    const budget = budgets({ ...limits, ...options.limits }), record = { id: stage.id, role, kind: stage.kind ?? null,
      revision: stage.revision ?? null, startedAt: new Date().toISOString(), phase: 'preparing', clickRequested: false,
      promptSha256: sha(stage.prompt), limits: budget }
    runtime.active = true; journal.submissions.push(record); journal.lease = { commandId: record.id, role, held: true, clickRequested: false }
    try {
      persist(); const { read, check, deadline } = operations(budget, options.signal)
      const prepared = await read('prepare-target', () => ports.prepareTarget(role, clone(stage), { startRole: options.startRole === true }))
      record.target = { ...expectedTarget(role, prepared), newTask: prepared.newTask === true }
      const status = await read('before-status', () => ports.readStatus(record.target.sessionId))
      need(status?.running === false && (!status.run || terminal.has(status.run.status) && Array.isArray(status.run.pending) && status.run.pending.length === 0), 'SESSION_NOT_IDLE')
      if (status.run) {
        need(status.run.sessionId === record.target.sessionId && id(status.run.runId) && Number.isSafeInteger(status.run.seq)
          && status.run.serverAdmissionReceipt?.tenantId === record.target.tenantId, 'BEFORE_SESSION_MISMATCH')
        equal(status.run.serverAdmissionReceipt.namespace, record.target.namespace, 'BEFORE_NAMESPACE_MISMATCH')
      }
      record.beforeRunId = status.run?.runId ?? null; record.beforeSequence = status.run?.seq ?? 0
      record.beforeQueue = readQueueSnapshot(await read('before-queue', () => ports.readQueue(record.target.sessionId)), record.target, budget)
      need(record.beforeQueue.entries.every(entry => entry.phase === 'terminal' && terminal.has(entry.outcome)), 'QUEUE_NOT_DRAINED')
      record.history = captureHistoryCheckpoint(record.target, histories)
      const visibleText = await read('prepare-composer', () => ports.prepareComposer(role, stage.prompt, record.target))
      need(visibleText === stage.prompt, 'COMPOSER_CHANGED_PROMPT')
      await boundary(record, read)
      const beforeAgain = await read('preclick-status', () => ports.readStatus(record.target.sessionId))
      need(beforeAgain?.running === false && (beforeAgain.run?.runId ?? null) === record.beforeRunId, 'PRECLICK_ROOT_CHANGED')
      equal(captureHistoryCheckpoint(record.target, histories), record.history, 'PRECLICK_HISTORY_CHANGED')
      equal(readQueueSnapshot(await read('preclick-queue', () => ports.readQueue(record.target.sessionId)), record.target, budget), record.beforeQueue, 'PRECLICK_QUEUE_CHANGED')
      for (const suffix of ['-binding.json', '-prompt.json', '.verified-dispatch.json', '.verified-click-intent.json', '.verified-binding.json'])
        need(!fs.existsSync(path.join(directory, record.id + suffix)), 'PRECLICK_COMMAND_EVIDENCE_CHANGED')
      record.dispatch = artifact(record.id + '.verified-dispatch.json', { ...record, prompt: stage.prompt }, budget)
      check(); need(runtime.pendingOperations === 0, 'OPERATIONS_STILL_PENDING')
      record.clickRequested = true; record.clickRequestedAt = Date.now(); record.phase = 'dispatching'
      record.clickIntent = artifact(record.id + '.verified-click-intent.json', { commandId: record.id, dispatch: record.dispatch,
        clickRequestedAt: record.clickRequestedAt, at: new Date(record.clickRequestedAt).toISOString(), noAutomaticRetry: true }, budget)
      journal.lease.clickRequested = true; persist()
      await read('single-click', () => ports.clickSend(role, record.target))
      record.phase = 'admission-uncertain'; persist()
      return await observe(record, budget, options.signal, deadline)
    } catch (error) { return failure(record, error) } finally { runtime.active = false }
  }
  return {
    submit,
    startRole: (role, stage, options = {}) => submit(role, stage, { ...options, startRole: true }),
    async reconcile(commandId, options = {}) {
      need(!runtime.active && runtime.pendingOperations === 0, 'SUBMISSION_LEASE_HELD')
      const matches = journal.submissions.filter(item => item.id === commandId)
      need(matches.length === 1, 'RECONCILIATION_RECORD_MISSING')
      const record = matches[0]
      need(record.clickRequested && ['dispatching', 'admission-uncertain'].includes(record.phase)
        && journal.lease?.commandId === commandId, 'RECONCILIATION_NOT_ALLOWED')
      runtime.active = true
      try { return await observe(record, budgets({ ...record.limits, ...options.limits }), options.signal) }
      catch (error) { return failure(record, error) } finally { runtime.active = false }
    },
    inspect: () => ({ active: runtime.active, pendingOperations: runtime.pendingOperations, lease: clone(journal.lease), submissions: clone(journal.submissions) }),
  }
}
