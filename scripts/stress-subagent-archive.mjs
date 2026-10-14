import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const planTools = new Set(['plan_update', 'todo_list', 'todo_create', 'todo_update', 'todo_delete'])
const identityKeys = ['runId', 'tenantId', 'parentSessionId', 'rootSessionId', 'parentConversationId', 'parentMessageId', 'parentToolCallId', 'childSessionId']
const scalarKeys = ['status', 'lastSeq', 'updatedAt', 'startedAt', 'finishedAt', 'durationMs', 'stopReason', 'error', 'resultSummary', 'partialOutput', 'externalEffectStatus', 'usage', 'modelId', 'toolCount', 'activeToolCount', 'nonPlanToolCount', 'latestActivity']
const parse = (value, label) => {
  const parsed = JSON.parse(String(value))
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${label}: expected object`)
  return parsed
}

export function stressCronEditableFields(job) {
  return { name: job.name, description: job.description ?? null, cronExpr: job.cronExpr, message: job.message, sessionId: job.sessionId,
    enabled: job.enabled, timeoutSeconds: job.timeoutSeconds ?? null, thinkingMode: job.thinkingMode ?? null,
    agentId: job.agentId ?? null, configuration: job.configuration ?? null, revision: job.revision ?? null, scheduleRevision: job.scheduleRevision ?? null }
}
export function stressCronEditableSHA256(job) {
  return createHash('sha256').update(JSON.stringify(stressCronEditableFields(job))).digest('hex')
}

/** Test evidence uses complete private archives; a resident UI summary cannot prove tool arguments or Agent ownership. */
export class StressSubagentArchive {
  constructor(db, { tenantId = 'default', sessions } = {}) {
    assert.ok(db && Array.isArray(sessions) && sessions.length && sessions.every(value => typeof value === 'string' && value), 'Owned archive sessions are required')
    this.db = db
    this.tenantId = tenantId
    this.sessions = new Set(sessions)
    this.cache = new Map()
  }

  read() {
    // Identity, scalar checkpoint and tool revisions must all refer to one SQLite read snapshot.
    this.db.exec('BEGIN')
    try {
      const exists = name => Boolean(this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name))
      if (!exists('subagent_runs')) return []
      const modern = ['subagent_records', 'subagent_checkpoints', 'subagent_tool_versions'].every(exists)
      const marks = [...this.sessions].map(() => '?').join(',')
      const rows = this.db.prepare(`SELECT run_id,parent_session_id,parent_tool_call_id,child_session_id,seq,snapshot FROM subagent_runs WHERE tenant_id=? AND parent_session_id IN (${marks}) ORDER BY created_at,run_id`).all(this.tenantId, ...this.sessions)
      const runs = rows.map(row => {
        const current = parse(row.snapshot, 'current child')
        assert.equal(current.runId, row.run_id, 'Current child identity mismatch')
        assert.equal(current.lastSeq, Number(row.seq), 'Current child sequence mismatch')
        assert.ok(Number.isSafeInteger(current.lastSeq) && current.lastSeq > 0, 'Invalid child sequence')
        if (current.schemaVersion === 1) {
          this.validate(current)
          this.validateIndex(current, row)
          return current
        }
        assert.equal(current.schemaVersion, 2, 'Unknown child archive version')
        assert.ok(modern, 'Modern child archive tables are missing')
        const rowAt = this.db.prepare(`SELECT r.record,c.header FROM subagent_records r JOIN subagent_checkpoints c ON c.tenant_id=r.tenant_id AND c.run_id=r.run_id WHERE r.tenant_id=? AND r.run_id=? AND c.seq=?`).get(this.tenantId, current.runId, current.lastSeq)
        assert.ok(rowAt, 'Exact child checkpoint is missing')
        const prior = this.cache.get(current.runId)
        assert.ok(!prior || prior.seq <= current.lastSeq, 'Child archive regressed')
        assert.ok(!prior || prior.recordText === rowAt.record, 'Immutable child identity/configuration changed')
        if (prior?.seq === current.lastSeq) {
          assert.equal(prior.headerText, rowAt.header, 'Same-sequence child checkpoint conflict')
          return prior.run
        }
        const record = parse(rowAt.record, 'immutable child record'), header = parse(rowAt.header, 'child checkpoint')
        this.validateIndex(record, row)
        assert.equal(header.lastSeq, current.lastSeq, 'Checkpoint sequence mismatch')
        for (const key of scalarKeys) assert.deepEqual(current[key], header[key], `Current scalar/checkpoint mismatch: ${key}`)
        for (const key of identityKeys) assert.equal(typeof record[key], 'string', `Missing child identity: ${key}`)
        for (const key of scalarKeys) assert.ok(!(key in record), `Immutable record contains stale mutable field: ${key}`)
        const versions = new Map(prior?.versions ?? [])
        // The immutable revision table makes it sufficient to decode newly written tool versions.
        const changed = this.db.prepare(`SELECT v.tool_id,v.seq,v.ordinal,v.status,v.detail FROM subagent_tool_versions v WHERE v.tenant_id=? AND v.run_id=? AND v.seq>? AND v.seq<=? AND v.seq=(SELECT max(n.seq) FROM subagent_tool_versions n WHERE n.tenant_id=v.tenant_id AND n.run_id=v.run_id AND n.tool_id=v.tool_id AND n.seq<=?) ORDER BY v.ordinal,v.tool_id`).all(this.tenantId, current.runId, prior?.seq ?? 0, current.lastSeq, current.lastSeq)
        for (const tool of changed) {
          const detail = parse(tool.detail, 'complete child tool')
          assert.equal(detail.id, tool.tool_id, 'Tool identity mismatch')
          assert.equal(detail.status, tool.status, 'Tool state mismatch')
          assert.ok(Number.isSafeInteger(Number(tool.ordinal)) && Number(tool.ordinal) > 0, 'Invalid tool ordinal')
          versions.set(tool.tool_id, { ordinal: Number(tool.ordinal), detail })
        }
        const tools = [...versions.values()].sort((a, b) => a.ordinal - b.ordinal)
        assert.equal(new Set(tools.map(tool => tool.ordinal)).size, tools.length, 'Duplicate tool ordinal')
        assert.ok(tools.every((tool, index) => tool.ordinal === index + 1), 'Child tool ordinals have missing positions')
        assert.equal(tools.length, header.toolCount, 'Incomplete child tool archive')
        assert.equal(tools.filter(tool => tool.detail.status === 'running').length, header.activeToolCount, 'Child active tool count mismatch')
        assert.equal(tools.filter(tool => !planTools.has(tool.detail.name)).length, header.nonPlanToolCount, 'Child effect tool count mismatch')
        const { toolCount: _count, activeToolCount: _active, nonPlanToolCount: _effects, latestActivity: _latest, ...state } = header
        const run = { ...record, ...state, schemaVersion: 1, toolCalls: tools.map(tool => tool.detail) }
        this.validate(run)
        this.cache.set(run.runId, { seq: run.lastSeq, recordText: rowAt.record, headerText: rowAt.header, versions, run })
        return run
      })
      return runs
    } finally {
      this.db.exec('ROLLBACK')
    }
  }

  validate(run) {
    assert.equal(run.schemaVersion, 1, 'Canonical child must preserve v1 archive semantics')
    assert.equal(run.tenantId, this.tenantId, 'Foreign tenant archive')
    assert.ok(this.sessions.has(run.parentSessionId), 'Foreign parent archive')
    assert.ok(Array.isArray(run.toolCalls), 'Complete child tool array is required')
    assert.equal(new Set(run.toolCalls.map(tool => tool.id)).size, run.toolCalls.length, 'Duplicate archived tool identity')
    if (run.agentId) assert.equal(run.continuation?.agent?.id, run.agentId, 'Complete Agent continuation ownership is required')
  }

  validateIndex(record, row) {
    assert.equal(record.runId, row.run_id, 'Child record/index identity mismatch')
    assert.equal(record.parentSessionId, row.parent_session_id, 'Child record/index parent mismatch')
    assert.equal(record.parentToolCallId, row.parent_tool_call_id, 'Child record/index call mismatch')
    assert.equal(record.childSessionId, row.child_session_id, 'Child record/index session mismatch')
  }
}

export function requireStressSubagentV2(capability) {
  assert.equal(capability?.schemaVersion, 2, 'Stress requires negotiated child protocol 2')
  assert.ok(capability.eventVersions?.includes(2) && capability.views?.includes('summary') && capability.exactWatermarks === true
    && capability.toolPagination === true && capability.eventPagination === true, 'Incomplete child protocol capabilities')
  return 2
}

/** A run-list cursor fixes membership, while individual live views may advance between pages. */
export async function readStressSubagentPages(request, parentSessionId) {
  const runs = [], seen = new Set(), cursors = new Set()
  let cursor, revision
  for (;;) {
    const page = await request({ parentSessionId, view: 'summary', limit: '64', ...(cursor ? { cursor } : {}) })
    assert.equal(page?.schemaVersion, 2, 'Expected negotiated child page')
    assert.equal(page.parentSessionId, parentSessionId, 'Foreign child page')
    assert.ok(Array.isArray(page.runs) && typeof page.hasMore === 'boolean' && typeof page.revision === 'string' && page.revision, 'Invalid child page metadata')
    revision ??= page.revision
    assert.equal(page.revision, revision, 'Child membership revision changed during paging')
    for (const run of page.runs) {
      assert.equal(run.schemaVersion, 2, 'Expected summary view')
      assert.equal(run.view, 'summary', 'Unknown child view')
      assert.equal(run.parentSessionId, parentSessionId, 'Foreign child view')
      assert.equal(typeof run.runId, 'string', 'Child run identity missing')
      assert.ok(!seen.has(run.runId), 'Duplicate child page identity')
      seen.add(run.runId); runs.push(run)
    }
    if (!page.hasMore) {
      assert.ok(!page.nextCursor, 'Terminal child page must not hide another cursor')
      if (!cursor) assert.equal(page.listComplete, true, 'Single child page must report complete membership')
      break
    }
    assert.ok(page.runs.length && typeof page.nextCursor === 'string' && page.nextCursor && !cursors.has(page.nextCursor), 'Child paging stalled')
    cursors.add(page.nextCursor); cursor = page.nextCursor
  }
  return runs
}
