/** Explicit existing-window adapter. Importing starts no app, observer or model. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runCompactionProbe } from './run-context-compaction-probe.mjs'
import { createReadonlyWorkQueueReader } from './office-readonly-work-queue.mjs'
import { createProbeOperationTracker, observeOfficeProbeTerminal, probeCommandFingerprint } from './office-context-probe-lifecycle.mjs'

const owners = new WeakMap()
const now = () => new Date().toISOString()
const bindings = c => Object.fromEntries(Object.entries(c.state.roles).map(([key, role]) => [key, { sessionId: role.sessionId, agentId: role.agentId ?? null }]))
const save = c => { try { c.save() } catch { c.state.contextCompactionProbeControl.persistenceError = 'CONTROLLER_SAVE_FAILED' } }
function probeState(c) {
  const file = join(c.state.runRoot, 'context-compaction-probe', 'state.json')
  if (!existsSync(file)) return undefined
  assert.ok(statSync(file).size <= 16 * 1024 * 1024, 'PROBE_STATE_BYTE_BUDGET')
  const value = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(value.schemaVersion === 1 && Array.isArray(value.records) && value.records.length <= 131, 'PROBE_STATE_SCHEMA_OR_BUDGET')
  return value
}
function assertOwner(c, lease) {
  assert.equal(owners.get(c), lease, 'PROBE_LEASE_OWNER_CHANGED')
  assert.equal(c.state.contextCompactionProbeControl, lease.control, 'PROBE_CONTROL_CHANGED')
  assert.ok(lease.control.leaseActive && c.contextProbePromise, 'PROBE_SLOT_LOST')
  assert.deepEqual(bindings(c), lease.control.officeBindings, 'OFFICE_OWNER_BINDINGS_CHANGED')
  assert.deepEqual(c.state.engine, lease.control.runnerEngine, 'RUNNER_ENGINE_BINDING_CHANGED')
  for (const [name, wrapper] of Object.entries(lease.wrappers)) assert.equal(c[name], wrapper, 'PROBE_ADMISSION_GUARD_CHANGED')
  assert.deepEqual(probeCommandFingerprint(c), lease.commandFingerprint, 'OFFICE_COMMANDS_CHANGED_DURING_PROBE')
}
function hold(c, lease, error) {
  lease.control.phase = 'needs-reconciliation'; lease.control.leaseHeldForReview = true
  lease.control.error = String(error?.message || error).slice(0, 1024)
  lease.control.finishedAt = now(); save(c)
}
function release(c, lease) {
  assertOwner(c, lease)
  assert.equal(lease.track.pending, 0, 'PENDING_OPERATIONS_PREVENT_RELEASE')
  assert.equal(lease.running, false, 'RUNNING_PROBE_PREVENTS_RELEASE')
  // Persist before restoring admission. A failed write stays held.
  lease.control.releaseProofAt = now(); c.save()
  Object.assign(c, lease.originals); c.contextProbePromise = null
  lease.control.leaseActive = false; lease.control.leaseHeldForReview = false; lease.control.releasedAt = now()
  if (lease.monitorStopped) {
    try { c.startMonitoring(); lease.control.monitoringResumedAt = now() }
    catch (error) { lease.control.monitoringError = String(error?.message || error).slice(0, 1024) }
  }
  save(c)
}
async function observe(c, lease, probe = probeState(c)) {
  assertOwner(c, lease); assert.equal(lease.track.pending, 0, 'PENDING_OPERATIONS_PREVENT_OBSERVATION')
  if (lease.control.dispatched) assert.ok(probe && Array.isArray(probe.records), 'PROBE_STATE_MISSING_AFTER_START')
  return observeOfficeProbeTerminal(c, { track: lease.track, readQueue: scope => lease.reader.read(scope),
    expectedEngine: lease.engine, commandFingerprint: lease.commandFingerprint,
    expectedOfficeRuns: lease.control.officeRuns, probe, limits: lease.dependencies.observationLimits })
}
async function initializeReadBoundary(c, lease) {
  assertOwner(c, lease)
  const read = (label, fn) => lease.track.run(label, fn)
  const host = await read('native queue backend', () => c.app.evaluate(({ app }) => ({ profile: app.getPath('userData'),
    nativeQueue: process.env.AETHER_NEXT_TURN_BACKEND === 'sqlite-worker-opt-in' })))
  assert.equal(resolve(host.profile), resolve(lease.control.profile), 'QUEUE_PROFILE_CHANGED')
  assert.equal(host.nativeQueue, false, 'READONLY_NATIVE_QUEUE_UNSUPPORTED')
  if (!lease.reader) lease.reader = await read('readonly queue validator', () => (lease.dependencies.createQueueReader || createReadonlyWorkQueueReader)({ profile: host.profile, backend: 'json-journal' }))
  lease.control.queueValidatorSourceHashes = lease.reader.sourceHashes
  const engine = await read('initial engine identity', () => c.page.evaluate(() => window.aether.engine.getSnapshot()))
  assert.equal(engine.phase, 'ready'); assert.equal(engine.adopted, false)
  for (const key of ['mode', 'baseUrl', 'accountId', 'instanceId']) assert.equal(engine[key], lease.control.runnerEngine[key], 'RUNNER_ENGINE_CHANGED')
  if (lease.engine) for (const key of ['mode', 'baseUrl', 'accountId', 'instanceId', 'pid', 'buildId']) assert.equal(engine[key], lease.engine[key], 'PROBE_ENGINE_CHANGED')
  else lease.engine = engine
  lease.control.engineIdentity = { mode: engine.mode, baseUrl: engine.baseUrl, accountId: engine.accountId, instanceId: engine.instanceId, pid: engine.pid, buildId: engine.buildId }
}

export async function startOfficeContextProbe(c, options = {}, dependencies = {}) {
  assert.ok(c?.app && c.page && c.state?.runRoot, 'An existing office controller is required')
  assert.ok(options.expectedRoot && resolve(c.state.runRoot) === resolve(options.expectedRoot), 'The owned runner root must match exactly')
  assert.ok(!c.contextProbePromise && !c.state.contextCompactionProbeControl?.leaseActive, 'A context probe is running or held; reconcile instead of dispatching a duplicate')
  assert.ok(!c.uiLoadProbePromise, 'A UI load probe already owns the window')
  for (const key of Object.keys(c)) if (/MaintenanceLease/.test(key)) assert.ok(!c[key]?.active, 'A maintenance lease owns the runner')
  assert.ok(!c.state.contextCompactionProbe?.completed, 'The ten-cycle experiment is already completed; inspect its report instead')
  const commandFingerprint = probeCommandFingerprint(c)
  const originals = Object.fromEntries(['submit', 'createAndStart', 'selectTask'].map(name => [name, c[name]]))
  assert.ok(Object.values(originals).every(value => typeof value === 'function'))
  const control = { phase: 'preflighting', startedAt: now(), leaseActive: true, leaseHeldForReview: false,
    profile: resolve(c.state.profile), runnerEngine: structuredClone(c.state.engine), officeBindings: bindings(c),
    pendingOperations: 0, pendingOperationDetails: [], dispatched: false,
    evidence: join(c.state.runRoot, 'context-compaction-probe', 'evidence'),
    maxDurationMs: options.maxDurationMs ?? 12 * 60 * 60_000, packetTokens: options.packetTokens ?? 60_000,
    monitorDrainVerified: false, monitorDisposition: 'timer-stopped-readonly-tick-may-complete' }
  assert.equal(control.packetTokens, 60000, 'The owned ten-cycle plan uses 60000-token packets')
  assert.ok(Number.isFinite(control.maxDurationMs) && control.maxDurationMs > 0 && control.maxDurationMs <= 12 * 60 * 60_000)
  const lease = { control, originals, commandFingerprint, dependencies, running: true, monitorStopped: false }
  lease.track = createProbeOperationTracker(control, { readMs: dependencies.observationLimits?.readMs, onLateSettlement: () => save(c) })
  lease.wrappers = Object.fromEntries(Object.keys(originals).map(name => [name, async () => {
    throw new Error('The independent context probe owns the Work UI; wait for terminal reconciliation')
  }]))
  const previousControl = c.state.contextCompactionProbeControl
  c.state.contextCompactionProbeControl = control; Object.assign(c, lease.wrappers); owners.set(c, lease)
  // Reserve before the first read. Even preflight can outlive an Inspector call.
  let resolveJob
  c.contextProbePromise = new Promise(resolve => { resolveJob = resolve })
  try { c.stopMonitoring(); lease.monitorStopped = true; c.save() }
  catch (error) {
    Object.assign(c, originals); c.contextProbePromise = null; owners.delete(c)
    if (previousControl === undefined) delete c.state.contextCompactionProbeControl
    else c.state.contextCompactionProbeControl = previousControl
    if (lease.monitorStopped) c.startMonitoring()
    throw error
  }
  setTimeout(() => { void (async () => {
    let result
    try {
      const read = (label, fn) => lease.track.run(label, fn)
      await initializeReadBoundary(c, lease)
      const tasks = await read('Work task restoration target', () => c.workTasks())
      control.restoreTaskId = options.restoreTaskId ?? tasks.find(task => task.active)?.id
      assert.ok(Object.values(c.state.roles).some(role => role.sessionId === control.restoreTaskId), 'Select an existing office task for restoration')
      const before = await observe(c, lease)
      control.officeRuns = before.officeRuns; control.preflight = before; c.save(); assertOwner(c, lease)
      control.phase = 'running'; control.dispatched = true; c.save()
      result = await (dependencies.runProbe || runCompactionProbe)({ app: c.app, page: c.page, state: c.state,
        request: (...args) => { assertOwner(c, lease); return lease.track.run('probe ' + args[0] + ' ' + args[1], () => c.request(...args), 60000) },
        artifact: c.artifact, log: c.log,
        options: { hostContext: 'office', restoreTaskId: control.restoreTaskId, maxDurationMs: control.maxDurationMs, packetTokens: control.packetTokens,
          checkExclusive: () => assertOwner(c, lease),
          beforeSelectionRestore: async probe => { const proof = await observe(c, lease, probe); control.selectionRestoreProof = proof; c.save(); return proof } } })
      c.state.contextCompactionProbe = result; control.passed = result.passed === true
      c.artifact('context-compaction-probe-result.json', result); lease.running = false
      // Incomplete admissions need explicit reconciliation, including late reads.
      if (!result.completed) throw new Error('PROBE_INCOMPLETE_REQUIRES_RECONCILIATION')
      control.terminalProof = await observe(c, lease)
      control.phase = 'completed'; control.finishedAt = now(); release(c, lease)
    } catch (error) {
      lease.running = false; result ||= { completed: false, passed: false, error: String(error?.message || error) }
      hold(c, lease, error)
      // Definite preflight rejection has never admitted probe work.
      if (!control.dispatched && lease.track.pending === 0) {
        try { control.phase = 'preflight-rejected'; release(c, lease) } catch (releaseError) { hold(c, lease, releaseError) }
      }
    }
    resolveJob({ ...result, maintenanceLeaseHeld: control.leaseActive, controlPhase: control.phase })
  })().catch(error => { lease.running = false; hold(c, lease, error); resolveJob({ completed: false, passed: false, maintenanceLeaseHeld: true, error: control.error }) }) }, 0)
  return { accepted: true, ...control, runnerPid: process.pid, query: 'queryOfficeContextProbe', promise: 'contextProbePromise' }
}

export function queryOfficeContextProbe(c) {
  const value = c.state.contextCompactionProbeControl
  if (!value) return { started: false }
  const proof = value.terminalProof || value.preflight
  return structuredClone({ started: true, phase: value.phase, startedAt: value.startedAt, finishedAt: value.finishedAt ?? null,
    leaseActive: value.leaseActive, leaseHeldForReview: value.leaseHeldForReview, pendingOperations: value.pendingOperations,
    pendingOperationDetails: value.pendingOperationDetails, dispatched: value.dispatched, passed: value.passed ?? null,
    reconciliationActive: value.reconciliationActive === true, reconciledAt: value.reconciledAt ?? null,
    releasedAt: value.releasedAt ?? null, engineIdentity: value.engineIdentity ?? null, restoreTaskId: value.restoreTaskId ?? null,
    error: value.error ?? null, persistenceError: value.persistenceError ?? null, monitoringError: value.monitoringError ?? null,
    terminalProof: proof ? { ready: proof.ready, at: proof.at, stateSha256: proof.stateSha256, roots: proof.roots.length,
      children: proof.children.length, jobs: proof.jobs.length, queues: proof.queues.length } : null })
}

/** Observation and release only: no cancel, resend, queue recovery, history
 * mutation, or selection change. A failed observation leaves the guard held. */
export async function reconcileOfficeContextProbe(c) {
  const lease = owners.get(c)
  assert.ok(lease?.control.leaseActive, 'No live owned probe lease to reconcile')
  assert.equal(lease.running, false, 'The probe invocation is still running')
  assert.ok(!lease.reconciling, 'A reconciliation is already observing this lease')
  assert.equal(lease.track.pending, 0, 'Pending operations have not settled; timeout is not cancellation')
  lease.reconciling = true; lease.control.reconciliationActive = true; lease.control.reconciliationStartedAt = now(); save(c)
  try {
    await initializeReadBoundary(c, lease)
    const proof = await observe(c, lease)
    lease.control.terminalProof = proof; lease.control.phase = 'reconciled'; lease.control.reconciledAt = now()
    release(c, lease)
    return { released: true, proof, selectionRestoreDeferred: c.state.contextCompactionProbe?.restoredPrimarySelection !== true }
  } catch (error) { hold(c, lease, error); throw error }
  finally { lease.reconciling = false; lease.control.reconciliationActive = false; save(c) }
}
