export interface BrowserInputOwner {
  engineId: string
  rootSessionId: string
  runId: string
  requestId: string
}

export type BrowserInputRunOwner = Omit<BrowserInputOwner, 'requestId'>
export type BrowserInputQueueErrorCode =
  'cancelled' | 'disposed' | 'capacity' | 'duplicate' | 'invalid-owner'

export class BrowserInputQueueError extends Error {
  readonly name = 'BrowserInputQueueError'

  constructor(
    message: string,
    readonly code: BrowserInputQueueErrorCode,
    readonly operationPerformed: false | 'unknown',
    readonly owner?: Readonly<BrowserInputOwner>,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause })
  }
}

export interface BrowserInputLease {
  readonly owner: Readonly<BrowserInputOwner>
  readonly signal: AbortSignal
  /** Call immediately before the first input dispatch, after ownership/visibility checks. */
  markInputDispatched(): void
}

export interface BrowserInputQueueOptions {
  /** Waiting entries only; the active input has its own reserved slot. */
  maxQueued?: number
  maxQueuedPerRoot?: number
}

export interface BrowserInputQueueSnapshot {
  disposed: boolean
  queuedCount: number
  active: { owner: Readonly<BrowserInputOwner>; inputDispatched: boolean; draining: boolean } | null
  roots: { engineId: string; rootSessionId: string; queued: Readonly<BrowserInputOwner>[] }[]
}

interface QueueEntry {
  readonly owner: Readonly<BrowserInputOwner>
  readonly rootKey: string
  readonly requestKey: string
  readonly controller: AbortController
  invoke(lease: BrowserInputLease): Promise<void>
  fulfill(): void
  reject(error: unknown): void
  removeAbortListener(): void
  settled: boolean
  inputDispatched: boolean
}

