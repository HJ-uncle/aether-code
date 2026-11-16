import { abortStream, onStreamEvent, startStream } from './client'
import { getEngineSource, isEngineReady, subscribeEngineReadiness, subscribeEngineSource } from './source'
import { notifyResourceCatalogueChanged, type ResourceCatalogueChange } from './resource-catalogue'

function terminalResponse(value: { status?: number; code?: number } | undefined): boolean {
  const status = value?.status ?? (value?.code && value.code >= 10_000 ? Math.floor(value.code / 100) : value?.code)
  return status === 200 || status === 401 || status === 403 || status === 404 || status === 405
}

/** Only the dedicated, authenticated catalogue stream can invalidate all plugins. */
export function parsePluginCatalogueChange(payload: unknown): ResourceCatalogueChange | null {
  if (!payload || typeof payload !== 'object' || !('pluginCatalogueChange' in payload)) return null
  const change = payload.pluginCatalogueChange
  if (!change || typeof change !== 'object' || !('kind' in change) || change.kind !== 'plugin' ||
    !('action' in change) || !('id' in change) || typeof change.id !== 'string') return null
  if (change.action === 'refresh' && change.id === '*') return { kind: 'plugin', action: 'refresh', id: '*' }
  if (change.action === 'update' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(change.id)) return { kind: 'plugin', action: 'update', id: change.id }
  return null
}

/** App lifetime subscription: mutations from any session/window reach every surface. */
export function startPluginCatalogueSync(): () => void {
  let disposed = false, streamId: string | undefined, reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectAttempt = 0, source = getEngineSource()
  const clearTimer = (): void => { if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = undefined }
  const disconnect = (): void => {
    clearTimer()
    const previous = streamId; streamId = undefined
    if (previous) void abortStream(previous).catch(() => {})
  }
  const retry = (id: string, unsupported = false): void => {
    if (disposed || streamId !== id || source !== getEngineSource()) return
    disconnect()
    if (unsupported || !isEngineReady()) return
    // Reconnect the notification channel only; no catalogue reads while idle.
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt++, 5))
    reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect() }, delay)
  }
  const connect = (): void => {
    if (disposed || streamId || !isEngineReady()) return
    source = getEngineSource()
    const id = `plugin-catalogue-${crypto.randomUUID()}`; streamId = id
    void startStream({ streamId: id, method: 'GET', path: '/plugins/runtime/changes', body: null }).then(result => {
      if (!result.ok) retry(id, terminalResponse(result.rejection))
    }).catch(() => retry(id))
  }
  const eventsOff = onStreamEvent(event => {
    if (disposed || event.streamId !== streamId || source !== getEngineSource()) return
    if (event.type === 'payload') {
      const change = parsePluginCatalogueChange(event.payload)
      if (change) { reconnectAttempt = 0; notifyResourceCatalogueChanged(change, source) }
    } else if (event.type === 'error') {
      // Older engines may answer with a non-streaming 200; do not keep probing them.
      retry(event.streamId, terminalResponse(event))
    } else retry(event.streamId)
  })
  const reconnect = (): void => { disconnect(); reconnectAttempt = 0; connect() }
  const sourceOff = subscribeEngineSource(reconnect), readyOff = subscribeEngineReadiness(() => { if (!isEngineReady()) disconnect(); else connect() })
  // React effect cleanup is not guaranteed when Chromium replaces the document.
  const stop = (): void => { disposed = true; disconnect(); eventsOff(); sourceOff(); readyOff(); window.removeEventListener('pagehide', stop) }
  window.addEventListener('pagehide', stop)
  connect()
  return stop
}
