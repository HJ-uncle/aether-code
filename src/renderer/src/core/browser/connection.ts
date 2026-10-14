import { getAppSettings, onAppSettingsChanged } from '../app-provider'
import {
  getEngineSource,
  getExpectedEngine,
  isEngineReady,
  subscribeEngineSource
} from '../engine/source'
import { onWorkspaceConnectionChanged } from '../workspace/connection'
import { getAppMode, onAppModeChanged } from '../platform/app-mode'

// Work owns a different session from Code even before its browser panel is visible.
// Keeping the override here means the single native browser bridge never has two
// competing registrations for the same window.
let sessionOverride: string | null = null
let overrideSource = -1
let scheduleOverride: (() => void) | null = null

export function setBrowserSessionOverride(
  sessionId?: string | null,
  source = getEngineSource()
): void {
  const next = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null
  if (sessionOverride === next && overrideSource === source) return
  sessionOverride = next
  overrideSource = source
  scheduleOverride?.()
}

/** Keep the engine tool channel available even before its browser editor has been opened. */
export function wireBrowserConnection(): () => void {
  let disposed = false
  let scheduled = false
  let lastKey = ''
  const sync = (): void => {
    if (disposed) return
    const settings = getAppSettings()
    const expectedEngine = getExpectedEngine()
    // A missing/pending Work identity must never attach its pages to Code's
    // remembered session. Generation guards prevent a hidden view's old account
    // identity from being reused during an engine/source transition.
    const sessionId =
      getAppMode() === 'work'
        ? overrideSource === getEngineSource()
          ? sessionOverride
          : null
        : settings.lastSessionId
    const key = isEngineReady() && sessionId ? JSON.stringify([expectedEngine, sessionId]) : ''
    if (key === lastKey) return
    lastKey = key
    if (!key || !sessionId) {
      void window.aether.browser.disconnect().catch(() => {})
      return
    }
    void window.aether.browser.connect({ sessionId, expectedEngine }).catch(() => {
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
  const mode = onAppModeChanged(schedule)
  schedule()
  return () => {
    disposed = true
    if (scheduleOverride === schedule) scheduleOverride = null
    settings()
    source()
    workspace()
    mode()
    void window.aether.browser.disconnect().catch(() => {})
  }
}
