import type { TerminalCleanupError } from '../../shared/ipc'

export interface PtyExit {
  exitCode: number
  signal?: number
  cleanupError?: TerminalCleanupError
}

interface PtyEvents {
  kill: () => void
  onExit: (listener: (event: PtyExit) => void) => { dispose: () => void }
  onCleanup?: (listener: (event: { cleanupError?: TerminalCleanupError }) => void) => { dispose: () => void }
}

/** A shell exit alone does not prove its ConPTY worker and profile were released. */
export class PtyLifecycle {
  private closing?: Promise<void>
  private killIssued = false
  private exited = false
  private exitEvent?: PtyExit
  private cleanupError?: TerminalCleanupError
  private readonly exitPromise: Promise<void>
  private readonly offExit: { dispose: () => void }
  private readonly offCleanup?: { dispose: () => void }
  private finishExit: () => void = () => undefined

  constructor(private readonly pty: PtyEvents, private readonly cleanup: () => void,
    private readonly onNaturalExit: (event: PtyExit) => void, private readonly timeoutMs = 12_000) {
    this.exitPromise = new Promise(resolve => { this.finishExit = resolve })
    this.offCleanup = pty.onCleanup?.(event => { if (event.cleanupError) this.cleanupError = event.cleanupError })
    this.offExit = pty.onExit(event => {
      this.exited = true
      this.exitEvent = event
      if (event.cleanupError) this.cleanupError = event.cleanupError
      this.finishExit()
      if (!this.killIssued) this.onNaturalExit(event)
    })
  }

  get stopped(): boolean { return this.killIssued || this.exited }

  close(): Promise<void> {
    if (this.closing) return this.closing
    const closing = Promise.resolve().then(async () => {
      if (!this.killIssued && !this.exited) {
        this.killIssued = true
        try { this.pty.kill() }
        catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          this.cleanupError = { code: 'PTY_CLEANUP_FAILED', message,
            errors: [{ phase: 'kill', code: 'PTY_KILL_FAILED', name: cause instanceof Error ? cause.name : 'Error', message }] }
          throw new Error(`PTY_CLEANUP_FAILED: ${message}`, { cause })
        }
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([this.exitPromise, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(this.cleanupError
            ? `PTY_CLEANUP_FAILED: ${this.cleanupError.message}` : 'PTY_EXIT_TIMEOUT: 终端进程未在期限内退出')), this.timeoutMs)
        })])
      } finally { clearTimeout(timer) }
      if (this.cleanupError) throw new Error(`PTY_CLEANUP_FAILED: ${this.cleanupError.message}`)
      this.cleanup()
      this.offExit.dispose()
      this.offCleanup?.dispose()
    }).catch(error => {
      if (this.closing === closing) this.closing = undefined
      throw error
    })
    this.closing = closing
    return closing
  }

  get lastExit(): PtyExit | undefined { return this.exitEvent }
  get cleanupFailure(): TerminalCleanupError | undefined { return this.cleanupError }
}
