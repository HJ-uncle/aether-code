import type { BrowserNetworkEntry, BrowserTabState } from './browser'

/** Filters run before pagination so an AI can narrow traffic without losing matches. */
export interface BrowserNetworkQuery {
  url?: string
  method?: string
  resourceType?: string
  status?: string
  failedOnly?: boolean
  minDurationMs?: number
  offset?: number
  limit?: number
}

export interface BrowserNetworkList {
  tab: BrowserTabState
  entries: BrowserNetworkEntry[]
  total: number
  captured: number
  dropped: number
  offset: number
  limit: number
  hasMore: boolean
  nextOffset?: number
  warnings?: string[]
}

export interface BrowserNetworkHeader { name: string; value: string; redacted?: boolean }

export interface BrowserNetworkBody {
  state: 'available' | 'pending' | 'unavailable' | 'binary' | 'too-large' | 'empty'
  text?: string
  mimeType?: string
  offset: number
  totalChars?: number
  returnedChars: number
  hasMore: boolean
  nextOffset?: number
  truncated?: boolean
  reason?: string
  redacted?: boolean
}

export interface BrowserNetworkDetailOptions {
  bodyTarget?: 'request' | 'response'
  bodyOffset?: number
  bodyLimit?: number
}

export interface BrowserNetworkDetail {
  tab: BrowserTabState
  entry: BrowserNetworkEntry
  request: {
    headers: BrowserNetworkHeader[]
    query: BrowserNetworkHeader[]
    cookies: BrowserNetworkHeader[]
    body: BrowserNetworkBody
  }
  response: {
    headers: BrowserNetworkHeader[]
    cookies: BrowserNetworkHeader[]
    body: BrowserNetworkBody
    statusText?: string
    mimeType?: string
    protocol?: string
    remoteIPAddress?: string
    remotePort?: number
    fromDiskCache?: boolean
    fromServiceWorker?: boolean
  }
  timing: Record<string, number>
  initiator?: { type: string; url?: string; lineNumber?: number; stack?: Array<{ functionName: string; url: string; lineNumber: number; columnNumber: number }> }
  previousRequestId?: string
  nextRequestId?: string
  warnings: string[]
}
