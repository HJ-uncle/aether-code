import { useEffect, useState, useSyncExternalStore } from 'react'
import { parseToolkitCatalogue, type SessionToolkit } from '@shared/toolkits'
import { request } from './client'
import { getEngineSource, subscribeEngineSource } from './source'
import { subscribeAgentCatalogueChanges } from './agent-catalogue'
import { subscribeResourceCatalogueChanges } from './resource-catalogue'

/** No static fallback: an older or differently configured engine may not support these tools. */
export function useToolkitCatalogue(enabled: boolean, sessionId?: string, agentId?: string, path?: string | null) {
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const scope = JSON.stringify([source, sessionId ?? null, agentId ?? null, path ?? null])
  const [result, setResult] = useState<{ scope: string; items: SessionToolkit[]; loading: boolean }>({ scope: '', items: [], loading: false })
  const [revision, setRevision] = useState(0)
  useEffect(() => subscribeAgentCatalogueChanges(() => setRevision(value => value + 1)), [])
  useEffect(() => subscribeResourceCatalogueChanges(['plugin'], () => setRevision(value => value + 1)), [source])
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setResult({ scope, items: [], loading: true })
    void request({ method: 'GET', path: '/toolkits', toolProfile: 'general',
      query: { sessionId, agentId: sessionId ? undefined : agentId, path: path || undefined } })
      .then(response => {
        if (!cancelled && source === getEngineSource()) setResult({ scope, items: response.ok ? parseToolkitCatalogue(response.data) : [], loading: false })
      }).catch(() => {
        if (!cancelled && source === getEngineSource()) setResult({ scope, items: [], loading: false })
      })
    return () => { cancelled = true }
  }, [enabled, scope, source, sessionId, agentId, path, revision])
  return enabled && result.scope === scope ? result : { items: [], loading: enabled }
}
