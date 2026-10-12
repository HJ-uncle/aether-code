import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { requestOrThrow } from '@renderer/core/engine/client'
import { getEngineSource } from '@renderer/core/engine/source'

export interface WorkAgent {
  id: string
  name: string
  description?: string
  /** Optional persisted Agent defaults. The picker only needs the identity, but
   * keeping the fields here lets the manager and @agent insertion share the
   * engine's complete Agent shape without dropping bindings. */
  systemPrompt?: string
  model?: string
  temperature?: number
  skills?: string[]
  mcpServers?: string[]
  knowledgeBases?: string[]
  allowedTools?: string[]
}

export function WorkAgentPicker({
  query,
  onSelect,
  onClose
}: {
  query: string
  onSelect: (agent: WorkAgent) => void
  onClose: () => void
}): JSX.Element {
  const [agents, setAgents] = useState<WorkAgent[]>([])
  const [active, setActive] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let alive = true
    const source = getEngineSource()
    setLoading(true); setError(null)
    void requestOrThrow<Array<{ id?: string; name?: string; description?: string }> | { list?: Array<{ id?: string; name?: string; description?: string }> }>({
      method: 'GET', path: '/agents'
    }).then((res) => {
      if (!alive || source !== getEngineSource()) return
      const rows = Array.isArray(res) ? res : res.list ?? []
      setAgents(rows.filter((item): item is { id: string; name: string; description?: string } => Boolean(item.id && item.name)))
      setLoading(false)
    }).catch((cause) => { if (alive && source === getEngineSource()) { setLoading(false); setError(cause instanceof Error ? cause.message : '无法读取 Agent 列表') } })
    return () => { alive = false }
  }, [reload])
  const filtered = useMemo(() => {
    const needle = query.replace(/^agent(?:\s+agent)?\s*/i, '').trim().toLowerCase()
    return agents.filter((item) => !needle || `${item.name} ${item.id} ${item.description ?? ''}`.toLowerCase().includes(needle)).slice(0, 20)
  }, [agents, query])
  useEffect(() => setActive(0), [query, filtered.length])
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      if (!filtered.length) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        setActive((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length)
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        onSelect(filtered[active] ?? filtered[0])
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, filtered, onClose, onSelect])
  return <div ref={rootRef} className="work-agent-picker" role="listbox" aria-label="选择自定义 Agent">
    <div className="work-agent-picker__title">选择 Agent <span>@agent 名称</span></div>
    {loading ? <div className="work-agent-picker__empty">正在加载 Agent…</div> : error ? <div className="work-agent-picker__empty">{error}<button type="button" onClick={() => setReload((value) => value + 1)}>重试</button></div> : filtered.length ? filtered.map((agent, index) => <button key={agent.id} type="button" role="option" aria-selected={index === active} className={`work-agent-picker__item${index === active ? ' is-active' : ''}`} onMouseDown={(event) => event.preventDefault()} onClick={() => onSelect(agent)} onMouseEnter={() => setActive(index)}>
      <span className="work-agent-picker__badge">A</span><span><strong>{agent.name}</strong><small>{agent.description || agent.id}</small></span>
    </button>) : <div className="work-agent-picker__empty">没有可用的自定义 Agent</div>}
    <div className="work-agent-picker__hint">↑↓ 选择 · Enter 确认 · Esc 关闭</div>
  </div>
}
