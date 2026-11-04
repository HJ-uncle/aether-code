/** Offline, read-only audit of an already completed real run. No Electron,
 * HTTP, model submission, database mutation or rewrite of original evidence. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assertProbeCalls, assertResendBranch } from './live-steering-phases.mjs'

const root = resolve(process.argv[2] || '')
assert.ok(process.argv[2], 'Usage: node scripts/verify-live-steering-completion.mjs <validation-root> [round]')
const round = Number(process.argv[3] || '2'); assert.ok(Number.isSafeInteger(round) && round > 0)
const state = JSON.parse(readFileSync(join(root, `round-${round}`, 'state.json'), 'utf8'))
const folder = join(state.evidence, 'live-validation'), workspace = join(state.workspace, 'validation')
const sha = value => createHash('sha256').update(value).digest('hex')
const evidenceHashes = new Map()
const read = name => { const file = join(folder, name + '.json'), bytes = readFileSync(file); evidenceHashes.set(file, sha(bytes)); return JSON.parse(bytes) }
const prompt = read('code-prompt').prompt, stopped = read('code-cancelled'), retry = read('code-retry-accepted')
const cancelled = read('code-cancelled-archive'), current = read('code-complete-archive'), phase = read('phase-status')
const acceptance = read('code-accepted'), integration = read('code-integrated'), immediate = read('code-immediate-prompt').immediate
const manifest = JSON.parse(readFileSync(join(state.evidence, 'live-inputs.json'), 'utf8'))
const reportPath = join(folder, `code-completion-readonly-${new Date().toISOString().replaceAll(':','-')}.json`)
const result = { schema: 'live-steering-readonly-completion/v1', at: Date.now(), passed: false, sourcePhaseStatus: phase.records.code,
  boundaries: ['No model was re-run; the original failed phase record is preserved.', 'Confirmed resend deletes old active history and root ledger; prior cancellation is separate supervisor/job evidence.', 'Native Office text/notes evidence is not full document fidelity or visual verification.'] }
let db
try {
  assert.match(retry.confirmationText, /删除此后的对话并重新发送/)
  assert.ok(retry.confirmedAt && retry.acceptedAt >= retry.confirmedAt)
  assert.equal(stopped.cancelled.run.status, 'cancelled')
  assert.equal(stopped.cancelled.run.runId, retry.before.runId)
  assert.equal(current.sessionId, cancelled.sessionId)
  assert.equal(current.sessionId, retry.after.sessionId)
  assert.equal(cancelled.rows.length, 3, 'This dedicated fixture stopped after one tool invocation')
  db = new DatabaseSync(join(state.profile, 'engine', 'state', 'agent.db'), { readOnly: true })
  db.exec('PRAGMA query_only=ON'); db.exec('BEGIN')
  const roots = db.prepare('SELECT run_id,turn_id,state FROM root_runs WHERE session_id=? ORDER BY rowid').all(current.sessionId)
    .map(row => ({ runId: row.run_id, turnId: row.turn_id, state: JSON.parse(row.state) }))
  assert.equal(roots.length, 1); const final = roots[0].state
  assert.equal(final.runId, retry.after.runId); assert.equal(final.turnId, retry.after.turnId); assert.equal(final.status, 'succeeded')
  assert.equal(final.attemptId, acceptance.context.scope.rootAttemptId)
  const branch = assertResendBranch({ cancelledHistory: cancelled.rows, history: current.rows, original: stopped.original, cancelled: stopped.cancelled.run, next: final, prompt })
  const oldCall = cancelled.rows.find(row => row.toolCall?.name === 'execute_cmd')
  const oldReceipt = cancelled.rows.find(row => row.toolCallId === oldCall.toolCall.id && row.role === 'tool')
  assert.equal(oldReceipt.metadata.commandJob.status, 'cancelled')
  const job = db.prepare('SELECT status,snapshot FROM command_jobs WHERE job_id=? AND session_id=?').get(oldReceipt.metadata.commandJob.jobId, current.sessionId)
  assert.equal(job?.status, 'cancelled'); assert.equal(JSON.parse(job.snapshot).runId, stopped.cancelled.run.runId)
  const scope = acceptance.context.scope
  const deliveries = db.prepare('SELECT * FROM collaboration_jsonl_deliveries WHERE root_run_id=? AND root_attempt_id=? AND message_id=? AND history_session_id=?')
    .all(scope.rootRunId, scope.rootAttemptId, acceptance.accepted.receipt.messageId, current.sessionId)
  assert.equal(deliveries.length, 1); const delivery = deliveries[0]
  assert.equal(delivery.state, 'integrated'); assert.equal(delivery.history_message_id, integration.history_message_id)
  assert.equal(sha(delivery.encoded_row), delivery.row_hash)
  const inputs = current.rows.filter(row => row.id === delivery.history_message_id)
  assert.equal(inputs.length, 1); assert.ok(inputs[0].content.includes(immediate)); assert.equal(inputs[0].conversationId, final.turnId)
  const commands = assertProbeCalls(branch.commandEvidence, [
    { turnId: stopped.cancelled.run.turnId, args: ['window','code','stop'] },
    { turnId: final.turnId, args: ['window','code','stop'] },
    { turnId: final.turnId, args: ['mark','code','steered'] },
    { turnId: final.turnId, args: ['mark','code','complete'] }
  ])
  const calls = current.rows.filter(row => row.toolCall)
  const native = manifest.office.map(file => {
    assert.equal(sha(readFileSync(file.path)), file.sha256, 'Input changed: ' + file.name)
    const matching = calls.filter(row => row.toolCall.name === 'office_inspect' && basename(row.toolCall.args.path.replaceAll('\\','/')) === file.name)
    assert.equal(matching.length, 1, 'This run should inspect each complete preview once')
    const receipts = current.rows.filter(row => row.role === 'tool' && row.toolCallId === matching[0].toolCall.id)
    assert.equal(receipts.length, 1); assert.equal(receipts[0].metadata.status, 'succeeded')
    const parsed = JSON.parse(receipts[0].content)
    assert.equal(parsed.expectedHash, 'sha256:' + file.sha256); assert.ok(parsed.content.length > 100)
    assert.equal(parsed.contentPage.hasMore, false); assert.equal(parsed.contentPage.nextOffset, null)
    assert.equal(parsed.contentTruncated, false); assert.equal(parsed.contentPage.sourceTruncated, false)
    if (file.name.endsWith('.pptx')) assert.ok(parsed.content.includes('target=notes'))
    return { name: file.name, toolCallId: matching[0].toolCall.id, expectedHash: parsed.expectedHash, page: parsed.contentPage }
  })
  assert.equal(calls.filter(row => !['office_inspect','write_file'].includes(row.toolCall.name) && /\.(docx|xlsx|pptx|pdf)\b/i.test(JSON.stringify(row.toolCall.args))).length, 0)
  const report = readFileSync(join(workspace, 'office-report.md'), 'utf8')
  assert.ok(/target\s*=\s*notes/.test(report) && /slide\s*=|slide\s*[:：]|第\s*\d+\s*页/.test(report))
  const lines = readFileSync(join(workspace, 'code.jsonl'), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
  assert.deepEqual(lines.map(row => row.event), ['first-started','retry-started','retry-finished','mark','mark'])
  assert.equal(lines.at(-2).label, 'steered'); assert.equal(lines.at(-1).label, 'complete')
  assert.ok(!existsSync(join(workspace,'code-first-finished.json')))
  assert.equal(sha(readFileSync(join(workspace,'probe.mjs'))), manifest.probeSha256)
  assert.equal(sha(readFileSync(state.builds.appEntry)), state.builds.appSha256)
  assert.equal(sha(readFileSync(state.builds.engineEntry)), state.builds.engineSha256)
  const tenant = retry.afterRun.serverAdmissionReceipt.tenantId
  const jsonlPath = join(state.profile,'engine','state','sessions',tenant,current.sessionId + '.jsonl')
  const physical = readFileSync(jsonlPath), rows = physical.toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
  for (const id of branch.deletedMessageIds) assert.ok(rows.some(row => row.uuid === id), 'Physical history no longer retains old evidence: ' + id)
  assert.ok(rows.some(row => row.type === 'tombstone' && row.scope === 'truncate' && row.afterSeq === stopped.original.dbId))
  assert.ok(rows.some(row => row.type === 'tombstone' && row.scope === 'message' && row.targetUuid === stopped.original.id))
  result.passed = true; result.status = 'passed-with-explicit-history-replacement'
  result.cancelled = { run: stopped.cancelled.run, snapshotRows: cancelled.rows.length, commandJobId: oldReceipt.metadata.commandJob.jobId, commandJobStatus: job.status }
  result.current = { runId: final.runId, turnId: final.turnId, attemptId: final.attemptId, status: final.status, archiveRows: current.rows.length, ledgerRows: roots.length }
  result.resend = { confirmationText: retry.confirmationText, oldRootDeleted: true, deletedMessageIds: branch.deletedMessageIds,
    activeModelHistoryContainsOldCancellation: false, physicalJsonl: { path: jsonlPath, sha256: sha(physical), rows: rows.length, restoreApiProven: false } }
  result.integration = { messageId: delivery.message_id, historyMessageId: delivery.history_message_id, state: delivery.state, rowHash: delivery.row_hash }
  result.commands = commands.map(row => ({ id: row.toolCall.id, turnId: row.conversationId, args: row.toolCall.args.args }))
  result.office = native; result.officeReportSha256 = sha(report); result.journal = lines
} catch (error) { result.error = error.stack; process.exitCode = 1 }
finally {
  db?.close()
  for (const [file, hash] of evidenceHashes) assert.equal(sha(readFileSync(file)), hash, 'Original evidence changed: ' + file)
  result.originalEvidenceUnchanged = true
  writeFileSync(reportPath, JSON.stringify(result,null,2), { flag: 'wx' })
  console.log(JSON.stringify({ reportPath, passed: result.passed, status: result.status, error: result.error }))
}
