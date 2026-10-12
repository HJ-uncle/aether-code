import type { EngineLogEntry } from '@shared/ipc'

export interface EngineLogLine extends EngineLogEntry {
  readonly id: number
  readonly truncated: boolean
}

export interface EngineLogSnapshot {
  readonly entries: readonly EngineLogLine[]
  readonly discarded: number
}

export const ENGINE_LOG_LIMITS = {
  entries: 500,
  characters: 512 * 1024,
  lineCharacters: 32 * 1024,
  batchMs: 100
} as const

interface BufferOptions {
  entries?: number
  characters?: number
  lineCharacters?: number
  batchMs?: number
  schedule?: (callback: () => void, delayMs: number) => () => void
}

export interface EngineLogBuffer {
  append: (entry: EngineLogEntry) => void
  clear: () => void
  flush: () => void
  getSnapshot: () => EngineLogSnapshot
  subscribe: (listener: () => void) => () => void
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('日志缓冲上限必须是正整数')
  return value
}

/** A count bound alone still permits one tool's stdout to retain megabytes. */
export function createEngineLogBuffer(options: BufferOptions = {}): EngineLogBuffer {
  const capacity = positiveInteger(options.entries ?? ENGINE_LOG_LIMITS.entries)
  const maxCharacters = positiveInteger(options.characters ?? ENGINE_LOG_LIMITS.characters)
  const maxLineCharacters = Math.min(
    maxCharacters,
    positiveInteger(options.lineCharacters ?? ENGINE_LOG_LIMITS.lineCharacters)
  )
  const batchMs = positiveInteger(options.batchMs ?? ENGINE_LOG_LIMITS.batchMs)
  const schedule =
    options.schedule ??
    ((callback: () => void, delayMs: number) => {
      const timer = setTimeout(callback, delayMs)
      return () => clearTimeout(timer)
    })
  const ring = new Array<EngineLogLine | undefined>(capacity)
  const listeners = new Set<() => void>()
  let start = 0
  let length = 0
  let characters = 0
  let discarded = 0
  let sequence = 0
  let dirty = false
  let cancelNotification: (() => void) | undefined
  let snapshot: EngineLogSnapshot = Object.freeze({ entries: Object.freeze([]), discarded: 0 })

  const getSnapshot = (): EngineLogSnapshot => {
    if (!dirty) return snapshot
    const entries: EngineLogLine[] = []
    for (let index = 0; index < length; index++) {
      const entry = ring[(start + index) % capacity]
      if (entry) entries.push(entry)
    }
    snapshot = Object.freeze({ entries: Object.freeze(entries), discarded })
    dirty = false
    return snapshot
  }

  const flush = (): void => {
    cancelNotification?.()
    cancelNotification = undefined
    // Reads can materialize the snapshot before a scheduled notification. The
    // timer still has to notify readers that observed the preceding version.
    getSnapshot()
    for (const listener of listeners) listener()
  }

  const notifyLater = (): void => {
    if (!listeners.size || cancelNotification) return
    cancelNotification = schedule(flush, batchMs)
  }

  const removeOldest = (): void => {
    const entry = ring[start]
    characters -= entry?.line.length ?? 0
    ring[start] = undefined
    start = (start + 1) % capacity
    length--
    discarded++
  }

  const append = (entry: EngineLogEntry): void => {
    let line = entry.line
    const needsTruncation = line.length > maxLineCharacters
    const truncated = entry.truncated === true || needsTruncation
    if (needsTruncation) {
      let end = maxLineCharacters - 1
      // A UTF-16 limit must not leave half an emoji at the truncation boundary.
      const last = line.charCodeAt(end - 1)
      if (last >= 0xd800 && last <= 0xdbff) end--
      line = line.slice(0, end) + '…'
    }
    while (length && (length === capacity || characters + line.length > maxCharacters))
      removeOldest()
    ring[(start + length) % capacity] = Object.freeze({ ...entry, line, id: ++sequence, truncated })
    characters += line.length
    length++
    dirty = true
    notifyLater()
  }

  const clear = (): void => {
    cancelNotification?.()
    cancelNotification = undefined
    if (!length && !discarded) return
    ring.fill(undefined)
    start = length = characters = discarded = 0
    dirty = true
    flush()
  }

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) {
        cancelNotification?.()
        cancelNotification = undefined
      }
    }
  }

  return { append, clear, flush, getSnapshot, subscribe }
}
