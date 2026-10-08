import { getAppSettings, onAppSettingsChanged } from '../app-provider'
import { getExpectedEngine, isEngineReady, subscribeEngineSource } from '../engine/source'
import { onWorkspaceConnectionChanged } from '../workspace/connection'

/** Keep the engine tool channel available even before its browser editor has been opened. */
export function wireBrowserConnection(): () => void {
  let disposed = false
  let scheduled = false
  let lastKey = ''
  const sync = (): void => {
    if (disposed) return
    const settings = getAppSettings()
    const expectedEngine = getExpectedEngine()
    const sessionId = settings.lastSessionId
    const key = isEngineReady() && sessionId ? JSON.stringify([expectedEngine, sessionId]) : ''
    if (key === lastKey) return
    lastKey = key
    if (!key) { void window.aether.browser.disconnect().catch(() => {}); return }
    void window.aether.browser.connect({ sessionId, expectedEngine }).catch(() => { if (lastKey === key) lastKey = '' })
  }
  const schedule = (): void => {
    if (scheduled || disposed) return
    scheduled = true
    queueMicrotask(() => { scheduled = false; sync() })
  }
  const settings = onAppSettingsChanged(schedule)
  const source = subscribeEngineSource(schedule)
  const workspace = onWorkspaceConnectionChanged(schedule)
  schedule()
  return () => { disposed = true; settings(); source(); workspace(); void window.aether.browser.disconnect().catch(() => {}) }
}
