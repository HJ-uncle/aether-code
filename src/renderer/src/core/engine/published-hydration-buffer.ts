/** A fixed archive can grow while the selected root continues to publish live events. */
export function createPublishedHydrationBuffer<T>(options: {
  current: () => boolean
  exhausted: () => void
  maxUpdates?: number
  maxBytes?: number
}): {
  record: (update: (previous: T) => T) => void
  account: (input: unknown) => void
  rebase: (base: T) => (previous: T) => T
  finish: () => void
  cancel: () => void
  valid: () => boolean
} {
  let updates: Array<(previous: T) => T> = [], bytes = 0, cancelled = false, accepting = true
  let retained = new WeakSet<object>()
  const valid = (): boolean => !cancelled && options.current()
  const exhaust = (): void => {
    if (!accepting || !valid()) return
    accepting = false; cancelled = true; updates = []; retained = new WeakSet()
    options.exhausted()
  }
  return {
    record: update => {
      if (!accepting || !valid()) return
      if (updates.length >= (options.maxUpdates ?? 1024)) { exhaust(); return }
      // A throttled batch can contain many closures. Callers record each
      // retained patch, and reserve space for its own capture/context storage.
      bytes += 256
      if (bytes > (options.maxBytes ?? 8 * 1024 * 1024)) { exhaust(); return }
      updates.push(update)
    },
    account: input => {
      if (!accepting || !valid()) return
      // Accepted IPC payloads and store snapshots are immutable values. Count
      // their shared object graph once, but charge every newly retained array
      // and every reference slot. Serializing a whole inventory for each text
      // frame both blocks rendering and misses the arrays captured by closures.
      const pending: unknown[] = [input]
      const consume = (amount: number): boolean => {
        bytes += amount
        if (bytes > (options.maxBytes ?? 8 * 1024 * 1024)) { exhaust(); return false }
        return true
      }
      try {
        while (pending.length && accepting && valid()) {
          const value = pending.pop()
          if (typeof value === 'string') { if (!consume(retainedStringBytes(value))) return; continue }
          if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
            if (!consume(16)) return
            continue
          }
          if (typeof value !== 'object') { exhaust(); return }
          if (!consume(16)) return
          if (retained.has(value)) continue
          const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
          if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) { exhaust(); return }
          retained.add(value)
          if (!consume(128 + (array ? value.length * 16 : 0))) return
          for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== 'string') { exhaust(); return }
            if (array && key === 'length') continue
            const descriptor = Object.getOwnPropertyDescriptor(value, key)
            if (!descriptor || !('value' in descriptor)) { exhaust(); return }
            // Array index labels are not retained strings in the source graph.
            const index = Number(key)
            if (!(array && Number.isInteger(index) && index >= 0 && index < value.length && String(index) === key)) {
              if (!consume(32 + retainedStringBytes(key))) return
            }
            pending.push(descriptor.value)
          }
        }
      } catch { exhaust() }
    },
    rebase: base => {
      // Capture before enqueueing React's update. Later live dispatches apply
      // after this replacement and must not be replayed twice.
      const accepted = updates.slice()
      return previous => valid() ? accepted.reduce((state, update) => update(state), base) : previous
    },
    finish: () => { accepting = false; updates = []; retained = new WeakSet() },
    cancel: () => { cancelled = true; accepting = false; updates = []; retained = new WeakSet() },
    valid
  }
}

/** Upper-bound JSON UTF-8 and UTF-16 storage without allocating a second body. */
function retainedStringBytes(value: string): number {
  let encoded = 2
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code === 34 || code === 92) encoded += 2
    else if (code < 32) encoded += [8, 9, 10, 12, 13].includes(code) ? 2 : 6
    else if (code < 128) encoded++
    else if (code < 2048) encoded += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { encoded += 4; index++ }
    else encoded += code >= 0xd800 && code <= 0xdfff ? 6 : 3
  }
  return 64 + Math.max(encoded, value.length * 2)
}
