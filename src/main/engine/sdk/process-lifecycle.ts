import type { ChildProcess } from 'node:child_process'

export type ProcessStopOutcome =
  | 'exited-unverified'
  | 'forced-unverified'
  | 'spawn-failed'
  | 'abnormal-exit'
  | 'unconfirmed'

/** OS observations do not prove that engine-owned work or SQLite was flushed. */
export interface ProcessStopReceipt {
  pid: number | undefined
  method: 'none' | 'SIGTERM' | 'SIGKILL'
  exitObserved: boolean
  closeObserved: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
  spawnError: string | null
  signalErrors: string[]
  forced: boolean
  cleanupVerified: false
  outcome: ProcessStopOutcome
}

export class ProcessStopError extends Error {
  constructor(message: string, readonly receipt: ProcessStopReceipt) {
    super(message)
    this.name = 'ProcessStopError'
  }
}

export interface ProcessLifecycle {
  /** Resolves on actual close, including a spawn failure that never had a PID. */
  readonly closed: Promise<ProcessStopReceipt>
  observation(): ProcessStopReceipt
  /** First caller sets the deadlines; subsequent callers share this exact promise. */
  stop(timeoutMs?: number, killTimeoutMs?: number): Promise<ProcessStopReceipt>
}

const lifecycles = new WeakMap<ChildProcess, ProcessLifecycle>()

export interface OwnedProcessHandle {
  readonly pid: number | undefined
  readonly lifecycle: ProcessLifecycle
  stop(timeoutMs?: number): Promise<void>
}

interface OwnedProcessRecord {
  generation: number
  stopRequested: boolean
  stopTask: Promise<void> | null
  failure: unknown
}

/** Tracks only exact child handles, never a port lookup or a recycled PID. */
export class OwnedProcessLedger<T extends OwnedProcessHandle> {
  private readonly records = new Map<T, OwnedProcessRecord>()
  private tail: Promise<void> = Promise.resolve()

  register(handle: T, generation: number): void {
    this.records.set(handle, { generation, stopRequested: false, stopTask: null, failure: null })
  }

  wasStopRequested(handle: T): boolean {
    return this.records.get(handle)?.stopRequested ?? false
  }

  /** Closed records are retired only after their stop result was handled. */
  pruneClosed(): void {
    for (const [handle, record] of this.records) {
      if (handle.lifecycle.observation().closeObserved && (!record.stopRequested || record.stopTask)) {
        this.records.delete(handle)
      }
    }
  }

  unclosed(): T[] {
    return [...this.records.keys()].filter((handle) => !handle.lifecycle.observation().closeObserved)
  }

  assertNoUnclosed(): void {
    const unclosed = this.unclosed()
    if (unclosed.length) throw new Error(`旧引擎进程尚未确认关闭，已阻止启动新实例（pid=${unclosed.map((handle) => handle.pid ?? '-').join(',')}）`)
  }

  stopAll(): Promise<void> {
    const handles = [...this.records.entries()]
    // A failed predecessor must not prevent later exact owned handles from
    // receiving shutdown. Each returned task still reports its own failure.
    const task = this.tail.catch(() => undefined).then(async () => {
      const failures: unknown[] = []
      for (const [handle, record] of handles) {
        if (handle.lifecycle.observation().closeObserved && record.failure) continue
        record.stopRequested = true
        if (!record.stopTask) {
          record.stopTask = handle.stop().catch((error: unknown) => {
            record.failure = error
            throw error
          })
        }
        try { await record.stopTask } catch (error) { failures.push(error) }
      }
      this.pruneClosed()
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, '多个 owned 引擎进程未正常关闭')
    })
    this.tail = task
    return task
  }
}

