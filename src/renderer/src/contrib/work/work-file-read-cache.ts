import type { FsFileContent } from '@shared/ipc'

interface CacheEntry {
  value: FsFileContent
  bytes: number
  lastUsed: number
}

const MAX_CACHE_BYTES = 128 * 1024 * 1024
const MAX_CACHE_ENTRIES = 24
const entries = new Map<string, CacheEntry>()
const pending = new Map<string, Promise<FsFileContent>>()
const generations = new Map<string, number>()
let usedBytes = 0
let clock = 0

function contentBytes(file: FsFileContent): number {
  return file.bytes?.byteLength ?? (file.base64 ? file.base64.length : file.content.length * 2)
}

function evict(): void {
  const ordered = [...entries].sort((left, right) => left[1].lastUsed - right[1].lastUsed)
  for (const [key, entry] of ordered) {
    if (entries.size <= MAX_CACHE_ENTRIES && usedBytes <= MAX_CACHE_BYTES) break
    entries.delete(key)
    usedBytes -= entry.bytes
  }
}

/** Read-through cache for tab activation. Explicit refresh bypasses it, while
 * concurrent views of one resource share the same bounded read. */
export function readWorkFileCached(key: string, reader: () => Promise<FsFileContent>, refresh = false): Promise<FsFileContent> {
  if (!refresh) {
    const cached = entries.get(key)
    if (cached) {
      cached.lastUsed = ++clock
      entries.delete(key)
      entries.set(key, cached)
      return Promise.resolve(cached.value)
    }
    const running = pending.get(key)
    if (running) return running
  }
  if (refresh) generations.set(key, (generations.get(key) ?? 0) + 1)
  if (!generations.has(key)) generations.set(key, 0)
  const generation = generations.get(key) ?? 0
  const task = Promise.resolve().then(reader).then(value => {
    const bytes = contentBytes(value)
    if (generations.get(key) === generation && bytes <= MAX_CACHE_BYTES) {
      const previous = entries.get(key)
      if (previous) usedBytes -= previous.bytes
      entries.set(key, { value, bytes, lastUsed: ++clock })
      usedBytes += bytes
      evict()
    }
    return value
  }).finally(() => {
    if (pending.get(key) === task) pending.delete(key)
  })
  pending.set(key, task)
  return task
}

export function invalidateWorkFileReadCache(key: string): void {
  generations.set(key, (generations.get(key) ?? 0) + 1)
  const entry = entries.get(key)
  if (entry) usedBytes -= entry.bytes
  entries.delete(key)
}

export function clearWorkFileReadCache(): void {
  entries.clear()
  pending.clear()
  generations.clear()
  usedBytes = 0
}

export function workFileReadCacheStats(): { entries: number; bytes: number; pending: number } {
  return { entries: entries.size, bytes: usedBytes, pending: pending.size }
}
