import { useEffect, useMemo, useState, type JSX } from 'react'
import { requestOrThrow } from '@renderer/core/engine/client'

export interface WorkAgent {
  id: string
  name: string
  description?: string
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
  useEffect(() => {
    let alive = true
    void requestOrThrow<{ list?: Array<{ id?: string; name?: string; description?: string }> }>({
      method: 'GET', path: '/agents', query: { current: 1, pageSize: 100 }
    }).then((res) => {
      if (!alive) return
      setAgents((res.list ?? []).filter((item): item is { id: string; name: string; description?: string } => Boolean(item.id && item.name)))
    }).catch(() => { if (alive) setAgents([]) })
    return () => { alive = false }
  }, [])
  const filtered = useMemo(() => {
    const needle = query.replace(/^agent\s*/i, '').trim().toLowerCase()
    return agents.filter((item) => !needle || `${item.name} ${item.id} ${item.description ?? ''}`.toLowerCase().includes(needle)).slice(0, 20)
  }, [agents, query])
  useEffect(() => setActive(0), [query, filtered.length])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (!filtered.length) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); setActive((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length)
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault(); onSelect(filtered[active] ?? filtered[0])
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, filtered, onClose, onSelect])
  return <div className="work-agent-picker" role="listbox" aria-label="选择自定义 Agent">
    <div className="work-agent-picker__title">选择 Agent <span>@agent 名称</span></div>
    {filtered.length ? filtered.map((agent, index) => <button key={agent.id} type="button" className={`work-agent-picker__item${index === active ? ' is-active' : ''}`} onMouseDown={(event) => { event.preventDefault(); onSelect(agent) }} onMouseEnter={() => setActive(index)}>
      <span className="work-agent-picker__badge">A</span><span><strong>{agent.name}</strong><small>{agent.description || agent.id}</small></span>
    </button>) : <div className="work-agent-picker__empty">没有可用的自定义 Agent</div>}
    <div className="work-agent-picker__hint">↑↓ 选择 · Enter 确认 · Esc 关闭</div>
  </div>
}
