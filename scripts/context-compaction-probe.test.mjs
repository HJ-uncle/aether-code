/** Pure harness regressions only. No Electron launch, inspector, HTTP or model request. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { runInNewContext } from 'node:vm'
import { summaryBelongsToPacket, assertActiveSummaryMatches, assessCohortArchival, renderCompactionReport,
  buildBusinessPacket, loadCompactionOracle, assessRecall, assessProbeHeadroom } from './run-context-compaction-probe.mjs'
import { startOfficeContextProbe, reconcileOfficeContextProbe } from './office-context-probe-control.mjs'
import { recover } from './office-context-probe-recovery.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const createFixture = () => {
  mkdirSync('.e2e-tmp', { recursive: true })
  return mkdtempSync(resolve('.e2e-tmp/context-probe-selftest-'))
}
const cleanup = fixture => {
  assert.equal(dirname(fixture), resolve('.e2e-tmp'))
  assert.ok(basename(fixture).startsWith('context-probe-selftest-'))
  rmSync(fixture, { recursive: true, force: true })
}

test('owned recovery executes without a dynamic-import callback and preserves the exact controller/options', async () => {
  const entrypoint = resolve('scripts/run-office-company-campaign.mjs')
  const expectedRoot = resolve('.ae/office-company-selftest')
  const c = { state: { runRoot: expectedRoot } }, loads = []
  const processForEvaluation = {
    argv: ['node', entrypoint],
    getBuiltinModule(name) {
      if (name === 'node:path') return path
      assert.equal(name, 'node:module')
      return { createRequire(base) {
        assert.equal(base, entrypoint)
        return file => {
          loads.push(file)
          return { startOfficeContextProbe: async (controller, options) => {
            assert.equal(controller, c)
            assert.equal(options.expectedRoot, expectedRoot)
            assert.equal(options.packetTokens, 60_000)
            assert.equal(options.maxDurationMs, 12 * 60 * 60_000)
            return { accepted: true }
          } }
        }
      } }
    },
  }
  // No importModuleDynamically callback: this reproduces the owned inspector's
  // evaluation boundary without attaching an inspector or starting a model.
  const result = await runInNewContext(`(${recover.toString()})(controller)`, { process: processForEvaluation, controller: c })
  assert.equal(result.accepted, true)
  assert.deepEqual(loads, [resolve('scripts/office-context-probe-control.mjs')])
  await assert.rejects(runInNewContext(`(${recover.toString()})(controller, { expectedRoot: outside })`,
    { process: processForEvaluation, controller: c, outside: resolve('../other-campaign') }), /owned runner repository/)
  assert.equal(loads.length, 1)
  processForEvaluation.argv[1] = resolve('scripts/unrelated-runner.mjs')
  await assert.rejects(runInNewContext(`(${recover.toString()})(controller)`,
    { process: processForEvaluation, controller: c }), /existing owned office runner/)
  assert.equal(loads.length, 1)
})

test('the real control module supports synchronous ESM loading without starting a campaign', () => {
  const requireOwned = createRequire(import.meta.url)
  assert.equal(requireOwned('./office-context-probe-control.mjs').startOfficeContextProbe, startOfficeContextProbe)
  assert.equal(requireOwned('./office-context-probe-recovery.mjs').recover, recover)
})

test('owned reconciliation acknowledges before its read-only proof completes and query stays controller-only', async () => {
  const entrypoint = resolve('scripts/run-office-company-campaign.mjs')
  const c = { state: { runRoot: resolve('.ae/office-company-selftest'), contextCompactionProbeControl: {} } }
  let finish, reconciliations = 0, queries = 0, settled = false
  const proof = new Promise(resolve => { finish = resolve })
  const processForEvaluation = {
    argv: ['node', entrypoint],
    getBuiltinModule(name) {
      if (name === 'node:path') return path
      assert.equal(name, 'node:module')
      return { createRequire: () => () => ({
        reconcileOfficeContextProbe(controller) {
          assert.equal(controller, c); reconciliations++
          c.state.contextCompactionProbeControl.reconciliationActive = true
          return proof.then(value => { settled = true; return value })
        },
        queryOfficeContextProbe(controller) { assert.equal(controller, c); queries++; return { pendingOperations: 1 } },
      }) }
    },
  }
  const invoke = action => runInNewContext(`(${recover.toString()})(controller, { action })`, { process: processForEvaluation, controller: c, action })
  const ack = await invoke('reconcile')
  assert.equal(ack.accepted, true); assert.equal(ack.promise, 'contextProbeReconcilePromise')
  assert.equal(settled, false); assert.equal(reconciliations, 1)
  await assert.rejects(invoke('reconcile'), /already running/)
  assert.equal((await invoke('query')).pendingOperations, 1)
  assert.equal(queries, 1); assert.equal(reconciliations, 1); assert.equal(settled, false)
  finish({ released: true })
  assert.deepEqual(await c.contextProbeReconcilePromise, { released: true })
})

test('summary scoring excludes retrieval compaction and unrelated or failed packets', () => {
  const packet = { kind: 'business-review', outcome: 'succeeded', runId: 'business-2', summaryIdAtCompletion: 'summary-2',
    dispatchAttemptedAt: '2026-10-24T00:00:10.000Z', finishedAt: '2026-10-24T00:00:30.000Z' }
  const summary = { id: 'summary-2', committedAt: Date.parse('2026-10-24T00:00:20.000Z'), progress: { runId: 'business-2' } }
  assert.equal(summaryBelongsToPacket(summary, packet), true)
  assert.equal(summaryBelongsToPacket({ ...summary, progress: null }, packet), true)
  assert.equal(summaryBelongsToPacket({ ...summary, committedAt: Date.parse('2026-10-24T00:00:09.000Z') }, packet), false)
  assert.equal(summaryBelongsToPacket({ ...summary, progress: { runId: 'retrieval-1' } }, packet), false)
  assert.equal(summaryBelongsToPacket({ ...summary, id: 'summary-1' }, packet), false)
  assert.equal(summaryBelongsToPacket(summary, { ...packet, outcome: 'failed' }), false)
  assert.equal(summaryBelongsToPacket(summary, { ...packet, kind: 'archive-recovery' }), false)
})

test('active summary identity also proves exact payload, not just an equal UUID', () => {
  const summary = { id: 'same-id', content: '【历史上下文摘要】retained facts' }
  const durable = { id: 'same-id', summarySha256: hash('retained facts') }
  assert.doesNotThrow(() => assertActiveSummaryMatches(summary, durable))
  assert.throws(() => assertActiveSummaryMatches({ ...summary, content: '【历史上下文摘要】altered facts' }, durable), /physical payload/)
  assert.throws(() => assertActiveSummaryMatches(summary, { ...durable, id: 'other' }), /committed/)
})

test('closed-book eligibility rejects facts resurfaced through a later raw tool result', () => {
  const cohort = { seedMessageId: 'seed', correctionMessageId: 'correction', seedRunId: 'seed-run', correctionRunId: 'correction-run',
    original: { pendingAction: 'P-OLD-核验' }, current: { vendorCode: 'SYN-1234567890', pendingAction: 'P-NEW-复核' } }
  const summary = { id: 'summary', content: 'SYN-1234567890 P-NEW-复核', metadata: { isCompactSummary: true } }
  assert.equal(assessCohortArchival({ history: [summary] }, cohort).passed, true)
  assert.equal(assessCohortArchival({ history: [summary, { id: 'seed', content: 'redacted' }] }, cohort).passed, false)
  const result = assessCohortArchival({ history: [summary, { id: 'later-tool', role: 'tool', content: 'SYN-1234567890' }] }, cohort)
  assert.equal(result.passed, false); assert.deepEqual(result.resurfacedFactIds, ['later-tool'])
})

test('oracle survives resume and strict closed-book checks reject missing/old/invented values', () => {
  const fixture = createFixture()
  try {
    const file = join(fixture, 'oracle.json'), first = loadCompactionOracle(file), before = readFileSync(file)
    assert.deepEqual(loadCompactionOracle(file, { resume: true, expectedHash: first.sha256 }), first)
    assert.deepEqual(readFileSync(file), before)
    assert.throws(() => loadCompactionOracle(join(fixture, 'missing.json'), { resume: true }), /never regenerate/)
    for (const cohort of first.cohorts) {
      assert.equal(assessRecall({ cohort: cohort.id, answers: cohort.current }, cohort).passed, true)
      assert.equal(assessRecall({ cohort: cohort.id, answers: cohort.original }, cohort).passed, false)
      for (const key of Object.keys(cohort.current)) {
        const answers = { ...cohort.current }; delete answers[key]
        assert.equal(assessRecall({ cohort: cohort.id, answers }, cohort).passed, false)
      }
      assert.equal(assessRecall({ cohort: cohort.id, answers: { ...cohort.current, approvalCode: 'invented' } }, cohort).passed, false)
    }
  } finally { cleanup(fixture) }
})

test('packet transport is bounded and headroom rejects missing or near-threshold usage', () => {
  for (const target of [48000, 60000, 64000]) {
    const packet = buildBusinessPacket(1, target)
    assert.ok(packet.modelInputTokens >= target && packet.modelInputTokens < target + 1000)
    assert.ok(Buffer.byteLength(JSON.stringify({ message: '[CP-9999]\n' + packet.prompt })) + 65536 < 2 * 1024 * 1024)
    assert.ok(packet.anomalous.length >= 3)
  }
  assert.equal(assessProbeHeadroom({}, { postTokens: 40000 }, '复核', 0.92).sufficient, false)
  assert.equal(assessProbeHeadroom({ projection: [{ usage: { currentPromptTokens: 245000 } }] }, { postTokens: 40000 }, '复核', 0.92).sufficient, false)
  assert.equal(assessProbeHeadroom({ projection: [{ usage: { currentPromptTokens: 80000 } }] }, { postTokens: 40000 }, '复核', 0.92).sufficient, true)
})

function fakeController(fixture) {
  writeFileSync(join(fixture, 'commands.json'), JSON.stringify({ commands: [] }))
  const roles = Object.fromEntries(Array.from({ length: 6 }, (_, i) => ['role' + i, { sessionId: 'session' + i }]))
  const effects = []
  const engine = { phase: 'ready', adopted: false, mode: 'embedded', baseUrl: 'http://owned.invalid', accountId: 'account', instanceId: 'instance', pid: 1, buildId: 'build' }
  const run = sessionId => ({ runId: 'run-' + sessionId, sessionId, status: 'succeeded', finishedAt: 1, pending: [] })
  return { app: { evaluate: async () => ({ profile: fixture, nativeQueue: false }) }, page: { evaluate: async () => engine },
    state: { runRoot: fixture, profile: fixture, roles, commands: [], engine }, effects,
    workTasks: async () => [{ id: 'session0', active: true }],
    request: async (_method, endpoint, _body, query) => {
      if (endpoint === '/chat/status') return { running: false, run: run(query.sessionId) }
      if (endpoint === '/chat/runs') return { runs: [run(query.sessionId)] }
      if (endpoint === '/chat/admission/context') return { protocolVersion: 1, sessionId: query.sessionId, tenantId: 'tenant', namespace: { id: 'namespace', generation: 'generation' } }
      if (endpoint === '/subagent/runs') return { schemaVersion: 2, parentSessionId: query.parentSessionId, runs: [], hasMore: false, listComplete: true, revision: 'mock' }
      if (endpoint === '/command-jobs') return { jobs: [] }
      throw new Error('Unexpected fake request ' + endpoint)
    },
    submit: async () => effects.push('submit'), createAndStart: async () => effects.push('create'), selectTask: async () => effects.push('select'),
    stopMonitoring: () => effects.push('stop-monitor'), startMonitoring: () => effects.push('start-monitor'),
    save() {}, log() {}, artifact: (name, value) => effects.push({ name, value }) }
}
const createQueueReader = async () => ({ sourceHashes: {}, read: async scope => ({ state: { schemaVersion: 1, scope,
  revision: 0, paused: false, entries: [], removed: [] } }) })
const fakeProbe = (fixture, body) => async input => {
  const dir = join(fixture, 'context-compaction-probe'); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 1, records: [], sessionId: null }))
  return body(input)
}

test('existing-controller adapter acknowledges once, locks competing sends, then restores without launching a desktop', async () => {
  const fixture = createFixture()
  try {
    const c = fakeController(fixture), originalSubmit = c.submit
    let finish, received, ready
    const running = new Promise(done => { ready = done })
    const pending = new Promise(done => { finish = done })
    const ack = await startOfficeContextProbe(c, { expectedRoot: fixture }, { createQueueReader,
      runProbe: fakeProbe(fixture, async input => { received = input; ready(); return pending }) })
    const job = c.contextProbePromise
    assert.equal(ack.accepted, true)
    await running
    assert.equal(received.app, c.app); assert.equal(received.page, c.page)
    assert.equal(received.options.hostContext, 'office'); assert.equal(received.options.restoreTaskId, 'session0')
    await assert.rejects(c.submit(), /owns the Work UI/)
    await assert.rejects(startOfficeContextProbe(c, { expectedRoot: fixture }), /running or held/)
    finish({ completed: true, passed: false }); await job
    assert.equal(c.submit, originalSubmit); assert.equal(c.contextProbePromise, null)
    assert.equal(c.state.contextCompactionProbeControl.phase, 'completed')
    assert.equal(c.state.contextCompactionProbeControl.passed, false)
    assert.deepEqual(c.effects.filter(value => typeof value === 'string'), ['stop-monitor', 'start-monitor'])
  } finally { cleanup(fixture) }
})

test('adapter refuses active office roots/jobs and pending UI commands before invoking the probe', async () => {
  const fixture = createFixture()
  try {
    let calls = 0
    const dependencies = { createQueueReader, runProbe: async () => { calls++; return {} } }
    const c = fakeController(fixture)
    const originalRequest = c.request
    c.request = async () => ({ running: true, run: { status: 'running' } })
    await startOfficeContextProbe(c, { expectedRoot: fixture }, dependencies)
    assert.match((await c.contextProbePromise).error, /ROOT_STILL_RUNNING/)
    c.request = async (...args) => args[1] === '/command-jobs' ? { jobs: [{ status: 'running' }] } : originalRequest(...args)
    await startOfficeContextProbe(c, { expectedRoot: fixture }, dependencies)
    assert.match((await c.contextProbePromise).error, /JOB_NONTERMINAL/)
    writeFileSync(join(fixture, 'commands.json'), JSON.stringify({ commands: [{ id: 'queued', action: 'message' }] }))
    await assert.rejects(startOfficeContextProbe(c, { expectedRoot: fixture }, dependencies), /RUNNER_COMMAND_QUEUE_NOT_DRAINED/)
    assert.equal(calls, 0)
  } finally { cleanup(fixture) }
})

test('adapter retains methods and monitoring until explicit terminal reconciliation after failure', async () => {
  const fixture = createFixture()
  try {
    const c = fakeController(fixture)
    const originalMethods = [c.submit, c.createAndStart, c.selectTask]
    const ack = await startOfficeContextProbe(c, { expectedRoot: fixture }, {
      createQueueReader, runProbe: fakeProbe(fixture, async () => { throw new Error('intentional isolated harness failure') }),
    })
    assert.equal(ack.accepted, true)
    const result = await c.contextProbePromise
    assert.equal(result.completed, false); assert.equal(result.passed, false)
    assert.match(result.error, /isolated harness failure/)
    assert.notEqual(c.submit, originalMethods[0]); assert.ok(c.contextProbePromise)
    assert.equal(c.state.contextCompactionProbeControl.phase, 'needs-reconciliation')
    assert.deepEqual(c.effects.filter(value => typeof value === 'string'), ['stop-monitor'])
    const reconciled = await reconcileOfficeContextProbe(c)
    assert.equal(reconciled.released, true)
    assert.deepEqual([c.submit, c.createAndStart, c.selectTask], originalMethods)
    assert.equal(c.contextProbePromise, null)
    assert.deepEqual(c.effects.filter(value => typeof value === 'string'), ['stop-monitor', 'start-monitor'])
  } finally { cleanup(fixture) }
})

test('adapter rolls back a failed admission save before any probe dispatch', async () => {
  const fixture = createFixture()
  try {
    const c = fakeController(fixture), previousControl = { phase: 'incomplete' }
    const originalMethods = [c.submit, c.createAndStart, c.selectTask]
    c.state.contextCompactionProbeControl = previousControl
    c.save = () => { throw new Error('intentional admission persistence failure') }
    let dispatches = 0
    await assert.rejects(startOfficeContextProbe(c, { expectedRoot: fixture }, {
      runProbe: async () => { dispatches++; return {} },
    }), /admission persistence failure/)
    assert.equal(dispatches, 0)
    assert.deepEqual([c.submit, c.createAndStart, c.selectTask], originalMethods)
    assert.equal(c.contextProbePromise, null)
    assert.equal(c.state.contextCompactionProbeControl, previousControl)
    assert.deepEqual(c.effects.filter(value => typeof value === 'string'), ['stop-monitor', 'start-monitor'])
  } finally { cleanup(fixture) }
})

test('report separates office isolation, configured window and unverified provider billing', () => {
  const report = renderCompactionReport({ completed: true, passed: false, cycles: [], hostBoundary: { kind: 'office' } })
  assert.match(report, /执行完成：\*\*是\*\*；验收通过：\*\*否\*\*/)
  assert.match(report, /六个办公根任务空闲/)
  assert.match(report, /不表示服务商实测输入恰为 268K/)
  assert.match(report, /摘要子请求的完整费用/)
})
