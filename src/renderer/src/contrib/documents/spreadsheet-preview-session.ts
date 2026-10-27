import { DOCUMENT_LIMITS, previewErrorMessage } from './document-kind'
import { SHEET_RANGE_CELL_LIMIT, type SheetLayout, type SheetPage, type SheetSummary, type SpreadsheetRequest, type SpreadsheetResponse } from './spreadsheet-preview-contract'

const IDLE_SESSION_MS = 60_000
const IDLE_SESSION_LIMIT = 6
const PAGE_CACHE_LIMIT = 12
const RANGE_CACHE_CELL_LIMIT = SHEET_RANGE_CELL_LIMIT

type PageRequest = Extract<SpreadsheetRequest, { kind: 'page' }>

export interface SpreadsheetSession {
  sheets: SheetSummary[]
  layouts: SheetLayout[]
  page: SheetPage | null
  error: string
  pageError: string
  version: number
  subscribe: (notify: () => void) => () => void
  select: (sheet: number, row: number, column: number) => void
  getRange: (sheet: number, row: number, column: number, endRow: number, endColumn: number) => SheetPage | null
  requestRange: (sheet: number, row: number, column: number, endRow: number, endColumn: number) => void
}

export interface Lease {
  session: SpreadsheetPreviewSession
  release: () => void
}

type PreviewWorker = Pick<Worker, 'onmessage' | 'onerror' | 'postMessage' | 'terminate'>
type WorkerFactory = () => PreviewWorker

export class SpreadsheetPreviewSession {
  sheets: SheetSummary[] = []
  layouts: SheetLayout[] = []
  page: SheetPage | null = null
  error = ''
  pageError = ''
  version = 0
  private timer: ReturnType<typeof setTimeout>
  private request: Extract<SpreadsheetRequest, { kind: 'page' }> | null = null
  private nextRequestId = 0
  private closed = false
  private loaded = false
  private failed = false
  private pages = new Map<string, SheetPage>()
  private pageErrors = new Map<string, string>()
  private ranges = new Map<string, SheetPage>()
  private rangeErrors = new Map<string, string>()
  private rangeCells = 0
  private pendingRanges = new Map<string, PageRequest>()
  private rangeRequestKeys = new Map<number, string>()
  private pageRequestKeys = new Map<number, string>()

  constructor(private target: PreviewWorker, data: ArrayBuffer) {
    this.timer = setTimeout(() => this.fail('工作簿解析超时，原文件已保留。'), DOCUMENT_LIMITS.parseTimeoutMs)
    this.target.onmessage = (event: MessageEvent<SpreadsheetResponse>) => {
      if (this.closed || this.failed) return
      if (event.data.kind === 'loaded') {
        clearTimeout(this.timer)
        this.loaded = true
        this.sheets = event.data.sheets
        this.layouts = event.data.layouts || []
        if (!this.sheets.length) { this.fail('工作簿中没有可预览的工作表。'); return }
        if (this.request) this.target.postMessage(this.request)
        for (const request of this.pendingPages.values()) this.target.postMessage(request)
        for (const request of this.pendingRanges.values()) this.target.postMessage(request)
      } else if (event.data.kind === 'page') {
        const { requestId, page } = event.data
        const rangeKey = this.rangeRequestKeys.get(requestId)
        if (rangeKey) {
          this.rangeRequestKeys.delete(requestId)
          this.pendingRanges.delete(rangeKey)
          this.rememberRange(rangeKey, page)
          this.rangeErrors.delete(rangeKey)
        } else {
          const key = this.pageKey(page.sheet, page.row, page.column)
          this.pendingPages.delete(key)
          this.pageRequestKeys.delete(requestId)
          this.rememberPage(key, page)
          this.pageErrors.delete(key)
          if (this.request?.requestId === requestId) {
            this.pageError = ''
            this.page = page
            this.error = ''
          }
        }
      } else {
        const requestId = event.data.requestId
        if (requestId === undefined) { this.fail(previewErrorMessage(new Error(event.data.message))); return }
        const message = previewErrorMessage(new Error(event.data.message))
        const rangeKey = this.rangeRequestKeys.get(requestId)
        if (rangeKey) {
          this.rangeRequestKeys.delete(requestId)
          this.pendingRanges.delete(rangeKey)
          this.rangeErrors.set(rangeKey, message)
          while (this.rangeErrors.size > PAGE_CACHE_LIMIT) this.rangeErrors.delete(this.rangeErrors.keys().next().value!)
        } else if (this.pageRequestKeys.has(requestId)) {
          const key = this.pageRequestKeys.get(requestId)!
          this.pageRequestKeys.delete(requestId)
          this.pendingPages.delete(key)
          this.pageErrors.set(key, message)
        } else {
          if (this.request?.requestId !== requestId) return
          const key = this.pageKey(this.request.sheet, this.request.row, this.request.column)
          this.pageErrors.set(key, message)
          this.page = this.pages.get(key) || null
          // A malformed page must not discard an already parsed workbook. The
          // error belongs to this selection and is cleared by another selection.
          this.pageError = message
        }
        while (this.pageErrors.size > PAGE_CACHE_LIMIT) this.pageErrors.delete(this.pageErrors.keys().next().value!)
      }
      this.notify()
    }
    this.target.onerror = () => this.fail('工作簿解析失败，请重试。')
    this.target.postMessage({ kind: 'load', data } satisfies SpreadsheetRequest, [data])
  }

