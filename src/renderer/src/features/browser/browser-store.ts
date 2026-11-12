import { useSyncExternalStore } from 'react'
import {
  DEFAULT_BROWSER_SETTINGS,
  type BrowserEvent,
  type BrowserSettings,
  type BrowserTabState
} from '@shared/browser'
import { toast } from '@renderer/core/toast'
import { getBrowserPresentationScope, getBrowserSurfaceOwner, onBrowserPresentationChanged } from '@renderer/core/browser/presentation'
import { BrowserScopeRegistry, browserScopeKey } from '@renderer/core/browser/scope'
import type { ClientSurfaceScope } from '@renderer/core/platform/surface-scope'

interface BrowserState {
  tabs: BrowserTabState[]
  activeTabId: string | null
  settings: BrowserSettings
  ready: boolean
  error: string
  addressFocusRequest: number
  revealRequest: { tabId: string; requestId: string } | null
}

let state: BrowserState = {
  tabs: [],
  activeTabId: null,
  settings: DEFAULT_BROWSER_SETTINGS,
  ready: false,
  error: '',
  addressFocusRequest: 0,
  revealRequest: null
}
const registry = new BrowserScopeRegistry()
const listeners = new Set<() => void>()
const snapshots = new Map<string, { source: BrowserState; value: BrowserState }>()
onBrowserPresentationChanged(() => { for (const listener of listeners) listener() })
let starting: Promise<void> | undefined
let unsubscribe: (() => void) | undefined
function publish(patch: Partial<BrowserState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}
export function getBrowserState(mode?: ClientSurfaceScope): BrowserState {
  const scope = mode ? getBrowserPresentationScope(mode) : getBrowserSurfaceOwner()
  const key = browserScopeKey(scope), cached = snapshots.get(key)
  if (cached?.source === state) return cached.value
  const value = { ...state, ...registry.view(scope) }
  snapshots.delete(key); snapshots.set(key, { source: state, value })
  while (snapshots.size > 128) snapshots.delete(snapshots.keys().next().value!)
  return value
}
export function onBrowserState(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export function useBrowserState(mode?: ClientSurfaceScope): BrowserState {
  return useSyncExternalStore(onBrowserState, () => getBrowserState(mode))
}

function receive(event: BrowserEvent): void {
  registry.receive(event)
  publish({})
}

/** A completed open may precede event delivery. Ingest the result without
 * replaying a foreground reveal after its originating action was superseded. */
export function acceptBrowserTab(tab: BrowserTabState): void {
  registry.receive({ type: 'created', tabId: tab.tabId, tab })
  publish({})
}

/** User actions and browser tool requests reveal the same session resource pane. */
export function revealBrowserTab(tabId: string): void {
  const tab = getBrowserState().tabs.find(tab => tab.tabId === tabId)
  if (!tab) return
  receive({ type: 'reveal', tabId, tab, requestId: `ui:${crypto.randomUUID()}` })
}

export function initializeBrowser(): Promise<void> {
  if (starting) return starting
  const observed = new Set<string>()
  unsubscribe = window.aether.browser.onEvent((event) => {
    observed.add(event.tabId)
    receive(event)
  })
  starting = Promise.all([window.aether.browser.list(), window.aether.browser.getSettings()])
    .then(([tabs, settings]) => {
      registry.replace(tabs, observed)
      publish({
        settings,
        ready: true,
        error: ''
      })
    })
    .catch((error: unknown) => {
      publish({ ready: true, error: error instanceof Error ? error.message : String(error) })
      unsubscribe?.()
      unsubscribe = undefined
      starting = undefined
    })
  return starting
}

export function selectBrowserTab(tabId: string): void {
  if (registry.select(tabId, getBrowserSurfaceOwner())) publish({})
}

export async function openBrowser(url?: string, options: { reveal?: boolean } = {}): Promise<void> {
  const scope = browserScopeKey(getBrowserSurfaceOwner())
  await initializeBrowser()
  if (scope !== browserScopeKey(getBrowserSurfaceOwner())) return
  let tabId = getBrowserState().activeTabId ?? getBrowserState().tabs[0]?.tabId
  if (url !== undefined || getBrowserState().tabs.length === 0) {
    const tab = await window.aether.browser.create(url ? { url } : {})
    acceptBrowserTab(tab)
    tabId = tab.tabId
  }
  if (!tabId || scope !== browserScopeKey(getBrowserSurfaceOwner())) return
  selectBrowserTab(tabId)
  if (options.reveal !== false) revealBrowserTab(tabId)
}

async function openLocalBrowser(operation: () => Promise<BrowserTabState | null>): Promise<void> {
  const scope = browserScopeKey(getBrowserSurfaceOwner())
  await initializeBrowser()
  if (scope !== browserScopeKey(getBrowserSurfaceOwner())) return
  const tab = await operation()
  if (!tab) return
  acceptBrowserTab(tab)
  // The file picker can outlive a mode/session change; retain the initiating owner.
  if (scope !== browserScopeKey(getBrowserSurfaceOwner())) return
  selectBrowserTab(tab.tabId)
  revealBrowserTab(tab.tabId)
}

export function openLocalBrowserFile(path?: string): Promise<void> {
  return openLocalBrowser(() => window.aether.browser.openLocalFile(path))
}

export function openLocalBrowserDirectory(path?: string): Promise<void> {
  return openLocalBrowser(() => window.aether.browser.openLocalDirectory(path))
}

export function openLocalBrowserEntry(tabId: string, path: string): Promise<void> {
  return openLocalBrowser(() => window.aether.browser.openLocalEntry(tabId, path))
}

export async function updateBrowserSettings(patch: Partial<BrowserSettings>): Promise<void> {
  const settings = await window.aether.browser.updateSettings(patch)
  publish({ settings })
}

/** Settings can also be changed through IPC while this page is unmounted. */
export async function refreshBrowserSettings(): Promise<void> {
  try {
    const settings = await window.aether.browser.getSettings()
    publish({ settings, error: '' })
  } catch (reason: unknown) {
    publish({ error: reason instanceof Error ? reason.message : String(reason) })
  }
}

/** Release native pages when Work's browser workspace is closed or not selected. */
export async function hideBrowserSurfaces(stillHidden: () => boolean = () => true): Promise<void> {
  const surface = getBrowserSurfaceOwner()
  await initializeBrowser()
  if (!stillHidden() || surface !== getBrowserSurfaceOwner()) return
  await Promise.all(
    getBrowserState().tabs.map((tab) =>
      window.aether.browser
        .setBounds({
          tabId: tab.tabId,
          surface,
          bounds: { x: 0, y: 0, width: 0, height: 0 },
          visible: false
        })
        .catch(() => undefined)
    )
  )
}

export function browserAction(operation: () => Promise<unknown>): void {
  void operation().catch((error: unknown) =>
    toast.error(error instanceof Error ? error.message : String(error))
  )
}

export function disposeBrowser(): void {
  unsubscribe?.()
  unsubscribe = undefined
  starting = undefined
}
