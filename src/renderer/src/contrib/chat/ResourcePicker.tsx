import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { requestOrThrow } from '@renderer/core/engine/client'
import { getEngineSource } from '@renderer/core/engine/source'
import { listKnowledgeBases, type KnowledgeBase } from '@renderer/core/engine/knowledge'
import './resource-picker.css'

export type ResourceKind = 'skill' | 'mcp' | 'kb'
export interface ResourceItem { kind: ResourceKind; id: string; label: string; description?: string }

interface Props {
  query: string
  projectPath?: string
  /** Engine generation; forces a fresh query when local/remote source changes. */
  source?: number
  onSelect: (item: ResourceItem) => void
  onClose: () => void
}

interface SkillRow { id?: string; name: string; description?: string; enabled?: boolean }
interface McpRow { id: string; name?: string; description?: string; enabled?: boolean; scope?: string }

/** Slash resource palette. It is deliberately read-only: management remains in Settings. */
export function ResourcePicker({ query, projectPath, source, onSelect, onClose }: Props): JSX.Element {
  const [items, setItems] = useState<ResourceItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    const sourceAtStart = source ?? getEngineSource()
    setLoading(true); setItems([]); setError(''); setActive(0)
    void Promise.allSettled([
      requestOrThrow<{ list?: SkillRow[] }>({ method: 'GET', path: '/skills', query: { reload: 1, path: projectPath || undefined } }),
      requestOrThrow<McpRow[]>({ method: 'GET', path: '/mcp/servers', query: projectPath ? { path: projectPath } : undefined }),
      listKnowledgeBases()
    ]).then(([skillsResult, mcpResult, basesResult]) => {
      // A local/remote switch can resolve an old request after the picker has
      // already been rendered against the new engine. Never project that old
      // resource list into the new composer.
      if (!alive || sourceAtStart !== getEngineSource()) return
      const result: ResourceItem[] = []
      const failures: string[] = []
      const skills = skillsResult.status === 'fulfilled' ? skillsResult.value : (failures.push('技能'), null)
      const mcp = mcpResult.status === 'fulfilled' ? mcpResult.value : (failures.push('MCP'), [])
      const bases = basesResult.status === 'fulfilled' ? basesResult.value : (failures.push('知识库'), [])
      for (const row of skills?.list ?? []) {
        if (row.enabled === false) continue
        result.push({ kind: 'skill', id: row.id || row.name, label: row.name, description: row.description })
      }
      for (const row of mcp) {
        if (row.enabled === false) continue
        result.push({ kind: 'mcp', id: row.id, label: row.name || row.id, description: row.description || `${row.id} MCP 服务器` })
      }
      for (const row of bases as KnowledgeBase[]) result.push({ kind: 'kb', id: row.id, label: row.name, description: `${row.documentCount ?? 0} 篇文档` })
      setItems(result); setLoading(false)
      // Successful categories remain usable, but an unavailable catalogue must
      // not be described as empty or as a missing user configuration.
      if (failures.length) setError(`资源加载失败：${failures.join('、')}`)
    })
    return () => { alive = false }
  }, [projectPath, source, reload])

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return items
    const category = needle.match(/^(skill|skills|技能|mcp|kb|knowledge|知识库)(?:\s+(.+))?$/)
    if (category) {
      const kind: ResourceKind = category[1] === 'mcp' ? 'mcp' : ['kb', 'knowledge', '知识库'].includes(category[1]) ? 'kb' : 'skill'
      const rest = category[2]?.trim() ?? ''
      return items.filter(item => item.kind === kind && (!rest || `${item.label} ${item.id} ${item.description ?? ''}`.toLocaleLowerCase().includes(rest)))
    }
    return items.filter(item => `${item.label} ${item.id} ${item.description ?? ''}`.toLocaleLowerCase().includes(needle))
  }, [items, query])

  // Narrowing `/mcp foo` or switching category must never leave the highlight
  // on an index that no longer exists in the filtered list.
  useEffect(() => setActive(0), [query, filtered.length])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
      if ((event.key === 'Enter' || event.key === 'Tab') && event.target instanceof HTMLButtonElement && event.target.classList.contains('resource-picker__retry')) return
      // Own the selection keys before the contenteditable handles Enter as send,
      // including the loading/empty state where there is nothing to select yet.
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      if (filtered.length === 0) return
      if (event.key === 'ArrowDown') setActive(index => (index + 1) % filtered.length)
      else if (event.key === 'ArrowUp') setActive(index => (index - 1 + filtered.length) % filtered.length)
      else onSelect(filtered[active] ?? filtered[0])
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, filtered, onClose, onSelect])

  // Match the file palette / context menu behaviour: clicking elsewhere should
  // dismiss the transient picker. Without this, the list stayed pinned above the
  // composer after focus moved to a message, toolbar control, or another pane.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return
      onClose()
    }
    const onViewportChange = (): void => onClose()
    const onScroll = (event: Event): void => {
      // Scrolling the suggestions (including keyboard scrollIntoView) is part of
      // selection, not a dismissal. Only a moving ancestor invalidates the anchor.
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('blur', onViewportChange)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('blur', onViewportChange)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose])

  useEffect(() => { rootRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [active])

  return <div ref={rootRef} className="resource-picker" role="listbox" aria-label="选择 MCP、技能或知识库">
    <div className="resource-picker__title">添加资源 <span>/skill、/mcp、/kb</span></div>
    {!loading && error ? <div className="resource-picker__hint is-error" role="alert">{error}<button type="button" className="resource-picker__retry" onClick={() => setReload(value => value + 1)}>重试加载资源</button></div> : null}
    {loading ? <div className="resource-picker__hint" role="status">加载中…</div> : filtered.length === 0 ? <div className="resource-picker__hint">{error ? '目录暂不可用，重试后继续选择。' : '没有匹配资源，请先在设置中创建。'}</div> : filtered.map((item, index) => <button key={`${item.kind}:${item.id}`} type="button" role="option" aria-selected={index === active} className={`resource-picker__item${index === active ? ' is-active' : ''}`} onMouseEnter={() => setActive(index)} onMouseDown={(event) => { event.preventDefault(); onSelect(item) }}>
      <span className={`resource-picker__badge is-${item.kind}`}>{item.kind === 'skill' ? '技' : item.kind === 'mcp' ? 'MCP' : '库'}</span>
      <span className="resource-picker__copy"><strong>{item.label}</strong><small>{item.description || item.id}</small></span>
      <kbd>/{item.kind}</kbd>
    </button>)}
    <div className="resource-picker__footer">↑↓ 选择 · Enter 插入 · Esc 关闭</div>
  </div>
}