/** Attach immediately after spawn: exitCode/killed alone cannot prove pipe closure. */
export function observeProcessLifecycle(child: ChildProcess): ProcessLifecycle {
  const existing = lifecycles.get(child)
  if (existing) return existing

  let method: ProcessStopReceipt['method'] = 'none'
  let exitObserved = false
  let closeObserved = false
  let exitCode: number | null = null
  let signal: NodeJS.Signals | null = null
  let spawnError: string | null = null
  let forced = false
  const signalErrors: string[] = []
  let stopping: Promise<ProcessStopReceipt> | null = null
  let resolveClosed!: (receipt: ProcessStopReceipt) => void
  const closed = new Promise<ProcessStopReceipt>((resolve) => { resolveClosed = resolve })

  const observation = (): ProcessStopReceipt => {
    let outcome: ProcessStopOutcome = 'unconfirmed'
    if (closeObserved && spawnError && !exitObserved) outcome = 'spawn-failed'
    else if (closeObserved && exitObserved) {
      // Windows SIGTERM commonly reports code 1 with no signal. This is an
      // explicit platform exception, not permission to accept natural failures.
      const nativeFailure = exitCode !== null && (exitCode >= 0x80000000 || exitCode < -1)
      const requestedTermination = method === 'SIGTERM' && (
        signal === 'SIGTERM' || (process.platform === 'win32' && signal === null && exitCode === 1)
      )
      const abnormalExit = signal !== null || exitCode !== 0
      outcome = nativeFailure || (!forced && abnormalExit && !requestedTermination)
        ? 'abnormal-exit'
        : forced ? 'forced-unverified' : 'exited-unverified'
    }
    return {
      pid: child.pid, method, exitObserved, closeObserved, exitCode, signal,
      spawnError, signalErrors: [...signalErrors], forced, cleanupVerified: false, outcome
    }
  }

  child.on('error', (error: Error) => {
    // A failed kill can emit error too; only a child without a PID failed spawn.
    if (child.pid === undefined && !exitObserved) spawnError = error.message
    else signalErrors.push(error.message)
  })
  child.once('exit', (code, exitSignal) => {
    exitObserved = true
    exitCode = code
    signal = exitSignal
  })
  child.once('close', (code, closeSignal) => {
    closeObserved = true
    if (!exitObserved) { exitCode = code; signal = closeSignal }
    resolveClosed(observation())
  })

  const sendSignal = (next: 'SIGTERM' | 'SIGKILL'): void => {
    method = next
    if (next === 'SIGKILL') forced = true
    try {
      if (!child.kill(next)) signalErrors.push(`${next} was not delivered`)
    } catch (error) {
      signalErrors.push(`${next}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const checked = (receipt: ProcessStopReceipt): ProcessStopReceipt => {
    if (receipt.outcome === 'spawn-failed') throw new ProcessStopError(`引擎进程创建失败：${receipt.spawnError}`, receipt)
    if (receipt.outcome === 'abnormal-exit') {
      throw new ProcessStopError(`引擎进程异常退出（code=${receipt.exitCode ?? '-'} signal=${receipt.signal ?? '-'}）`, receipt)
    }
    if (receipt.outcome === 'forced-unverified') {
      throw new ProcessStopError(`引擎进程被强制终止，清理未验证（code=${receipt.exitCode ?? '-'} signal=${receipt.signal ?? '-'}）`, receipt)
    }
    if (!receipt.exitObserved || !receipt.closeObserved) {
      throw new ProcessStopError(`未确认引擎进程退出与管道关闭（pid=${receipt.pid ?? '-'}）`, receipt)
    }
    return receipt
  }

  const lifecycle: ProcessLifecycle = {
    closed,
    observation,
    stop(timeoutMs = 5000, killTimeoutMs = 5000) {
      if (stopping) return stopping
      stopping = new Promise<ProcessStopReceipt>((resolve, reject) => {
        let terminateTimer: ReturnType<typeof setTimeout> | null = null
        let killTimer: ReturnType<typeof setTimeout> | null = null
        let settled = false
        const finish = (receipt: ProcessStopReceipt): void => {
          if (settled) return
          settled = true
          if (terminateTimer) clearTimeout(terminateTimer)
          if (killTimer) clearTimeout(killTimer)
          try { resolve(checked(receipt)) } catch (error) { reject(error) }
        }
        void closed.then(finish)
        if (closeObserved) { finish(observation()); return }
        // Do not signal a child whose exit has already been observed while its
        // pipes are still draining. A pending error/kill is never exit evidence.
        if (!exitObserved && !spawnError) sendSignal('SIGTERM')
        terminateTimer = setTimeout(() => {
          if (!exitObserved && !spawnError && !closeObserved) sendSignal('SIGKILL')
          killTimer = setTimeout(() => finish(observation()), Math.max(0, killTimeoutMs))
        }, Math.max(0, timeoutMs))
      })
      return stopping
    }
  }
  lifecycles.set(child, lifecycle)
  return lifecycle
}
