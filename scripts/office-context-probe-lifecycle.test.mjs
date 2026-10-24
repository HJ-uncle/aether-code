/** Isolated lifecycle fixtures only: no Electron, Inspector, HTTP or model. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, dirname, basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { observeOfficeProbeTerminal, createProbeOperationTracker, probeCommandFingerprint, PROBE_OBSERVATION_LIMITS, assertProbeDefaultAssistant } from './office-context-probe-lifecycle.mjs'
import { startOfficeContextProbe, reconcileOfficeContextProbe, queryOfficeContextProbe } from './office-context-probe-control.mjs'
import { probeFolderPickerOverride } from './run-context-compaction-probe.mjs'

const sha = text => createHash('sha256').update(text).digest('hex')
function fixture() {
  mkdirSync('.e2e-tmp', { recursive: true })
  const root = mkdtempSync(resolve('.e2e-tmp/context-lifecycle-'))
  writeFileSync(join(root, 'commands.json'), '{"commands":[]}')
  const engine = { phase: 'ready', adopted: false, mode: 'embedded', baseUrl: 'http://mock.invalid', accountId: 'account', instanceId: 'engine', pid: 17, buildId: 'built' }
  const roles = Object.fromEntries(Array.from({ length: 6 }, (_, i) => ['role' + i, { sessionId: 'session' + i, agentId: 'agent' + i }]))
  const roots = new Map(Object.values(roles).map(role => [role.sessionId, [{ runId: 'root-' + role.sessionId, sessionId: role.sessionId, status: 'succeeded', finishedAt: 1, pending: [] }]]))
  const children = new Map(), jobs = new Map(), turns = new Map(), queues = new Map(), requests = [], effects = []
  const c = { state: { runRoot: root, profile: root, roles, commands: [], engine },
    app: { evaluate: async () => ({ profile: root, nativeQueue: false }) }, page: { evaluate: async () => structuredClone(engine) },
    workTasks: async () => [{ id: 'session0', active: true }],
    request: async (method, route, body, query) => {
      assert.equal(method, 'GET', 'Observation must not mutate the engine'); assert.equal(body, undefined)
      requests.push({ method, route, query })
      if (route === '/chat/status') { const run = roots.get(query.sessionId)?.at(-1); return { running: run?.status === 'running', run: run ? structuredClone(run) : null } }
      if (route === '/chat/runs') return { runs: structuredClone(roots.get(query.sessionId) || []) }
      if (route === '/chat/admission/context') return { protocolVersion: 1, sessionId: query.sessionId, tenantId: 'tenant', namespace: { id: 'namespace', generation: 'generation' } }
      if (route === '/subagent/runs') {
        assert.equal(query.view, 'summary')
        return { schemaVersion: 2, parentSessionId: query.parentSessionId, runs: structuredClone(children.get(query.parentSessionId) || []),
          hasMore: false, listComplete: true, revision: 'revision-' + query.parentSessionId }
      }
      if (route === '/command-jobs') return structuredClone(jobs.get(query.sessionId) || { jobs: [] })
      if (route.startsWith('/conversations/')) return structuredClone(turns.get(route.slice('/conversations/'.length)) || [])
      throw new Error('Unexpected mock route: ' + route)
    },
    submit: async () => effects.push('submit'), createAndStart: async () => effects.push('create'), selectTask: async () => effects.push('select'),
    stopMonitoring: () => effects.push('stop'), startMonitoring: () => effects.push('start'), save() {}, artifact() {}, log() {} }
  const reader = { sourceHashes: { fixture: 'mock' }, read: async scope => ({ state: structuredClone(queues.get(scope.taskId) || {
    schemaVersion: 1, scope, revision: 0, paused: false, entries: [], removed: [] }) }) }
  const writeProbe = probe => {
    mkdirSync(join(root, 'context-compaction-probe'), { recursive: true })
    writeFileSync(join(root, 'context-compaction-probe/state.json'), JSON.stringify({ schemaVersion: 1, records: [], ...probe }))
  }
  const options = () => ({ track: createProbeOperationTracker({}), readQueue: reader.read, expectedEngine: engine, commandFingerprint: probeCommandFingerprint(c) })
  const dependencies = runProbe => ({ createQueueReader: async () => reader, runProbe })
  const close = () => { assert.equal(dirname(root), resolve('.e2e-tmp')); assert.ok(basename(root).startsWith('context-lifecycle-')); rmSync(root, { recursive: true, force: true }) }
  return { c, root, engine, roots, children, jobs, turns, queues, requests, effects, reader, options, dependencies, writeProbe, close }
}
const child = (runId, parentSessionId, childSessionId, status = 'succeeded') => ({ schemaVersion: 2, view: 'summary', runId, parentSessionId, childSessionId, rootSessionId: 'session0', status, lastSeq: 1 })

test('complete recursive roots, shared historical child sessions, jobs and queues are observed twice without mutations', async () => {
  const h = fixture()
  try {
    h.children.set('session0', [child('child-1', 'session0', 'c1'), child('child-2', 'session0', 'c1')])
    h.children.set('c1', [child('child-3', 'c1', 'c2')])
    h.jobs.set('c2', { jobs: [{ jobId: 'deep-job', sessionId: 'c2', status: 'timed_out' }] })
    const proof = await observeOfficeProbeTerminal(h.c, h.options())
    assert.equal(proof.ready, true); assert.equal(proof.passes, 2); assert.equal(proof.children.length, 3); assert.equal(proof.jobs.length, 1)
    assert.equal(h.requests.filter(item => item.route === '/command-jobs' && item.query.sessionId === 'c2').length, 2)
    assert.ok(h.requests.every(item => item.method === 'GET')); assert.deepEqual(h.effects, [])
  } finally { h.close() }
})

for (const fault of [null, 'revision', 'cursor', 'duplicate', 'page-budget']) {
  test('summary-only child pagination ' + (fault ? 'rejects ' + fault : 'proves a complete multi-page list'), async () => {
    const h = fixture()
    try {
      const request = h.c.request
      h.c.request = (...args) => {
        if (args[1] !== '/subagent/runs' || args[3].parentSessionId !== 'session0') return request(...args)
        const query = args[3]; assert.equal(query.view, 'summary'); assert.equal(query.limit, 50)
        const second = Boolean(query.cursor)
        return { schemaVersion: 2, parentSessionId: 'session0', revision: second && fault === 'revision' ? 'changed' : 'stable',
          runs: [child(second && fault !== 'duplicate' ? 'b' : 'a', 'session0', second ? 'cb' : 'ca')],
          hasMore: !second || fault === 'cursor', listComplete: false,
          ...(!second || fault === 'cursor' ? { nextCursor: 'next' } : {}),
          ...(fault === 'page-budget' ? { extra: 'x'.repeat(600 * 1024) } : {}) }
      }
      if (fault) await assert.rejects(observeOfficeProbeTerminal(h.c, h.options()), /CHILD_PAGE/)
      else { const proof = await observeOfficeProbeTerminal(h.c, h.options()); assert.equal(proof.children.length, 2); assert.equal(proof.passes, 2) }
    } finally { h.close() }
  })
}

for (const fault of ['active-descendant', 'nested-job', 'unknown-job', 'paginated-jobs', 'oversized-jobs', 'unknown-root', 'queue-pending', 'queue-scope', 'new-office-root', 'changed-between-passes']) {
  test(fault + ' cannot produce a ready terminal proof', async () => {
    const h = fixture()
    try {
      const options = h.options()
      if (fault === 'active-descendant' || fault === 'nested-job') {
        h.children.set('session0', [child('c1-run', 'session0', 'c1')])
        h.children.set('c1', [child('c2-run', 'c1', 'c2', fault === 'active-descendant' ? 'running' : 'succeeded')])
        if (fault === 'nested-job') h.jobs.set('c2', { jobs: [{ jobId: 'j', sessionId: 'c2', status: 'running' }] })
      }
      if (fault === 'unknown-job') h.jobs.set('session0', { jobs: [{ jobId: 'j', sessionId: 'session0', status: 'unrecognized' }] })
      if (fault === 'paginated-jobs') h.jobs.set('session0', { jobs: [], hasMore: true })
      if (fault === 'oversized-jobs') h.jobs.set('session0', { jobs: Array.from({ length: 2049 }, (_, i) => ({ jobId: 'j' + i, sessionId: 'session0', status: 'succeeded' })) })
      if (fault === 'unknown-root') h.roots.get('session0')[0].status = 'unrecognized'
      if (fault.startsWith('queue-')) options.readQueue = async scope => ({ state: { schemaVersion: 1, scope: fault === 'queue-scope' ? { ...scope, taskId: 'other' } : scope,
        revision: 0, paused: false, entries: fault === 'queue-pending' ? [{ id: 'queued', phase: 'pending' }] : [] } })
      if (fault === 'new-office-root') options.expectedOfficeRuns = Object.fromEntries([...h.roots].map(([key]) => [key, 'old-' + key]))
      if (fault === 'changed-between-passes') {
        const original = h.c.request; let count = 0
        h.c.request = (...args) => { if (args[1] === '/chat/status' && args[3].sessionId === 'session0' && ++count === 2) h.roots.get('session0')[0].finishedAt = 2; return original(...args) }
      }
      await assert.rejects(observeOfficeProbeTerminal(h.c, options))
    } finally { h.close() }
  })
}

test('a timed-out read keeps the lease through late settlement and only explicit reconciliation releases it', async () => {
  const h = fixture()
  try {
    const request = h.c.request; let complete, delayed = true
    h.c.request = (...args) => args[1] === '/chat/status' && delayed ? new Promise(resolve => { complete = () => resolve(request(...args)); delayed = false }) : request(...args)
    let dispatches = 0
    const ack = await startOfficeContextProbe(h.c, { expectedRoot: h.root }, { ...h.dependencies(async () => { dispatches++ }),
      observationLimits: { ...PROBE_OBSERVATION_LIMITS, readMs: 30, totalMs: 5000 } })
    assert.equal(ack.phase, 'preflighting')
    const slot = h.c.contextProbePromise, result = await slot
    assert.equal(result.maintenanceLeaseHeld, true); assert.equal(dispatches, 0)
    assert.equal(queryOfficeContextProbe(h.c).pendingOperations, 1)
    await assert.rejects(reconcileOfficeContextProbe(h.c), /Pending operations/)
    complete(); await nextTurn()
    assert.equal(queryOfficeContextProbe(h.c).pendingOperations, 0); assert.equal(h.c.contextProbePromise, slot)
    assert.equal(queryOfficeContextProbe(h.c).leaseActive, true)
    const reconciled = await reconcileOfficeContextProbe(h.c)
    assert.equal(reconciled.released, true); assert.equal(h.c.contextProbePromise, null); assert.equal(dispatches, 0)
  } finally { h.close() }
})

test('unknown dispatch stays held until read-only exact-prompt admission reconciliation; state is never rewritten or resent', async () => {
  const h = fixture()
  try {
    const prompt = 'unique immutable test prompt'
    const probe = { sessionId: 'probe', records: [{ id: 'CP-1', phase: 'dispatching', dispatchAttemptedAt: '2026-10-24T00:00:00Z', beforeRunIds: [], promptSha256: sha(prompt) }] }
    await startOfficeContextProbe(h.c, { expectedRoot: h.root }, h.dependencies(async () => {
      h.writeProbe(probe); return { completed: false, passed: false }
    }))
    await h.c.contextProbePromise
    const before = readFileSync(join(h.root, 'context-compaction-probe/state.json'))
    await assert.rejects(reconcileOfficeContextProbe(h.c), /PROBE_ADMISSION_UNKNOWN_OR_AMBIGUOUS/)
    await assert.rejects(startOfficeContextProbe(h.c, { expectedRoot: h.root }), /running or held/)
    h.roots.set('probe', [{ runId: 'probe-run', sessionId: 'probe', turnId: 'probe-turn', userMessageId: 'u', status: 'failed', finishedAt: 2, pending: [] }])
    h.turns.set('probe-turn', [{ id: 'u', role: 'user', content: 'wrong prompt' }])
    await assert.rejects(reconcileOfficeContextProbe(h.c), /PROBE_ADMISSION_PROMPT_MISMATCH/)
    h.turns.set('probe-turn', [{ id: 'u', role: 'user', content: prompt }])
    const proof = await reconcileOfficeContextProbe(h.c)
    assert.equal(proof.released, true); assert.equal(proof.proof.admissions[0].runId, 'probe-run')
    assert.deepEqual(readFileSync(join(h.root, 'context-compaction-probe/state.json')), before)
    assert.ok(h.requests.every(item => item.method === 'GET')); assert.ok(!h.effects.includes('submit'))
  } finally { h.close() }
})

test('a root that finishes while a child is active cannot release the slot or restore selection', async () => {
  const h = fixture()
  try {
    let cleanupRejected = false
    await startOfficeContextProbe(h.c, { expectedRoot: h.root }, h.dependencies(async input => {
      const probe = { sessionId: 'probe', records: [] }; h.writeProbe(probe)
      h.roots.set('probe', [{ runId: 'probe-run', sessionId: 'probe', status: 'succeeded', finishedAt: 2, pending: [] }])
      h.children.set('probe', [{ ...child('probe-child', 'probe', 'pc', 'running'), rootSessionId: 'probe' }])
      await assert.rejects(input.options.beforeSelectionRestore({ schemaVersion: 1, ...probe }), /CHILD_NONTERMINAL/); cleanupRejected = true
      return { completed: true, passed: false }
    }))
    const result = await h.c.contextProbePromise
    assert.equal(cleanupRejected, true); assert.equal(result.maintenanceLeaseHeld, true)
    await assert.rejects(reconcileOfficeContextProbe(h.c), /CHILD_NONTERMINAL/)
    h.children.get('probe')[0].status = 'cancelled'
    assert.equal((await reconcileOfficeContextProbe(h.c)).released, true)
  } finally { h.close() }
})

test('production requestConfig Agent identity is checked for default-assistant isolation', () => {
  assert.doesNotThrow(() => assertProbeDefaultAssistant({ requestConfig: {} }))
  assert.throws(() => assertProbeDefaultAssistant({ requestConfig: { agentId: 'office-role' } }), /default assistant/)
})

test('concurrent reconciliation is rejected and controller queries perform no additional reads', async () => {
  const h = fixture()
  try {
    await startOfficeContextProbe(h.c, { expectedRoot: h.root }, h.dependencies(async () => { h.writeProbe({ sessionId: null }); return { completed: false, passed: false } }))
    await h.c.contextProbePromise
    const original = h.c.request; let releaseRead, started, delay = true
    const reading = new Promise(resolve => { started = resolve })
    h.c.request = (...args) => {
      if (delay && args[1] === '/chat/status') {
        delay = false; started(); return new Promise(resolve => { releaseRead = () => resolve(original(...args)) })
      }
      return original(...args)
    }
    const first = reconcileOfficeContextProbe(h.c); await reading
    await assert.rejects(reconcileOfficeContextProbe(h.c), /already observing/)
    const count = h.requests.length
    assert.equal(queryOfficeContextProbe(h.c).reconciliationActive, true)
    assert.equal(queryOfficeContextProbe(h.c).pendingOperations, 1); assert.equal(h.requests.length, count)
    releaseRead(); assert.equal((await first).released, true)
    assert.equal(queryOfficeContextProbe(h.c).reconciliationActive, false)
  } finally { h.close() }
})

test('a persistence failure at release keeps the admission guard until another explicit reconciliation', async () => {
  const h = fixture()
  try {
    await startOfficeContextProbe(h.c, { expectedRoot: h.root }, h.dependencies(async () => { h.writeProbe({ sessionId: null }); return { completed: false, passed: false } }))
    await h.c.contextProbePromise
    h.c.save = () => { if (h.c.state.contextCompactionProbeControl.releaseProofAt) throw new Error('synthetic persist failure') }
    await assert.rejects(reconcileOfficeContextProbe(h.c), /persist failure/)
    assert.equal(queryOfficeContextProbe(h.c).leaseActive, true); assert.ok(h.c.contextProbePromise)
    await assert.rejects(h.c.submit(), /owns the Work UI/)
    h.c.save = () => {}
    assert.equal((await reconcileOfficeContextProbe(h.c)).released, true)
  } finally { h.close() }
})

test('a monitor restart error is reported without falsely retaining an already released lease', async () => {
  const h = fixture()
  try {
    await startOfficeContextProbe(h.c, { expectedRoot: h.root }, h.dependencies(async () => { h.writeProbe({ sessionId: null }); return { completed: false, passed: false } }))
    await h.c.contextProbePromise
    h.c.startMonitoring = () => { throw new Error('synthetic monitor failure') }
    assert.equal((await reconcileOfficeContextProbe(h.c)).released, true)
    assert.equal(queryOfficeContextProbe(h.c).leaseActive, false)
    assert.equal(queryOfficeContextProbe(h.c).leaseHeldForReview, false)
    assert.match(queryOfficeContextProbe(h.c).monitoringError, /synthetic monitor failure/)
    await h.c.submit(); assert.ok(h.effects.includes('submit'))
  } finally { h.close() }
})

test('folder picker override restores if the folder click fails before the one-shot callback', async () => {
  const original = async () => ({ canceled: true }), dialog = { showOpenDialog: original }
  const app = { evaluate: async (fn, arg) => fn({ dialog }, arg) }
  const picker = probeFolderPickerOverride(app, 'D:/synthetic')
  try { await picker.install(); assert.notEqual(dialog.showOpenDialog, original) }
  finally { await picker.restore() }
  assert.equal(dialog.showOpenDialog, original)
  await picker.install(); assert.deepEqual(await dialog.showOpenDialog(), { canceled: false, filePaths: ['D:/synthetic'] })
  await picker.restore(); assert.equal(dialog.showOpenDialog, original)
})
