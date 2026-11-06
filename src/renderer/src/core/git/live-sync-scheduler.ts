/** One bounded read queue for both workbenches; Git writes retain their own gate. */
export interface GitSyncSchedulerOptions {
  target: () => string
  eligible: () => boolean
  busy: () => boolean
  refresh: () => Promise<{ changed: boolean; failed: boolean }>
}

const MIN_POLL = 2_500
const MAX_POLL = 8_000
const MAX_FAILURE = 30_000
const BURST_DELAY = 80
const MIN_RECOVERY = 250

export function createGitSyncScheduler(options: GitSyncSchedulerOptions): {
  wake: () => void
  changed: () => void
  dispose: () => void
} {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let deadline = 0
  let running = false
  let queued = false
  let currentTarget = options.target()
  let enabled = false
  let generation = 0
  let delay = MIN_POLL
  let failureDelay = 0
  let notBefore = 0

  const clear = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    deadline = 0
  }
  const synchronize = (): boolean => {
    const nextTarget = options.target()
    const nextEnabled = !disposed && options.eligible()
    if (nextTarget !== currentTarget || nextEnabled !== enabled) {
      generation++
      clear()
      queued = false
      delay = MIN_POLL
      failureDelay = 0
      notBefore = 0
      currentTarget = nextTarget
      enabled = nextEnabled
    }
    if (!nextEnabled) { clear(); queued = false }
    return nextEnabled
  }
  const schedule = (ms: number): void => {
    if (!synchronize()) return
    if (running) { queued = true; return }
    const due = Math.max(Date.now() + ms, notBefore)
    // Repeated hints cannot postpone a pending refresh indefinitely.
    if (timer !== null && deadline <= due) return
    clear()
    deadline = due
    timer = setTimeout(() => { timer = null; deadline = 0; void run() }, Math.max(0, due - Date.now()))
  }
  const run = async (): Promise<void> => {
    if (!synchronize()) return
    if (running) { queued = true; return }
    if (options.busy()) { schedule(MIN_POLL); return }
    running = true
    const requestGeneration = generation
    const started = Date.now()
    let result = { changed: false, failed: true }
    try { result = await options.refresh() }
    catch { /* A failed read keeps the last good store snapshot and backs off. */ }
    finally {
      running = false
      if (!synchronize()) return
      if (requestGeneration !== generation) { queued = false; schedule(0); return }
      const pending = queued
      queued = false
      if (result.failed) {
        failureDelay = Math.min(MAX_FAILURE, failureDelay ? failureDelay * 2 : MIN_POLL)
        notBefore = Date.now() + failureDelay
      } else {
        failureDelay = 0
        delay = result.changed ? MIN_POLL : Math.min(MAX_POLL, delay * 2)
        // Sustained tool output cannot monopolize a slow engine with a tight
        // completion→request loop. Keep at most one trailing refresh.
        notBefore = Date.now() + Math.max(MIN_RECOVERY, Math.min(MIN_POLL, Date.now() - started))
      }
      schedule(pending ? 0 : result.failed ? failureDelay : delay)
    }
  }
  return {
    wake: () => schedule(0),
    changed: () => schedule(BURST_DELAY),
    dispose: () => { disposed = true; enabled = false; queued = false; clear() }
  }
}