  subscribe = (notify: () => void): (() => void) => {
    this.listeners.add(notify)
    return () => { this.listeners.delete(notify) }
  }

  select(sheet: number, row: number, column: number): void {
    if (this.closed || this.failed) return
    const key = this.pageKey(sheet, row, column)
    this.pageError = this.pageErrors.get(key) || ''
    this.page = this.pages.get(key) || null
    if (this.pages.has(key)) this.rememberPage(key, this.pages.get(key)!)
    const request = this.request
    if (request?.sheet === sheet && request.row === row && request.column === column) { this.notify(); return }
    if (this.pages.has(key)) {
      // A cache hit still advances latest-wins. The worker may finish an older
      // page, but that response can only populate its own cache entry.
      this.request = { kind: 'page', sheet, row, column, requestId: ++this.nextRequestId }
      this.notify()
      return
    }
    this.request = { kind: 'page', sheet, row, column, requestId: ++this.nextRequestId }
    if (this.loaded) this.target.postMessage(this.request)
    this.notify()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.timer)
    this.target.terminate()
    this.listeners.clear()
    this.pages.clear()
    this.pageErrors.clear()
    this.ranges.clear()
    this.rangeErrors.clear()
    this.pendingRanges.clear()
    this.rangeRequestKeys.clear()
    this.pageRequestKeys.clear()
    this.rangeCells = 0
  }

  private listeners = new Set<() => void>()
  private pageKey(sheet: number, row: number, column: number): string { return `${sheet}:${row}:${column}` }
  private rememberPage(key: string, page: SheetPage): void {
    this.pages.delete(key); this.pages.set(key, page)
    while (this.pages.size > PAGE_CACHE_LIMIT) this.pages.delete(this.pages.keys().next().value!)
  }
  getPage(sheet: number, row: number, column: number): SheetPage | null {
    return this.pages.get(this.pageKey(sheet, row, column)) ?? null
  }

  requestPage(sheet: number, row: number, column: number): void {
    const key = this.pageKey(sheet, row, column)
    if (this.closed || this.failed || this.pages.has(key) || this.pendingPages.has(key)) return
    const request: PageRequest = { kind: 'page', sheet, row, column, requestId: ++this.nextRequestId }
    this.pendingPages.set(key, request)
    this.pageRequestKeys.set(request.requestId, key)
    if (this.loaded) this.target.postMessage(request)
  }

  private pendingPages = new Map<string, PageRequest>()

  getRange(sheet: number, row: number, column: number, endRow: number, endColumn: number): SheetPage | null {
    const key = this.rangeKey(sheet, row, column, endRow, endColumn)
    const range = this.ranges.get(key)
    if (range) this.rememberRange(key, range)
    return range || null
  }

  requestRange(sheet: number, row: number, column: number, endRow: number, endColumn: number): void {
    if (this.closed || this.failed || ![sheet, row, column, endRow, endColumn].every(Number.isSafeInteger) || row < 0 || column < 0 || endRow <= row || endColumn <= column) return
    const key = this.rangeKey(sheet, row, column, endRow, endColumn)
    if (this.ranges.has(key) || this.pendingRanges.has(key)) return
    const request: PageRequest = { kind: 'page', sheet, row, column, endRow, endColumn, requestId: ++this.nextRequestId }
    this.pendingRanges.set(key, request)
    this.rangeRequestKeys.set(request.requestId, key)
    if (this.loaded) this.target.postMessage(request)
  }

  getRangeError(sheet: number, row: number, column: number, endRow: number, endColumn: number): string {
    return this.rangeErrors.get(this.rangeKey(sheet, row, column, endRow, endColumn)) || ''
  }

  private rangeKey(sheet: number, row: number, column: number, endRow: number, endColumn: number): string {
    return `${sheet}:${row}:${column}:${endRow}:${endColumn}`
  }

  private rememberRange(key: string, range: SheetPage): void {
    const previous = this.ranges.get(key)
    if (previous) this.rangeCells -= previous.cells.length * (previous.cells[0]?.length || 0)
    this.ranges.delete(key)
    const cells = range.cells.length * (range.cells[0]?.length || 0)
    // An oversized response is never retained; the worker applies the same cell
    // ceiling, so accepting one cannot make the cache temporarily unbounded.
    if (cells > RANGE_CACHE_CELL_LIMIT) return
    this.ranges.set(key, range)
    this.rangeCells += cells
    while (this.rangeCells > RANGE_CACHE_CELL_LIMIT) {
      const oldest = this.ranges.keys().next().value!
      this.removeRange(oldest)
    }
  }

  private removeRange(key: string): void {
    const range = this.ranges.get(key)
    if (range) this.rangeCells -= range.cells.length * (range.cells[0]?.length || 0)
    this.ranges.delete(key)
  }

  private notify(): void { this.version++; for (const listener of this.listeners) listener() }
  private fail(message: string): void {
    if (this.failed || this.closed) return
    this.failed = true
    this.pageError = ''
    this.error = message
    clearTimeout(this.timer)
    this.target.terminate()
    this.notify()
  }
}

