import { type QueueAuthorityCheck } from './next-turn-queue-authority-fence'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { DEFAULT_NEXT_TURN_QUEUE_LIMITS, NextTurnQueueError, type NextTurnQueueLimits, type NextTurnQueueMutation, type NextTurnQueueScope, type NextTurnQueueState, type QueueCommitReceipt, type QueueCommitResult } from '../shared/next-turn-queue'
import { assertQueueJsonValue, assertQueueLimits, assertQueueScope, sameQueueScope } from '../shared/next-turn-queue-state'
import type { NextTurnQueueRepository } from './next-turn-queue-repository'
import type { ArchivedQueueEntry, QueueStoreRead } from './next-turn-queue-store'
import { assertQueueWorkerInputFrame, assertWorkerEpoch, QUEUE_WORKER_RPC_LIMITS, type QueueWorkerBody, type QueueWorkerOutput, type QueueWorkerPhase, type QueueWorkerInput, type QueueWorkerStart } from './next-turn-queue-worker-protocol'

type ExactQuery = Extract<QueueWorkerBody, { method: 'queryExact' | 'mutate' }>
export type QueueWorkerOutcome = { status: 'absent' } | { status: 'committed'; state: NextTurnQueueState; receipt: QueueCommitReceipt }
export class QueueWorkerCommitUnknownError extends NextTurnQueueError {
  readonly commitMayExist = true
  readonly exactQuery: ExactQuery
  constructor(message: string, query: ExactQuery) {
    super('IO', message); this.exactQuery = structuredClone({ ...query, method: 'queryExact' })
  }
}
export interface QueueSqliteWorkerOptions {
  /** No factory selection or legacy JSON activation is installed by this experiment. */
  nativeExperimentOnly: true
  workerBundle: { path: string; sha256: string }
  identity: Omit<NextTurnQueueScope, 'taskId'>
  generation: string
  /** Production integration must revoke the shared epoch on every source/namespace change. */
  assertGeneration: () => void
  requireExisting?: boolean
  requireCapabilityFence?: boolean
  maxVerifiedScopes?: number
  limits?: NextTurnQueueLimits
  rpcLimits?: { maxRequests: number; maxRequestBytes: number; maxFrameBytes: number; deadlineMs: number }
  deadlines?: { startupMs: number; stopMs: number }
  test?: { holdAt?: QueueWorkerPhase; hangAt?: 'startup' | 'close'; onBarrier: (event: { id: string; step: QueueWorkerPhase }) => void }
}
interface Pending {
  body: QueueWorkerBody
  bytes: number
  sent: boolean
  assertAuthority: QueueAuthorityCheck
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Trusted owned RPC experiment. SQLite execution and restart auditing happen in
 * an actual native worker. Packaged Electron and migration remain separate gates. */
export class NextTurnQueueSqliteWorker implements NextTurnQueueRepository {
  readonly limits: NextTurnQueueLimits
  readonly generation: string
  private readonly instanceId = randomUUID()
  private readonly worker: Worker
  private readonly shared = new Int32Array(new SharedArrayBuffer(8))
  private readonly identity: Omit<NextTurnQueueScope, 'taskId'>
  private readonly rpcLimits: { [Key in keyof typeof QUEUE_WORKER_RPC_LIMITS]: number }
  private readonly pending = new Map<string, Pending>()
  private pendingBytes = 0
  private closing = false
  private closedAck = false
  private failure: Error | undefined
  private closePromise: Promise<void> | undefined
  private readonly ready: Promise<void>
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private readonly exited: Promise<number>
  private readonly deadlines: { startupMs: number; stopMs: number }
  private startupTimer: ReturnType<typeof setTimeout> | undefined
  private stopDeadlineExceeded = false
  private exitCode: number | undefined
  constructor(readonly file: string, private readonly options: QueueSqliteWorkerOptions) {
    if (options.nativeExperimentOnly !== true || !options.generation) throw new NextTurnQueueError('AUTHORITY', 'SQLite worker is a trusted construction experiment only')
    this.generation = options.generation; this.identity = structuredClone(options.identity)
    assertQueueScope({ ...this.identity, taskId: 'worker-authority-probe' })
    this.limits = { ...(options.limits ?? DEFAULT_NEXT_TURN_QUEUE_LIMITS) }; assertQueueLimits(this.limits)
    this.rpcLimits = { ...(options.rpcLimits ?? QUEUE_WORKER_RPC_LIMITS) }
    for (const key of ['maxRequests','maxRequestBytes','maxFrameBytes','deadlineMs'] as const)
      if (!Number.isSafeInteger(this.rpcLimits[key]) || this.rpcLimits[key] < 1 || this.rpcLimits[key] > QUEUE_WORKER_RPC_LIMITS[key]) throw new NextTurnQueueError('INVALID', 'Worker RPC budget is invalid')
    this.deadlines = { ...(options.deadlines ?? { startupMs: 90000, stopMs: 10000 }) }
    for (const key of ['startupMs','stopMs'] as const) if (!Number.isSafeInteger(this.deadlines[key]) || this.deadlines[key] < 1 || this.deadlines[key] > 90000) throw new NextTurnQueueError('INVALID', 'Worker lifecycle deadline is invalid')
    const bundle = resolve(options.workerBundle.path)
    if (!lstatSync(bundle).isFile() || lstatSync(bundle).isSymbolicLink() || !/^[a-f0-9]{64}$/.test(options.workerBundle.sha256) || createHash('sha256').update(readFileSync(bundle)).digest('hex') !== options.workerBundle.sha256)
      throw new NextTurnQueueError('CORRUPT', 'Worker bundle is missing or differs from the trusted build')
    options.assertGeneration(); Atomics.store(this.shared, 0, 1)
    this.ready = new Promise((done, reject) => { this.readyResolve = done; this.readyReject = reject })
    // A startup error remains available to calls/close without an unhandled rejection.
    void this.ready.catch(() => {})
    const start: QueueWorkerStart = { instanceId: this.instanceId, file: resolve(file), limits: this.limits, identity: this.identity, rpcLimits: this.rpcLimits, epoch: this.shared.buffer as SharedArrayBuffer, requireExisting: options.requireExisting === true, requireCapabilityFence: options.requireCapabilityFence === true, maxVerifiedScopes: options.maxVerifiedScopes, holdAt: options.test?.holdAt, testHangAt: options.test?.hangAt }
    this.worker = new Worker(bundle, { workerData: start })
    this.worker.on('message', (message: QueueWorkerOutput) => this.receive(message))
    this.worker.on('error', error => this.fail(error))
    this.exited = new Promise(done => this.worker.once('exit', code => {
      this.exitCode = code; if (this.startupTimer) clearTimeout(this.startupTimer)
      if (!this.closedAck || code !== 0) this.fail(new NextTurnQueueError('IO', 'Queue worker exited without confirmed native close: ' + code))
      done(code)
    }))
    this.startupTimer = setTimeout(() => this.fail(new NextTurnQueueError('IO', 'Queue worker startup deadline exceeded; owner fenced')), this.deadlines.startupMs)
  }
  private assertOwner(scope?: NextTurnQueueScope): void {
    if (this.closing || this.failure) throw new NextTurnQueueError('AUTHORITY', 'Queue worker owner is fenced or closing')
    this.options.assertGeneration()
    try { assertWorkerEpoch(this.shared, 1) } catch { throw new NextTurnQueueError('AUTHORITY', 'Queue worker source/epoch was revoked') }
    if (scope) {
      assertQueueScope(scope)
      if (!sameQueueScope(scope, { ...this.identity, taskId: scope.taskId })) throw new NextTurnQueueError('SCOPE', 'Queue worker cannot bind another source/namespace/tenant')
    }
  }
  /** Called synchronously by the trusted source lifecycle, never by renderer IPC.
   * Old queued/held operations cannot become valid in a later source epoch. */
  revoke(): void { Atomics.store(this.shared, 0, 2); void this.close().catch(() => {}) }
  private post(message: QueueWorkerInput): void { assertQueueWorkerInputFrame(message, this.rpcLimits.maxFrameBytes); this.worker.postMessage(message) }
  private finish(id: string, error?: Error, value?: unknown): void {
    const item = this.pending.get(id)
    if (!item) return
    this.pending.delete(id); this.pendingBytes -= item.bytes; clearTimeout(item.timer)
    if (error) item.reject(error); else item.resolve(value)
  }
  private unknown(item: Pending, reason: string): Error {
    return item.sent && item.body.method === 'mutate' ? new QueueWorkerCommitUnknownError(reason, item.body) : new NextTurnQueueError('IO', reason)
  }
  private fail(error: Error): void {
    if (!this.failure) this.failure = error
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.closing = true; Atomics.store(this.shared, 1, 1); this.readyReject(error)
    for (const [id, item] of this.pending) this.finish(id, this.unknown(item, 'Worker unavailable; exact durable outcome must be queried'))
    void this.close().catch(() => {})
  }
  private receive(message: QueueWorkerOutput): void {
    try { assertQueueJsonValue(message, this.rpcLimits.maxFrameBytes) } catch { this.fail(new NextTurnQueueError('CAPACITY', 'Worker result/control frame exceeded trusted budget')); return }
    if (!message || message.instanceId !== this.instanceId) return
    if (message.kind === 'ready') { if (this.startupTimer) clearTimeout(this.startupTimer); this.readyResolve(); return }
    if (message.kind === 'closed') { this.closedAck = true; return }
    if (message.kind === 'fatal') { this.fail(new NextTurnQueueError('IO', message.message)); return }
    if (message.kind === 'test-barrier') {
      try { this.options.test?.onBarrier({ id: message.id, step: message.step }) } catch (error) { this.fail(error instanceof Error ? error : new Error('Worker test observer failed')) }
      return
    }
    const item = this.pending.get(message.id)
    if (message.kind === 'authority') {
      let ok = false
      try { if (!item || message.epoch !== 1) throw new Error('Worker authority selector differs'); this.assertOwner('scope' in item.body ? item.body.scope : undefined); item.assertAuthority(); ok = true } catch { /* The worker returns the authoritative no-commit error. */ }
      this.post({ kind: 'authorize', instanceId: this.instanceId, id: message.id, step: message.step, ok, message: ok ? '' : 'owner changed' }); return
    }
    if (message.kind !== 'result' || !item) return
    if (!message.ok) {
      const error = message.commitMayExist && item.body.method === 'mutate' ? new QueueWorkerCommitUnknownError(message.message, item.body) : new NextTurnQueueError(message.code, message.message)
      this.finish(message.id, error); return
    }
    try {
      assertQueueJsonValue(message, this.rpcLimits.maxFrameBytes)
      this.assertOwner('scope' in item.body ? item.body.scope : undefined); item.assertAuthority()
      this.finish(message.id, undefined, message.value)
    } catch (error) { this.finish(message.id, item.body.method === 'mutate' ? this.unknown(item, 'Commit response crossed a revoked source/owner; query exact outcome') : error instanceof Error ? error : new Error('Worker response invalid')) }
  }
  private call<T>(body: QueueWorkerBody, assertAuthority: QueueAuthorityCheck = () => {}): Promise<T> {
    let captured: QueueWorkerBody, bytes: number
    const id = randomUUID()
    try {
      this.assertOwner('scope' in body ? body.scope : undefined); assertAuthority()
      assertQueueJsonValue(body, this.rpcLimits.maxFrameBytes); captured = structuredClone(body)
      if (captured.method === 'mutate' && this.options.requireCapabilityFence && !assertAuthority.capabilityFence) throw new NextTurnQueueError('AUTHORITY', 'Production mutation requires owned capability fence')
      const frame: QueueWorkerInput = { kind: 'request', instanceId: this.instanceId, id, epoch: 1, body: captured, ...(assertAuthority.capabilityFence ? { capabilityFence: assertAuthority.capabilityFence } : {}) }
      assertQueueWorkerInputFrame(frame, this.rpcLimits.maxFrameBytes); bytes = Buffer.byteLength(JSON.stringify({ ...frame, capabilityFence: undefined })) + (assertAuthority.capabilityFence ? 4 : 0)
      if (this.pending.size >= this.rpcLimits.maxRequests || this.pendingBytes + bytes > this.rpcLimits.maxRequestBytes) throw new NextTurnQueueError('CAPACITY', 'Queue worker RPC count/byte budget exceeded')
    } catch (error) { return Promise.reject(error) }
    return new Promise<T>((done, reject) => {
      const timer = setTimeout(() => this.fail(new NextTurnQueueError('IO', 'Queue worker RPC deadline exceeded; owner fenced')), this.rpcLimits.deadlineMs)
      const item: Pending = { body: captured, bytes, sent: false, assertAuthority, resolve: value => done(value as T), reject, timer }
      this.pending.set(id, item); this.pendingBytes += bytes
      void this.ready.then(() => {
        if (!this.pending.has(id)) return
        try {
          this.assertOwner('scope' in captured ? captured.scope : undefined); assertAuthority()
          this.post({ kind: 'request', instanceId: this.instanceId, id, epoch: 1, body: captured, ...(assertAuthority.capabilityFence ? { capabilityFence: assertAuthority.capabilityFence } : {}) }); item.sent = true
        } catch (error) { this.finish(id, error instanceof Error ? error : new Error('Worker post failed')) }
      }, error => this.finish(id, error instanceof Error ? error : new Error('Worker startup failed')))
    })
  }
  read(scope: NextTurnQueueScope): Promise<QueueStoreRead> { return this.call({ method: 'read', scope }) }
  mutate(scope: NextTurnQueueScope, expectedRevision: number, operationId: string, operation: NextTurnQueueMutation, assertAuthority: QueueAuthorityCheck): Promise<QueueCommitResult> { return this.call({ method: 'mutate', scope, expectedRevision, operationId, operation }, assertAuthority) }
  findReceipt(scope: NextTurnQueueScope, operationId: string): Promise<QueueCommitReceipt | null> { return this.call({ method: 'findReceipt', scope, operationId }) }
  findCommitted(scope: NextTurnQueueScope, operationId: string): Promise<{ state: NextTurnQueueState; receipt: QueueCommitReceipt } | null> { return this.call({ method: 'findCommitted', scope, operationId }) }
  findArchived(scope: NextTurnQueueScope, id: string): Promise<ArchivedQueueEntry | null> { return this.call({ method: 'findArchived', scope, id }) }
  queryExact(scope: NextTurnQueueScope, expectedRevision: number, operationId: string, operation: NextTurnQueueMutation): Promise<QueueWorkerOutcome> { return this.call({ method: 'queryExact', scope, expectedRevision, operationId, operation }) }
  listScopes(maximum = 200): Promise<NextTurnQueueScope[]> { return this.call({ method: 'listScopes', maximum }) }
  statistics() { return { pendingRequests: this.pending.size, pendingBytes: this.pendingBytes, closing: this.closing, nativeCloseAcknowledged: this.closedAck, stopDeadlineExceeded: this.stopDeadlineExceeded, workerExitCode: this.exitCode } }
  /** An unconfirmed native stop keeps this join separate from its bounded failure report. */
  waitForExit(): Promise<number> { return this.exited }
  nativeDiagnostics(scope: NextTurnQueueScope): Promise<{ runtime: string; packagedRuntimeVerified: false; revision: number; events: number; eventBytes: number; verifiedScopes: number; maxVerifiedScopes: number }> { return this.call({ method: 'diagnostics', scope }) }
  releaseTestBarrier(): void { if (!this.options.test) throw new Error('Test barrier is not installed'); this.post({ kind: 'release-test', instanceId: this.instanceId }) }
  terminateForTest(): Promise<number> { if (!this.options.test) throw new Error('Test control is not installed'); return this.worker.terminate() }
  close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true; Atomics.store(this.shared, 1, 1)
      this.readyReject(new NextTurnQueueError('AUTHORITY', 'Worker owner is closing'))
      for (const [id, item] of this.pending) if (!item.sent) this.finish(id, new NextTurnQueueError('AUTHORITY', 'Worker closed before request was sent'))
      this.closePromise = new Promise<void>((done, reject) => {
        const timer = setTimeout(() => {
          this.stopDeadlineExceeded = true
          const error = new NextTurnQueueError('IO', 'Native worker stop deadline exceeded; close unconfirmed, retain evidence')
          if (!this.failure) this.failure = error
          for (const [id, item] of this.pending) this.finish(id, this.unknown(item, 'Native stop unconfirmed; exact durable outcome must be queried'))
          reject(error)
          // Termination is an owned recovery attempt, never a successful native close ACK.
          void this.worker.terminate().catch(failure => { if (!this.failure) this.failure = failure })
        }, this.deadlines.stopMs)
        void this.exited.then(code => {
          clearTimeout(timer)
          if (this.pending.size) this.fail(new NextTurnQueueError('IO', 'Worker exit left outstanding requests'))
          if (this.stopDeadlineExceeded || !this.closedAck || code !== 0) reject(new NextTurnQueueError('IO', 'Native worker close ACK was not observed within deadline'))
          else done()
        })
      })
      try { this.post({ kind: 'close', instanceId: this.instanceId }) } catch { /* Actual exit/stop deadline determines close outcome. */ }
    }
    return this.closePromise
  }
}
