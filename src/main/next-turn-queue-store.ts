import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  DEFAULT_NEXT_TURN_QUEUE_LIMITS,
  NextTurnQueueError,
  type NextTurnQueueLimits,
  type NextTurnQueueMutation,
  type NextTurnQueueEntry,
  type NextTurnQueueScope,
  type NextTurnQueueState,
  type QueueCommitReceipt,
  type QueueCommitResult
} from '../shared/next-turn-queue'
import {
  applyNextTurnQueueMutation,
  assertQueueJsonValue,
  assertQueueLimits,
  assertQueueScope,
  assertQueueState,
  emptyNextTurnQueue,
  queueScopeIdentity
} from '../shared/next-turn-queue-state'

interface JournalRecordBase {
  schemaVersion: 1 | 2
  bucketKey: string
  previousDigest: string | null
  operationId: string
  operationDigest: string
  committedAt: number
  state: NextTurnQueueState
  snapshotDigest: string
}
type JournalRecord = (JournalRecordBase & { schemaVersion: 1 }) | (JournalRecordBase & {
  schemaVersion: 2
  /** The archive and removal share the same immutable exclusive revision slot. */
  archived: NextTurnQueueEntry[]
  mutation: NextTurnQueueMutation
})
export interface ArchivedQueueEntry {
  entry: NextTurnQueueEntry
  archiveReceipt: QueueCommitReceipt
}
export interface QueueStoreRead {
  state: NextTurnQueueState
  auxiliaryFiles: string[]
  receipt?: QueueCommitReceipt
}
export type QueueJournalPhase = 'after-stage-fsync' | 'after-ready-rename' | 'after-publish'
export interface QueueJournalTestHookContext {
  phase: QueueJournalPhase
  bucket: string
  stage: string
  ready: string
  committed: string
  record: Readonly<JournalRecord>
}
export interface NextTurnQueueStoreOptions {
  limits?: NextTurnQueueLimits
  /** Trusted construction/test seam, never an IPC parameter or renderer callback. */
  testHook?: (context: QueueJournalTestHookContext) => Promise<void>
}
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  const record = value as Record<string, unknown>
  return (
    '{' +
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => JSON.stringify(key) + ':' + canonical(record[key]))
      .join(',') +
    '}'
  )
}
const codeOf = (error: unknown): string =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'UNKNOWN'
const isMissing = (error: unknown): boolean => codeOf(error) === 'ENOENT'
function journalName(revision: number): string {
  return 'r' + String(revision).padStart(10, '0') + '.json'
}
function receipt(record: JournalRecord): QueueCommitReceipt {
  return {
    bucketKey: record.bucketKey,
    revision: record.state.revision,
    operationId: record.operationId,
    committedAt: record.committedAt,
    snapshotDigest: record.snapshotDigest
  }
}
function makeRecord(
  scope: NextTurnQueueScope,
  state: NextTurnQueueState,
  operationId: string,
  operationDigest: string,
  previousDigest: string | null,
  archival?: { archived: NextTurnQueueEntry[]; mutation: NextTurnQueueMutation }
): JournalRecord {
  const unsigned = {
    ...(archival ? { schemaVersion: 2 as const, ...archival } : { schemaVersion: 1 as const }),
    bucketKey: sha(queueScopeIdentity(scope)),
    previousDigest,
    operationId,
    operationDigest,
    committedAt: Date.now(),
    state
  }
  return { ...unsigned, snapshotDigest: sha(canonical(unsigned)) }
}

function removeArchived(state: NextTurnQueueState, archived: NextTurnQueueEntry[]): NextTurnQueueState {
  const ids = new Set(archived.map(entry => entry.id))
  return { ...structuredClone(state), entries: state.entries.filter(entry => !ids.has(entry.id)).map(entry => structuredClone(entry)) }
}

