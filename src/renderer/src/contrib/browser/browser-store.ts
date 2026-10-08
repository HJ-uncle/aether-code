import { useSyncExternalStore } from 'react'
import {
  DEFAULT_BROWSER_SETTINGS,
  type BrowserEvent,
  type BrowserSettings,
  type BrowserTabState
} from '@shared/browser'
import { showEditorView } from '@renderer/core/platform/layout-state'
import { toast } from '@renderer/core/toast'

interface BrowserState {
  tabs: BrowserTabState[]
  activeTabId: string | null
  settings: BrowserSettings
  ready: boolean
  error: string
  addressFocusRequest: number
}

let state: BrowserState = {
  tabs: [],
  activeTabId: null,
  settings: DEFAULT_BROWSER_SETTINGS,
  ready: false,
  error: '',
  addressFocusRequest: 0
}
const listeners = new Set<() => void>()
let starting: Promise<void> | undefined
let unsubscribe: (() => void) | undefined
function publish(patch: Partial<BrowserState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}
export function getBrowserState(): BrowserState {
  return state
}
export function onBrowserState(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export function useBrowserState(): BrowserState {
  return useSyncExternalStore(onBrowserState, getBrowserState)
}

function receive(event: BrowserEvent): void {
  if (event.type === 'focused') {
    if (state.activeTabId !== event.tabId) publish({ activeTabId: event.tabId })
    // The native page cannot bubble pointer events into EditorGroupView. Route
    // the editor ownership through layout without moving Chromium's input focus.
    showEditorView('browser')
    return
  }
  if (event.type === 'focus-address') {
    publish({ activeTabId: event.tabId, addressFocusRequest: state.addressFocusRequest + 1 })
    showEditorView('browser')
    return
  }
  if (event.type === 'closed') {
    const index = state.tabs.findIndex((tab) => tab.tabId === event.tabId)
    const tabs = state.tabs.filter((tab) => tab.tabId !== event.tabId)
    publish({
      tabs,
      activeTabId:
        state.activeTabId === event.tabId
          ? (tabs[Math.min(index, tabs.length - 1)]?.tabId ?? null)
          : state.activeTabId
    })
    return
  }
  const exists = state.tabs.some((tab) => tab.tabId === event.tabId)
  publish({
    tabs: exists
      ? state.tabs.map((tab) => (tab.tabId === event.tabId ? event.tab : tab))
      : [...state.tabs, event.tab]
  })
  if (event.type === 'created') {
    publish({ activeTabId: event.tabId })
    // An AI-created page must become the same visible page the user can inspect.
    showEditorView('browser')
  }
}

export function initializeBrowser(): Promise<void> {
  if (starting) return starting
  let eventRevision = 0
  unsubscribe = window.aether.browser.onEvent((event) => {
    eventRevision++
    receive(event)
  })
  starting = Promise.all([window.aether.browser.list(), window.aether.browser.getSettings()])
    .then(([tabs, settings]) => {
      publish({
        settings,
        ready: true,
        error: '',
        ...(eventRevision === 0 ? { tabs, activeTabId: tabs[0]?.tabId ?? null } : {})
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
  publish({ activeTabId: tabId })
}

export async function openBrowser(url?: string): Promise<void> {
  await initializeBrowser()
  showEditorView('browser')
  if (url !== undefined || state.tabs.length === 0) {
    const tab = await window.aether.browser.create(url ? { url } : {})
    receive({ type: 'created', tabId: tab.tabId, tab })
  }
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
