import { useEffect, useRef, useState } from 'react'
import { requestOrThrow } from '@renderer/core/engine/client'
import { getEngineSource } from '@renderer/core/engine/source'
import { listKnowledgeBases } from '@renderer/core/engine/knowledge'
import { isResourceSource, type Mention } from './mention-context'
import { RESOURCE_KINDS, resourceBindingKey, resourceMention, resourceMentionKey, type ResourceBindings } from './resource-mentions'

/** Migrate earlier strip selections once, without recreating labels after send or deletion. */
export function useResourceMentions({ scope, active, projectPath, bindings, consumedKnowledgeBases, mentions, insert }: {
  scope: string
  active: boolean
  projectPath?: string
  bindings: Partial<ResourceBindings>
  consumedKnowledgeBases?: readonly string[]
  mentions: readonly Mention[]
  insert: (mention: Mention) => boolean
}): void {
  const seen = useRef(new Map<string, Set<string>>())
  const [catalogue, setCatalogue] = useState<{ scope: string; labels: Map<string, string> } | null>(null)
  const needsMigration = RESOURCE_KINDS.some(kind => (bindings[resourceBindingKey(kind)] ?? []).some(id =>
    !(kind === 'kb' && consumedKnowledgeBases?.includes(id)) &&
    !seen.current.get(scope)?.has(resourceMentionKey(kind, id)) &&
    !mentions.some(mention => mention.source === kind && mention.path === id)))
  useEffect(() => {
    if (!active || !needsMigration || catalogue?.scope === scope) return
    let alive = true
    const source = getEngineSource()
    void Promise.allSettled([
      requestOrThrow<{ list?: Array<{ id?: string; name: string }> }>({ method: 'GET', path: '/skills', query: { path: projectPath || undefined } }),
      requestOrThrow<Array<{ id: string; name?: string }>>({ method: 'GET', path: '/mcp/servers', query: projectPath ? { path: projectPath } : undefined }),
      listKnowledgeBases()
    ]).then(([skills, servers, bases]) => {
      if (!alive || source !== getEngineSource()) return
      const labels = new Map<string, string>()
      if (skills.status === 'fulfilled') for (const skill of skills.value.list ?? []) labels.set(resourceMentionKey('skill', skill.id || skill.name), skill.name)
      if (servers.status === 'fulfilled') for (const server of servers.value) labels.set(resourceMentionKey('mcp', server.id), server.name || server.id)
      if (bases.status === 'fulfilled') for (const base of bases.value) labels.set(resourceMentionKey('kb', base.id), base.name)
      setCatalogue({ scope, labels })
    })
    return () => { alive = false }
  }, [active, scope, projectPath, needsMigration, catalogue?.scope])
  useEffect(() => {
    if (!active) return
    let visited = seen.current.get(scope)
    if (!visited) { visited = new Set(); seen.current.set(scope, visited) }
    for (const mention of mentions) if (isResourceSource(mention.source) && mention.path)
      visited.add(resourceMentionKey(mention.source, mention.path))
    for (const kind of RESOURCE_KINDS) {
      const key = resourceBindingKey(kind)
      for (const id of bindings[key] ?? []) {
        if (kind === 'kb' && consumedKnowledgeBases?.includes(id)) continue
        const identity = resourceMentionKey(kind, id)
        if (visited.has(identity) || catalogue?.scope !== scope) continue
        if (insert(resourceMention(kind, id, catalogue.labels.get(identity) ?? id))) visited.add(identity)
      }
    }
  }, [active, scope, bindings, consumedKnowledgeBases, mentions, insert, catalogue])
}
