export interface RecoveryScope {
  source: number
  sessionId: string
  viewEpoch: number
}

export interface RecoveryLease {
  scope: Readonly<RecoveryScope>
  signal: AbortSignal
  isCurrent: () => boolean
}

export type RecoveryOutcome = 'attached' | 'idle' | 'retry' | { blocked: string }
export type RecoveryPhase = 'idle' | 'connecting' | 'retrying' | 'attached' | 'blocked' | 'disposed'
export interface RecoveryState {
  scope: Readonly<RecoveryScope> | null
  phase: RecoveryPhase
  failures: number
  retryInMs?: number
  reason?: string
}

interface Completion { promise: Promise<boolean>; resolve: (attached: boolean) => void }
interface Generation {
  scope: Readonly<RecoveryScope>
  controller: AbortController
  completion: Completion | null
  flight: Promise<void> | null
  timer: unknown | null
  retryRequested: boolean
  failures: number
  phase: RecoveryPhase
}

export interface RecoveryLoopOptions {
  attempt: (lease: RecoveryLease) => Promise<RecoveryOutcome>
  isScopeCurrent: (scope: Readonly<RecoveryScope>) => boolean
  onState?: (state: RecoveryState) => void
  random?: () => number
  schedule?: (callback: () => void, delayMs: number) => unknown
  unschedule?: (timer: unknown) => void
  baseDelayMs?: number
  maxDelayMs?: number
}

export function sameRecoveryScope(left: RecoveryScope, right: RecoveryScope): boolean {
  return left.source === right.source && left.sessionId === right.sessionId && left.viewEpoch === right.viewEpoch
}

/** Frequency is bounded; elapsed task lifetime and the total retry count are not. */
export function recoveryDelay(failures: number, random: number, base = 500, maximum = 30_000): number {
  const sample = Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 0.5
  const exponent = Math.max(0, Math.min(30, failures - 1))
  return Math.max(1, Math.min(maximum, Math.round(base * 2 ** exponent * (0.8 + sample * 0.4))))
}

export function createRecoveryLoop(options: RecoveryLoopOptions): {
  resume: (scope: RecoveryScope) => Promise<boolean>
  retry: (scope: RecoveryScope) => void
  progress: (scope: RecoveryScope) => void
  cancel: () => void
  dispose: () => void
  state: () => RecoveryState
} {
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay))
  const unschedule = options.unschedule ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  let current: Generation | null = null
  let disposed = false
  let publicState: RecoveryState = { scope: null, phase: 'idle', failures: 0 }

  const live = (generation: Generation): boolean => !disposed && current === generation &&
    !generation.controller.signal.aborted && options.isScopeCurrent(generation.scope)

  function publish(generation: Generation, phase: RecoveryPhase, extra: Partial<RecoveryState> = {}): void {
    if (!live(generation)) return
    generation.phase = phase
    publicState = { scope: generation.scope, phase, failures: generation.failures, ...extra }
    options.onState?.(publicState)
  }

  function completion(generation: Generation): Completion {
    if (!generation.completion) {
      let resolve!: (attached: boolean) => void
      const promise = new Promise<boolean>(done => { resolve = done })
      generation.completion = { promise, resolve }
    }
    return generation.completion
  }

  function settle(generation: Generation, attached: boolean): void {
    generation.completion?.resolve(attached)
    generation.completion = null
  }

  function drop(generation: Generation): void {
    if (generation.timer !== null) unschedule(generation.timer)
    generation.timer = null
    generation.retryRequested = false
    generation.controller.abort()
    settle(generation, false)
  }

  function cancel(): void {
    if (current) drop(current)
    current = null
    publicState = { scope: null, phase: disposed ? 'disposed' : 'idle', failures: 0 }
    if (!disposed) options.onState?.(publicState)
  }

  function defer(generation: Generation): void {
    if (!live(generation) || generation.phase === 'blocked') return
    completion(generation)
    if (generation.flight) { generation.retryRequested = true; return }
    if (generation.timer !== null) return
    generation.failures = Math.min(Number.MAX_SAFE_INTEGER, generation.failures + 1)
    const delay = recoveryDelay(generation.failures, (options.random ?? Math.random)(), options.baseDelayMs, options.maxDelayMs)
    publish(generation, 'retrying', { retryInMs: delay })
    generation.timer = schedule(() => {
      generation.timer = null
      if (live(generation)) start(generation)
      else settle(generation, false)
    }, delay)
  }

  function start(generation: Generation): void {
    if (!live(generation) || generation.flight || generation.timer !== null) return
    generation.retryRequested = false
    publish(generation, 'connecting')
    const lease: RecoveryLease = {
      scope: generation.scope, signal: generation.controller.signal, isCurrent: () => live(generation)
    }
    // Assign the flight before invoking the adapter, including synchronous failure paths.
    generation.flight = Promise.resolve().then(() => options.attempt(lease)).then(outcome => {
      if (!live(generation)) return
      if (typeof outcome === 'object') {
        generation.retryRequested = false
        publish(generation, 'blocked', { reason: outcome.blocked })
        settle(generation, false)
      } else if (outcome === 'retry') {
        generation.retryRequested = true
      } else if (!generation.retryRequested) {
        publish(generation, outcome === 'attached' ? 'attached' : 'idle')
        settle(generation, outcome === 'attached')
      }
    }, () => {
      if (live(generation)) generation.retryRequested = true
    }).finally(() => {
      generation.flight = null
      if (!live(generation)) { settle(generation, false); return }
      if (generation.retryRequested) { generation.retryRequested = false; defer(generation) }
      else if (generation.phase === 'attached' || generation.phase === 'idle') settle(generation, generation.phase === 'attached')
    })
  }

  function generationFor(scope: RecoveryScope): Generation | null {
    if (disposed || !options.isScopeCurrent(scope)) return null
    if (!current || !sameRecoveryScope(current.scope, scope)) {
      if (current) drop(current)
      current = { scope: Object.freeze({ ...scope }), controller: new AbortController(), completion: null,
        flight: null, timer: null, retryRequested: false, failures: 0, phase: 'idle' }
    }
    return current
  }

  function resume(scope: RecoveryScope): Promise<boolean> {
    const generation = generationFor(scope)
    if (!generation) return Promise.resolve(false)
    if (generation.phase === 'blocked') return Promise.resolve(false)
    if (generation.phase === 'attached' && !generation.flight && generation.timer === null) return Promise.resolve(true)
    const result = completion(generation).promise
    if (!generation.flight && generation.timer === null) start(generation)
    return result
  }

  function retry(scope: RecoveryScope): void {
    const generation = generationFor(scope)
    if (generation) defer(generation)
  }

  function progress(scope: RecoveryScope): void {
    if (!current || !sameRecoveryScope(current.scope, scope) || !live(current)) return
    current.failures = 0
    if (publicState.failures !== 0) publish(current, current.phase)
  }

  function dispose(): void { disposed = true; cancel() }
  return { resume, retry, progress, cancel, dispose, state: () => publicState }
}