/** Immutable files + exclusive hard-link publication implement cross-process CAS without stale lock deletion. */
export class NextTurnQueueStore {
  readonly root: string
  readonly limits: NextTurnQueueLimits
  constructor(
    root: string,
    private readonly options: NextTurnQueueStoreOptions = {}
  ) {
    this.root = resolve(root)
    this.limits = { ...(options.limits ?? DEFAULT_NEXT_TURN_QUEUE_LIMITS) }
    assertQueueLimits(this.limits)
  }
  bucketPath(scope: NextTurnQueueScope): string {
    assertQueueScope(scope)
    return join(this.root, sha(queueScopeIdentity(scope)))
  }
  private async ensureDirectory(directory: string): Promise<void> {
    await fs.mkdir(directory, { recursive: true })
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new NextTurnQueueError(
        'SCOPE',
        'Queue journal directory is not an owned ordinary directory'
      )
  }
  private async diagnose(
    bucket: string,
    phase: string,
    error: unknown
  ): Promise<string | undefined> {
    const file = join(bucket, 'error-' + Date.now() + '-' + randomUUID() + '.json')
    try {
      const evidence = {
        schemaVersion: 1,
        at: new Date().toISOString(),
        phase,
        code: codeOf(error),
        message: error instanceof Error ? error.message.slice(0, 4096) : 'Queue operation failed',
        processId: process.pid
      }
      const data = JSON.stringify(evidence, null, 2),
        names = (await fs.readdir(bucket)).filter((name) => !/^r\d{10}\.json$/.test(name))
      let auxiliaryBytes = 0
      for (const name of names) {
        try {
          auxiliaryBytes += (await fs.lstat(join(bucket, name))).size
        } catch (error) {
          if (!isMissing(error)) throw error
        }
      }
      // Retain original evidence when the observed budget is full; never erase failures to make space.
      if (
        names.length + 1 > this.limits.maxAuxiliaryFiles ||
        auxiliaryBytes + Buffer.byteLength(data, 'utf8') > this.limits.maxAuxiliaryBytes
      )
        return undefined
      await fs.writeFile(file, data, { flag: 'wx' })
      return file
    } catch {
      return undefined
    }
  }
  private async records(scope: NextTurnQueueScope): Promise<{
    records: JournalRecord[]
    auxiliaryFiles: string[]
    journalBytes: number
    auxiliaryBytes: number
  }> {
    const bucket = this.bucketPath(scope)
    let names: string[]
    try {
      const stat = await fs.lstat(bucket)
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new NextTurnQueueError('SCOPE', 'Queue bucket is not an ordinary directory')
      names = await fs.readdir(bucket)
    } catch (error) {
      if (isMissing(error))
        return { records: [], auxiliaryFiles: [], journalBytes: 0, auxiliaryBytes: 0 }
      throw error
    }
    const revisions = names.filter((name) => /^r\d{10}\.json$/.test(name)).sort()
    if (
      names.some(
        (name) =>
          !/^r\d{10}\.json$/.test(name) &&
          !/^(stage|ready|initializing)-[a-f0-9-]+\.json$/.test(name) &&
          !/^error-\d+-[a-f0-9-]+\.json$/.test(name)
      )
    )
      throw new NextTurnQueueError(
        'CORRUPT',
        'Unrecognized journal filename; no earlier prefix is silently substituted'
      )
    if (revisions.length === 0)
      throw new NextTurnQueueError(
        'CORRUPT',
        'Existing queue bucket has no committed bootstrap; auxiliary evidence is retained'
      )
    const auxiliaryFiles: string[] = []
    let auxiliaryBytes = 0
    for (const name of names.filter((name) => !revisions.includes(name))) {
      let stat: Awaited<ReturnType<typeof fs.lstat>>
      try {
        stat = await fs.lstat(join(bucket, name))
      } catch (error) {
        if (isMissing(error)) continue
        throw error
      }
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new NextTurnQueueError('CORRUPT', 'Queue auxiliary evidence is not an ordinary file')
      auxiliaryFiles.push(name)
      auxiliaryBytes += stat.size
    }
    if (auxiliaryFiles.length > this.limits.maxAuxiliaryFiles)
      throw new NextTurnQueueError(
        'CAPACITY',
        'Queue auxiliary file budget exceeded; retained evidence needs owner review'
      )
    if (auxiliaryBytes > this.limits.maxAuxiliaryBytes)
      throw new NextTurnQueueError(
        'CAPACITY',
        'Queue auxiliary byte budget exceeded; retained evidence needs owner review'
      )
    if (revisions.length > this.limits.maxRevisions)
      throw new NextTurnQueueError('CAPACITY', 'Queue journal revision budget exceeded')
    const result: JournalRecord[] = [],
      bucketKey = sha(queueScopeIdentity(scope))
    const usedEntryIds = new Set<string>()
    let journalBytes = 0,
      previousDigest: string | null = null
    for (let index = 0; index < revisions.length; index++) {
      const file = join(bucket, revisions[index]),
        stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || revisions[index] !== journalName(index))
        throw new NextTurnQueueError('CORRUPT', 'Queue journal sequence/link is invalid')
      journalBytes += stat.size
      if (
        // A v2 record contains the bounded old terminal batch, mutation and new active state.
        stat.size > 3 * this.limits.maxStateBytes + 8192 ||
        journalBytes > this.limits.maxJournalBytes
      )
        throw new NextTurnQueueError('CAPACITY', 'Queue journal byte budget exceeded')
      let value: unknown
      try {
        value = JSON.parse(await fs.readFile(file, 'utf8'))
      } catch {
        throw new NextTurnQueueError(
          'CORRUPT',
          'Queue journal contains unreadable JSON; original bytes are retained'
        )
      }
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new NextTurnQueueError('CORRUPT', 'Queue journal record is invalid')
      const record = value as JournalRecord
      const fields = [
        'schemaVersion',
        'bucketKey',
        'previousDigest',
        'operationId',
        'operationDigest',
        'committedAt',
        'state',
        'snapshotDigest'
      ]
      if (record.schemaVersion === 2) fields.push('archived', 'mutation')
      if (
        Object.keys(record).some((key) => !fields.includes(key)) ||
        (record.schemaVersion !== 1 && record.schemaVersion !== 2) ||
        (record.schemaVersion === 1 && (stat.size > this.limits.maxStateBytes + 8192 || result.at(-1)?.schemaVersion === 2)) ||
        record.bucketKey !== bucketKey ||
        record.previousDigest !== previousDigest ||
        typeof record.operationId !== 'string' ||
        !record.operationId ||
        typeof record.operationDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record.operationDigest) ||
        !Number.isSafeInteger(record.committedAt) ||
        record.committedAt < 0 ||
        typeof record.snapshotDigest !== 'string'
      )
        throw new NextTurnQueueError('CORRUPT', 'Queue journal identity/chain is invalid')
      const { snapshotDigest, ...unsigned } = record
      if (snapshotDigest !== sha(canonical(unsigned)))
        throw new NextTurnQueueError(
          'CORRUPT',
          'Queue journal checksum changed; no empty fallback is allowed'
        )
      try {
        assertQueueState(record.state, scope, this.limits)
      } catch (error) {
        throw new NextTurnQueueError(
          'CORRUPT',
          'Queue journal state is invalid: ' +
            (error instanceof Error ? error.message : 'validation failed')
        )
      }
      if (record.state.revision !== index)
        throw new NextTurnQueueError(
          'CORRUPT',
          'Queue snapshot revision differs from its journal slot'
        )
      if (record.schemaVersion === 2) {
        const previous = result.at(-1)
        if (!previous || !Array.isArray(record.archived) || record.archived.length > 32)
          throw new NextTurnQueueError('CORRUPT', 'Archive record needs a previous commit and a bounded batch')
        const ids = new Set<string>()
        for (const entry of record.archived) {
          if (!entry || typeof entry !== 'object' || entry.phase !== 'terminal' || ids.has(entry.id) ||
            canonical(previous.state.entries.find(candidate => candidate.id === entry.id)) !== canonical(entry))
            throw new NextTurnQueueError('CORRUPT', 'Archive can only retain an exact previously committed terminal entry')
          ids.add(entry.id)
        }
        try {
          if (record.operationDigest !== sha(canonical({ expectedRevision: previous.state.revision, operation: record.mutation })))
            throw new Error('Archive mutation digest differs')
          if (record.mutation.kind === 'enqueue' && usedEntryIds.has(record.mutation.id))
            throw new Error('Archived entry identity was reused')
          const reconstructed = applyNextTurnQueueMutation(removeArchived(previous.state, record.archived), previous.state.revision, record.mutation, this.limits)
          if (canonical(reconstructed) !== canonical(record.state)) throw new Error('Archive and active state do not share one transition')
        } catch (error) {
          throw new NextTurnQueueError('CORRUPT', 'Archive transaction is invalid: ' + (error instanceof Error ? error.message : 'validation failed'))
        }
      }
      result.push(record)
      for (const entry of record.state.entries) usedEntryIds.add(entry.id)
      for (const entry of record.state.removed) usedEntryIds.add(entry.id)
      previousDigest = snapshotDigest
    }
    return { records: result, auxiliaryFiles, journalBytes, auxiliaryBytes }
  }
  async read(scope: NextTurnQueueScope): Promise<QueueStoreRead> {
    assertQueueScope(scope)
    const bucket = this.bucketPath(scope)
    try {
      const current = await this.records(scope),
        record = current.records.at(-1)
      return {
        state: record ? structuredClone(record.state) : emptyNextTurnQueue(scope),
        auxiliaryFiles: current.auxiliaryFiles,
        ...(record ? { receipt: receipt(record) } : {})
      }
    } catch (error) {
      const evidence = await this.diagnose(bucket, 'read', error)
      if (error instanceof NextTurnQueueError)
        throw new NextTurnQueueError(error.code, error.message, evidence)
      throw new NextTurnQueueError(
        'IO',
        'Queue journal could not be read: ' + codeOf(error),
        evidence
      )
    }
  }
  async findReceipt(
    scope: NextTurnQueueScope,
    operationId: string
  ): Promise<QueueCommitReceipt | null> {
    assertQueueScope(scope)
    try {
      const record = (await this.records(scope)).records.find(
        (item) => item.operationId === operationId
      )
      return record ? receipt(record) : null
    } catch (error) {
      const evidence = await this.diagnose(this.bucketPath(scope), 'receipt-read', error)
      if (error instanceof NextTurnQueueError)
        throw new NextTurnQueueError(error.code, error.message, evidence)
      throw new NextTurnQueueError(
        'IO',
        'Queue receipt could not be read: ' + codeOf(error),
        evidence
      )
    }
  }
  async findCommitted(scope: NextTurnQueueScope, operationId: string): Promise<{ state: NextTurnQueueState; receipt: QueueCommitReceipt } | null> {
    const record = (await this.records(scope)).records.find(item => item.operationId === operationId)
    return record ? { state: structuredClone(record.state), receipt: receipt(record) } : null
  }
  /** Verified immutable history retains authored bytes, exact frozen wire and original outcome. */
  async findArchived(scope: NextTurnQueueScope, id: string): Promise<ArchivedQueueEntry | null> {
    assertQueueScope(scope)
    const records = (await this.records(scope)).records
    for (const record of records) {
      if (record.schemaVersion !== 2) continue
      const entry = record.archived.find(candidate => candidate.id === id)
      if (entry) return { entry: structuredClone(entry), archiveReceipt: receipt(record) }
    }
    return null
  }
  /** Only journal-owned scopes are discoverable; renderer paths never select a directory. */
  async listScopes(maximum = 200): Promise<NextTurnQueueScope[]> {
    let directories: import('node:fs').Dirent[]
    try {
      const stat = await fs.lstat(this.root)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new NextTurnQueueError('SCOPE', 'Queue restoration root is not an owned ordinary directory')
      directories = await fs.readdir(this.root, { withFileTypes: true })
    } catch (error) { if (isMissing(error)) return []; throw error }
    const buckets = directories.filter(item => /^[a-f0-9]{64}$/.test(item.name))
    if (buckets.length > maximum) throw new NextTurnQueueError('CAPACITY', 'Queue restoration bucket budget exceeded')
    const scopes: NextTurnQueueScope[] = []
    for (const item of buckets) {
      if (!item.isDirectory() || item.isSymbolicLink()) throw new NextTurnQueueError('SCOPE', 'Queue restoration found an unowned link')
      const bucket = join(this.root, item.name), names = (await fs.readdir(bucket)).filter(name => /^r\d{10}\.json$/.test(name)).sort()
      if (!names.length) throw new NextTurnQueueError('CORRUPT', 'Retained queue bucket has no committed bootstrap')
      const file = join(bucket, names[0]), stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.limits.maxStateBytes + 8192) throw new NextTurnQueueError('CORRUPT', 'Queue scope record is not an ordinary bounded file')
      const candidate: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
      if (!candidate || typeof candidate !== 'object' || !('state' in candidate)) throw new NextTurnQueueError('CORRUPT', 'Queue scope record is invalid')
      const state = candidate.state
      if (!state || typeof state !== 'object' || !('scope' in state)) throw new NextTurnQueueError('CORRUPT', 'Queue scope is missing')
      assertQueueScope(state.scope)
      if (this.bucketPath(state.scope) !== bucket) throw new NextTurnQueueError('SCOPE', 'Queue directory does not match its scope')
      const verified = await this.read(state.scope)
      if (verified.state.entries.some(entry => entry.phase !== 'terminal')) scopes.push(verified.state.scope)
    }
    return scopes
  }
  private async syncDirectory(directory: string): Promise<string[]> {
    try {
      const handle = await fs.open(directory, 'r')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      return []
    } catch (error) {
      return ['directory-sync-unavailable:' + codeOf(error)]
    }
  }
  private async publish(
    scope: NextTurnQueueScope,
    record: JournalRecord,
    assertAuthority: () => void,
    allowHooks: boolean
  ): Promise<string[]> {
    const bucket = this.bucketPath(scope),
      nonce = randomUUID(),
      stage = join(bucket, 'stage-' + nonce + '.json'),
      ready = join(bucket, 'ready-' + nonce + '.json'),
      committed = join(bucket, journalName(record.state.revision))
    const context = { bucket, stage, ready, committed, record }
    let phase = 'write',
      handle: Awaited<ReturnType<typeof fs.open>> | undefined,
      published = false
    try {
      assertAuthority()
      handle = await fs.open(stage, 'wx', 0o600)
      await handle.writeFile(canonical(record), 'utf8')
      phase = 'file-fsync'
      await handle.sync()
      await handle.close()
      handle = undefined
      if (allowHooks) await this.options.testHook?.({ ...context, phase: 'after-stage-fsync' })
      phase = 'ready-rename'
      await fs.rename(stage, ready)
      if (allowHooks) await this.options.testHook?.({ ...context, phase: 'after-ready-rename' })
      phase = 'publish-cas'
      assertAuthority()
      // link is exclusive: a second instance cannot overwrite a committed next revision.
      await fs.link(ready, committed)
      published = true
      const warnings = await this.syncDirectory(bucket)
      if (allowHooks) await this.options.testHook?.({ ...context, phase: 'after-publish' })
      try {
        await fs.unlink(ready)
      } catch (error) {
        warnings.push('ready-cleanup-unavailable:' + codeOf(error))
      }
      return warnings
    } catch (error) {
      if (handle) await handle.close().catch(() => {})
      if (!published && phase === 'publish-cas' && codeOf(error) === 'EEXIST') {
        await fs.unlink(ready).catch(() => {})
        await fs.unlink(stage).catch(() => {})
        throw new NextTurnQueueError('CAS', 'Another queue owner committed this revision')
      }
      const evidence = await this.diagnose(
        bucket,
        published ? 'after-commit-ack-unknown' : phase,
        error
      )
      if (error instanceof NextTurnQueueError)
        throw new NextTurnQueueError(error.code, error.message, evidence)
      throw new NextTurnQueueError(
        'IO',
        (published
          ? 'Queue commit exists but acknowledgement was interrupted: '
          : 'Queue journal mutation failed: ') + codeOf(error),
        evidence
      )
    }
  }
  private async bootstrap(scope: NextTurnQueueScope, assertAuthority: () => void): Promise<void> {
    const bucket = this.bucketPath(scope)
    let created = false
    try {
      await fs.mkdir(bucket)
      created = true
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error
    }
    const stat = await fs.lstat(bucket)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new NextTurnQueueError('SCOPE', 'Queue bucket is not an owned ordinary directory')
    if (!created) {
      // Observe an in-flight first owner, but never reconstruct an existing directory from empty state.
      for (let attempt = 0; attempt < 25; attempt++) {
        try {
          await fs.lstat(join(bucket, journalName(0)))
          return
        } catch (error) {
          if (!isMissing(error)) throw error
        }
        await new Promise<void>((done) => setTimeout(done, 10))
        assertAuthority()
      }
      const names = await fs.readdir(bucket)
      if (names.some((name) => /^initializing-[a-f0-9-]+\.json$/.test(name)))
        throw new NextTurnQueueError(
          'CAS',
          'Queue bootstrap owner has not acknowledged publication; retry or reconcile the retained initialization evidence'
        )
      throw new NextTurnQueueError(
        'CORRUPT',
        'Existing queue bucket lacks bootstrap; it cannot be reconstructed by a mutation'
      )
    }
    const marker = join(bucket, 'initializing-' + randomUUID() + '.json')
    const record = makeRecord(
      scope,
      emptyNextTurnQueue(scope),
      '__bootstrap__',
      sha('bootstrap'),
      null
    )
    const markerData = JSON.stringify({ schemaVersion: 1, processId: process.pid, at: Date.now() }),
      recordBytes = Buffer.byteLength(canonical(record), 'utf8')
    if (
      recordBytes > this.limits.maxJournalBytes ||
      recordBytes + Buffer.byteLength(markerData, 'utf8') > this.limits.maxAuxiliaryBytes ||
      this.limits.maxAuxiliaryFiles < 2
    )
      throw new NextTurnQueueError(
        'CAPACITY',
        'Queue bootstrap exceeds the configured journal/staging budget'
      )
    await fs.writeFile(marker, markerData, { flag: 'wx' })
    await this.publish(scope, record, assertAuthority, false)
    await fs.unlink(marker)
  }
  async mutate(
    scope: NextTurnQueueScope,
    expectedRevision: number,
    operationId: string,
    operation: NextTurnQueueMutation,
    assertAuthority: () => void
  ): Promise<QueueCommitResult> {
    assertQueueScope(scope)
    assertQueueJsonValue(operation, this.limits.maxStateBytes + 8192)
    if (
      typeof operationId !== 'string' ||
      !operationId.trim() ||
      operationId.length > 256 ||
      operationId.startsWith('__') ||
      /[\u0000-\u001f\u007f]/.test(operationId)
    )
      throw new NextTurnQueueError('INVALID', 'Operation ID is invalid')
    assertAuthority()
    const bucket = this.bucketPath(scope)
    try {
      await this.ensureDirectory(this.root)
      await this.bootstrap(scope, assertAuthority)
      const current = await this.records(scope),
        last = current.records.at(-1)!
      const operationDigest = sha(canonical({ expectedRevision, operation })),
        existing = current.records.find((item) => item.operationId === operationId)
      if (existing) {
        if (existing.operationDigest !== operationDigest)
          throw new NextTurnQueueError(
            'CONFLICT',
            'Operation ID was already committed with another mutation'
          )
        assertAuthority()
        const durabilityWarnings = await this.syncDirectory(bucket)
        assertAuthority()
        return {
          state: structuredClone(last.state),
          receipt: receipt(existing),
          replayed: true,
          durabilityWarnings
        }
      }
      if (operation.kind === 'enqueue' && current.records.some(record =>
        record.state.entries.some(entry => entry.id === operation.id) || record.state.removed.some(entry => entry.id === operation.id) ||
        (record.schemaVersion === 2 && record.archived.some(entry => entry.id === operation.id))))
        throw new NextTurnQueueError('CONFLICT', 'Entry identity was already used in committed history')
      const terminal = last.state.entries.filter(entry => entry.phase === 'terminal')
      const retain = Math.min(16, Math.max(0, this.limits.maxEntries - 1))
      const required = operation.kind === 'enqueue' && last.state.entries.length >= this.limits.maxEntries ? 1 : 0
      const archived = terminal.slice(0, Math.min(32, Math.max(required, terminal.length - retain)))
      const state = applyNextTurnQueueMutation(removeArchived(last.state, archived), expectedRevision, operation, this.limits)
      // The first v2 commit arbitrates the exact slot an already prepared v1 writer would publish.
      // Later records must stay v2, so an old reader cannot silently continue after the fence.
      const archival = archived.length || last.schemaVersion === 2 ? { archived, mutation: structuredClone(operation) } : undefined
      const record = makeRecord(scope, state, operationId, operationDigest, last.snapshotDigest, archival),
        size = Buffer.byteLength(canonical(record), 'utf8')
      if (
        current.records.length + 1 > this.limits.maxRevisions ||
        current.journalBytes + size > this.limits.maxJournalBytes
      )
        throw new NextTurnQueueError(
          'CAPACITY',
          'Committed queue journal budget exhausted; existing entries are retained'
        )
      if (
        current.auxiliaryFiles.length + 1 > this.limits.maxAuxiliaryFiles ||
        current.auxiliaryBytes + size > this.limits.maxAuxiliaryBytes
      )
        throw new NextTurnQueueError(
          'CAPACITY',
          'Queue auxiliary staging budget exhausted; retained evidence is not deleted'
        )
      const durabilityWarnings = await this.publish(scope, record, assertAuthority, true)
      return {
        state: structuredClone(state),
        receipt: receipt(record),
        replayed: false,
        durabilityWarnings
      }
    } catch (error) {
      if (error instanceof NextTurnQueueError) {
        if (error.code !== 'CORRUPT') throw error
        const evidence = await this.diagnose(bucket, 'mutate-read', error)
        throw new NextTurnQueueError(error.code, error.message, evidence)
      }
      const evidence = await this.diagnose(bucket, 'mutate', error)
      throw new NextTurnQueueError('IO', 'Queue mutation failed: ' + codeOf(error), evidence)
    }
  }
}
