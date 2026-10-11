import { getAppSettings, onAppSettingsChanged } from '../app-provider'
import { getExpectedEngine, isEngineReady, subscribeEngineSource } from '../engine/source'
import { onWorkspaceConnectionChanged } from '../workspace/connection'

// Work can own a different session from Code while its browser panel is visible.
// Keeping the override here means the single native browser bridge never has two
// competing registrations for the same window.
let sessionOverride: string | null = null
let scheduleOverride: (() => void) | null = null

export function setBrowserSessionOverride(sessionId?: string | null): void {
  const next = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null
  if (sessionOverride === next) return
  sessionOverride = next
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
    const sessionId = sessionOverride ?? settings.lastSessionId
    const key = isEngineReady() && sessionId ? JSON.stringify([expectedEngine, sessionId]) : ''
    if (key === lastKey) return
    lastKey = key
    if (!key) {
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
