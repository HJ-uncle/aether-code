import type { BrowserSurfaceOwner, BrowserTabPresentation } from '@shared/browser'
import type { ClientSurfaceScope } from '../platform/surface-scope'
import { getAppSettings, onAppSettingsChanged } from '../app-provider'
import { engineConnectionKey, getExpectedEngine, isEngineReady, subscribeEngineSource } from '../engine/source'
import { getBrowserSessionId, onBrowserSessionChanged } from './connection'
import { browserPendingSourceId, browserScopeKey } from './scope'

let current: BrowserSurfaceOwner = { mode: 'work', generation: 0 }
const listeners = new Set<() => void>()
export function getBrowserSurfaceOwner(): BrowserSurfaceOwner { return current }
export function getBrowserPresentationScope(mode: ClientSurfaceScope = 'work', sessionId = getBrowserSessionId(mode)): BrowserTabPresentation {
  const expected = getExpectedEngine(), settings = getAppSettings()
  return { mode, sessionId, ...(isEngineReady()
    ? { engineId: engineConnectionKey({ ...expected, phase: 'ready' }) }
    : { pendingSourceId: browserPendingSourceId(settings.engineMode, settings.remoteBaseUrl, expected.accountId) }) }
}
export function onBrowserPresentationChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Installed before React mounts, even when the active mode contains only a
 * document. Native views must be hidden without waiting for another browser. */
export function wireBrowserPresentation(): () => void {
  let activated = false
  const sync = (): void => {
    const owner = getBrowserPresentationScope()
    if (activated && browserScopeKey(owner) === browserScopeKey(current)) return
    activated = true
    current = { ...owner, generation: current.generation + 1 }
    void window.aether.browser.activateSurface(current).catch(() => {})
    for (const listener of listeners) listener()
  }
  const subscriptions = [onAppSettingsChanged(sync), subscribeEngineSource(sync), onBrowserSessionChanged(sync)]
  sync()
  return () => { for (const unsubscribe of subscriptions) unsubscribe() }
}
