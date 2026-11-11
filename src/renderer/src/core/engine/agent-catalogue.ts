import { getEngineSource } from './source'

const AGENTS_CHANGED = 'aether:work-agents-changed'

export function canonicalAgentToolName(name: string): string {
  return name.replace(/^agent_do_(create|update|delete)$/, 'agent_$1')
}

/** Old execution aliases are not separate selectable capabilities. */
export function visibleAgentToolCatalogue<T extends { name: string }>(tools: readonly T[]): T[] {
  const seen = new Set<string>()
  return tools.filter(tool => {
    if (canonicalAgentToolName(tool.name) !== tool.name || seen.has(tool.name)) return false
    seen.add(tool.name)
    return true
  })
}

export function notifyAgentCatalogueChanged(source = getEngineSource()): void {
  if (source === getEngineSource()) window.dispatchEvent(new CustomEvent(AGENTS_CHANGED, { detail: { source } }))
}

export function subscribeAgentCatalogueChanges(listener: () => void): () => void {
  const receive = (event: Event): void => {
    if (event instanceof CustomEvent && event.detail?.source === getEngineSource()) listener()
  }
  window.addEventListener(AGENTS_CHANGED, receive)
  return () => window.removeEventListener(AGENTS_CHANGED, receive)
}

/** Only successful, structured management receipts invalidate the catalogue. */
export function hasAgentCatalogueChange(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const result = raw as Record<string, unknown>
  if (typeof result.name !== 'string' || !/^agent_(?:do_)?(?:create|update|delete)$/.test(result.name) ||
    result.success !== true || result.error) return false
  const metadata = result.metadata as Record<string, unknown> | undefined
  const change = metadata?.agentChange
  if (!change || typeof change !== 'object' || Array.isArray(change)) return false
  const value = change as Record<string, unknown>
  return ['create', 'update', 'delete'].includes(String(value.action)) && typeof value.id === 'string' && Boolean(value.id.trim())
}
