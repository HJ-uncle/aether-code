/** Existing append campaign only. Never launches, resends, releases a window,
 * resets attempted flags or modifies original failure evidence.
 * audit=read-only; ui=explicit existing-session navigation/popover/reload;
 * stop=explicit independent new stop probe (one reserved UI submission).
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const digest = value => createHash('sha256').update(value).digest('hex')
const nap = ms => new Promise(done => setTimeout(done, ms))
const done = value => !value?.running && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(value?.run?.status)
const engineOf = value => Object.fromEntries(['mode', 'baseUrl', 'instanceId', 'accountId'].map(key => [key, value[key]]))

export async function auditAppendRecovery(context, input = {}) {
  const mode = input.mode || 'work', stage = input.stage || 'audit'
  assert.ok(['work', 'code'].includes(mode)); assert.ok(['audit', 'ui', 'stop'].includes(stage))
  const { page, state, signal } = context
  assert.ok(page && state?.profile && state?.evidence, 'EXISTING_CONTROLLER_REQUIRED')
  const url = new URL('./append-mode-acceptance.mjs', import.meta.url)
  url.searchParams.set('source', digest(readFileSync(new URL('./append-mode-acceptance.mjs', import.meta.url))))
  const helpers = await import(url.href)
  const role = mode === 'work' ? 'product' : 'development', bound = state.roles[role]
  const owner = { mode, sessionId: bound.sessionId, engine: engineOf(state.engine), modelId: state.modelId, modelRecordId: state.modelRecordId, workspace: state.workspace }
  assert.ok(owner.sessionId, 'EXISTING_SESSION_REQUIRED')
  const folder = join(state.workspace, 'append-validation'), evidence = join(state.evidence, 'append-validation')
  const output = join(state.evidence, 'append-recovery'); mkdirSync(output, { recursive: true })
  const token = new Date().toISOString().replace(/[:.]/g, '-') + '-' + mode + '-' + stage
  const persist = (name, value) => { const path = join(output, token + '-' + name + '.json'); writeFileSync(path, JSON.stringify(value, null, 2), { flag: 'wx' }); return path }
  const check = () => signal?.throwIfAborted()
  const wait = async (name, read, timeout = 180000) => {
    const start = Date.now()
    while (Date.now() - start < timeout) { check(); const value = await read(); if (value) return value; await nap(300) }
    throw new Error('RECOVERY_WAIT_TIMEOUT:' + name + '; no resend or automatic cancel')
  }
  const request = async value => { check(); return page.evaluate(input => window.aether.engine.request(input), value) }
  const read = async (path, query = {}) => {
    const response = await request({ method: 'GET', path, query, expectedEngine: owner.engine, toolProfile: mode === 'code' ? 'code' : 'general' })
    assert.ok(response.ok, 'RECOVERY_READ_FAILED:' + path + ':' + JSON.stringify(response)); return response
  }
  const status = async () => (await read('/chat/status', { sessionId: owner.sessionId })).data
  const dbRead = () => {
    const db = new DatabaseSync(join(state.profile, 'engine', 'state', 'agent.db'), { readOnly: true })
    try {
      db.exec('PRAGMA query_only=ON'); db.exec('BEGIN')
      return { roots: db.prepare('SELECT session_id,run_id,turn_id,state FROM root_runs WHERE session_id=? ORDER BY rowid').all(owner.sessionId),
        deliveries: db.prepare('SELECT * FROM collaboration_jsonl_deliveries WHERE history_session_id=?').all(owner.sessionId),
        origins: db.prepare('SELECT * FROM collaboration_controller_origins WHERE root_session_id=?').all(owner.sessionId),
        authorities: db.prepare('SELECT * FROM collaboration_controller_roots WHERE root_session_id=?').all(owner.sessionId) }
    } finally { db.close() }
  }
  const records = () => page.evaluate(() => [...JSON.parse(localStorage.getItem('aether.collaboration-controller-outbox.v1') || '[]'), ...JSON.parse(localStorage.getItem('aether.collaboration-controller-results.v1') || '[]')])
  const plan = JSON.parse(readFileSync(join(evidence, mode + '-plan.json'), 'utf8'))
  const accepted = JSON.parse(readFileSync(join(evidence, mode + '-accepted.json'), 'utf8'))
  const sourceOutcomes = JSON.parse(readFileSync(join(evidence, 'outcomes.json'), 'utf8'))
  const sourceHash = digest(readFileSync(join(evidence, 'outcomes.json')))
  assert.equal(accepted.length, 5); helpers.assertFiveCurrent(accepted)
  accepted.forEach(item => { assert.equal(item.pending.rootSessionId, owner.sessionId); helpers.assertEngine(item.pending.expectedEngine, owner.engine) })
  const initialRunId = accepted[0].pending.rootRunId
  const report = { schemaVersion: 1, mode, stage, at: Date.now(), sessionId: owner.sessionId, initialRunId,
    originalOutcome: sourceOutcomes[mode], originalOutcomeSha256: sourceHash, reads: [], checks: [], modelSubmissions: 0, limitations: [] }
  const recordCheck = async (name, action) => {
    try { const value = await action(); report.checks.push({ name, passed: true }); return value }
    catch (error) { report.checks.push({ name, passed: false, error: String(error.stack || error) }); throw error }
  }
  try {
    helpers.assertEngine(await page.evaluate(() => window.aether.engine.getSnapshot()), owner.engine)
    assert.equal(digest(readFileSync(join(folder, 'probe.mjs'))), digest(helpers.probeSource), 'PROBE_CHANGED')
    await wait('existing roots settle', async () => done(await status()))
    const db = dbRead(), first = JSON.parse(db.roots.find(row => row.run_id === initialRunId)?.state || 'null')
    assert.ok(first && first.status === 'succeeded', 'EXISTING_INITIAL_RUN_NOT_SUCCEEDED')
    const nextCandidates = db.roots.filter(row => row.run_id !== first.runId).map(row => JSON.parse(row.state))
    const next = nextCandidates.find(row => row.status === 'succeeded')
    assert.ok(next, 'EXISTING_NEXT_RUN_MISSING')
    assert.equal(first.attemptId, accepted[0].pending.rootAttemptId)
    const archive = await helpers.readCompleteArchive(read, owner.sessionId); persist('archive', archive); persist('db', db)
    await recordCheck('five-integrated-and-exact-public-content', async () => {
      for (const item of accepted) {
        const delivery = helpers.assertIntegrated({ ...item, deliveries: db.deliveries, history: archive.rows, firstRun: first })
        const observed = await helpers.queryOriginalReceipt(request, item.pending, owner.engine, mode)
        report.reads.push({ requestKey: item.pending.requestKey, ...observed })
        assert.equal(observed.outcome, 'accepted'); helpers.assertDeliveredReceipt(observed.receipt, item.pending, delivery)
        helpers.assertControllerProvenance({ pending: item.pending, receipt: observed.receipt, origin: db.origins.find(row => row.message_id === observed.receipt.messageId),
          authority: db.authorities.find(row => row.root_run_id === first.runId && row.root_attempt_id === first.attemptId) })
      }
    })
    await recordCheck('independent-next-turn-admission', async () => helpers.assertNextTurn({ history: archive.rows, firstRun: first, nextRun: next, message: plan.next,
      roots: db.roots.filter(row => row.run_id === first.runId || row.run_id === next.runId) }))
    const journal = readFileSync(join(folder, mode + '.jsonl'), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
    await recordCheck('model-tool-calls-and-ordered-file-effects', async () => {
      assert.deepEqual(journal.filter(row => row.event === 'mark').map(row => row.label), ['current-1', 'current-2', 'current-3', 'current-4', 'current-5', 'original-complete', 'next'])
      const calls = archive.rows.filter(row => row.toolCall?.name === 'execute_cmd' && basename(String(row.toolCall.args?.args?.[0]).replaceAll('\\', '/')) === 'probe.mjs')
      const appendCalls = calls.filter(row => (row.metadata?.turnId || row.conversationId) === first.turnId || (row.metadata?.turnId || row.conversationId) === next.turnId)
      assert.equal(appendCalls.length, 8)
      for (const label of ['current-1', 'current-2', 'current-3', 'current-4', 'current-5', 'original-complete', 'next']) {
        const matches = appendCalls.filter(row => JSON.stringify(row.toolCall.args.args.slice(1)) === JSON.stringify(['mark', mode, label]))
        assert.equal(matches.length, 1); assert.equal(matches[0].metadata?.turnId || matches[0].conversationId, label === 'next' ? next.turnId : first.turnId)
      }
    })
    if (mode === 'work') {
      const input = { taskId: owner.sessionId, expectedEngine: owner.engine, action: { kind: 'read' } }
      const response = await page.evaluate(value => window.aether.workQueue.invoke(value), input)
      report.queueRead = { input, response }; persist('queue-read', report.queueRead)
      // Preserve the original bootstrap race even when a later read succeeds.
      const root = join(state.profile, 'next-turn-queue-v1')
      report.queueErrors = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(row => row.isDirectory()).flatMap(dir => readdirSync(join(root, dir.name)).filter(name => /^error-.*\.json$/.test(name))
        .map(name => ({ path: join(root, dir.name, name), ...JSON.parse(readFileSync(join(root, dir.name, name), 'utf8')) }))) : []
      await recordCheck('persisted-next-queue-terminal', async () => {
        assert.equal(response.ok, true, JSON.stringify(response))
        const matches = response.value.state.entries.filter(row => row.envelope.draft.text === plan.next)
        assert.equal(matches.length, 1); assert.equal(matches[0].phase, 'terminal'); assert.equal(matches[0].receipt.runId, next.runId)
      })
    } else report.limitations.push('Code queue is memory-only; already-consumed messages are proven by history/root/tool evidence. This audit does not assert crash persistence.')
    const saved = (await records()).filter(row => accepted.some(item => item.pending.requestKey === row.requestKey))
    persist('renderer-records', saved)
    await recordCheck('automatic-delivery-refresh', async () => {
      assert.equal(saved.length, 5); assert.ok(saved.every(row => row.kind === 'accepted' && row.receipt.delivery?.state === 'integrated'))
    })
    report.initial = first; report.next = next; report.journal = journal
    if (stage === 'ui') {
      await helpers.selectExactSession(page, owner); await helpers.assertActiveOwner(page, owner)
      report.popover = await recordCheck('existing-popover-and-mode-navigation', () => helpers.auditFollowupPopover(page, owner, plan.current))
      report.publicUi = await recordCheck('public-user-bubbles-and-navigation', () => helpers.auditPublicMessages(page, owner, archive.rows))
      await page.reload(); await wait('engine ready after explicit reload', async () => (await page.evaluate(() => window.aether.engine.getSnapshot())).phase === 'ready', 90000)
      await helpers.selectExactSession(page, owner); await helpers.assertActiveOwner(page, owner)
      const reloaded = await helpers.readCompleteArchive(read, owner.sessionId)
      await recordCheck('complete-history-survives-reload', async () => assert.deepEqual(reloaded.rows.map(row => [row.id, row.role, row.content]), archive.rows.map(row => [row.id, row.role, row.content])))
      report.reloadedUi = await helpers.auditPublicMessages(page, owner, reloaded.rows)
      if (context.screenshot) report.screenshot = await context.screenshot({ name: 'append-recovery-' + mode + '-ui' })
    }
    if (stage === 'stop') {
      assert.equal(db.roots.length, 2, 'STOP_PROBE_REQUIRES_ONLY_EXISTING_TWO_RUNS')
      assert.ok(!existsSync(join(folder, mode + '-stop-started.json')), 'STOP_ALREADY_STARTED')
      await helpers.selectExactSession(page, owner); await helpers.assertActiveOwner(page, owner)
      const surface = page.locator('#mode-' + mode), editor = surface.locator('.input-composer__input[role="textbox"]').filter({ visible: true })
      assert.equal(await editor.count(), 1)
      writeFileSync(join(evidence, mode + '-stop-submit-reservation.json'), JSON.stringify({ at: Date.now(), sessionId: owner.sessionId, beforeRunId: next.runId, text: plan.stop, stage: 'one-explicit-independent-stop-probe' }), { flag: 'wx' })
      report.modelSubmissions = 1
      await editor.fill(plan.stop); await editor.press('Enter')
      await wait('new stop command started', () => existsSync(join(folder, mode + '-stop-started.json')))
      const before = (await status()).run
      assert.equal(before.sessionId, owner.sessionId); assert.notEqual(before.runId, next.runId); assert.equal(before.status, 'running')
      const button = mode === 'code' ? surface.locator('.input-composer__stop').filter({ visible: true }) : surface.getByRole('button', { name: '停止任务', exact: true }).filter({ visible: true }).first()
      assert.equal(await button.count(), 1); assert.ok(await button.isEnabled()); await button.click()
      await wait('precise stopped root settled', async () => done(await status()))
      const stopped = (await status()).run
      assert.equal(stopped.runId, before.runId); assert.equal(stopped.status, 'cancelled'); assert.equal(dbRead().roots.length, 3)
      report.stopped = stopped; persist('after-stop-archive', await helpers.readCompleteArchive(read, owner.sessionId))
      report.checks.push({ name: 'explicit-independent-stop', passed: true })
    }
    assert.equal(digest(readFileSync(join(evidence, 'outcomes.json'))), sourceHash, 'ORIGINAL_FAILURE_EVIDENCE_CHANGED')
    report.passed = true; report.reportPath = persist('report', report); return report
  } catch (error) {
    report.passed = false; report.error = String(error.stack || error); report.reportPath = persist('report', report); return report
  }
}
