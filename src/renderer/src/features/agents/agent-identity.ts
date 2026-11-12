import { useEffect, useState } from 'react'
import { requestOrThrow } from '@renderer/core/engine/client'
import { getEngineSource } from '@renderer/core/engine/source'
import { notifyAgentCatalogueChanged, subscribeAgentCatalogueChanges } from '@renderer/core/engine/agent-catalogue'

/** Agent edits can happen while a task stays selected; refresh its identity
 * without resetting the conversation or changing the task's fixed Agent ID. */
export function notifySessionAgentsChanged(): void {
  notifyAgentCatalogueChanged()
}

export function useSessionAgentIdentity(
  id: string,
  ready: boolean
): {
  name: string
  model: string
  loading: boolean
  error: string | null
} {
  const source = getEngineSource()
  const [revision, setRevision] = useState(0)
  const [identity, setIdentity] = useState<{
    source: number
    id: string
    name: string
    model: string
    error: string | null
  } | null>(null)
  useEffect(() => {
    const refresh = (): void => setRevision((value) => value + 1)
    return subscribeAgentCatalogueChanges(refresh)
  }, [])
  useEffect(() => {
    if (!id || !ready) return
    let alive = true
    void requestOrThrow<{ name?: string; model?: string }>({
      method: 'GET',
      path: `/agents/${encodeURIComponent(id)}`
    })
      .then((agent) => {
        if (!alive || source !== getEngineSource()) return
        setIdentity({
          source,
          id,
          name: agent?.name?.trim() || '',
          model: agent?.model?.trim() || '',
          error: agent?.name?.trim() ? null : 'Agent 配置中没有名称'
        })
      })
      .catch((cause) => {
        if (alive && source === getEngineSource())
          setIdentity({
            source,
            id,
            name: '',
            model: '',
            error: cause instanceof Error ? cause.message : '无法读取 Agent 配置'
          })
      })
    return () => {
      alive = false
    }
  }, [id, ready, source, revision])
  if (!id) return { name: '默认助手', model: '', loading: false, error: null }
  const current = identity?.source === source && identity.id === id ? identity : null
  return {
    name: current?.name ?? '',
    model: current?.model ?? '',
    loading: !current,
    error: current?.error ?? null
  }
}
