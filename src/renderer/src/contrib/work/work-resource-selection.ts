import type { WorkResources } from './work-state'
import { consumedResourcePatch, draftResourceBindings, resourceFollowupChanges, sameResourceBindings, type ResourceBindings, type ResourceDraft } from '../chat/resource-mentions'

/** Persistent knowledge scope must not turn consumed single-turn tools into a new edit. */
export function workResourceFollowupChanges(selection: Partial<ResourceBindings>, running: Partial<ResourceBindings> | undefined): boolean {
  const { knowledgeBases, ...singleTurn } = selection
  return resourceFollowupChanges(singleTurn, running) || knowledgeBases !== undefined &&
    !sameResourceBindings({ knowledgeBases }, { knowledgeBases: running?.knowledgeBases })
}

/** Knowledge references authorize this conversation; sending consumes their draft labels only. */
export function consumedWorkResourcePatch(current: WorkResources | undefined, draft: ResourceDraft, sentSelection: Partial<ResourceBindings> = {}): Partial<WorkResources> {
  const patch: Partial<WorkResources> = consumedResourcePatch(current ?? {}, draft, sentSelection)
  delete patch.knowledgeBases
  const sent = new Set([...draftResourceBindings(draft).knowledgeBases, ...(sentSelection.knowledgeBases ?? [])])
  if (sent.size) patch.knowledgeBaseMentionsConsumed = (current?.knowledgeBases ?? []).filter(id =>
    sent.has(id) || current?.knowledgeBaseMentionsConsumed?.includes(id))
  return patch
}

/** Removing the final inline tag must not fall back to the preceding run's selection. */
export function workResourceSelection(resources: WorkResources | undefined, key: 'skills' | 'mcpServers' | 'knowledgeBases'): string[] | undefined {
  const ids = resources?.[key].filter(Boolean) ?? []
  return ids.length || resources?.resourceOverrides?.includes(key) ? ids : undefined
}
