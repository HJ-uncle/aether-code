import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NextTurnQueueError, DEFAULT_NEXT_TURN_QUEUE_LIMITS, type NextTurnQueueLimits, type NextTurnQueueMutation, type NextTurnQueueScope } from '../shared/next-turn-queue'
import { assertQueueScope } from '../shared/next-turn-queue-state'
import type { NextTurnQueueRepository } from './next-turn-queue-repository'
import type { QueueAuthorityCheck } from './next-turn-queue-authority-fence'
import { NextTurnQueueSqliteWorker } from './next-turn-queue-sqlite-worker'
import { QueueCatalogRegistry } from './next-turn-queue-catalog-registry'

type Identity = Omit<NextTurnQueueScope, 'taskId'>
export interface QueueWorkerFactoryEpoch { generation: string; source: NextTurnQueueScope['source']; signal: AbortSignal }
export interface QueueWorkerFactoryOptions {
  /** Explicit trusted opt-in; a separate root never activates or migrates JSON. */
  enabled: true
  workerBundle: { path: string; sha256: string }
  captureEpoch(): QueueWorkerFactoryEpoch
  limits?: NextTurnQueueLimits
  maxOwners?: number
  maxCatalogs?: number
  maxVerifiedScopes?: number
}
interface Owner { worker: NextTurnQueueSqliteWorker; epoch: QueueWorkerFactoryEpoch; references: number; disposeAbort(): void }
const canonical = (identity: Identity): string => JSON.stringify([identity.source.mode, identity.source.endpoint, identity.source.accountId, identity.tenantId, identity.namespace.id, identity.namespace.generation, identity.owner])
const identityOf = (scope: NextTurnQueueScope): Identity => { const { taskId: _, ...identity } = scope; return structuredClone(identity) }
const keyOf = (identity: Identity): string => createHash('sha256').update(canonical(identity)).digest('hex')
const sameEpoch = (a: QueueWorkerFactoryEpoch, b: QueueWorkerFactoryEpoch): boolean => a.generation === b.generation && a.signal === b.signal && JSON.stringify(a.source) === JSON.stringify(b.source) && !a.signal.aborted
const ordinary = (file: string, directory: boolean): void => { const stat = lstatSync(file); if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new NextTurnQueueError('SCOPE', 'Owned SQLite catalog is not ordinary') }

/** Actual repository selected only by a main-process launch opt-in. Owners and
 * catalogs have independent bounds; every retired owner retains close/join. */
