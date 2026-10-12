import type { EngineLogBatch, EngineLogEntry } from '../../shared/ipc'

export const ENGINE_LOG_BATCH_LIMITS = {
  entries: 128,
  characters: 64 * 1024,
  lineCharacters: 32 * 1024,
  batchMs: 100
} as const

interface BatchOptions {
  entries?: number
  characters?: number
  lineCharacters?: number
  batchMs?: number
  schedule?: (callback: () => void, delayMs: number) => () => void
}

export interface EngineLogBatcher {
  append: (entry: EngineLogEntry) => void
  flush: () => void
  dispose: () => void
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('日志批次上限必须是正整数')
  return value
}

/** Bound each IPC payload and the pending queue, including a single giant stdout line. */
export function createEngineLogBatcher(
  send: (batch: EngineLogBatch) => void,
  options: BatchOptions = {}
): EngineLogBatcher {
  const maxEntries = positiveInteger(options.entries ?? ENGINE_LOG_BATCH_LIMITS.entries)
  const maxCharacters = positiveInteger(options.characters ?? ENGINE_LOG_BATCH_LIMITS.characters)
  const maxLineCharacters = Math.min(
    maxCharacters,
    positiveInteger(options.lineCharacters ?? ENGINE_LOG_BATCH_LIMITS.lineCharacters)
  )
  const batchMs = positiveInteger(options.batchMs ?? ENGINE_LOG_BATCH_LIMITS.batchMs)
  const schedule =
    options.schedule ??
    ((callback: () => void, delayMs: number) => {
      const timer = setTimeout(callback, delayMs)
      return () => clearTimeout(timer)
    })
  let pending: EngineLogEntry[] = []
  let characters = 0
  let cancelTimer: (() => void) | undefined
  let disposed = false

  const flush = (): void => {
    cancelTimer?.()
    cancelTimer = undefined
    if (!pending.length) return
    // Reset before sending so a synchronous send hook cannot join this batch.
    const batch = pending
    pending = []
    characters = 0
    send(batch)
  }

  const append = (entry: EngineLogEntry): void => {
    if (disposed) return
    let line = entry.line
    const truncated = line.length > maxLineCharacters
    if (truncated) {
      let end = maxLineCharacters - 1
      const last = line.charCodeAt(end - 1)
      if (last >= 0xd800 && last <= 0xdbff) end--
      line = line.slice(0, end) + '…'
    }
    if (pending.length && characters + line.length > maxCharacters) flush()
    pending.push({ ...entry, line, ...(truncated ? { truncated: true } : {}) })
    characters += line.length
    // Flush full batches early rather than retaining an unbounded burst until
    // the timer. Ordinary traffic still crosses IPC at most every 100ms.
    if (pending.length === maxEntries || characters === maxCharacters) flush()
    else if (!cancelTimer) cancelTimer = schedule(flush, batchMs)
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    flush()
  }

  return { append, flush, dispose }
}
