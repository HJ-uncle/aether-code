import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { requestOrThrow } from '@renderer/core/engine/client'
import { getEngineSource, subscribeEngineSource } from '@renderer/core/engine/source'
import { agentMentionSearch, type AgentReferenceIdentity } from './agent-references'

export function AgentRefPicker({ query, onSelect, onClose }: {
  query: string
  onSelect: (agent: AgentReferenceIdentity) => void
  onClose: () => void
}): JSX.Element {
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const [agents, setAgents] = useState<AgentReferenceIdentity[]>([])
  const [active, setActive] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let alive = true
    setLoading(true)
    setAgents([])
    setError(null)
    void requestOrThrow<AgentReferenceIdentity[] | { list?: AgentReferenceIdentity[] }>({
      method: 'GET', path: '/agents'
    }).then(res => {
      if (!alive || source !== getEngineSource()) return
      const rows = Array.isArray(res) ? res : res.list ?? []
      setAgents(rows.filter(item => typeof item.id === 'string' && Boolean(item.id.trim()) &&
        typeof item.name === 'string' && Boolean(item.name.trim())))
      setLoading(false)
    }).catch(cause => {
      if (alive && source === getEngineSource()) {
        setLoading(false)
        setError(cause instanceof Error ? cause.message : '无法读取 Agent 列表')
      }
    })
    return () => { alive = false }
  }, [source, reload])
  const filtered = useMemo(() => {
    const needle = (agentMentionSearch(query) ?? query).trim().toLowerCase()
    return agents.filter(item => !needle || `${item.name} ${item.id} ${item.description ?? ''}`.toLowerCase().includes(needle)).slice(0, 20)
  }, [agents, query])
  useEffect(() => setActive(0), [query, filtered.length])
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, filtered])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.target instanceof Element && event.target.closest('[data-mention-list-control]')) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key) || event.shiftKey) return
      event.preventDefault()
      event.stopPropagation()
      if (!filtered.length) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length)
      } else onSelect(filtered[active] ?? filtered[0])
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, filtered, onClose, onSelect])
  return <div ref={rootRef} className="agent-ref-picker work-agent-picker" role="listbox" aria-label="选择自定义 Agent" aria-busy={loading}>
    <div className="agent-ref-picker__list">
      {loading ? <div className="mention-ref-picker__empty" role="status">正在加载 Agent…</div> : error ?
        <div className="mention-ref-picker__empty" role="alert">
          <span>{error}</span>
          <button type="button" data-mention-list-control className="mention-ref-picker__retry work-agent-picker__retry" onClick={() => setReload(value => value + 1)}>重试</button>
        </div> : filtered.length ? filtered.map((agent, index) =>
          <button key={agent.id} type="button" role="option" aria-selected={index === active}
            className={`agent-ref-picker__item work-agent-picker__item${index === active ? ' is-active' : ''}`}
            onMouseDown={event => event.preventDefault()} onClick={() => onSelect(agent)} onMouseEnter={() => setActive(index)}>
            <span className="agent-ref-picker__badge" aria-hidden="true">A</span>
            <span className="agent-ref-picker__copy"><strong>{agent.name}</strong><small>{agent.description || agent.id}</small></span>
          </button>) : <div className="mention-ref-picker__empty">{agents.length ? '没有匹配的 Agent' : '暂无自定义 Agent，可在 Agent 管理中创建'}</div>}
    </div>
  </div>
}
