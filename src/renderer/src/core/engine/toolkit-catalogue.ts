import { useEffect, useSyncExternalStore } from 'react'
import { parseToolkitCatalogue } from '@shared/toolkits'
import { requestOrThrow } from './client'
import { getEngineSource, subscribeEngineSource } from './source'
import { startReferenceCatalogues, toolkitReferenceCache } from './reference-catalogues'
import { useCatalogue } from './use-catalogue'

/** No static fallback: an older or differently configured engine may not support these tools. */
export function useToolkitCatalogue(enabled: boolean, sessionId?: string, agentId?: string, path?: string | null) {
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const effectiveAgentId = sessionId ? undefined : agentId
  // The local agent identity also invalidates a bound session while its new binding is being applied.
  const scope = JSON.stringify([source, sessionId ?? null, agentId ?? null, path || null])
  useEffect(startReferenceCatalogues, [])
  const result = useCatalogue(toolkitReferenceCache, scope, enabled, async () => parseToolkitCatalogue(
    await requestOrThrow({ method: 'GET', path: '/toolkits', toolProfile: 'general',
      query: { sessionId, agentId: effectiveAgentId, path: path || undefined } })))
  return { items: result.value ?? [], loading: result.loading, error: result.error, retry: result.retry }
}
