import { getEngineSource } from './source'

export type ResourceCatalogueKind = 'skill' | 'knowledge' | 'automation'
export interface ResourceCatalogueChange { kind: ResourceCatalogueKind; action: string; id: string }
const EVENT = 'aether:resource-catalogue-changed'
const PREFIXES: Record<ResourceCatalogueKind, string> = { skill: 'skill_', knowledge: 'knowledge_', automation: 'cron_' }
const ACTIONS = new Set(['create', 'update', 'delete', 'set_enabled', 'import'])

/** Tool prose and unrelated extensions cannot fabricate management receipts. */
export function resourceCatalogueChange(raw: unknown): ResourceCatalogueChange | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const result = raw as Record<string, unknown>
  if (result.success !== true || result.error || typeof result.name !== 'string') return null
  const metadata = result.metadata
  if (!metadata || typeof metadata !== 'object' || !('resourceChange' in metadata)) return null
  const change = metadata.resourceChange
  if (!change || typeof change !== 'object' || Array.isArray(change)) return null
  const value = change as Record<string, unknown>
  if (value.kind !== 'skill' && value.kind !== 'knowledge' && value.kind !== 'automation') return null
  if (!result.name.startsWith(PREFIXES[value.kind]) || typeof value.action !== 'string' || !ACTIONS.has(value.action) ||
    typeof value.id !== 'string' || !value.id.trim()) return null
  return { kind: value.kind, action: value.action, id: value.id }
}

export function notifyResourceCatalogueChanged(change: ResourceCatalogueChange, source = getEngineSource()): void {
  if (source === getEngineSource()) window.dispatchEvent(new CustomEvent(EVENT, { detail: { ...change, source } }))
}

export function subscribeResourceCatalogueChanges(kinds: readonly ResourceCatalogueKind[], listener: (change: ResourceCatalogueChange) => void): () => void {
  const source = getEngineSource()
  const receive = (event: Event): void => {
    if (event instanceof CustomEvent && source === getEngineSource() && event.detail?.source === source && kinds.includes(event.detail?.kind)) listener(event.detail)
  }
  window.addEventListener(EVENT, receive)
  return () => window.removeEventListener(EVENT, receive)
}
