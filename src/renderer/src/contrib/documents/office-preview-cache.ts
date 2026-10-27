const MAX_CACHED_HTML = 48 * 1024 * 1024
const MAX_CACHED_DOCUMENTS = 8
const RETENTION_MS = 60_000

interface Entry {
  source: ArrayBuffer
  pages: readonly string[]
  bytes: number
  expires: number
}

const entries = new Map<string, Entry>()
let cachedBytes = 0

function evict(now: number): void {
  for (const [key, entry] of entries) {
    if (entries.size <= MAX_CACHED_DOCUMENTS && cachedBytes <= MAX_CACHED_HTML && entry.expires > now) continue
    entries.delete(key)
    cachedBytes -= entry.bytes
  }
}

/** Survives Work's bounded preview unmounts. Retention is deliberately short:
 * a new file generation never renders these stale bytes while it parses. */
export function getOfficePreview(key: string, source: ArrayBuffer): readonly string[] | null {
  const entry = entries.get(key)
  if (!entry || entry.source !== source || entry.expires <= Date.now()) return null
  entry.expires = Date.now() + RETENTION_MS
  entries.delete(key)
  entries.set(key, entry)
  return entry.pages
}

export function cacheOfficePreview(key: string, source: ArrayBuffer, pages: readonly string[]): void {
  const bytes = pages.reduce((sum, page) => sum + page.length * 2, 0)
  const previous = entries.get(key)
  if (previous) cachedBytes -= previous.bytes
  entries.delete(key)
  if (bytes > MAX_CACHED_HTML) return
  entries.set(key, { source, pages, bytes, expires: Date.now() + RETENTION_MS })
  cachedBytes += bytes
  evict(Date.now())
}

export function officePreviewCacheStats(): { entries: number; bytes: number } {
  return { entries: entries.size, bytes: cachedBytes }
}
