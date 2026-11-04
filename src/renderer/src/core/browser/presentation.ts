import type { BrowserSurfaceOwner } from '@shared/browser'
import { getAppMode, onAppModeChanged } from '../platform/app-mode'

let current: BrowserSurfaceOwner = { mode: getAppMode(), generation: 0 }
export function getBrowserSurfaceOwner(): BrowserSurfaceOwner { return current }

/** Installed before React mounts, even when the active mode contains only a
 * document. Native views must be hidden without waiting for another browser. */
export function wireBrowserPresentation(): () => void {
  const sync = (): void => {
    current = { mode: getAppMode(), generation: current.generation + 1 }
    void window.aether.browser.activateSurface(current).catch(() => {})
  }
  const unsubscribe = onAppModeChanged(sync)
  sync()
  return unsubscribe
}
