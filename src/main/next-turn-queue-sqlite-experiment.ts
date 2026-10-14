import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULT_NEXT_TURN_QUEUE_LIMITS, NextTurnQueueError, type NextTurnQueueEntry, type NextTurnQueueLimits, type NextTurnQueueMutation, type NextTurnQueueScope, type NextTurnQueueState, type QueueCommitReceipt, type QueueCommitResult } from '../shared/next-turn-queue'
import { applyNextTurnQueueMutation, assertQueueJsonValue, assertQueueLimits, assertQueueScope, assertQueueState, emptyNextTurnQueue, queueScopeIdentity } from '../shared/next-turn-queue-state'
import type { ArchivedQueueEntry, QueueStoreRead } from './next-turn-queue-store'
import type { NextTurnQueueRepository } from './next-turn-queue-repository'

type Row = Record<string, unknown>
interface RecordProof {
  schemaVersion: 1
  bucketKey: string
  previousDigest: string
  operationId: string
  operationDigest: string
  committedAt: number
  state: NextTurnQueueState
  mutation: NextTurnQueueMutation
  archived: NextTurnQueueEntry[]
  removed: NextTurnQueueState['removed']
  snapshotDigest: string
}
export interface QueueSqliteExperimentOptions {
  /** This prototype is never chosen by the application factory. Packaged runtime + worker + migration gates remain. */
  nativeExperimentOnly: true
  /** Recovery must never create an empty replacement for a missing acknowledged database. */
  requireExisting?: boolean
  limits?: NextTurnQueueLimits
  maxVerifiedScopes?: number
  testHook?: (phase: 'before-transaction' | 'before-commit' | 'after-commit') => Promise<void>
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  const item = value as Record<string, unknown>
  return '{' + Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => JSON.stringify(key) + ':' + canonical(item[key])).join(',') + '}'
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
function text(value: unknown): string { if (typeof value !== 'string') throw new NextTurnQueueError('CORRUPT', 'SQLite queue field is not text'); return value }
function number(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new NextTurnQueueError('CORRUPT', 'SQLite queue count/revision is invalid'); return value }
function decode<T>(json: unknown, digest: unknown): T {
  const bytes = text(json)
  if (sha(bytes) !== text(digest)) throw new NextTurnQueueError('CORRUPT', 'SQLite queue payload checksum changed')
  try { return JSON.parse(bytes) as T } catch { throw new NextTurnQueueError('CORRUPT', 'SQLite queue payload JSON is invalid') }
}
function receipt(record: RecordProof): QueueCommitReceipt { return { bucketKey: record.bucketKey, revision: record.state.revision, operationId: record.operationId, committedAt: record.committedAt, snapshotDigest: record.snapshotDigest } }
function initialDigest(scope: NextTurnQueueScope) { return sha(canonical({ schemaVersion: 1, scope, state: emptyNextTurnQueue(scope) })) }
function compact(state: NextTurnQueueState, archived: NextTurnQueueEntry[], removed: NextTurnQueueState['removed']): NextTurnQueueState {
  const ids = new Set(archived.map(entry => entry.id)), tombstones = new Set(removed.map(entry => entry.id))
  return { ...structuredClone(state), entries: state.entries.filter(entry => !ids.has(entry.id)).map(entry => structuredClone(entry)), removed: state.removed.filter(entry => !tombstones.has(entry.id)).map(entry => structuredClone(entry)) }
}

