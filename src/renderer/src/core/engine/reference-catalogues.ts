import type { SessionToolkit } from '@shared/toolkits'
import { CatalogueCache } from './catalogue-cache'
import { subscribeAgentCatalogueChanges } from './agent-catalogue'
import { subscribeResourceCatalogueChanges } from './resource-catalogue'
import { subscribeEngineSource } from './source'

export interface AgentCatalogueReference { id: string; name: string; description?: string }
export const agentReferenceCache = new CatalogueCache<AgentCatalogueReference[]>(1)
export const toolkitReferenceCache = new CatalogueCache<SessionToolkit[]>()
let subscribed = false

/** Keep invalidation alive while the picker is closed, including AI-authored mutations. */
export function startReferenceCatalogues(): void {
  if (subscribed) return
  subscribed = true
  const invalidateAll = (): void => { agentReferenceCache.invalidate(); toolkitReferenceCache.invalidate() }
  let resourcesOff = subscribeResourceCatalogueChanges(['plugin'], () => toolkitReferenceCache.invalidate())
  subscribeEngineSource(() => {
    resourcesOff()
    resourcesOff = subscribeResourceCatalogueChanges(['plugin'], () => toolkitReferenceCache.invalidate())
    invalidateAll()
  })
  subscribeAgentCatalogueChanges(invalidateAll)
}
