import type { PDFDocumentProxy } from 'pdfjs-dist'

interface Entry {
  source: ArrayBuffer
  document: PDFDocumentProxy
  destroy: () => void | Promise<void>
  references: number
  retired: boolean
  idleTimer?: ReturnType<typeof setTimeout>
  closed: boolean
}

export interface PdfLoadedDocument { document: PDFDocumentProxy; destroy: () => void | Promise<void> }
export interface PdfLease { document: PDFDocumentProxy; release: (discard?: boolean) => void }

const sessions = new Map<string, Entry[]>()
const pending = new Map<string, Promise<PdfLoadedDocument>>()
const IDLE_MS = 60_000
const IDLE_LIMIT = 4

function sameBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left === right) return true
  if (left.byteLength !== right.byteLength) return false
  const a = new Uint8Array(left), b = new Uint8Array(right)
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false
  return true
}

function closeEntry(entry: Entry): void {
  if (entry.closed) return
  entry.closed = true
  clearTimeout(entry.idleTimer)
  void entry.destroy()
  for (const [key, entries] of sessions) {
    const remaining = entries.filter(item => item !== entry)
    if (remaining.length !== entries.length) {
      if (remaining.length) sessions.set(key, remaining)
      else sessions.delete(key)
      break
    }
  }
}

function evict(): void {
  const idle = [...sessions.values()].flat().filter(entry => !entry.references)
  for (const entry of idle.slice(0, Math.max(0, idle.length - IDLE_LIMIT))) closeEntry(entry)
}

export async function acquirePdfDocument(key: string, data: ArrayBuffer, load: (bytes: ArrayBuffer) => Promise<PdfLoadedDocument>): Promise<PdfLease> {
  const entries = sessions.get(key) ?? []
  for (const entry of entries) {
    if (sameBytes(entry.source, data) && !entry.retired) continue
    clearTimeout(entry.idleTimer)
    entry.retired = true
    if (!entry.references) closeEntry(entry)
  }
  const cached = (sessions.get(key) ?? []).find(entry => sameBytes(entry.source, data) && !entry.retired)
  if (cached) {
    clearTimeout(cached.idleTimer)
    cached.references++
    return lease(cached)
  }
  const previous = pending.get(key)
  const task = (previous ? previous.catch(() => undefined).then(() => load(data.slice(0))) : load(data.slice(0)))
    .then(loaded => {
      if (loaded.document.numPages > 1000) {
        void loaded.destroy()
        throw new Error('此 PDF 超出预览范围（最多 1000 页）。')
      }
      return loaded
    })
  pending.set(key, task)
  try {
    const loaded = await task
    const entry: Entry = { source: data, document: loaded.document, destroy: loaded.destroy, references: 1, retired: false, closed: false }
    sessions.set(key, [...(sessions.get(key) ?? []).filter(item => !item.closed), entry])
    evict()
    return lease(entry)
  } finally {
    if (pending.get(key) === task) pending.delete(key)
  }
}

function release(entry: Entry, discard = false): void {
  entry.references = Math.max(0, entry.references - 1)
  if (discard) entry.retired = true
  if (!entry.references) {
    clearTimeout(entry.idleTimer)
    if (discard || entry.retired) closeEntry(entry)
    else entry.idleTimer = setTimeout(() => closeEntry(entry), IDLE_MS)
  }
  evict()
}

export function pdfPreviewSessionCount(): number { return [...sessions.values()].flat().filter(entry => !entry.closed).length }

function lease(entry: Entry): PdfLease {
  let released = false
  return {
    document: entry.document,
    release: discard => {
      if (released) return
      released = true
      release(entry, discard)
    }
  }
}