export class NextTurnQueueWorkerFactory implements NextTurnQueueRepository {
  readonly limits: NextTurnQueueLimits
  private readonly owners = new Map<string, Owner>()
  private readonly retiring = new Set<Promise<void>>()
  private readonly failures: Error[] = []
  private readonly operations = new Set<Promise<unknown>>()
  private readonly maxOwners: number
  private readonly maxCatalogs: number
  private readonly registry: QueueCatalogRegistry
  private serial: Promise<unknown> = Promise.resolve()
  private closing = false
  private closed?: Promise<void>
  constructor(readonly root: string, private readonly options: QueueWorkerFactoryOptions) {
    if (options.enabled !== true) throw new NextTurnQueueError('AUTHORITY', 'SQLite factory requires trusted explicit opt-in')
    this.root = resolve(root); this.limits = { ...(options.limits ?? DEFAULT_NEXT_TURN_QUEUE_LIMITS) }
    this.maxOwners = options.maxOwners ?? 8; this.maxCatalogs = options.maxCatalogs ?? 200
    for (const [value, maximum] of [[this.maxOwners, 16], [this.maxCatalogs, 200]]) if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new NextTurnQueueError('INVALID', 'SQLite factory budget is invalid')
    this.registry = new QueueCatalogRegistry(this.root, this.maxCatalogs)
    this.registry.assertCatalogs()
  }
  private epoch(): QueueWorkerFactoryEpoch {
    const epoch = this.options.captureEpoch()
    if (!epoch.generation || epoch.signal.aborted) throw new NextTurnQueueError('AUTHORITY', 'SQLite factory engine epoch is unavailable')
    return epoch
  }
  private catalog(identity: Identity, creating: boolean): { file: string; existed: boolean } {
    assertQueueScope({ ...identity, taskId: 'owned-catalog-check' })
    const key = keyOf(identity), directory = join(this.root, key), metadata = join(directory, 'identity.json'), file = join(directory, 'queue.sqlite')
    if (!existsSync(directory)) {
      if (!creating) throw new NextTurnQueueError('IO', 'Acknowledged SQLite catalog is missing')
      if (this.catalogs().length >= this.maxCatalogs) throw new NextTurnQueueError('CAPACITY', 'SQLite catalog capacity reached; original evidence retained')
      const descriptor = JSON.stringify({ schemaVersion: 1, key, identity }) + '\n'
      this.registry.register(key, descriptor)
      mkdirSync(directory); ordinary(directory, true)
      writeFileSync(metadata, descriptor, { flag: 'wx' })
      const handle = openSync(metadata, 'r+'); try { fsyncSync(handle) } finally { closeSync(handle) }
      return { file, existed: false }
    }
    ordinary(directory, true); ordinary(metadata, false)
    if (lstatSync(metadata).size > 8192) throw new NextTurnQueueError('CAPACITY', 'SQLite catalog descriptor exceeds budget')
    let value: { schemaVersion: number; key: string; identity: Identity }
    try { value = JSON.parse(readFileSync(metadata, 'utf8')) as typeof value } catch { throw new NextTurnQueueError('CORRUPT', 'SQLite catalog descriptor is invalid') }
    if (value.schemaVersion !== 1 || value.key !== key || keyOf(value.identity) !== key || canonical(value.identity) !== canonical(identity)) throw new NextTurnQueueError('CORRUPT', 'SQLite catalog identity changed')
    // A persisted catalog is an acknowledgement boundary: even an interrupted
    // creation cannot silently reconstruct a fresh empty database on reopen.
    if (!existsSync(file)) throw new NextTurnQueueError('IO', 'Catalog database is missing; retain evidence')
    ordinary(file, false)
    return { file, existed: true }
  }
  private catalogs(): Identity[] {
    const names = this.registry.assertCatalogs()
    if (names.length > this.maxCatalogs) throw new NextTurnQueueError('CAPACITY', 'SQLite catalog enumeration exceeds budget')
    return names.map(name => {
      if (!/^[a-f0-9]{64}$/.test(name)) throw new NextTurnQueueError('CORRUPT', 'Unexpected SQLite catalog leaf')
      const directory = join(this.root, name), metadata = join(directory, 'identity.json')
      ordinary(directory, true); ordinary(metadata, false)
      if (lstatSync(metadata).size > 8192) throw new NextTurnQueueError('CAPACITY', 'SQLite catalog descriptor exceeds budget')
      let value: { schemaVersion: number; key: string; identity: Identity }
      try { value = JSON.parse(readFileSync(metadata, 'utf8')) as typeof value } catch { throw new NextTurnQueueError('CORRUPT', 'SQLite catalog descriptor is invalid') }
      assertQueueScope({ ...value.identity, taskId: 'owned-catalog-check' })
      if (value.schemaVersion !== 1 || value.key !== name || keyOf(value.identity) !== name) throw new NextTurnQueueError('CORRUPT', 'SQLite catalog namespace/key differs')
      return value.identity
    })
  }
  private retire(key: string, owner: Owner): Promise<void> {
    if (this.owners.get(key) !== owner) return Promise.resolve()
    this.owners.delete(key); owner.disposeAbort(); owner.worker.revoke()
    const stopped = (async () => { let failure: unknown; try { await owner.worker.close() } catch (error) { failure = error }; await owner.worker.waitForExit(); if (failure) throw failure })()
    this.retiring.add(stopped)
    stopped.then(() => this.retiring.delete(stopped), error => { this.retiring.delete(stopped); if (this.failures.length < this.maxOwners) this.failures.push(error instanceof Error ? error : new Error('Native close failed')) })
    return stopped
  }
  onEngineChanged(): void {
    let current: QueueWorkerFactoryEpoch | undefined
    try { current = this.epoch() } catch { /* Source is leaving ready state. */ }
    for (const [key, owner] of this.owners) if (!current || !sameEpoch(owner.epoch, current)) void this.retire(key, owner).catch(() => {})
  }
  revoke(): void { for (const [key, owner] of this.owners) void this.retire(key, owner).catch(() => {}) }
  private owner(identity: Identity, creating: boolean): Promise<Owner> {
    const operation = this.serial.catch(() => {}).then(async () => {
      if (this.closing) throw new NextTurnQueueError('AUTHORITY', 'SQLite factory is closing')
      this.onEngineChanged()
      const epoch = this.epoch(), key = keyOf(identity), existing = this.owners.get(key)
      if (existing) { this.owners.delete(key); this.owners.set(key, existing); existing.references++; return existing }
      if (this.retiring.size >= this.maxOwners * 2) throw new NextTurnQueueError('CAPACITY', 'Native owners are still joining')
      if (this.owners.size >= this.maxOwners) {
        const idle = [...this.owners].find(([, owner]) => owner.references === 0 && owner.worker.statistics().pendingRequests === 0)
        if (!idle) throw new NextTurnQueueError('CAPACITY', 'Native owner capacity reached')
        await this.retire(...idle)
      }
      if (this.closing || !sameEpoch(epoch, this.epoch())) throw new NextTurnQueueError('AUTHORITY', 'Native owner construction crossed shutdown or source change')
      const catalog = this.catalog(identity, creating)
      const worker = new NextTurnQueueSqliteWorker(catalog.file, { nativeExperimentOnly: true, workerBundle: this.options.workerBundle, identity, generation: epoch.generation,
        requireExisting: catalog.existed, requireCapabilityFence: true, maxVerifiedScopes: this.options.maxVerifiedScopes,
        limits: this.limits, assertGeneration: () => { if (!sameEpoch(epoch, this.epoch())) throw new NextTurnQueueError('AUTHORITY', 'Native source generation changed') } })
      const abort = (): void => { void this.retire(key, result).catch(() => {}) }
      const result: Owner = { worker, epoch, references: 1, disposeAbort: () => epoch.signal.removeEventListener('abort', abort) }
      this.owners.set(key, result); epoch.signal.addEventListener('abort', abort, { once: true })
      if (epoch.signal.aborted) { abort(); throw new NextTurnQueueError('AUTHORITY', 'Native source changed during construction') }
      return result
    })
    this.serial = operation
    return operation
  }
  private operate<T>(scope: NextTurnQueueScope, operation: (worker: NextTurnQueueSqliteWorker, capturedScope: NextTurnQueueScope) => Promise<T>): Promise<T> {
    if (this.closing || this.operations.size >= 128) return Promise.reject(new NextTurnQueueError('CAPACITY', 'SQLite factory is closing or busy'))
    const captured = structuredClone(scope); assertQueueScope(captured)
    const current = (async () => { const owner = await this.owner(identityOf(captured), true); try { return await operation(owner.worker, captured) } finally { owner.references-- } })()
    this.operations.add(current); const done = (): void => { this.operations.delete(current) }; current.then(done, done)
    return current
  }
  read(scope: NextTurnQueueScope) { return this.operate(scope, (worker, captured) => worker.read(captured)) }
  mutate(scope: NextTurnQueueScope, revision: number, operationId: string, mutation: NextTurnQueueMutation, authority: QueueAuthorityCheck) {
    authority(); const current = this.epoch()
    if (JSON.stringify(current.source) !== JSON.stringify(scope.source)) return Promise.reject(new NextTurnQueueError('SCOPE', 'Native mutation source differs from active engine'))
    const capturedMutation = structuredClone(mutation)
    return this.operate(scope, (worker, captured) => worker.mutate(captured, revision, operationId, capturedMutation, authority))
  }
  findReceipt(scope: NextTurnQueueScope, id: string) { return this.operate(scope, (worker, captured) => worker.findReceipt(captured, id)) }
  findCommitted(scope: NextTurnQueueScope, id: string) { return this.operate(scope, (worker, captured) => worker.findCommitted(captured, id)) }
  listScopes(maximum = 200): Promise<NextTurnQueueScope[]> {
    if (this.closing || this.operations.size >= 128) return Promise.reject(new NextTurnQueueError('CAPACITY', 'SQLite enumeration is closing or busy'))
    const current = this.enumerate(maximum)
    this.operations.add(current); const done = (): void => { this.operations.delete(current) }; current.then(done, done)
    return current
  }
  private async enumerate(maximum: number): Promise<NextTurnQueueScope[]> {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 200) throw new NextTurnQueueError('INVALID', 'Native restore scope budget is invalid')
    const scopes: NextTurnQueueScope[] = []
    for (const identity of this.catalogs()) {
      const owner = await this.owner(identity, false)
      try { scopes.push(...await owner.worker.listScopes(maximum)); if (scopes.length > maximum) throw new NextTurnQueueError('CAPACITY', 'Native restored tasks exceed budget') } finally { owner.references-- }
    }
    return scopes
  }
  diagnostics() { return { owners: this.owners.size, retiring: this.retiring.size, operations: this.operations.size, maxOwners: this.maxOwners, maxCatalogs: this.maxCatalogs, retainedStopFailures: this.failures.map(error => error.message.slice(0, 1024)) } }
  close(): Promise<void> {
    if (!this.closed) {
      this.closing = true; this.revoke()
      this.closed = (async () => { await this.serial.catch(() => {}); await Promise.allSettled([...this.operations]); await Promise.allSettled([...this.retiring]); if (this.failures.length) throw new NextTurnQueueError('IO', 'Native factory close retained unconfirmed stop failures') })()
    }
    return this.closed
  }
}