/** A terminal engine outcome is data to display, never an instruction to replay the task. */
export function snapshotRecoveryOutcome(snapshot: {
  source: 'live' | 'persisted' | 'persisted-published'; finished: boolean; eventId: string | null
  run?: { status: string }
  executionRun?: { status: string }
}): 'attach' | 'idle' | 'retry' {
  const execution = snapshot.executionRun ?? snapshot.run
  if (execution && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(execution.status)) return 'idle'
  if (execution?.status === 'waiting') return 'idle'
  if ((snapshot.source === 'live' || snapshot.source === 'persisted-published') && !snapshot.finished && snapshot.eventId) return 'attach'
  return execution?.status === 'running' ? 'retry' : 'idle'
}

/** Absence of a renderer subscription cannot erase the known durable stop target. */
export function durableCancelBody(sessionId: string | null, run: { sessionId: string; runId: string; status: string } | undefined):
  { sessionId: string; runId: string } | null {
  if (!sessionId || !run || run.sessionId !== sessionId || !['running', 'waiting'].includes(run.status)) return null
  return { sessionId, runId: run.runId }
}

/** Authentication and deleted sessions need user action; ordinary transport failures keep retrying. */
export function recoveryFailure(code: number, message: string): RecoveryOutcome {
  return [401, 403, 404, 40100, 40300, 40400].includes(code)
    ? { blocked: message || '无法访问此会话，请检查登录状态或重新打开会话' }
    : 'retry'
}

export type RecoveryRestoreResult<T> =
  | { kind: 'restored'; snapshot: T }
  | { kind: 'attached' | 'retry' | 'stale' }
  | { kind: 'blocked'; message: string }

/** The recovery adapter only reads and subscribes; it must never POST the original task again. */
export async function recoverSnapshot<T extends Parameters<typeof snapshotRecoveryOutcome>[0]>(
  lease: RecoveryLease,
  restore: (lease: RecoveryLease) => Promise<RecoveryRestoreResult<T>>,
  attach: (snapshot: T, lease: RecoveryLease) => void | Promise<void>
): Promise<RecoveryOutcome> {
  const result = await restore(lease)
  if (!lease.isCurrent()) return 'idle'
  if (result.kind === 'blocked') return { blocked: result.message }
  if (result.kind === 'attached') return 'attached'
  if (result.kind !== 'restored') return 'retry'
  const outcome = snapshotRecoveryOutcome(result.snapshot)
  if (outcome !== 'attach') return outcome
  await attach(result.snapshot, lease)
  return 'attached'
}

/** A gap/invalid reduction has not consumed the event, even if its SSE ID is newer. */
export function reducedEventCursor(consumed: string | null, incoming: string | undefined,
  status: 'applied' | 'verified-duplicate' | 'gap' | 'invalid'): string | null {
  return status === 'applied' || status === 'verified-duplicate' ? incoming ?? consumed : consumed
}

/** Share reads with history actions without allowing an old view's completion to clear a new flight. */
export function createRecoverySingleFlight<T>(): {
  read: (scope: RecoveryScope, reader: () => Promise<T>) => Promise<T>
  clear: () => void
} {
  let flight: { scope: RecoveryScope; promise: Promise<T> } | null = null
  return {
    read(scope, reader) {
      if (flight && sameRecoveryScope(flight.scope, scope)) return flight.promise
      const next = { scope: { ...scope }, promise: Promise.resolve().then(reader) }
      flight = next
      void next.promise.finally(() => { if (flight === next) flight = null }).catch(() => {})
      return next.promise
    },
    clear() { flight = null }
  }
}
