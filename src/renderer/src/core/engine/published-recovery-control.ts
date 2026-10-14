export interface PublishedRecoveryProgress {
  source: number
  sessionId: string
  snapshotId: string
  phase: 'references' | 'body-ready' | 'body' | 'complete' | 'retained' | 'cancelled' | 'failed'
  loadedReferences: number
  totalReferences: number
  loadedBodyParts: number
  totalBodyParts: number
  previewAvailable: boolean
  message?: string
}

export class PublishedRecoveryCancelledError extends Error {
  constructor() { super('已暂停记录恢复，后台任务继续运行'); this.name = 'PublishedRecoveryCancelledError' }
}

/** Reading a stored body is a client choice, separate from cancelling execution. */
export function createPublishedRecoveryControl(): {
  signal: AbortSignal
  requestBody: () => void
  waitForBody: () => Promise<void>
  cancel: () => void
} {
  const controller = new AbortController()
  let allowed = false
  let pending: { promise: Promise<void>; resolve: () => void; reject: (cause: unknown) => void } | null = null
  const cancelled = (): void => { pending?.reject(new PublishedRecoveryCancelledError()); pending = null }
  controller.signal.addEventListener('abort', cancelled, { once: true })
  return {
    signal: controller.signal,
    requestBody: () => { allowed = true; pending?.resolve(); pending = null },
    waitForBody: () => {
      if (controller.signal.aborted) return Promise.reject(new PublishedRecoveryCancelledError())
      if (allowed) return Promise.resolve()
      if (!pending) {
        let resolve!: () => void, reject!: (cause: unknown) => void
        const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
        pending = { promise, resolve, reject }
      }
      return pending.promise
    },
    cancel: () => controller.abort()
  }
}
