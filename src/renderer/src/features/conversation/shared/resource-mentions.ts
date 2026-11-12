import { isResourceSource, mentionToken, type Mention, type ResourceMentionSource } from './mention-context'

export interface ResourceBindings { skills: string[]; mcpServers: string[]; knowledgeBases: string[] }
export type ResourceDraft = { text: string; mentions: readonly Mention[] }
export const RESOURCE_KINDS = ['skill', 'mcp', 'kb'] as const
export const resourceBindingKey = (kind: ResourceMentionSource): keyof ResourceBindings =>
  kind === 'skill' ? 'skills' : kind === 'mcp' ? 'mcpServers' : 'knowledgeBases'
export const resourceMentionKey = (kind: ResourceMentionSource, id: string): string => `${kind}:${id}`

export function resourceMention(kind: ResourceMentionSource, id: string, label = id): Mention {
  return { source: kind, path: id, displayText: label }
}

/** Authored chips select resources; typing a similar slash string does not. */
export function draftResourceBindings(draft: ResourceDraft): ResourceBindings {
  const result: ResourceBindings = { skills: [], mcpServers: [], knowledgeBases: [] }
  for (const mention of draft.mentions) {
    if (!isResourceSource(mention.source) || !mention.path || mention.textOffset === undefined || mention.textOffset < 0) continue
    const token = mentionToken(mention)
    if (draft.text.slice(mention.textOffset, mention.textOffset + token.length) !== token) continue
    const ids = result[resourceBindingKey(mention.source)]
    if (!ids.includes(mention.path)) ids.push(mention.path)
  }
  return result
}

/** Preserve inherited bindings, applying only actual edits (including undo/redo). */
export function editResourceBindings(current: Partial<ResourceBindings> | undefined, before: ResourceDraft, after: ResourceDraft): ResourceBindings {
  const previous = draftResourceBindings(before), next = draftResourceBindings(after)
  const result: ResourceBindings = { skills: [], mcpServers: [], knowledgeBases: [] }
  for (const kind of RESOURCE_KINDS) {
    const key = resourceBindingKey(kind)
    const removed = previous[key].filter(id => !next[key].includes(id))
    result[key] = [...new Set([...(current?.[key] ?? []).filter(id => !removed.includes(id)),
      ...next[key].filter(id => !previous[key].includes(id))])]
  }
  return result
}

export function sameResourceBindings(left: Partial<ResourceBindings> | undefined, right: Partial<ResourceBindings> | undefined): boolean {
  return RESOURCE_KINDS.every(kind => {
    const key = resourceBindingKey(kind), a = left?.[key] ?? [], b = right?.[key] ?? []
    return a.length === b.length && a.every(id => b.includes(id))
  })
}

/** Consuming a message resets the next turn's selection, not the active run. */
export function resourceFollowupChanges(selection: Partial<ResourceBindings>, running: Partial<ResourceBindings> | undefined): boolean {
  if (!RESOURCE_KINDS.some(kind => selection[resourceBindingKey(kind)]?.length)) return false
  return RESOURCE_KINDS.some(kind => {
    const key = resourceBindingKey(kind), ids = selection[key]
    return ids !== undefined && !sameResourceBindings({ [key]: ids }, { [key]: running?.[key] })
  })
}

export function resourceBindingEdits(before: ResourceDraft, after: ResourceDraft): Array<keyof ResourceBindings> {
  const previous = draftResourceBindings(before), next = draftResourceBindings(after)
  return RESOURCE_KINDS.map(resourceBindingKey).filter(key => previous[key].length !== next[key].length ||
    previous[key].some(id => !next[key].includes(id)))
}

export function consumedResourcePatch(current: Partial<ResourceBindings>, draft: ResourceDraft, sentSelection: Partial<ResourceBindings> = {}): Partial<ResourceBindings> {
  const sent = draftResourceBindings(draft), patch: Partial<ResourceBindings> = {}
  for (const kind of RESOURCE_KINDS) {
    const key = resourceBindingKey(kind)
    // Legacy bindings can be sent before their catalogue labels finish loading.
    // Consume the admitted selection too, while preserving later additions.
    const ids = new Set([...sent[key], ...(sentSelection[key] ?? [])])
    if (ids.size) patch[key] = (current[key] ?? []).filter(id => !ids.has(id))
  }
  return patch
}

export function restoredResourcePatch(current: Partial<ResourceBindings>, draft: ResourceDraft): Partial<ResourceBindings> {
  const sent = draftResourceBindings(draft), patch: Partial<ResourceBindings> = {}
  for (const kind of RESOURCE_KINDS) {
    const key = resourceBindingKey(kind)
    if (sent[key].length) patch[key] = [...new Set([...(current[key] ?? []), ...sent[key]])]
  }
  return patch
}

/** Persistent configuration labels alone are not a new instruction. */
export function hasNonResourceContent(draft: ResourceDraft): boolean {
  let text = draft.text
  for (const mention of [...draft.mentions].reverse()) {
    if (!isResourceSource(mention.source) || mention.textOffset === undefined) continue
    const token = mentionToken(mention), offset = mention.textOffset
    if (text.slice(offset, offset + token.length) === token) text = text.slice(0, offset) + text.slice(offset + token.length)
  }
  return Boolean(text.replace(/\u200b/g, '').trim())
}