/** Actual native SQLite storage-port experiment. No UI switch, provider, socket or app default is installed. */
export class NextTurnQueueSqliteExperiment implements NextTurnQueueRepository {
  readonly limits: NextTurnQueueLimits
  readonly path: string
  private readonly db: DatabaseSync
  private readonly maxVerifiedScopes: number
  private readonly verified = new Map<string, { revision: number; digest: string }>()
  private serial: Promise<unknown> = Promise.resolve()
  private closing = false
  private closed: Promise<void> | undefined
  constructor(path: string, private readonly options: QueueSqliteExperimentOptions) {
    if (options.nativeExperimentOnly !== true) throw new NextTurnQueueError('AUTHORITY', 'Native SQLite storage is an owned experiment only')
    this.maxVerifiedScopes = options.maxVerifiedScopes ?? 200
    if (!Number.isSafeInteger(this.maxVerifiedScopes) || this.maxVerifiedScopes < 1 || this.maxVerifiedScopes > 1000) throw new NextTurnQueueError('INVALID', 'Verified scope cache budget is invalid')
    this.path = resolve(path); this.limits = { ...(options.limits ?? DEFAULT_NEXT_TURN_QUEUE_LIMITS) }; assertQueueLimits(this.limits)
    mkdirSync(dirname(this.path), { recursive: true })
    if (!lstatSync(dirname(this.path)).isDirectory() || lstatSync(dirname(this.path)).isSymbolicLink() || (existsSync(this.path) && (!lstatSync(this.path).isFile() || lstatSync(this.path).isSymbolicLink()))) throw new NextTurnQueueError('SCOPE', 'SQLite experiment must use owned ordinary files')
    const existing = existsSync(this.path)
    if (options.requireExisting && !existing) throw new NextTurnQueueError('IO', 'Acknowledged SQLite root is missing; no empty reconstruction')
    this.db = new DatabaseSync(this.path)
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=250; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      const version = this.db.prepare('PRAGMA user_version').get()
      if (version?.user_version === 0 && !existing) {
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE scope_head(bucket TEXT PRIMARY KEY, scope_json TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), state_json TEXT NOT NULL, state_digest TEXT NOT NULL, head_digest TEXT NOT NULL, op_count INTEGER NOT NULL, entry_count INTEGER NOT NULL, archive_count INTEGER NOT NULL, active_count INTEGER NOT NULL CHECK(active_count>=0));
          CREATE INDEX active_scope ON scope_head(active_count,bucket);
          CREATE TABLE operation(bucket TEXT NOT NULL REFERENCES scope_head(bucket), operation_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), operation_digest TEXT NOT NULL, record_json TEXT NOT NULL, record_digest TEXT NOT NULL, PRIMARY KEY(bucket,operation_id), UNIQUE(bucket,revision));
          CREATE TABLE identity(bucket TEXT NOT NULL REFERENCES scope_head(bucket), id TEXT NOT NULL, phase TEXT NOT NULL, entry_json TEXT NOT NULL, entry_digest TEXT NOT NULL, PRIMARY KEY(bucket,id));
          CREATE TABLE archive(bucket TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, entry_json TEXT NOT NULL, entry_digest TEXT NOT NULL, receipt_json TEXT NOT NULL, receipt_digest TEXT NOT NULL, PRIMARY KEY(bucket,id), FOREIGN KEY(bucket,id) REFERENCES identity(bucket,id));
          CREATE TABLE recent_event(bucket TEXT NOT NULL REFERENCES scope_head(bucket), revision INTEGER NOT NULL, receipt_json TEXT NOT NULL, byte_count INTEGER NOT NULL, PRIMARY KEY(bucket,revision));
          CREATE TRIGGER immutable_operation_update BEFORE UPDATE ON operation BEGIN SELECT RAISE(ABORT,'immutable operation'); END;
          CREATE TRIGGER immutable_operation_delete BEFORE DELETE ON operation BEGIN SELECT RAISE(ABORT,'immutable operation'); END;
          CREATE TRIGGER immutable_archive_update BEFORE UPDATE ON archive BEGIN SELECT RAISE(ABORT,'immutable archive'); END;
          CREATE TRIGGER immutable_archive_delete BEFORE DELETE ON archive BEGIN SELECT RAISE(ABORT,'immutable archive'); END;
          CREATE TRIGGER immutable_identity_delete BEFORE DELETE ON identity BEGIN SELECT RAISE(ABORT,'immutable identity'); END;
          PRAGMA user_version=1; COMMIT;`)
      } else if (version?.user_version !== 1) throw new NextTurnQueueError('CORRUPT', 'SQLite experiment has no acknowledged schema; no empty reconstruction')
      const integrity = this.db.prepare('PRAGMA integrity_check').all()
      if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || this.db.prepare('PRAGMA foreign_key_check').all().length) throw new NextTurnQueueError('CORRUPT', 'SQLite queue integrity/foreign-key audit failed')
      // Restart verifies the actual persisted prefix once under a stable read snapshot.
      this.db.exec('BEGIN')
      for (const row of this.db.prepare('SELECT * FROM scope_head ORDER BY bucket').iterate()) this.verifyHead(row, true)
      this.auditRows()
      this.db.exec('COMMIT')
    } catch (error) { try { this.db.exec('ROLLBACK') } catch { /* Preserve the native failure. */ }; this.db.close(); throw error }
  }
  private owned<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.closing) return Promise.reject(new NextTurnQueueError('AUTHORITY', 'SQLite owner is closing'))
    const result = this.serial.catch(() => {}).then(() => { if (this.closing) throw new NextTurnQueueError('AUTHORITY', 'SQLite owner closed before operation'); return operation() })
    this.serial = result
    return result
  }
  private remember(bucket: string, value: { revision: number; digest: string }): void {
    this.verified.delete(bucket); this.verified.set(bucket, value)
    while (this.verified.size > this.maxVerifiedScopes) this.verified.delete(this.verified.keys().next().value!)
  }
  private proof(row: Row): RecordProof {
    const record = decode<RecordProof>(row.record_json, row.record_digest)
    const { snapshotDigest, ...unsigned } = record
    if (record.schemaVersion !== 1 || snapshotDigest !== sha(canonical(unsigned)) || record.operationId !== row.operation_id || record.operationDigest !== row.operation_digest || record.state.revision !== row.revision || record.bucketKey !== row.bucket) throw new NextTurnQueueError('CORRUPT', 'SQLite operation proof changed')
    return record
  }
  private verifyHead(row: Row, restart = false): NextTurnQueueState {
    const scope: unknown = JSON.parse(text(row.scope_json)); assertQueueScope(scope)
    const bucket = sha(queueScopeIdentity(scope)), revision = number(row.revision)
    if (bucket !== row.bucket) throw new NextTurnQueueError('SCOPE', 'SQLite head scope differs')
    const state = decode<NextTurnQueueState>(row.state_json, row.state_digest); assertQueueState(state, scope, this.limits)
    if (state.revision !== revision || number(row.op_count) !== revision) throw new NextTurnQueueError('CORRUPT', 'SQLite global revision/counter differs')
    const verified = restart ? undefined : this.verified.get(bucket)
    const cached = verified?.revision ? this.db.prepare('SELECT * FROM operation WHERE bucket=? AND revision=?').get(bucket, verified.revision) : undefined
    if (verified?.revision && (!cached || this.proof(cached).snapshotDigest !== verified.digest)) throw new NextTurnQueueError('CORRUPT', 'SQLite verified prefix lost its original head proof')
    let previous = cached ? this.proof(cached).state : emptyNextTurnQueue(scope), digest = verified?.digest ?? initialDigest(scope), next = verified?.revision ?? 0
    if (next > revision) throw new NextTurnQueueError('CORRUPT', 'SQLite head revision moved backwards')
    // SQLite indexes select only new immutable operations; this is not a fresh all-history JSON file scan.
    for (const item of this.db.prepare('SELECT * FROM operation WHERE bucket=? AND revision>? AND revision<=? ORDER BY revision').iterate(bucket, next, revision)) {
      const record = this.proof(item)
      if (record.state.revision !== next + 1 || record.previousDigest !== digest || record.operationDigest !== sha(canonical({ expectedRevision: next, operation: record.mutation })) || record.archived.length > 32 || record.removed.length > 32) throw new NextTurnQueueError('CORRUPT', 'SQLite immutable prefix has a gap or wrong chain')
      const applied = applyNextTurnQueueMutation(previous, next, record.mutation, this.limits)
      for (const entry of record.archived) if (entry.phase !== 'terminal' || canonical(applied.entries.find(candidate => candidate.id === entry.id)) !== canonical(entry)) throw new NextTurnQueueError('CORRUPT', 'SQLite archive changed exact terminal evidence')
      for (const marker of record.removed) if (canonical(applied.removed.find(candidate => candidate.id === marker.id)) !== canonical(marker)) throw new NextTurnQueueError('CORRUPT', 'SQLite removed identity archive changed')
      if (canonical(compact(applied, record.archived, record.removed)) !== canonical(record.state)) throw new NextTurnQueueError('CORRUPT', 'SQLite archive/active transaction differs')
      previous = record.state; digest = record.snapshotDigest; next++
    }
    if (next !== revision || digest !== row.head_digest || canonical(previous) !== canonical(state)) throw new NextTurnQueueError('CORRUPT', 'SQLite head is not its committed immutable prefix')
    if (number(row.active_count) !== state.entries.filter(entry => entry.phase !== 'terminal').length) throw new NextTurnQueueError('CORRUPT', 'SQLite active scope index differs')
    if (restart && (number(this.db.prepare('SELECT COUNT(*) AS count FROM operation WHERE bucket=?').get(bucket)?.count) !== number(row.op_count) || number(this.db.prepare('SELECT COUNT(*) AS count FROM identity WHERE bucket=?').get(bucket)?.count) !== number(row.entry_count) || number(this.db.prepare('SELECT COUNT(*) AS count FROM archive WHERE bucket=?').get(bucket)?.count) !== number(row.archive_count))) throw new NextTurnQueueError('CORRUPT', 'SQLite immutable ledger counts differ')
    this.remember(bucket, { revision, digest })
    return state
  }
  private auditRows(): void {
    for (const row of this.db.prepare('SELECT * FROM identity').iterate()) {
      const entry = decode<{ id: string }>(row.entry_json, row.entry_digest)
      if (entry.id !== row.id) throw new NextTurnQueueError('CORRUPT', 'SQLite identity row differs')
    }
    for (const row of this.db.prepare('SELECT * FROM archive').iterate()) {
      const entry = decode<NextTurnQueueEntry>(row.entry_json, row.entry_digest), originalReceipt = decode<QueueCommitReceipt>(row.receipt_json, row.receipt_digest)
      const operation = this.db.prepare('SELECT * FROM operation WHERE bucket=? AND revision=?').get(text(row.bucket), number(row.revision))
      if (!operation || entry.id !== row.id || entry.phase !== 'terminal' || canonical(receipt(this.proof(operation))) !== canonical(originalReceipt) || !this.proof(operation).archived.some(candidate => canonical(candidate) === canonical(entry))) throw new NextTurnQueueError('CORRUPT', 'SQLite archive lost its actual commit proof')
    }
  }
  private current(scope: NextTurnQueueScope): { bucket: string; row?: Row; state: NextTurnQueueState } {
    assertQueueScope(scope)
    const bucket = sha(queueScopeIdentity(scope)), row = this.db.prepare('SELECT * FROM scope_head WHERE bucket=?').get(bucket)
    return { bucket, row, state: row ? this.verifyHead(row) : emptyNextTurnQueue(scope) }
  }
  read(scope: NextTurnQueueScope): Promise<QueueStoreRead> { return this.owned(() => { const { bucket, state } = this.current(scope); const last = this.db.prepare('SELECT * FROM operation WHERE bucket=? AND revision=?').get(bucket, state.revision); return { state: structuredClone(state), auxiliaryFiles: [], ...(last ? { receipt: receipt(this.proof(last)) } : {}) } }) }
  mutate(scope: NextTurnQueueScope, expectedRevision: number, operationId: string, operation: NextTurnQueueMutation, assertAuthority: () => void): Promise<QueueCommitResult> {
    assertQueueScope(scope); assertQueueJsonValue(operation, this.limits.maxStateBytes + 8192)
    if (!operationId.trim() || operationId.length > 256 || operationId.startsWith('__') || /[\u0000-\u001f\u007f]/.test(operationId)) return Promise.reject(new NextTurnQueueError('INVALID', 'Operation ID is invalid'))
    const captured = structuredClone(operation)
    return this.owned(async () => {
      await this.options.testHook?.('before-transaction'); assertAuthority()
      let begun = false, committed = false
      try {
        this.db.exec('BEGIN IMMEDIATE'); begun = true
        const { bucket, row, state } = this.current(scope), operationDigest = sha(canonical({ expectedRevision, operation: captured }))
        const prior = this.db.prepare('SELECT * FROM operation WHERE bucket=? AND operation_id=?').get(bucket, operationId)
        if (prior) { const proof = this.proof(prior); if (proof.operationDigest !== operationDigest) throw new NextTurnQueueError('CONFLICT', 'Operation identity changed bytes'); await this.options.testHook?.('before-commit'); assertAuthority(); this.db.exec('COMMIT'); committed = true; return { state, receipt: receipt(proof), replayed: true, durabilityWarnings: [] } }
        if (state.revision !== expectedRevision) throw new NextTurnQueueError('CAS', 'SQLite queue revision changed')
        if (captured.kind === 'enqueue' && this.db.prepare('SELECT id FROM identity WHERE bucket=? AND id=?').get(bucket, captured.id)) throw new NextTurnQueueError('CONFLICT', 'Entry identity already committed')
        if (!row) this.db.prepare('INSERT INTO scope_head VALUES(?,?,?,?,?,?,?,?,?,?)').run(bucket, canonical(scope), 0, canonical(state), sha(canonical(state)), initialDigest(scope), 0, 0, 0, 0)
        const applied = applyNextTurnQueueMutation(state, expectedRevision, captured, this.limits), archived = applied.entries.filter(entry => entry.phase === 'terminal').slice(0, 32), removed = applied.removed.slice(0, 32), next = compact(applied, archived, removed)
        const unsigned = { schemaVersion: 1 as const, bucketKey: bucket, previousDigest: row ? text(row.head_digest) : initialDigest(scope), operationId, operationDigest, committedAt: Date.now(), state: next, mutation: captured, archived, removed }
        const record = { ...unsigned, snapshotDigest: sha(canonical(unsigned)) }, commitReceipt = receipt(record), json = canonical(record)
        this.db.prepare('INSERT INTO operation VALUES(?,?,?,?,?,?)').run(bucket, operationId, next.revision, operationDigest, json, sha(json))
        for (const entry of applied.entries) {
          const bytes = canonical(entry)
          this.db.prepare('INSERT INTO identity VALUES(?,?,?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET phase=excluded.phase,entry_json=excluded.entry_json,entry_digest=excluded.entry_digest').run(bucket, entry.id, entry.phase, bytes, sha(bytes))
        }
        for (const marker of removed) { const bytes = canonical(marker); this.db.prepare('INSERT INTO identity VALUES(?,?,?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET phase=excluded.phase,entry_json=excluded.entry_json,entry_digest=excluded.entry_digest').run(bucket, marker.id, 'removed', bytes, sha(bytes)) }
        for (const entry of archived) { const bytes = canonical(entry), ack = canonical(commitReceipt); this.db.prepare('INSERT INTO archive VALUES(?,?,?,?,?,?,?)').run(bucket, entry.id, next.revision, bytes, sha(bytes), ack, sha(ack)) }
        const ack = canonical(commitReceipt), eventLimit = Math.min(512, this.limits.maxRevisions), byteLimit = Math.min(8 * 1024 * 1024, this.limits.maxJournalBytes)
        if (Buffer.byteLength(ack) > byteLimit) throw new NextTurnQueueError('CAPACITY', 'One recent event exceeds storage budget')
        this.db.prepare('INSERT INTO recent_event VALUES(?,?,?,?)').run(bucket, next.revision, ack, Buffer.byteLength(ack))
        for (let count = 0; count < 32; count++) {
          const totals = this.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(byte_count),0) AS bytes FROM recent_event WHERE bucket=?').get(bucket)
          if (number(totals?.count) <= eventLimit && number(totals?.bytes) <= byteLimit) break
          this.db.prepare('DELETE FROM recent_event WHERE bucket=? AND revision=(SELECT MIN(revision) FROM recent_event WHERE bucket=?)').run(bucket, bucket)
        }
        const totals = this.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(byte_count),0) AS bytes FROM recent_event WHERE bucket=?').get(bucket)
        if (number(totals?.count) > eventLimit || number(totals?.bytes) > byteLimit) throw new NextTurnQueueError('CAPACITY', 'Bounded event rotation could not fit')
        this.db.prepare('UPDATE scope_head SET revision=?,state_json=?,state_digest=?,head_digest=?,op_count=?,entry_count=?,archive_count=?,active_count=? WHERE bucket=? AND revision=?').run(next.revision, canonical(next), sha(canonical(next)), record.snapshotDigest, next.revision, (row ? number(row.entry_count) : 0) + (captured.kind === 'enqueue' ? 1 : 0), (row ? number(row.archive_count) : 0) + archived.length, next.entries.filter(entry => entry.phase !== 'terminal').length, bucket, expectedRevision)
        await this.options.testHook?.('before-commit'); assertAuthority()
        if (this.closing) throw new NextTurnQueueError('AUTHORITY', 'SQLite owner closed before commit')
        this.db.exec('COMMIT'); committed = true
        this.remember(bucket, { revision: next.revision, digest: record.snapshotDigest })
        await this.options.testHook?.('after-commit')
        return { state: structuredClone(next), receipt: commitReceipt, replayed: false, durabilityWarnings: [] }
      } catch (error) {
        if (begun && !committed) this.db.exec('ROLLBACK')
        if (error instanceof NextTurnQueueError) throw error
        throw new NextTurnQueueError('IO', committed ? 'SQLite commit exists; ACK interrupted' : 'SQLite transaction failed: ' + (error instanceof Error ? error.message : 'native failure'))
      }
    })
  }
  findCommitted(scope: NextTurnQueueScope, operationId: string): Promise<{ state: NextTurnQueueState; receipt: QueueCommitReceipt } | null> { return this.owned(() => { const { bucket } = this.current(scope), row = this.db.prepare('SELECT * FROM operation WHERE bucket=? AND operation_id=?').get(bucket, operationId); const proof = row ? this.proof(row) : null; return proof ? { state: structuredClone(proof.state), receipt: receipt(proof) } : null }) }
  queryExact(scope: NextTurnQueueScope, expectedRevision: number, operationId: string, operation: NextTurnQueueMutation) {
    assertQueueScope(scope)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof operationId !== 'string' || !operationId.trim() || operationId.length > 256 || operationId.startsWith('__') || /[\u0000-\u001f\u007f]/.test(operationId)) return Promise.reject(new NextTurnQueueError('INVALID', 'Unknown ACK selector is invalid'))
    assertQueueJsonValue(operation, this.limits.maxStateBytes + 8192)
    const captured = structuredClone(operation)
    return this.owned(() => {
      const { bucket } = this.current(scope), row = this.db.prepare('SELECT * FROM operation WHERE bucket=? AND operation_id=?').get(bucket, operationId)
      if (!row) return { status: 'absent' as const }
      const proof = this.proof(row)
      if (proof.operationDigest !== sha(canonical({ expectedRevision, operation: captured }))) throw new NextTurnQueueError('CONFLICT', 'Unknown ACK query changed original operation bytes')
      return { status: 'committed' as const, state: structuredClone(proof.state), receipt: receipt(proof) }
    })
  }
  async findReceipt(scope: NextTurnQueueScope, operationId: string): Promise<QueueCommitReceipt | null> { return (await this.findCommitted(scope, operationId))?.receipt ?? null }
  findArchived(scope: NextTurnQueueScope, id: string): Promise<ArchivedQueueEntry | null> {
    return this.owned(() => {
      const { bucket } = this.current(scope), row = this.db.prepare('SELECT * FROM archive WHERE bucket=? AND id=?').get(bucket, id)
      if (!row) return null
      const entry = decode<NextTurnQueueEntry>(row.entry_json, row.entry_digest), archiveReceipt = decode<QueueCommitReceipt>(row.receipt_json, row.receipt_digest)
      const committed = this.db.prepare('SELECT * FROM operation WHERE bucket=? AND revision=?').get(bucket, number(row.revision))
      const proof = committed ? this.proof(committed) : undefined
      if (!proof || entry.id !== id || entry.phase !== 'terminal' || canonical(receipt(proof)) !== canonical(archiveReceipt) || !proof.archived.some(candidate => canonical(candidate) === canonical(entry))) throw new NextTurnQueueError('CORRUPT', 'Archive lookup lost its exact committed operation proof')
      return { entry, archiveReceipt }
    })
  }
  listScopes(maximum = 200): Promise<NextTurnQueueScope[]> { return this.owned(() => { if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 200) throw new NextTurnQueueError('INVALID', 'Active scope read budget is invalid'); const scopes: NextTurnQueueScope[] = []; for (const row of this.db.prepare('SELECT * FROM scope_head WHERE active_count>0 ORDER BY active_count,bucket LIMIT ?').iterate(maximum + 1)) { const state = this.verifyHead(row); scopes.push(state.scope); if (scopes.length > maximum) throw new NextTurnQueueError('CAPACITY', 'Active scope restoration budget exceeded') }; return scopes }) }
  diagnostics(scope: NextTurnQueueScope) { return this.owned(() => { const { bucket, state } = this.current(scope), events = this.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(byte_count),0) AS bytes FROM recent_event WHERE bucket=?').get(bucket); return { runtime: process.versions.node, packagedRuntimeVerified: false as const, revision: state.revision, events: number(events?.count), eventBytes: number(events?.bytes), verifiedScopes: this.verified.size, maxVerifiedScopes: this.maxVerifiedScopes } }) }
  close(): Promise<void> { if (!this.closed) { this.closing = true; this.closed = this.serial.catch(() => {}).then(() => { this.db.close(); this.verified.clear() }) }; return this.closed }
}
