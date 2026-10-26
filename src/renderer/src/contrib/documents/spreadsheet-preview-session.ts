import { DOCUMENT_LIMITS, previewErrorMessage } from './document-kind'
import type { SheetPage, SheetSummary, SpreadsheetRequest, SpreadsheetResponse } from './spreadsheet-preview-contract'

const IDLE_SESSION_MS = 60_000
const IDLE_SESSION_LIMIT = 2

export interface SpreadsheetSession {
  sheets: SheetSummary[]
  page: SheetPage | null
  error: string
  version: number
  subscribe: (notify: () => void) => () => void
  select: (sheet: number, row: number, column: number) => void
}

export interface Lease {
  session: SpreadsheetPreviewSession
  release: () => void
}

class SpreadsheetPreviewSession {
  sheets: SheetSummary[] = []
  page: SheetPage | null = null
  error = ''
  version = 0
  private target: Worker
  private timer: ReturnType<typeof setTimeout>
  private request: Extract<SpreadsheetRequest, { kind: 'page' }> | null = null

  constructor(data: ArrayBuffer) {
    this.target = new Worker(new URL('./spreadsheet-preview.worker.ts', import.meta.url), { type: 'module', name: 'aether-document-spreadsheet' })
    this.timer = setTimeout(() => this.fail('工作簿解析超时，原文件已保留。'), DOCUMENT_LIMITS.parseTimeoutMs)
    this.target.onmessage = (event: MessageEvent<SpreadsheetResponse>) => {
      if (this.error) return
      if (event.data.kind === 'loaded') {
        clearTimeout(this.timer)
        this.sheets = event.data.sheets
        if (!this.sheets.length) this.error = '工作簿中没有可预览的工作表。'
        else if (this.request) this.target.postMessage(this.request)
      } else if (event.data.kind === 'page') this.page = event.data.page
      else this.fail(previewErrorMessage(new Error(event.data.message)))
      if (!this.error) this.notify()
    }
    this.target.onerror = () => this.fail('工作簿解析失败，请重试。')
    this.target.postMessage({ kind: 'load', data } satisfies SpreadsheetRequest, [data])
  }

  subscribe = (notify: () => void): (() => void) => {
    this.listeners.add(notify)
    return () => { this.listeners.delete(notify) }
  }

  select(sheet: number, row: number, column: number): void {
    this.request = { kind: 'page', sheet, row, column }
    if (this.sheets.length && !this.error) this.target.postMessage(this.request)
  }

  close(): void {
    clearTimeout(this.timer)
    this.target.terminate()
    this.listeners.clear()
  }

  private listeners = new Set<() => void>()
  private notify(): void { this.version++; for (const listener of this.listeners) listener() }
  private fail(message: string): void {
    if (this.error) return
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
  idleTimer?: ReturnType<typeof setTimeout>
}

function sameBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left === right) return true
  if (left.byteLength !== right.byteLength) return false
  const a = new Uint8Array(left), b = new Uint8Array(right)
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false
  return true
}

const sessions = new Map<string, Entry>()

export function acquireSpreadsheetSession(key: string, data: ArrayBuffer): Lease {
  let entry = sessions.get(key)
  if (entry && !sameBytes(entry.source, data)) {
    entry.session.close()
    sessions.delete(key)
    entry = undefined
  }
  if (!entry) {
    entry = { source: data, session: new SpreadsheetPreviewSession(data.slice(0)), references: 0 }
    sessions.set(key, entry)
  }
  clearTimeout(entry.idleTimer)
  entry.idleTimer = undefined
  entry.references++
  const current = entry
  let released = false
  evictIdleSessions()
  return {
    session: current.session,
    release: () => {
      if (released) return
      released = true
      if (sessions.get(key) !== current) return
      current.references = Math.max(0, current.references - 1)
      if (!current.references) {
        current.idleTimer = setTimeout(() => releaseSpreadsheetSession(key, current), IDLE_SESSION_MS)
        evictIdleSessions()
      }
    }
  }
}

export function releaseSpreadsheetSession(key: string, expected?: { session: SpreadsheetSession }): void {
  const entry = sessions.get(key)
  if (!entry || expected && entry !== expected) return
  clearTimeout(entry.idleTimer)
  entry.session.close()
  sessions.delete(key)
}

function evictIdleSessions(): void {
  if (sessions.size <= IDLE_SESSION_LIMIT) return
  for (const [key, entry] of sessions) {
    if (sessions.size <= IDLE_SESSION_LIMIT) break
    if (!entry.references) releaseSpreadsheetSession(key, entry)
  }
}

export function spreadsheetSessionCount(): number { return sessions.size }
