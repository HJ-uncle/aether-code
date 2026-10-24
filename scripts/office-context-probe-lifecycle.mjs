// Bounded observations only. Queue reads use the shared read-only journal adapter,
// never owner IPC: an owner read may bind/recover and dispatch queued work.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const rootTerminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted'])
const childTerminal = new Set([...rootTerminal, 'blocked'])
const jobTerminal = new Set([...rootTerminal, 'timed_out'])
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const hash = value => createHash('sha256').update(value).digest('hex')
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const textOf = row => typeof row?.content === 'string' ? row.content : JSON.stringify(row?.content ?? '')
export const PROBE_OBSERVATION_LIMITS = Object.freeze({ sessions: 128, children: 256, jobs: 2048, roots: 2048,
  queueEntries: 2048, jobBytes: 1024 * 1024, totalMs: 120000, readMs: 10000 })

export function probeCommandFingerprint(c) {
  const file = join(c.state.runRoot, 'commands.json'), info = statSync(file)
  assert.ok(info.isFile() && info.size <= 1024 * 1024, 'RUNNER_COMMAND_FILE_BUDGET')
  const bytes = readFileSync(file), queue = JSON.parse(bytes)
  assert.equal(bytes.length, info.size, 'RUNNER_COMMAND_FILE_CHANGED')
  assert.ok(Array.isArray(queue.commands) && queue.commands.length <= 2048 && Array.isArray(c.state.commands), 'RUNNER_COMMAND_SCHEMA')
  const records = new Map(c.state.commands.map(item => [item.id, item]))
  assert.equal(records.size, c.state.commands.length, 'DUPLICATE_RUNNER_HISTORY')
  assert.equal(new Set(queue.commands.map(item => item.id)).size, queue.commands.length, 'DUPLICATE_RUNNER_COMMAND')
  assert.ok(c.state.commands.every(item => id(item.id) && ['completed', 'failed'].includes(item.status)), 'RUNNER_COMMAND_NOT_TERMINAL')
  assert.ok(queue.commands.every(item => id(item.id) && ['completed', 'failed'].includes(records.get(item.id)?.status)), 'RUNNER_COMMAND_QUEUE_NOT_DRAINED')
  return { sha256: hash(bytes), history: c.state.commands.map(item => ({ id: item.id, status: item.status })) }
}

export function createProbeOperationTracker(control, { readMs = PROBE_OBSERVATION_LIMITS.readMs, onLateSettlement = () => {} } = {}) {
  const pending = new Map(); let number = 0
  const update = () => { control.pendingOperations = pending.size; control.pendingOperationDetails = [...pending.values()] }
  return {
    async run(label, operation, timeout = readMs) {
      const operationId = ++number
      pending.set(operationId, { id: operationId, label, startedAt: new Date().toISOString() }); update()
      const work = Promise.resolve().then(operation)
      const settled = () => { pending.delete(operationId); update(); if (control.leaseHeldForReview) onLateSettlement() }
      work.then(settled, settled)
      let timer
      try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PROBE_OPERATION_TIMEOUT: ' + label)), timeout) })]) }
      finally { clearTimeout(timer) }
    },
    get pending() { return pending.size },
  }
}

export function assertProbeDefaultAssistant(run) {
  assert.ok(!run.agentId && !run.requestConfig?.agentId && !run.requestConfig?.effectiveAgentId &&
    !run.snapshot?.agentId && !run.snapshot?.effectiveAgentId, 'The probe must use the default assistant, not an office role')
}

