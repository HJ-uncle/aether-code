import type { SessionResources } from '../sessions/state'
import { consumedResourcePatch, draftResourceBindings, resourceFollowupChanges, sameResourceBindings, type ResourceBindings, type ResourceDraft } from '../conversation/shared/resource-mentions'

/** Persistent knowledge scope must not turn consumed single-turn tools into a new edit. */
export function sessionResourceFollowupChanges(selection: Partial<ResourceBindings>, running: Partial<ResourceBindings> | undefined): boolean {
  const { knowledgeBases, ...singleTurn } = selection
  return resourceFollowupChanges(singleTurn, running) || knowledgeBases !== undefined &&
    !sameResourceBindings({ knowledgeBases }, { knowledgeBases: running?.knowledgeBases })
}

/** Knowledge references authorize this conversation; sending consumes their draft labels only. */
export function consumedSessionResourcePatch(current: SessionResources | undefined, draft: ResourceDraft, sentSelection: Partial<ResourceBindings> = {}): Partial<SessionResources> {
  const patch: Partial<SessionResources> = consumedResourcePatch(current ?? {}, draft, sentSelection)
  delete patch.knowledgeBases
  const sent = new Set([...draftResourceBindings(draft).knowledgeBases, ...(sentSelection.knowledgeBases ?? [])])
  if (sent.size) patch.knowledgeBaseMentionsConsumed = (current?.knowledgeBases ?? []).filter(id =>
    sent.has(id) || current?.knowledgeBaseMentionsConsumed?.includes(id))
  return patch
}

/** Removing the final inline tag must not fall back to the preceding run's selection. */
export function sessionResourceSelection(resources: SessionResources | undefined, key: 'skills' | 'mcpServers' | 'knowledgeBases'): string[] | undefined {
  const ids = resources?.[key].filter(Boolean) ?? []
  return ids.length || resources?.resourceOverrides?.includes(key) ? ids : undefined
}
