import { createHash, randomUUID } from 'node:crypto'
import { NextTurnQueueError, type NextTurnQueueEnvelope, type NextTurnQueueScope, type NextTurnQueueState, type QueueCommitResult } from '../shared/next-turn-queue'
import { queueScopeIdentity, sameQueueScope } from '../shared/next-turn-queue-state'
import type { WorkQueueDraft, WorkQueueRead } from '../shared/work-next-turn-api'
import { NextTurnQueueMutationService, type QueueOwnerCapability, type TrustedQueueAuthority } from './next-turn-queue-service'
import type { AdmissionContext, ExactAdmission } from './next-turn-admission-protocol'
import { freezeQueueRequest, assertFrozenQueueRequest, canonicalAdmissionJson } from './next-turn-admission-protocol'

export interface QueueDispatchGateway extends TrustedQueueAuthority {
  setConnected?(taskId: string, sender: { isDestroyed(): boolean }, connected: boolean): Promise<void>
  close?(): void
  context(scope: NextTurnQueueScope): Promise<AdmissionContext>
  prepare(scope: NextTurnQueueScope, envelope: NextTurnQueueEnvelope, context: AdmissionContext): Promise<Record<string, unknown>>
  envelope(scope: NextTurnQueueScope, draft: WorkQueueDraft): Promise<NextTurnQueueEnvelope>
  recoveryEnvelope?(scope: NextTurnQueueScope, runId: string): Promise<NextTurnQueueEnvelope>
  editDraft(envelope: NextTurnQueueEnvelope, draft: WorkQueueDraft['draft'], scope?: NextTurnQueueScope): NextTurnQueueEnvelope | Promise<NextTurnQueueEnvelope>
  submit(scope: NextTurnQueueScope, wireBody: string, signal: AbortSignal): Promise<void>
  receipt(scope: NextTurnQueueScope, entry: Exclude<NextTurnQueueState['entries'][number], { phase: 'pending' }>): Promise<ExactAdmission>
}
interface Job { capability: QueueOwnerCapability; scope: NextTurnQueueScope; busy?: Promise<void>; error?: string; active: boolean; evictable: boolean; evictionRetryAt?: number; revision: number }
/** A queue is owned by main, not by a selected Work view. Every POST follows a durable claim. */
export class NextTurnDispatcher {
  private readonly jobs = new Map<string, Job>()
  private readonly binding = new Map<string, Promise<Job>>()
  private readonly controller = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly pendingEnqueues = new Map<string, { id: string; expectedRevision: number; inputDigest: string; result: Promise<QueueCommitResult> }>()
  private readonly pendingRestarts = new Map<string, Promise<WorkQueueRead>>()
  private readonly retainedTasks = new Map<string, number>()
  private eviction?: Promise<boolean>
  private evictions = 0
  private closing = false
  private closePromise?: Promise<void>
  private running = 0
  private enqueues = 0
  private wakeCursor = 0
  constructor(private readonly service: NextTurnQueueMutationService, private readonly gateway: QueueDispatchGateway,
    private readonly changed: (scope: NextTurnQueueScope, revision: number) => void = () => {}) {}
  private owned<T>(operation: () => Promise<T>, taskId: string): Promise<T> {
    if (this.closing) return Promise.reject(new NextTurnQueueError('AUTHORITY', 'Queue dispatcher is closing'))
    if (this.operations.size >= 128) return Promise.reject(new NextTurnQueueError('CAPACITY', 'Queue dispatcher is busy'))
    // Retain before the first bind await: another task's capacity check must not evict a caller's just-bound job.
    this.retainedTasks.set(taskId, (this.retainedTasks.get(taskId) ?? 0) + 1)
    const release = (): void => {
      const count = (this.retainedTasks.get(taskId) ?? 1) - 1
      if (count) this.retainedTasks.set(taskId, count); else this.retainedTasks.delete(taskId)
    }
    let current: Promise<T>
    try { current = operation() } catch (error) { release(); return Promise.reject(error) }
    this.operations.add(current)
    const joined = (): void => { this.operations.delete(current); release() }
    current.then(joined, joined)
    return current
  }
  private publish(scope: NextTurnQueueScope, revision: number): void {
    try { this.changed(scope, revision) } catch (error) {
      console.error('[next-turn] queue observer failed:', error instanceof Error ? error.message : 'unknown')
    }
  }
  private observe(job: Job, state: NextTurnQueueState): void {
    if (state.revision < job.revision) return
    job.revision = state.revision
    job.active = state.entries.some(entry => entry.phase !== 'terminal' && (entry.phase !== 'pending' || !!entry.envelope.recovery || !state.paused && !state.recoveryBarrier))
    // A paused pending item is inactive for polling, but still owns work and must never be evicted.
    job.evictable = state.entries.every(entry => entry.phase === 'terminal')
  }
  private idle(job: Job): boolean { return job.evictable && !job.busy && !this.retainedTasks.has(job.scope.taskId) && !this.binding.has(job.scope.taskId) }
  private evictIdle(): Promise<boolean> {
    if (this.eviction) return this.eviction
    const operation = (async () => {
      for (const [key, job] of [...this.jobs]) {
        if (this.closing) return false
        if (!this.idle(job) || (job.evictionRetryAt ?? 0) > Date.now()) continue
        try {
          const current = await this.service.read(job.capability)
          this.observe(job, current.state)
        } catch (error) {
          job.error = error instanceof Error ? error.message : 'Queue idle authority check failed'
          // A known-obsolete idle authority can release its memory lease after all users joined. Its journal stays in its original scope.
          if (error instanceof NextTurnQueueError && error.code === 'AUTHORITY' && !this.closing && this.jobs.get(key) === job && this.idle(job)) {
            this.service.release(job.capability); this.jobs.delete(key); this.evictions++
            return true
          }
          job.evictionRetryAt = Date.now() + 30000
          continue
        }
        // Foreground use/background work may have started during the disk/authority check.
        if (this.closing || this.jobs.get(key) !== job || !this.idle(job)) continue
        this.service.release(job.capability); this.jobs.delete(key); this.evictions++
        return true
      }
      return false
    })()
    this.eviction = operation
    operation.finally(() => { if (this.eviction === operation) this.eviction = undefined }).catch(() => {})
    return operation
  }
  private async ensureBindingCapacity(): Promise<void> {
    while (this.jobs.size >= 200) {
      if (this.closing) throw new NextTurnQueueError('AUTHORITY', 'Queue dispatcher is closing')
      const freed = await this.evictIdle()
      if (this.closing) throw new NextTurnQueueError('AUTHORITY', 'Queue dispatcher is closing')
      if (!freed && this.jobs.size >= 200) throw new NextTurnQueueError('CAPACITY', 'Too many retained queue tasks; pending and unconfirmed work is preserved')
    }
  }
  async bind(taskId: string, expectedScope?: NextTurnQueueScope): Promise<Job> {
    const existing = this.binding.get(taskId)
    if (existing) {
      const job = await existing
      if (expectedScope && !sameQueueScope(job.scope, expectedScope)) throw new NextTurnQueueError('AUTHORITY', 'Queue restoration scope changed while binding')
      return job
    }
    const operation = this.bindOnce(taskId, expectedScope)
    this.binding.set(taskId, operation)
    try { return await operation } finally { if (this.binding.get(taskId) === operation) this.binding.delete(taskId) }
  }
  private async bindOnce(taskId: string, expectedScope?: NextTurnQueueScope): Promise<Job> {
    if (this.closing) throw new NextTurnQueueError('AUTHORITY', 'Queue dispatcher is closing')
    const lease = await this.gateway.capture(taskId), key = queueScopeIdentity(lease.scope)
    if (this.closing) throw new NextTurnQueueError('AUTHORITY', 'Queue dispatcher is closing')
    this.gateway.assertCurrent(lease)
    if (expectedScope && !sameQueueScope(lease.scope, expectedScope)) throw new NextTurnQueueError('AUTHORITY', 'Queue restoration scope changed while binding')
    const previous = this.jobs.get(key)
    if (previous) {
      try { await this.service.read(previous.capability); return previous } catch (error) {
        if (!(error instanceof NextTurnQueueError) || error.code !== 'AUTHORITY') throw error
        await previous.busy?.catch(() => {})
        this.service.release(previous.capability); this.jobs.delete(key)
      }
    }
    await this.ensureBindingCapacity()
    if (this.closing) throw new NextTurnQueueError('AUTHORITY', 'Queue dispatcher is closing')
    this.gateway.assertCurrent(lease)
    const capability = await this.service.bind(taskId, lease)
    try {
      const current = await this.service.recover(capability, Date.now())
      this.gateway.assertCurrent(lease)
      if (!sameQueueScope(current.state.scope, lease.scope)) throw new NextTurnQueueError('AUTHORITY', 'Queue authority changed while binding')
      const job: Job = { capability, scope: structuredClone(lease.scope), active: false, evictable: false, revision: -1 }
      this.observe(job, current.state)
      this.jobs.set(key, job)
      return job
    } catch (error) {
      // Repeated recovery faults must not spend a capability slot before any job exists.
      this.service.release(capability)
      throw error
    }
  }
  read(taskId: string): Promise<WorkQueueRead> { return this.owned(() => this.readOnce(taskId), taskId) }
  restart(taskId: string, runId: string): Promise<WorkQueueRead> {
    return this.owned(async () => {
      if (typeof runId !== 'string' || !runId.trim() || runId.length > 256 || /[\x00-\x1f\x7f]/.test(runId))
        throw new NextTurnQueueError('INVALID', '需要明确的待恢复任务身份')
      const job = await this.bind(taskId)
      if (job.scope.owner !== 'work' || !this.gateway.recoveryEnvelope) throw new NextTurnQueueError('AUTHORITY', '此模式不支持恢复 Work 任务')
      const key = JSON.stringify([queueScopeIdentity(job.scope), runId]), pending = this.pendingRestarts.get(key)
      if (pending) return pending
      const operation = this.restartOnce(job, runId)
      this.pendingRestarts.set(key, operation)
      try { return await operation } finally { if (this.pendingRestarts.get(key) === operation) this.pendingRestarts.delete(key) }
    }, taskId)
  }
  private async restartOnce(job: Job, runId: string): Promise<WorkQueueRead> {
    while (job.busy) await job.busy
    if (this.closing) throw new NextTurnQueueError('AUTHORITY', 'Queue dispatcher is closing')
    if (this.running >= 2) throw new NextTurnQueueError('CAPACITY', '队列正在核对其他任务，请稍后重试')
    this.running++
    const operation = (async () => {
      const id = 'work-recovery-' + createHash('sha256').update(JSON.stringify([queueScopeIdentity(job.scope), runId])).digest('hex')
      let state = (await this.service.read(job.capability)).state
      let entry = state.entries.find(item => item.id === id)
      if (!entry) {
        const envelope = await this.gateway.recoveryEnvelope!(job.scope, runId)
        if (this.closing) throw new NextTurnQueueError('AUTHORITY', '恢复请求准备期间队列已关闭，尚未提交')
        if (envelope.recovery?.runId !== runId) throw new NextTurnQueueError('AUTHORITY', '恢复请求未关联原任务')
        // A fixed entry identity survives local ACK loss; only its first claim allocates an admission key.
        for (let attempt = 0; attempt < 4; attempt++) {
          state = (await this.service.read(job.capability)).state
          if (this.closing) throw new NextTurnQueueError('AUTHORITY', '恢复请求准备期间队列已关闭，尚未提交')
          entry = state.entries.find(item => item.id === id)
          if (entry) break
          try {
            const result = await this.service.transition(job.capability, state.revision, randomUUID(), { kind: 'enqueue-recovery', id, envelope, at: Date.now() })
            state = result.state; this.observe(job, state); this.publish(state.scope, state.revision)
            entry = state.entries.find(item => item.id === id); break
          } catch (error) {
            if (!(error instanceof NextTurnQueueError) || error.code !== 'CAS' || attempt === 3) throw error
          }
        }
      }
      if (!entry || entry.envelope.recovery?.runId !== runId) throw new NextTurnQueueError('CONFLICT', '恢复请求身份冲突')
      // Terminal retry is observation only. A failed continuation owns its own later restart action.
      if (entry.phase !== 'terminal') await this.run(job, true, id)
      else {
        const exact = await this.gateway.receipt(job.scope, entry)
        if (exact.status !== 'accepted' || canonicalAdmissionJson(exact.receipt) !== canonicalAdmissionJson(entry.receipt))
          throw new NextTurnQueueError('AUTHORITY', '原恢复请求的准确回执尚未确认')
        if (exact.root.startedAt !== undefined && entry.startedAt !== exact.root.startedAt) {
          const result = await this.service.transition(job.capability, state.revision, randomUUID(), { kind: 'confirmed-start', id, startedAt: exact.root.startedAt, at: Date.now() })
          this.observe(job, result.state); this.publish(result.state.scope, result.state.revision)
        }
        delete job.error
      }
    })()
    job.busy = operation
    try { await operation } finally { this.running--; if (job.busy === operation) job.busy = undefined }
    return this.readOnce(job.scope.taskId)
  }
  private async readOnce(taskId: string): Promise<WorkQueueRead> {
    const job = await this.bind(taskId), current = await this.service.read(job.capability)
    this.observe(job, current.state)
    return { state: current.state, ...(job.error ? { dispatchError: job.error } : {}) }
  }
  enqueue(taskId: string, expectedRevision: number, operationId: string, id: string, submission: WorkQueueDraft) {
    return this.owned(() => this.enqueueOnce(taskId, expectedRevision, operationId, id, submission), taskId)
  }
  private async enqueueOnce(taskId: string, expectedRevision: number, operationId: string, id: string, submission: WorkQueueDraft) {
    const captured = structuredClone(submission), job = await this.bind(taskId)
    const inputDigest = createHash('sha256').update(canonicalAdmissionJson(captured)).digest('hex')
    const key = JSON.stringify([queueScopeIdentity(job.scope), operationId]), pending = this.pendingEnqueues.get(key)
    if (pending) {
      if (pending.id !== id || pending.expectedRevision !== expectedRevision || pending.inputDigest !== inputDigest)
        throw new NextTurnQueueError('CONFLICT', 'Queue operation ID was already used for another draft')
      return pending.result
    }
    if (this.enqueues >= 2) throw new NextTurnQueueError('CAPACITY', '队列正在准备附件，请稍后重试')
    this.enqueues++
    const result = this.commitEnqueue(job, expectedRevision, operationId, id, captured, inputDigest)
    this.pendingEnqueues.set(key, { id, expectedRevision, inputDigest, result })
    try { return await result } finally {
      if (this.pendingEnqueues.get(key)?.result === result) this.pendingEnqueues.delete(key)
      this.enqueues--
    }
  }
  private async commitEnqueue(job: Job, expectedRevision: number, operationId: string, id: string, captured: WorkQueueDraft, inputDigest: string): Promise<QueueCommitResult> {
    const prior = await this.service.findCommitted(job.capability, operationId)
    // An ACK-loss replay must return the original local commit, without re-reading files or preparing collaborators.
    if (prior) {
      const current = await this.service.read(job.capability)
      this.observe(job, current.state)
      const entry = prior.state.entries.find(item => item.id === id)
      if (!entry || entry.envelope.submissionDigest !== inputDigest || prior.state.revision !== expectedRevision + 1)
        throw new NextTurnQueueError('CONFLICT', 'Queue operation ID was already used for another draft')
      return { state: current.state, receipt: prior.receipt, replayed: true, durabilityWarnings: [] }
    }
    const envelope = await this.gateway.envelope(job.scope, captured)
    if (this.closing) throw new NextTurnQueueError('AUTHORITY', 'Queue dispatcher closed while preparing attachments')
    envelope.submissionDigest = inputDigest
    const result = await this.service.mutate(job.capability, expectedRevision, operationId, { kind: 'enqueue', id, envelope, at: Date.now() })
    this.observe(job, result.state)
    this.publish(result.state.scope, result.state.revision); this.wake(job); return result
  }
  editDraft(taskId: string, expectedRevision: number, operationId: string, id: string, entryRevision: number, draft: WorkQueueDraft['draft']) {
    return this.owned(() => this.editDraftOnce(taskId, expectedRevision, operationId, id, entryRevision, draft), taskId)
  }
  private async editDraftOnce(taskId: string, expectedRevision: number, operationId: string, id: string, entryRevision: number, draft: WorkQueueDraft['draft']) {
    const job = await this.bind(taskId), state = (await this.service.read(job.capability)).state
    const entry = state.entries.find(item => item.id === id)
    if (!entry || entry.phase !== 'pending') throw new NextTurnQueueError('CONFLICT', 'Only pending messages can be edited')
    const envelope = await this.gateway.editDraft(entry.envelope, structuredClone(draft), job.scope)
    const result = await this.service.mutate(job.capability, expectedRevision, operationId, { kind: 'edit', id, entryRevision, envelope, at: Date.now() })
    this.observe(job, result.state)
    this.publish(result.state.scope, result.state.revision); this.wake(job); return result
  }
  mutate(taskId: string, expectedRevision: number, operationId: string, operation: import('../shared/work-next-turn-api').WorkQueueAction & { kind: 'mutate' }) {
    return this.owned(() => this.mutateOnce(taskId, expectedRevision, operationId, operation), taskId)
  }
  private async mutateOnce(taskId: string, expectedRevision: number, operationId: string, operation: import('../shared/work-next-turn-api').WorkQueueAction & { kind: 'mutate' }) {
    const job = await this.bind(taskId)
    // A resumed queue may already have advanced its root by the time its ACK is
    // recovered. Rebuild the original payload from the committed snapshot; the
    // repository still verifies operation ID + revision + exact payload.
    const resumed = operation.operation.kind === 'resume' ? await this.service.findCommitted(job.capability, operationId) : null
    const result = operation.operation.kind === 'resume'
      ? await this.service.transition(job.capability, expectedRevision, operationId, { kind: 'confirm-resume',
        anchor: resumed ? resumed.state.resumeAnchor ?? null : (await this.gateway.context(job.scope)).predecessor })
      : await this.service.mutate(job.capability, expectedRevision, operationId, operation.operation)
    this.observe(job, result.state)
    this.publish(result.state.scope, result.state.revision); this.wake(job); return result
  }
  /** Normal background checks never retry an unknown request. The user's exact absent retry keeps its frozen key/body. */
  reconcile(taskId: string, retryIfAbsent = false): Promise<WorkQueueRead> { return this.owned(() => this.reconcileOnce(taskId, retryIfAbsent), taskId) }
  private async reconcileOnce(taskId: string, retryIfAbsent: boolean): Promise<WorkQueueRead> {
    const job = await this.bind(taskId)
    while (job.busy) await job.busy
    if (this.closing) throw new NextTurnQueueError('AUTHORITY', 'Queue dispatcher is closing')
    if (this.running >= 2) throw new NextTurnQueueError('CAPACITY', '队列正在核对其他任务，请稍后重试')
    this.running++
    const operation = this.run(job, retryIfAbsent)
    job.busy = operation
    try { await operation } finally { this.running--; if (job.busy === operation) job.busy = undefined }
    return this.readOnce(taskId)
  }
  wakeAll(): void {
    const jobs = [...this.jobs.values()].filter(job => job.active)
    if (!jobs.length) { this.wakeCursor = 0; return }
    let scanned = 0, cursor = this.wakeCursor % jobs.length
    while (scanned < jobs.length && this.running < 2) {
      this.wake(jobs[cursor]); cursor = (cursor + 1) % jobs.length; scanned++
    }
    this.wakeCursor = cursor
  }
  private wake(job: Job): void {
    if (this.closing || !job.active || job.busy || this.running >= 2) return
    this.running++
    const operation = this.run(job, false)
    job.busy = operation
    operation.finally(() => { this.running--; if (job.busy === operation) job.busy = undefined }).catch(() => {})
  }
  private async run(job: Job, retryIfAbsent: boolean, recoveryId?: string): Promise<void> {
    if (this.closing) return
    try {
      let state = (await this.service.read(job.capability)).state
      this.observe(job, state)
      const update = async (operation: import('../shared/next-turn-queue').NextTurnQueueOwnerMutation) => {
        const result = await this.service.transition(job.capability, state.revision, randomUUID(), operation)
        state = result.state; this.observe(job, state); this.publish(state.scope, state.revision)
      }
      let entry = state.entries.find(item => ['dispatching', 'admission-unknown', 'accepted'].includes(item.phase))
      if (entry && entry.phase !== 'pending' && entry.phase !== 'terminal') {
        let exact = await this.gateway.receipt(job.scope, entry)
        if (exact.status === 'absent') {
          if (entry.phase === 'accepted') throw new NextTurnQueueError('AUTHORITY', 'Accepted admission disappeared; automatic sending is paused')
          if (!retryIfAbsent || recoveryId !== undefined && entry.id !== recoveryId) {
            if (entry.phase !== 'admission-unknown') await update({ kind: 'admission-unknown', id: entry.id, reason: '接纳回执尚未确认；核对后可重试', at: Date.now() })
            if (recoveryId && entry.id !== recoveryId) job.error = '另一条消息的接纳状态尚未确认，请先核对后再恢复任务'
            return
          }
          // No preparation, new key, or changed predecessor occurs on an exact absent retry.
          await this.gateway.submit(job.scope, assertFrozenQueueRequest(job.scope, entry.frozen), this.controller.signal)
          exact = await this.gateway.receipt(job.scope, entry)
          if (exact.status === 'absent') throw new NextTurnQueueError('AUTHORITY', '重试后仍未取得接纳回执；未继续发送')
        }
        if (entry.phase !== 'accepted') await update({ kind: 'accepted', id: entry.id, receipt: exact.receipt,
          ...(exact.root.startedAt === undefined ? {} : { startedAt: exact.root.startedAt }), at: Date.now() })
        else if (exact.root.startedAt !== undefined && entry.startedAt !== exact.root.startedAt)
          await update({ kind: 'confirmed-start', id: entry.id, startedAt: exact.root.startedAt, at: Date.now() })
        if (exact.root.status === 'running' || exact.root.status === 'waiting') { delete job.error; return }
        await update({ kind: 'terminal', id: entry.id, outcome: exact.root.status, at: Date.now() })
        if (entry.envelope.recovery) { delete job.error; return }
      }
      if (this.closing) return
      entry = state.entries.find(item => item.phase === 'pending' && item.envelope.recovery)
      if (!entry && (state.paused || state.recoveryBarrier || recoveryId)) return
      entry ??= state.entries.find(item => item.phase === 'pending')
      if (!entry || entry.phase !== 'pending') { delete job.error; return }
      const context = await this.gateway.context(job.scope)
      if (!context.root) throw new NextTurnQueueError('AUTHORITY', '先启动任务的首轮，再排下一轮消息')
      const obsolete = state.entries.filter(item => item.phase === 'pending' && item.envelope.recovery && item.envelope.recovery.runId !== context.root!.runId)
      for (const stale of obsolete) await update({ kind: 'abandon-recovery', id: stale.id, entryRevision: stale.revision, at: Date.now() })
      if (obsolete.length) {
        job.error = '任务已进入新一轮，旧恢复请求未执行；请在当前任务上继续'
        if (recoveryId && obsolete.some(item => item.id === recoveryId)) return
        entry = state.entries.find(item => item.phase === 'pending' && item.envelope.recovery)
        if (!entry) return
      }
      if (entry.envelope.recovery && (context.root.runId !== entry.envelope.recovery.runId || !['failed', 'interrupted'].includes(context.root.status)))
        throw new NextTurnQueueError('AUTHORITY', '待恢复的任务已变化，请同步当前任务后重试')
      if (context.root.status === 'running' || context.root.status === 'waiting') { delete job.error; return }
      if (!entry.envelope.recovery && context.root.status !== 'succeeded' && (!state.resumeAnchor || canonicalAdmissionJson(state.resumeAnchor) !== canonicalAdmissionJson(context.predecessor))) {
        const result = await this.service.mutate(job.capability, state.revision, randomUUID(), { kind: 'pause', reason: '上一轮未成功，确认后恢复队列' })
        this.observe(job, result.state)
        this.publish(result.state.scope, result.state.revision); return
      }
      const body = await this.gateway.prepare(job.scope, entry.envelope, context)
      if (this.closing) return
      const frozen = freezeQueueRequest(job.scope, body, entry.revision, context.predecessor)
      await update({ kind: 'claim', id: entry.id, entryRevision: entry.revision, frozen, at: Date.now() })
      const claimed = state.entries.find(item => item.id === entry?.id)
      if (!claimed || claimed.phase !== 'dispatching') throw new NextTurnQueueError('CONFLICT', 'Dispatch claim was not committed')
      try {
        await this.gateway.submit(job.scope, assertFrozenQueueRequest(job.scope, frozen), this.controller.signal)
        const exact = await this.gateway.receipt(job.scope, claimed)
        if (exact.status !== 'accepted') throw new NextTurnQueueError('AUTHORITY', '接纳回执尚未确认；核对后可重试')
        await update({ kind: 'accepted', id: entry.id, receipt: exact.receipt,
          ...(exact.root.startedAt === undefined ? {} : { startedAt: exact.root.startedAt }), at: Date.now() })
        if (exact.root.status !== 'running' && exact.root.status !== 'waiting') await update({ kind: 'terminal', id: entry.id, outcome: exact.root.status, at: Date.now() })
        delete job.error
      } catch (error) {
        await update({ kind: 'admission-unknown', id: entry.id, reason: error instanceof Error ? error.message.slice(0, 1024) : '接纳回执未知', at: Date.now() })
        throw error
      }
    } catch (error) {
      job.error = error instanceof Error ? error.message : 'Queue dispatch failed'
      try { const state = (await this.service.read(job.capability)).state; this.observe(job, state); this.publish(state.scope, state.revision) }
      catch { job.active = false /* Rebind after reconnection; an obsolete authority must not occupy the polling budget. */ }
    }
  }
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true; this.controller.abort(); this.gateway.close?.()
    this.closePromise = (async () => {
      await Promise.allSettled([...this.operations])
      await Promise.allSettled([...this.binding.values()])
      await this.eviction
      await Promise.allSettled([...this.jobs.values()].flatMap(job => job.busy ? [job.busy] : []))
      await this.service.close()
      for (const job of this.jobs.values()) this.service.release(job.capability)
      this.jobs.clear()
      this.retainedTasks.clear()
    })()
    return this.closePromise
  }
  diagnostics() { return { dispatches: this.running, preparations: this.enqueues, ownedOperations: this.operations.size, bindings: this.jobs.size, capabilities: this.service.diagnostics().bindings,
    evictions: this.evictions, retainedTasks: this.retainedTasks.size, evicting: !!this.eviction, closing: this.closing } }
}
