import type { PptxNotesPreview } from './pptx-notes'

const MAX_CACHED_BYTES = 48 * 1024 * 1024
const MAX_CACHED_DOCUMENTS = 8
const RETENTION_MS = 60_000

export interface CachedOfficePreview extends PptxNotesPreview { pages: readonly string[] }

interface Entry {
  source: ArrayBuffer
  matches: WeakSet<ArrayBuffer>
  preview: CachedOfficePreview
  bytes: number
  expires: number
}

const entries = new Map<string, Entry>()
let cachedBytes = 0

function evict(now: number): void {
  for (const [key, entry] of entries) {
    if (entries.size <= MAX_CACHED_DOCUMENTS && cachedBytes <= MAX_CACHED_BYTES && entry.expires > now) continue
    entries.delete(key)
    cachedBytes -= entry.bytes
  }
}

function sameBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false
  const words = Math.floor(left.byteLength / 4)
  const leftWords = new Uint32Array(left, 0, words), rightWords = new Uint32Array(right, 0, words)
  for (let index = 0; index < words; index++) if (leftWords[index] !== rightWords[index]) return false
  const leftTail = new Uint8Array(left, words * 4), rightTail = new Uint8Array(right, words * 4)
  for (let index = 0; index < leftTail.length; index++) if (leftTail[index] !== rightTail[index]) return false
  return true
}

/** Preview inputs are immutable. Full byte comparison lets a newly decoded
 * buffer reuse its preview without mistaking a changed file for the same path. */
export function getOfficePreview(key: string, source: ArrayBuffer): CachedOfficePreview | null {
  const now = Date.now()
  evict(now)
  const entry = entries.get(key)
  if (!entry || !entry.matches.has(source) && !sameBytes(entry.source, source)) return null
  entry.matches.add(source)
  entry.expires = now + RETENTION_MS
  entries.delete(key)
  entries.set(key, entry)
  return entry.preview
}

export function cacheOfficePreview(key: string, source: ArrayBuffer, pages: readonly string[], notes: PptxNotesPreview = {}): void {
  const now = Date.now()
  evict(now)
  const bytes = source.byteLength + pages.reduce((sum, page) => sum + page.length * 2, 0) +
    (notes.notes?.reduce((sum, note) => sum + note.text.length * 2, 0) ?? 0) + (notes.notesError?.length ?? 0) * 2
  const previous = entries.get(key)
  if (previous) cachedBytes -= previous.bytes
  entries.delete(key)
  if (bytes > MAX_CACHED_BYTES) return
  entries.set(key, { source, matches: new WeakSet([source]), preview: { pages, ...notes }, bytes, expires: now + RETENTION_MS })
  cachedBytes += bytes
  evict(now)
}

export function officePreviewCacheStats(): { entries: number; bytes: number } {
  evict(Date.now())
  return { entries: entries.size, bytes: cachedBytes }
}
