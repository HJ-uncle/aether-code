import type { BrowserNetworkQuery, BrowserNetworkDetailOptions } from './browser-network'

/** The browser surface and AI tools address the same isolated WebContents. */
export interface BrowserContext {
  sessionId: string
  engineId: string
}

export interface BrowserViewport {
  width: number
  height: number
  mobile: boolean
  deviceScaleFactor: number
}

export interface BrowserSettings {
  homeUrl: string
  zoomFactor: number
  persistSession: boolean
  aiEnabled: boolean
  defaultViewport: BrowserViewport | null
}

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  homeUrl: 'about:blank',
  zoomFactor: 1,
  persistSession: true,
  aiEnabled: true,
  defaultViewport: null
}

export interface BrowserTabState {
  tabId: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  zoomFactor: number
  viewport: BrowserViewport | null
  navigationId: number
  context?: BrowserContext
  error?: string
}

export interface BrowserCreateInput {
  url?: string
  context?: BrowserContext
}

export type BrowserEvent =
  | { type: 'created' | 'changed'; tab: BrowserTabState; tabId: string }
  | { type: 'reveal'; tab: BrowserTabState; tabId: string; requestId: string }
  | { type: 'closed'; tabId: string }
  | { type: 'focus-address'; tabId: string }
  | { type: 'focused'; tabId: string }

export interface BrowserBoundsInput {
  tabId: string
  bounds: { x: number; y: number; width: number; height: number }
  visible: boolean
  /** A fresh layout acknowledgement for a requested AI-visible tab. */
  revealRequestId?: string
}

export type BrowserAction =
  | { tabId: string; action: 'navigate'; url: string }
  | { tabId: string; action: 'back' | 'forward' | 'reload' | 'stop' | 'devtools' }
  | { tabId: string; action: 'zoom'; zoomFactor: number }
  | { tabId: string; action: 'viewport'; viewport: BrowserViewport | null }

export type BrowserReadKind = 'snapshot' | 'screenshot' | 'console' | 'network'

export interface BrowserToolRequest {
  action: 'open' | 'tabs' | 'snapshot' | 'screenshot' | 'click' | 'fill' | 'scroll' | 'press_key' | 'wait' | 'console' | 'network' | 'network_detail' | 'navigate' | 'viewport' | 'close'
  tabId?: string
  url?: string
  ref?: string
  selector?: string
  x?: number
  y?: number
  text?: string
  key?: string
  deltaX?: number
  deltaY?: number
  timeoutMs?: number
  viewport?: BrowserViewport | null
  navigationId?: number
  query?: BrowserNetworkQuery
  requestId?: string
  bodyTarget?: BrowserNetworkDetailOptions['bodyTarget']
  bodyOffset?: number
  bodyLimit?: number
}

export interface BrowserToolResult {
  success: boolean
  output?: unknown
  error?: string
}

export interface BrowserConsoleEntry {
  id: number
  timestamp: number
  level: string
  message: string
  source?: string
  line?: number
}

export interface BrowserNetworkEntry {
  id: string
  timestamp: number
  method: string
  url: string
  status?: number
  resourceType?: string
  durationMs?: number
  error?: string
  navigationId?: number
  mimeType?: string
  transferredBytes?: number
  finished?: boolean
}

export interface BrowserElement {
  ref?: string
  role: string
  name: string
  value?: string
  /** Main-page viewport CSS pixels; null means no layout position was available, omitted for old records. */
  bounds?: { x: number; y: number; width: number; height: number } | null
}

/** The whole visible CSS viewport, stored as PNG; dimensions describe actual image pixels. */
export interface BrowserViewportScreenshot {
  dataUrl: string
  width: number
  height: number
}

/** CSS coordinates and page state captured before dispatch, even if the click navigates. */
export interface BrowserClickInteraction {
  type: 'click'
  x: number
  y: number
  navigationId: number
  pageUrl: string
  viewport: { width: number; height: number; deviceScaleFactor: number; scrollX: number; scrollY: number }
  /** Captured before mouse dispatch; never replaced with a post-navigation image. */
  screenshot?: BrowserViewportScreenshot
  target?: {
    name?: string
    role?: string
    ref?: string
    selector?: string
    bounds?: { x: number; y: number; width: number; height: number }
  }
}

export interface BrowserSnapshot {
  tab: BrowserTabState
  text: string
  elements: BrowserElement[]
  truncated: boolean
  viewport: { width: number; height: number; deviceScaleFactor: number; scrollX: number; scrollY: number }
  screenshot?: BrowserViewportScreenshot
  interaction?: BrowserClickInteraction
}

/** The action was dispatched successfully, but a following page could not be read yet. */
export interface BrowserUnavailableSnapshot {
  tab: BrowserTabState
  text: string
  elements: BrowserElement[]
  truncated: false
  snapshotUnavailable: string
  interaction?: BrowserClickInteraction
}

export interface BrowserScreenshot {
  tab: BrowserTabState
  dataUrl: string
  mimeType: 'image/png'
  filename: string
  size: number
  width: number
  height: number
  /** Input coordinates use CSS pixels; image dimensions may include device scaling. */
  viewport: { width: number; height: number; deviceScaleFactor: number }
}