interface Entry {
  source: ArrayBuffer
  session: SpreadsheetPreviewSession
  references: number
  retired: boolean
  idleTimer?: ReturnType<typeof setTimeout>
}

function sameBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left === right) return true
  if (left.byteLength !== right.byteLength) return false
  const a = new Uint8Array(left), b = new Uint8Array(right)
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false
  return true
}

const sessions = new Map<string, Entry[]>()
const sessionListeners = new Set<() => void>()
function notifySessions(): void { for (const listener of sessionListeners) listener() }

/** The store snapshot is nullable until the acquisition effect runs. Keeping
 * acquisition out of useMemo/useState initializers makes StrictMode safe. */
export function subscribeSpreadsheetSessions(notify: () => void): () => void {
  sessionListeners.add(notify)
  return () => { sessionListeners.delete(notify) }
}
export function getSpreadsheetSession(key: string, data: ArrayBuffer): SpreadsheetPreviewSession | null {
  const generations = sessions.get(key)
  for (let index = (generations?.length || 0) - 1; index >= 0; index--) {
    const entry = generations![index]
    if (sameBytes(entry.source, data)) return entry.session
  }
  return null
}

export function acquireSpreadsheetSession(key: string, data: ArrayBuffer, createWorker?: WorkerFactory): Lease {
  const generations = sessions.get(key) || []
  let entry: Entry | undefined
  let changed = false
  for (const candidate of generations) {
    if (sameBytes(candidate.source, data)) entry = candidate
    else {
      clearTimeout(candidate.idleTimer)
      candidate.idleTimer = undefined
      candidate.retired = true
      // A previous view may still hold this lease. Its worker remains readable
      // until that lease releases; only an idle stale generation closes here.
      if (!candidate.references) { candidate.session.close(); changed = true }
    }
  }
  // Active generations are bounded by real mounted leases, never by dropping
  // the generation a new lease is about to use. Only idle sessions have a fixed
  // global retention budget below.
  const active = generations.filter(candidate => candidate.references > 0 || !candidate.retired)
  if (!entry) {
    const target = createWorker ? createWorker() : new Worker(new URL('./spreadsheet-preview.worker.ts', import.meta.url), { type: 'module', name: 'aether-document-spreadsheet' })
    entry = { source: data, session: new SpreadsheetPreviewSession(target, data.slice(0)), references: 0, retired: false }
    active.push(entry)
    changed = true
  } else entry.retired = false
  clearTimeout(entry.idleTimer)
  entry.idleTimer = undefined
  entry.references++
  if (active.length) sessions.set(key, active)
  else sessions.delete(key)
  const current = entry
  let released = false
  if (changed) notifySessions()
  evictIdleSessions()
  return {
    session: current.session,
    release: () => {
      if (released) return
      released = true
      current.references = Math.max(0, current.references - 1)
      if (!current.references) {
        if (current.retired) closeGeneration(key, current)
        else current.idleTimer = setTimeout(() => closeGeneration(key, current), IDLE_SESSION_MS)
        evictIdleSessions()
      }
    }
  }
}

function closeGeneration(key: string, expected: Entry): void {
  const generations = sessions.get(key)
  if (!generations?.includes(expected)) return
  clearTimeout(expected.idleTimer)
  expected.retired = true
  expected.session.close()
  const remaining = generations.filter(entry => entry !== expected)
  if (remaining.length) sessions.set(key, remaining)
  else sessions.delete(key)
  notifySessions()
}

export function releaseSpreadsheetSession(key: string, expected?: { session: SpreadsheetSession }): void {
  const generations = sessions.get(key)
  if (!generations || expected && !generations.includes(expected as Entry)) return
  for (const entry of [...generations]) {
    if (!expected || entry === expected) closeGeneration(key, entry)
  }
}

function evictIdleSessions(): void {
  const idle = [...sessions.values()].flat().filter(entry => !entry.references)
  for (let index = 0; idle.length > IDLE_SESSION_LIMIT && index < idle.length; index++) {
    const entry = idle[index]
    for (const [key, generations] of sessions) if (generations.includes(entry)) { closeGeneration(key, entry); break }
    idle.splice(index--, 1)
  }
}

export function spreadsheetSessionCount(): number { return [...sessions.values()].reduce((total, entries) => total + entries.length, 0) }