function identifier(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

function copyOwner(value: BrowserInputOwner): Readonly<BrowserInputOwner> {
  if (
    !value ||
    !identifier(value.engineId, 1000) ||
    !identifier(value.rootSessionId, 500) ||
    !identifier(value.runId, 500) ||
    !identifier(value.requestId, 500)
  ) {
    throw new BrowserInputQueueError('浏览器输入缺少有效的任务与请求身份', 'invalid-owner', false)
  }
  return Object.freeze({
    engineId: value.engineId,
    rootSessionId: value.rootSessionId,
    runId: value.runId,
    requestId: value.requestId
  })
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} 必须是正整数`)
  return value
}

/**
 * One queue belongs to one native window. Roots take turns; each root stays FIFO.
 * Observation (including long waits) belongs outside this queue. Cancelling an
 * active input settles its caller, but cannot release the window until its callback
 * has actually joined: an ignored abort must never permit two native inputs at once.
 */
export class OwnedBrowserInputQueue {
  private readonly maxQueued: number
  private readonly maxQueuedPerRoot: number
  private readonly roots = new Map<string, QueueEntry[]>()
  private readonly requests = new Map<string, QueueEntry>()
  private readonly rotation: string[] = []
  private readonly idleWaiters = new Set<() => void>()
  private active: QueueEntry | null = null
  private queuedCount = 0
  private lastServed: string | null = null
  private disposed = false

  constructor(options: BrowserInputQueueOptions = {}) {
    this.maxQueued = positiveInteger(options.maxQueued ?? 128, 'maxQueued')
    this.maxQueuedPerRoot = positiveInteger(options.maxQueuedPerRoot ?? 32, 'maxQueuedPerRoot')
  }

  run<T>(
    input: { owner: BrowserInputOwner; signal?: AbortSignal },
    operation: (lease: BrowserInputLease) => T | Promise<T>
  ): Promise<T> {
    let owner: Readonly<BrowserInputOwner>
    try {
      owner = copyOwner(input?.owner)
    } catch (error) {
      return Promise.reject(error)
    }
    const signal = input.signal
    const refuse = (
      message: string,
      code: BrowserInputQueueErrorCode,
      cause?: unknown
    ): Promise<T> => Promise.reject(new BrowserInputQueueError(message, code, false, owner, cause))
    if (this.disposed) return refuse('浏览器窗口输入队列已关闭', 'disposed')
    if (signal?.aborted) return refuse('浏览器输入已取消，尚未派发输入', 'cancelled', signal.reason)
    const rootKey = JSON.stringify([owner.engineId, owner.rootSessionId])
    const requestKey = JSON.stringify([
      owner.engineId,
      owner.rootSessionId,
      owner.runId,
      owner.requestId
    ])
    if (this.requests.has(requestKey))
      return refuse('这个浏览器输入请求仍在处理，请勿重复派发', 'duplicate')
    if (
      this.queuedCount >= this.maxQueued ||
      (this.roots.get(rootKey)?.length ?? 0) >= this.maxQueuedPerRoot
    ) {
      return refuse('浏览器输入等待队列已满，请等待当前请求完成后重试', 'capacity')
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        owner,
        rootKey,
        requestKey,
        controller: new AbortController(),
        settled: false,
        inputDispatched: false,
        invoke: async (lease) => {
          if (entry.controller.signal.aborted) throw entry.controller.signal.reason
          const output = await operation(lease)
          entry.fulfill = () => {
            if (!entry.settled) {
              entry.settled = true
              resolve(output)
            }
          }
        },
        fulfill: () => undefined,
        reject: (error) => {
          if (!entry.settled) {
            entry.settled = true
            reject(error)
          }
        },
        removeAbortListener: () => signal?.removeEventListener('abort', abort)
      }
      const abort = (): void => {
        this.cancel(entry, 'cancelled', signal?.reason)
      }
      const queue = this.roots.get(rootKey)
      if (queue) queue.push(entry)
      else {
        this.roots.set(rootKey, [entry])
        this.rotation.push(rootKey)
      }
      this.queuedCount += 1
      this.requests.set(requestKey, entry)
      signal?.addEventListener('abort', abort, { once: true })
      // Cover a signal that became aborted between admission and listener attachment.
      if (signal?.aborted) abort()
      this.pump()
    })
  }

  cancelRun(owner: BrowserInputRunOwner, reason?: unknown): number {
    let cancelled = 0
    for (const entry of [...this.requests.values()]) {
      if (
        entry.owner.engineId === owner.engineId &&
        entry.owner.rootSessionId === owner.rootSessionId &&
        entry.owner.runId === owner.runId &&
        this.cancel(entry, 'cancelled', reason)
      )
        cancelled += 1
    }
    return cancelled
  }

  cancelRequest(owner: BrowserInputOwner, reason?: unknown): boolean {
    const entry = this.requests.get(
      JSON.stringify([owner.engineId, owner.rootSessionId, owner.runId, owner.requestId])
    )
    return !!entry && this.cancel(entry, 'cancelled', reason)
  }

  getSnapshot(): BrowserInputQueueSnapshot {
    return {
      disposed: this.disposed,
      queuedCount: this.queuedCount,
      active: this.active
        ? {
            owner: this.active.owner,
            inputDispatched: this.active.inputDispatched,
            draining: this.active.controller.signal.aborted
          }
        : null,
      roots: this.rotation.map((key) => {
        const queue = this.roots.get(key)!
        return {
          engineId: queue[0].owner.engineId,
          rootSessionId: queue[0].owner.rootSessionId,
          queued: queue.map((entry) => entry.owner)
        }
      })
    }
  }

  whenIdle(): Promise<void> {
    if (!this.active && this.queuedCount === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  /** Disposal cancels admission; whenIdle remains the truthful join acknowledgement. */
  dispose(reason?: unknown): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of [...this.requests.values()]) this.cancel(entry, 'disposed', reason)
    this.notifyIdle()
  }

  private cancel(entry: QueueEntry, code: 'cancelled' | 'disposed', reason?: unknown): boolean {
    if (entry.settled) return false
    const error = new BrowserInputQueueError(
      entry.inputDispatched
        ? '浏览器输入已取消，已派发输入的结果无法确认'
        : '浏览器输入已取消，尚未派发输入',
      code,
      entry.inputDispatched ? 'unknown' : false,
      entry.owner,
      reason
    )
    // Reject before abort listeners run; a synchronous callback cannot replace the cancellation result.
    entry.reject(error)
    entry.controller.abort(error)
    entry.removeAbortListener()
    if (this.active !== entry) {
      const queue = this.roots.get(entry.rootKey)!
      queue.splice(queue.indexOf(entry), 1)
      this.queuedCount -= 1
      this.requests.delete(entry.requestKey)
      if (!queue.length) {
        this.roots.delete(entry.rootKey)
        this.rotation.splice(this.rotation.indexOf(entry.rootKey), 1)
      }
      this.notifyIdle()
    }
    return true
  }

  private pump(): void {
    if (this.active || this.disposed || !this.rotation.length) {
      this.notifyIdle()
      return
    }
    // New work from A arriving before B during A's active input must not get A a second turn.
    if (this.rotation.length > 1 && this.rotation[0] === this.lastServed)
      this.rotation.push(this.rotation.shift()!)
    const key = this.rotation.shift()!
    const queue = this.roots.get(key)!
    const entry = queue.shift()!
    if (queue.length) this.rotation.push(key)
    else this.roots.delete(key)
    this.queuedCount -= 1
    this.lastServed = key
    this.active = entry
    const lease: BrowserInputLease = Object.freeze({
      owner: entry.owner,
      signal: entry.controller.signal,
      markInputDispatched: () => {
        if (entry.controller.signal.aborted) throw entry.controller.signal.reason
        if (this.active !== entry || entry.settled) throw new Error('浏览器输入租约已结束')
        entry.inputDispatched = true
      }
    })
    // The rejection branch is joined here; no detached finally can leak a rejected promise.
    Promise.resolve()
      .then(() => entry.invoke(lease))
      .then(
        () => {
          this.join(entry)
          entry.fulfill()
        },
        (error: unknown) => {
          this.join(entry)
          entry.reject(error)
        }
      )
  }

  private join(entry: QueueEntry): void {
    entry.removeAbortListener()
    this.requests.delete(entry.requestKey)
    this.active = null
    this.pump()
  }

  private notifyIdle(): void {
    if (this.active || this.queuedCount !== 0) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }
}
