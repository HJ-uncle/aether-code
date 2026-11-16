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
import { getEngineSource, subscribeEngineSource } from '@renderer/core/engine/source'
import { closePluginDevelopment, openPluginDevelopment, refreshPluginDevelopment, pluginDevelopmentPath, type PluginDevelopmentSession } from '@renderer/core/engine/plugins'
import { requestOrThrow } from '@renderer/core/engine/client'
import { extensionRegistry } from '../extensions/registry'
import { extensionId, type ExtensionContext, type ExtensionPage } from '../extensions/types'

export interface PluginBrowserDocument { page: ExtensionPage; context: ExtensionContext; development?: PluginDevelopmentSession; generation: number; presentation: NonNullable<BrowserTabState['presentation']> }
const pluginDocuments = new Map<string, PluginBrowserDocument>()
export const getPluginBrowserDocument = (tabId: string): PluginBrowserDocument | undefined => pluginDocuments.get(tabId)

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
function pluginTab(document: PluginBrowserDocument, tabId: string): BrowserTabState {
  const { page, development } = document
  return { tabId, url: `aether-plugin:${page.identity.pluginId}/${page.localId}`, title: page.title,
    loading: false, canGoBack: false, canGoForward: false, zoomFactor: 1, viewport: null, navigationId: document.generation,
    presentation: document.presentation,
    pluginPage: { pluginId: page.identity.pluginId, pageId: page.localId, revision: page.identity.revision, development: Boolean(development) } }
}
function updatePluginDocument(tabId: string, value: PluginBrowserDocument): void {
  pluginDocuments.set(tabId, value); receive({ type: 'changed', tabId, tab: pluginTab(value, tabId) })
}
/** Only structured registered plugin identities can enter this renderer-owned surface. */
export async function openPluginBrowserPage(page: ExtensionPage, context: ExtensionContext, development?: PluginDevelopmentSession): Promise<void> {
  const source = getEngineSource(), scope = browserScopeKey(getBrowserSurfaceOwner())
  if (page.identity.source !== source || !development && !extensionRegistry.has(page.identity)) throw new Error('插件版本已变化，请重新打开。')
  if (page.declaration?.kind !== 'webview') throw new Error('此插件没有自定义页面。')
  await initializeBrowser()
  if (source !== getEngineSource() || scope !== browserScopeKey(getBrowserSurfaceOwner())) return
  if (pluginDocuments.size >= 16) throw new Error('已打开 16 个插件页面，请先关闭不需要的标签。')
  const owner = getBrowserSurfaceOwner()
  let document: PluginBrowserDocument = { page, context: { ...context }, generation: 1, presentation: { ...owner, sessionId: owner.sessionId ?? null } }
  if (development) {
    const opened = await openPluginDevelopment(development.path)
    try {
      if (source !== getEngineSource() || scope !== browserScopeKey(getBrowserSurfaceOwner())) throw new Error('会话或引擎已变化。')
      if (opened.session.hash !== development.hash || !opened.application) throw new Error('源码已变化，请刷新开发预览后重试。')
      let session = opened.session
      if (development.permissionGrants?.length) {
        const value = await requestOrThrow<{ session: PluginDevelopmentSession }>({ method: 'PUT', path: `${pluginDevelopmentPath(session.devSessionId)}/permissions`, body: { grants: development.permissionGrants, revision: session.revision, hash: session.hash } })
        if (value.session.devSessionId !== session.devSessionId || value.session.hash !== session.hash) throw new Error('开发权限回执已失效。')
        session = value.session
      }
      if (source !== getEngineSource() || scope !== browserScopeKey(getBrowserSurfaceOwner())) throw new Error('会话或引擎已变化。')
      document = { ...document, development: session, page: { ...page, application: opened.application, identity: { ...page.identity, revision: session.revision, hash: session.hash, instanceId: `${session.devSessionId}:${session.hash}` } } }
    } catch (error) { if (source === getEngineSource()) await closePluginDevelopment(opened.session).catch(() => {}); throw error }
  }
  const tabId = `plugin:${crypto.randomUUID()}`
  pluginDocuments.set(tabId, document); receive({ type: 'created', tabId, tab: pluginTab(document, tabId) }); revealBrowserTab(tabId)
}
export async function closeBrowserTab(tabId: string): Promise<void> {
  const document = pluginDocuments.get(tabId)
  if (!document) { await window.aether.browser.close(tabId); return }
  if (document.development && document.page.identity.source === getEngineSource()) await closePluginDevelopment(document.development)
  pluginDocuments.delete(tabId); receive({ type: 'closed', tabId })
}
export async function reloadBrowserTab(tabId: string): Promise<void> {
  const document = pluginDocuments.get(tabId)
  if (!document) { await window.aether.browser.action({ tabId, action: 'reload' }); return }
  if (document.development) {
    const value = await refreshPluginDevelopment(document.development)
    if (pluginDocuments.get(tabId) !== document || document.page.identity.source !== getEngineSource()) return
    const page = value.application?.manifest.contributes?.pages?.find(item => item.id === document.page.localId)
    if (!value.application || page?.kind !== 'webview') throw new Error('源码中已移除此页面。')
    updatePluginDocument(tabId, { ...document, development: value.session, generation: document.generation + 1,
      page: { ...document.page, id: extensionId(value.session.manifest.id, page.id), title: page.title, scope: page.scope ?? 'global', declaration: page, application: value.application, identity: { ...document.page.identity, pluginId: value.session.manifest.id, revision: value.session.revision, hash: value.session.hash, instanceId: `${value.session.devSessionId}:${value.session.hash}` } } })
  } else {
    if (!extensionRegistry.has(document.page.identity)) throw new Error('插件已停用或版本已变化。')
    updatePluginDocument(tabId, { ...document, generation: document.generation + 1 })
  }
}
export function navigatePluginBrowserPage(tabId: string, target: string): void {
  const document = pluginDocuments.get(tabId)
  if (!document) return
  const declaration = document.page.application?.manifest.contributes?.pages?.find(page => extensionId(document.page.identity.pluginId, page.id) === target)
  if (!declaration || declaration.kind !== 'webview') throw new Error('此浏览器标签只能打开同一插件的自定义页面。')
  updatePluginDocument(tabId, { ...document, generation: document.generation + 1, page: { ...document.page, id: target, localId: declaration.id, title: declaration.title, declaration } })
}
subscribeEngineSource(() => { for (const tabId of pluginDocuments.keys()) { pluginDocuments.delete(tabId); receive({ type: 'closed', tabId }) } })
extensionRegistry.subscribe(() => { for (const [tabId, document] of pluginDocuments) if (!document.development && !extensionRegistry.has(document.page.identity)) { pluginDocuments.delete(tabId); receive({ type: 'closed', tabId }) } })
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
    getBrowserState().tabs.filter(tab => !tab.pluginPage).map((tab) =>
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
  for (const tabId of pluginDocuments.keys()) void closeBrowserTab(tabId).catch(() => {})
  unsubscribe?.()
  unsubscribe = undefined
  starting = undefined
}