export async function observeOfficeProbeTerminal(c, { track, readQueue, expectedEngine, commandFingerprint, probe,
  expectedOfficeRuns, limits = PROBE_OBSERVATION_LIMITS } = {}) {
  assert.equal(typeof readQueue, 'function', 'STRICT_READONLY_QUEUE_READER_REQUIRED')
  const deadline = Date.now() + limits.totalMs
  const check = () => {
    assert.ok(Date.now() < deadline, 'PROBE_TERMINAL_OBSERVATION_DEADLINE')
    assert.deepEqual(probeCommandFingerprint(c), commandFingerprint, 'OFFICE_COMMANDS_CHANGED_DURING_PROBE')
  }
  const call = (label, operation) => { check(); return track.run(label, operation, Math.max(1, Math.min(limits.readMs, deadline - Date.now()))) }
  const get = (route, query) => call(route, () => c.request('GET', route, undefined, query))
  const engine = async () => {
    const value = await call('engine identity', () => c.page.evaluate(() => window.aether.engine.getSnapshot()))
    assert.equal(value.phase, 'ready'); assert.equal(value.adopted, false)
    for (const key of ['mode', 'baseUrl', 'accountId', 'instanceId', 'pid', 'buildId']) assert.equal(value[key], expectedEngine[key], 'PROBE_ENGINE_CHANGED')
    return value
  }
  const office = Object.values(c.state.roles).map(role => role.sessionId)
  assert.equal(office.length, 6); assert.equal(new Set(office).size, 6); assert.ok(office.every(id))
  const owners = [...office]
  if (probe) assert.ok(probe.schemaVersion === 1 && Array.isArray(probe.records) && probe.records.length <= 131, 'PROBE_STATE_SCHEMA_OR_BUDGET')
  if (probe?.sessionId) { assert.ok(id(probe.sessionId) && !owners.includes(probe.sessionId), 'PROBE_SESSION_REUSES_OFFICE'); owners.push(probe.sessionId) }
  assert.ok(!probe?.records?.some(record => record.dispatchAttemptedAt && !probe.sessionId), 'PROBE_ADMISSION_WITHOUT_SESSION')

  async function pass() {
    await engine()
    const result = { roots: [], children: [], childLists: [], jobs: [], queues: [], admissions: [], officeRuns: {} }
    const sessions = new Set(), children = new Set(), jobs = new Set(), roots = new Set(), parents = new Map()
    const listChildren = async sessionId => {
      let cursor, revision
      const seen = new Set(), found = []
      for (let pageNumber = 0; pageNumber <= limits.children; pageNumber++) {
        const page = await get('/subagent/runs', { parentSessionId: sessionId, view: 'summary', limit: 50, ...(cursor ? { cursor } : {}) })
        assert.ok(page.schemaVersion === 2 && page.parentSessionId === sessionId && Array.isArray(page.runs) &&
          typeof page.hasMore === 'boolean' && typeof page.listComplete === 'boolean' && id(page.revision), 'CHILD_PAGE_UNKNOWN')
        assert.ok(page.runs.length <= 50 && Buffer.byteLength(canonical(page)) <= 600 * 1024, 'CHILD_PAGE_BUDGET')
        assert.equal(page.listComplete, !page.hasMore && !cursor, 'CHILD_PAGE_COMPLETENESS_CONFLICT')
        if (revision === undefined) revision = page.revision
        else assert.equal(page.revision, revision, 'CHILD_PAGE_REVISION_CHANGED')
        assert.ok(found.length + page.runs.length + children.size <= limits.children, 'CHILD_LIST_BUDGET')
        for (const child of page.runs) {
          assert.ok(child.schemaVersion === 2 && child.view === 'summary' && id(child.runId) && !seen.has(child.runId), 'CHILD_PAGE_IDENTITY_CONFLICT')
          seen.add(child.runId)
          found.push({ runId: child.runId, childSessionId: child.childSessionId, parentSessionId: child.parentSessionId,
            rootSessionId: child.rootSessionId, status: child.status, lastSeq: child.lastSeq })
        }
        if (!page.hasMore) {
          assert.equal(page.nextCursor, undefined, 'CHILD_PAGE_UNEXPECTED_CURSOR')
          result.childLists.push({ sessionId, revision, count: found.length }); return found
        }
        assert.ok(page.runs.length > 0 && typeof page.nextCursor === 'string' && page.nextCursor.length > 0 &&
          page.nextCursor.length <= 4096 && !seen.has('cursor:' + page.nextCursor), 'CHILD_PAGE_CURSOR_CONFLICT')
        cursor = page.nextCursor; seen.add('cursor:' + cursor)
      }
      throw new Error('CHILD_PAGE_COUNT_BUDGET')
    }
    for (const owner of owners) {
      const status = await get('/chat/status', { sessionId: owner })
      assert.equal(status.running, false, 'ROOT_STILL_RUNNING')
      const runList = await get('/chat/runs', { sessionId: owner })
      assert.ok(Array.isArray(runList.runs) && !runList.hasMore && runList.nextCursor == null && runList.pagination == null, 'ROOT_LIST_INCOMPLETE')
      assert.ok(runList.runs.length + roots.size <= limits.roots, 'ROOT_LIST_BUDGET')
      for (const run of runList.runs) {
        assert.ok(id(run.runId) && !roots.has(run.runId) && run.sessionId === owner && rootTerminal.has(run.status), 'ROOT_NONTERMINAL_OR_UNKNOWN')
        assert.ok(Number.isFinite(run.finishedAt) && run.finishedAt > 0, 'ROOT_FINISH_UNKNOWN')
        roots.add(run.runId); result.roots.push({ sessionId: owner, runId: run.runId, status: run.status, finishedAt: run.finishedAt })
      }
      if (status.run) {
        assert.ok(status.run.sessionId === owner && rootTerminal.has(status.run.status) && runList.runs.some(run => run.runId === status.run.runId && run.status === status.run.status), 'LATEST_ROOT_NOT_IN_TERMINAL_LIST')
        assert.ok(Array.isArray(status.run.pending) && status.run.pending.length === 0, 'ROOT_PENDING_INTERACTION')
      } else assert.ok(owner === probe?.sessionId && runList.runs.length === 0, 'OFFICE_ROOT_MISSING')
      if (office.includes(owner)) {
        result.officeRuns[owner] = status.run.runId
        if (expectedOfficeRuns) assert.equal(status.run.runId, expectedOfficeRuns[owner], 'NEW_OFFICE_ROOT_DURING_PROBE')
      }
      const admission = await get('/chat/admission/context', { sessionId: owner })
      assert.ok(admission.protocolVersion === 1 && admission.sessionId === owner && id(admission.tenantId) &&
        id(admission.namespace?.id) && id(admission.namespace?.generation), 'ADMISSION_SCOPE_UNKNOWN')
      if (status.run?.serverAdmissionReceipt) {
        assert.equal(status.run.serverAdmissionReceipt.tenantId, admission.tenantId)
        assert.deepEqual(status.run.serverAdmissionReceipt.namespace, admission.namespace)
      }
      const scope = { source: { mode: expectedEngine.mode, endpoint: expectedEngine.mode === 'embedded' ? '' : new URL(expectedEngine.baseUrl).href.replace(/\/+$/, ''),
        accountId: expectedEngine.accountId ?? null }, tenantId: admission.tenantId, namespace: admission.namespace, owner: 'work', taskId: owner }
      const queue = await call('readonly Work queue', () => readQueue(scope))
      const state = queue.state
      assert.deepEqual(state.scope, scope, 'WORK_QUEUE_SCOPE_CHANGED')
      assert.ok(state.schemaVersion === 1 && Number.isSafeInteger(state.revision) && typeof state.paused === 'boolean' && Array.isArray(state.entries), 'WORK_QUEUE_SCHEMA_UNKNOWN')
      assert.ok(state.entries.every(entry => id(entry.id) && entry.phase === 'terminal' && rootTerminal.has(entry.outcome)), 'WORK_QUEUE_PENDING_OR_UNKNOWN')
      assert.ok(state.entries.length <= limits.queueEntries && new Set(state.entries.map(entry => entry.id)).size === state.entries.length, 'WORK_QUEUE_ENTRY_BUDGET_OR_DUPLICATE')
      result.queues.push({ taskId: owner, stateSha256: hash(canonical(state)), revision: state.revision, count: state.entries.length })
      const pending = [owner], local = new Set()
      for (let i = 0; i < pending.length; i++) {
        const sessionId = pending[i]
        if (local.has(sessionId)) continue
        assert.ok(!sessions.has(sessionId) && sessions.size < limits.sessions, 'SESSION_SHARED_OR_BUDGET')
        sessions.add(sessionId); local.add(sessionId)
        const descendants = await listChildren(sessionId)
        for (const child of descendants) {
          assert.ok(id(child.runId) && id(child.childSessionId) && childTerminal.has(child.status) && !children.has(child.runId), 'CHILD_NONTERMINAL_UNKNOWN_OR_DUPLICATE')
          assert.equal(child.parentSessionId, sessionId); assert.equal(child.rootSessionId, owner)
          assert.ok(child.childSessionId !== sessionId && !owners.includes(child.childSessionId), 'CHILD_CYCLE_OR_ROOT_REUSE')
          assert.ok(!parents.has(child.childSessionId) || parents.get(child.childSessionId) === sessionId, 'CHILD_MULTIPLE_PARENTS')
          parents.set(child.childSessionId, sessionId); children.add(child.runId); pending.push(child.childSessionId)
          result.children.push({ runId: child.runId, sessionId: child.childSessionId, parentSessionId: sessionId, status: child.status, lastSeq: child.lastSeq ?? null })
        }
        const retained = await get('/command-jobs', { sessionId })
        assert.ok(Array.isArray(retained.jobs) && !retained.hasMore && retained.nextCursor == null && retained.pagination == null, 'JOBS_LIST_INCOMPLETE')
        assert.ok(retained.jobs.length + jobs.size <= limits.jobs, 'RETAINED_JOB_BUDGET')
        for (const job of retained.jobs) {
          assert.ok(id(job.jobId) && job.sessionId === sessionId && jobTerminal.has(job.status) && !jobs.has(job.jobId), 'JOB_NONTERMINAL_UNKNOWN_OR_DUPLICATE')
          jobs.add(job.jobId); result.jobs.push({ jobId: job.jobId, sessionId, status: job.status, runId: job.runId ?? null })
        }
        assert.ok(Buffer.byteLength(canonical(result.jobs)) <= limits.jobBytes, 'JOB_EVIDENCE_BYTE_BUDGET')
      }
      if (owner === probe?.sessionId) for (const record of probe.records || []) {
        if (record.phase === 'terminal') continue
        if (!record.dispatchAttemptedAt) { assert.ok(!record.runId, 'PROBE_UNDISPATCHED_RUN_CONFLICT'); result.admissions.push({ recordId: record.id, state: 'not-dispatched' }); continue }
        let run = record.runId ? runList.runs.find(run => run.runId === record.runId) : null
        if (!run && !record.runId) {
          assert.ok(Array.isArray(record.beforeRunIds), 'PROBE_ADMISSION_BASELINE_UNKNOWN')
          const candidates = runList.runs.filter(run => !record.beforeRunIds.includes(run.runId))
          assert.equal(candidates.length, 1, 'PROBE_ADMISSION_UNKNOWN_OR_AMBIGUOUS')
          const rows = []; let complete = false
          for (let current = 1; current <= 20; current++) {
            const page = await get('/conversations/' + encodeURIComponent(candidates[0].turnId), { current, pageSize: 100 })
            const items = Array.isArray(page) ? page : page?.items
            assert.ok(Array.isArray(items), 'PROBE_TURN_HISTORY_UNKNOWN'); rows.push(...items)
            if (items.length < 100) { complete = true; break }
          }
          assert.ok(complete, 'PROBE_TURN_HISTORY_INCOMPLETE')
          const user = rows.find(row => row.role === 'user' && row.id === candidates[0].userMessageId)
          assert.ok(user && hash(textOf(user)) === record.promptSha256, 'PROBE_ADMISSION_PROMPT_MISMATCH')
          run = candidates[0]
        }
        assert.ok(run && rootTerminal.has(run.status), 'PROBE_ADMISSION_NOT_TERMINAL')
        result.admissions.push({ recordId: record.id, runId: run.runId, status: run.status })
      }
    }
    for (const key of ['roots', 'children', 'childLists', 'jobs', 'queues', 'admissions']) result[key].sort((a, b) => canonical(a).localeCompare(canonical(b)))
    await engine(); check(); assert.equal(track.pending, 0, 'PENDING_READS_AFTER_TERMINAL_OBSERVATION')
    return result
  }
  const first = await pass(), second = await pass()
  assert.deepEqual(second, first, 'TERMINAL_OBSERVATIONS_DIFFER')
  return { ready: true, at: new Date().toISOString(), stateSha256: hash(canonical(second)), passes: 2, ...second,
    semantics: 'GET requests and filesystem reads only; no queue bind, recover, dispatch, cancel, retry, or history mutation.' }
}
