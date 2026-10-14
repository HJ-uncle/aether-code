import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { StressSubagentArchive, readStressSubagentPages, requireStressSubagentV2 } from './stress-subagent-archive.mjs'

function fixture() {
  const root = fs.mkdtempSync(path.resolve('.e2e-tmp/stress-archive-'))
  const file = path.join(root, 'archive.db'), writer = new DatabaseSync(file)
  writer.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE subagent_runs(tenant_id TEXT,run_id TEXT,parent_session_id TEXT,parent_tool_call_id TEXT,child_session_id TEXT,seq INTEGER,created_at INTEGER,snapshot TEXT);
    CREATE TABLE subagent_records(tenant_id TEXT,run_id TEXT,record TEXT);
    CREATE TABLE subagent_checkpoints(tenant_id TEXT,run_id TEXT,seq INTEGER,header TEXT);
    CREATE TABLE subagent_tool_versions(tenant_id TEXT,run_id TEXT,tool_id TEXT,seq INTEGER,ordinal INTEGER,status TEXT,detail TEXT);`)
  const identity = { schemaVersion: 1, runId: 'child', tenantId: 'default', parentSessionId: 'owned', rootSessionId: 'owned',
    parentConversationId: 'turn', parentMessageId: 'message', parentToolCallId: 'parent-call', childSessionId: 'child-session',
    agentId: 'custom', continuation: { agent: { id: 'custom', systemPrompt: 'synthetic-private', mcpServers: ['synthetic'] } },
    task: 'synthetic task', description: 'test', createdAt: 1 }
  writer.prepare('INSERT INTO subagent_records VALUES(?,?,?)').run('default', 'child', JSON.stringify(identity))
  function checkpoint(seq, tools, status = 'running') {
    const state = { status, lastSeq: seq, updatedAt: seq, usage: { promptTokens: seq, completionTokens: seq }, modelId: 'test-model',
      toolCount: tools.length, activeToolCount: tools.filter(tool => tool.status === 'running').length, nonPlanToolCount: tools.filter(tool => tool.name !== 'plan_update').length }
    writer.prepare('INSERT INTO subagent_checkpoints VALUES(?,?,?,?)').run('default', 'child', seq, JSON.stringify(state))
    const snapshot = JSON.stringify({ schemaVersion: 2, runId: 'child', ...state })
    const exists = writer.prepare('SELECT 1 FROM subagent_runs').get()
    if (exists) writer.prepare('UPDATE subagent_runs SET seq=?,snapshot=? WHERE run_id=?').run(seq, snapshot, 'child')
    else writer.prepare('INSERT INTO subagent_runs VALUES(?,?,?,?,?,?,?,?)').run('default', 'child', 'owned', 'parent-call', 'child-session', seq, 1, snapshot)
    for (const [index, tool] of tools.entries()) writer.prepare('INSERT INTO subagent_tool_versions VALUES(?,?,?,?,?,?,?)').run('default', 'child', tool.id, seq, index + 1, tool.status, JSON.stringify(tool))
  }
  const reader = new DatabaseSync(file, { readOnly: true }), archive = new StressSubagentArchive(reader, { sessions: ['owned'] })
  return { writer, reader, archive, identity, checkpoint, close() { reader.close(); writer.close(); fs.rmSync(root, { recursive: true }) } }
}
fs.mkdirSync('.e2e-tmp', { recursive: true })
const tool = (status = 'running') => ({ id: 'read', name: 'read_file', args: { path: '/synthetic', startLine: 1 }, startedAt: 2, status,
  ...(status === 'succeeded' ? { output: 'full synthetic output', finishedAt: 3 } : {}) })

test('complete same-checkpoint private ownership and tool arguments survive summary-only storage and cached revisions', () => {
  const f = fixture()
  try {
    f.checkpoint(2, [tool()]); const first = f.archive.read()[0]
    assert.deepEqual(first.continuation, f.identity.continuation); assert.deepEqual(first.toolCalls[0].args, tool().args)
    assert.equal(first.schemaVersion, 1)
    f.checkpoint(3, [tool('succeeded')], 'succeeded'); const second = f.archive.read()[0]
    assert.equal(first.toolCalls[0].status, 'running'); assert.equal(second.toolCalls[0].output, 'full synthetic output')
    assert.equal(second.status, 'succeeded'); assert.equal(f.archive.read()[0], second)
    assert.throws(() => f.reader.exec('DELETE FROM subagent_runs'), /readonly/i)
  } finally { f.close() }
})

test('legacy archive remains full and database tenant/parent scope excludes foreign records', () => {
  const f = fixture()
  try {
    const legacy = { ...f.identity, lastSeq: 4, status: 'succeeded', toolCalls: [tool('succeeded')] }
    f.writer.prepare('INSERT INTO subagent_runs VALUES(?,?,?,?,?,?,?,?)').run('default', 'child', 'owned', 'parent-call', 'child-session', 4, 1, JSON.stringify(legacy))
    f.writer.prepare('INSERT INTO subagent_runs VALUES(?,?,?,?,?,?,?,?)').run('foreign', 'foreign', 'owned', 'other', 'foreign-session', 1, 1, '{}')
    assert.deepEqual(f.archive.read(), [legacy])
  } finally { f.close() }
})

for (const [name, corrupt, pattern] of [
  ['missing exact checkpoint', f => f.writer.exec('DELETE FROM subagent_checkpoints'), /checkpoint is missing/],
  ['missing tool detail', f => f.writer.exec('DELETE FROM subagent_tool_versions'), /Incomplete child tool archive/],
  ['active count mismatch', f => f.writer.exec("UPDATE subagent_tool_versions SET status='succeeded',detail=json_set(detail,'$.status','succeeded')"), /active tool count mismatch/],
  ['Agent ownership mismatch', f => f.writer.exec("UPDATE subagent_records SET record=json_set(record,'$.continuation.agent.id','foreign')"), /ownership is required/],
  ['record index mismatch', f => f.writer.exec("UPDATE subagent_records SET record=json_set(record,'$.runId','foreign')"), /identity mismatch/],
  ['mutable state in immutable record', f => f.writer.exec("UPDATE subagent_records SET record=json_set(record,'$.status','succeeded')"), /stale mutable field/],
  ['current scalar mismatch', f => f.writer.exec("UPDATE subagent_runs SET snapshot=json_set(snapshot,'$.status','failed')"), /scalar\/checkpoint mismatch/],
]) test(`reject ${name}; read transaction is released after failure`, () => {
  const f = fixture()
  try { f.checkpoint(2, [tool()]); corrupt(f); assert.throws(() => f.archive.read(), pattern); f.reader.exec('BEGIN;ROLLBACK') }
  finally { f.close() }
})

test('same-sequence conflicts and immutable changes cannot pass through the cache', () => {
  const f = fixture()
  try {
    f.checkpoint(2, [tool()]); f.archive.read()
    f.writer.exec("UPDATE subagent_checkpoints SET header=json_set(header,'$.updatedAt',99)")
    assert.throws(() => f.archive.read(), /Same-sequence/)
    f.writer.exec("UPDATE subagent_records SET record=json_set(record,'$.task','changed')")
    assert.throws(() => f.archive.read(), /Immutable child/)
  } finally { f.close() }
})

test('membership pagination consumes every page without assuming terminal listComplete means all preceding pages', async () => {
  const one = id => ({ schemaVersion: 2, view: 'summary', runId: id, parentSessionId: 'owned' })
  const requests = []
  const runs = await readStressSubagentPages(async query => {
    requests.push(query)
    return { schemaVersion: 2, parentSessionId: 'owned', revision: 'fixed', runs: [one(query.cursor ? 'second' : 'first')], hasMore: !query.cursor,
      listComplete: false, ...(!query.cursor ? { nextCursor: 'cursor' } : {}) }
  }, 'owned')
  assert.deepEqual(runs.map(run => run.runId), ['first', 'second']); assert.equal(requests[1].cursor, 'cursor')
})

for (const [name, alteration] of [
  ['revision change', page => ({ ...page, revision: 'changed' })],
  ['duplicate identity', page => ({ ...page, runs: [{ ...page.runs[0], runId: 'first' }] })],
  ['foreign parent', page => ({ ...page, parentSessionId: 'foreign' })],
  ['stalled cursor', page => ({ ...page, hasMore: true, nextCursor: 'cursor' })],
]) test(`pagination rejects ${name}`, async () => {
  let count = 0
  await assert.rejects(readStressSubagentPages(async () => {
    const page = { schemaVersion: 2, parentSessionId: 'owned', revision: 'fixed', runs: [{ schemaVersion: 2, view: 'summary', parentSessionId: 'owned', runId: count ? 'second' : 'first' }], hasMore: count === 0, listComplete: false, ...(count === 0 ? { nextCursor: 'cursor' } : {}) }
    return count++ ? alteration(page) : page
  }, 'owned'))
})

test('protocol admission refuses legacy/incomplete capabilities', () => {
  const capability = { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], exactWatermarks: true, toolPagination: true, eventPagination: true }
  assert.equal(requireStressSubagentV2(capability), 2)
  assert.throws(() => requireStressSubagentV2({ ...capability, exactWatermarks: false }))
  assert.throws(() => requireStressSubagentV2({ ...capability, eventVersions: [1] }))
})
