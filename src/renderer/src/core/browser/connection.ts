import { getAppSettings, onAppSettingsChanged } from '../app-provider'
import {
  getEngineSource,
  getExpectedEngine,
  isEngineReady,
  subscribeEngineSource
} from '../engine/source'
import { onWorkspaceConnectionChanged } from '../workspace/connection'
import type { ClientSurfaceScope } from '../platform/surface-scope'

// Work owns a different session from Code even before its browser panel is visible.
// Keeping the override here means the single native browser bridge never has two
// competing registrations for the same window.
let sessionOverride: string | null = null
let overrideSource = -1
let scheduleOverride: (() => void) | null = null
const identityListeners = new Set<() => void>()
export function onBrowserSessionChanged(listener: () => void): () => void {
  identityListeners.add(listener)
  return () => { identityListeners.delete(listener) }
}
export function getBrowserSessionId(mode: ClientSurfaceScope = 'work'): string | null {
  return mode === 'work' ? overrideSource === getEngineSource() ? sessionOverride : null : getAppSettings().lastSessionId || null
}

export function setBrowserSessionOverride(
  sessionId?: string | null,
  source = getEngineSource()
): void {
  const next = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null
  if (sessionOverride === next && overrideSource === source) return
  sessionOverride = next
  overrideSource = source
  for (const listener of identityListeners) listener()
  scheduleOverride?.()
}

/** Keep the engine tool channel available even before its browser editor has been opened. */
export function wireBrowserConnection(): () => void {
  let disposed = false
  let scheduled = false
  let lastKey = ''
  const sync = (): void => {
    if (disposed) return
    const expectedEngine = getExpectedEngine()
    // A missing/pending Work identity must never attach its pages to Code's
    // remembered session. Generation guards prevent a hidden view's old account
    // identity from being reused during an engine/source transition.
    const mode = 'work', sessionId = getBrowserSessionId(mode)
    const key = isEngineReady() && sessionId ? JSON.stringify([expectedEngine, sessionId, mode]) : ''
    if (key === lastKey) return
    lastKey = key
    if (!key || !sessionId) {
      void window.aether.browser.disconnect().catch(() => {})
      return
    }
    void window.aether.browser.connect({ sessionId, expectedEngine, presentationMode: mode }).catch(() => {
      if (lastKey === key) lastKey = ''
    })
  }
  const schedule = (): void => {
    if (scheduled || disposed) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      sync()
    })
  }
  scheduleOverride = schedule
  const settings = onAppSettingsChanged(schedule)
  const source = subscribeEngineSource(schedule)
  const workspace = onWorkspaceConnectionChanged(schedule)
  schedule()
  return () => {
    disposed = true
    if (scheduleOverride === schedule) scheduleOverride = null
    settings()
    source()
    workspace()
    void window.aether.browser.disconnect().catch(() => {})
  }
}
