import { useEffect, useId, useRef, useState, type JSX } from 'react'
import { AgentRefPicker } from './AgentRefPicker'
import { agentMentionSearch } from './agent-references'
import { FileRefPalette } from './FileRefPalette'
import type { Mention } from './mention-context'
import './mention-ref-picker.css'

type ReferenceKind = 'files' | 'agents'

/** Modes share discovery and keyboard behavior; the composer still owns its draft. */
export function MentionRefPicker({ root, query, showSearch = false, onSelect, onClose }: {
  root: string | null
  query: string
  showSearch?: boolean
  onSelect: (mention: Mention) => void
  onClose: () => void
}): JSX.Element {
  const [kind, setKind] = useState<ReferenceKind>(() => agentMentionSearch(query) !== null || !root ? 'agents' : 'files')
  const [search, setSearch] = useState('')
  const id = useId()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const keyword = showSearch ? search : query
  useEffect(() => {
    if (!showSearch && agentMentionSearch(query) !== null) setKind('agents')
  }, [query, showSearch])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229 || !event.altKey || event.ctrlKey || event.metaKey ||
        !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      setKind(event.key === 'ArrowLeft' ? 'files' : 'agents')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  const changeTab = (next: ReferenceKind, focusTab = false): void => {
    setKind(next)
    if (focusTab) tabRefs.current[next === 'files' ? 0 : 1]?.focus()
  }
  return <div className="mention-ref-picker">
    <div className="mention-ref-picker__tabs" role="tablist" aria-label="引用类型">
      {(['files', 'agents'] as const).map((value, index) => <button key={value} ref={node => { tabRefs.current[index] = node }}
        type="button" role="tab" id={`${id}-${value}`} aria-controls={`${id}-list`} aria-selected={kind === value}
        tabIndex={kind === value ? 0 : -1} data-mention-list-control
        onMouseDown={event => event.preventDefault()} onClick={() => changeTab(value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          changeTab(event.key === 'ArrowLeft' || event.key === 'Home' ? 'files' : 'agents', true)
        }}>{value === 'files' ? '文件与目录' : '协作 Agent'}</button>)}
    </div>
    {showSearch ? <input className="mention-ref-picker__search" aria-label="搜索引用" autoFocus value={search}
      placeholder={kind === 'files' ? '搜索文件或目录…' : '搜索 Agent 名称…'} onChange={event => setSearch(event.target.value)} /> : null}
    <div id={`${id}-list`} role="tabpanel" aria-labelledby={`${id}-${kind}`} className="mention-ref-picker__content">
      {kind === 'agents' ? <AgentRefPicker query={keyword} onSelect={agent => onSelect({ source: 'agent', path: agent.id, displayText: agent.name })} onClose={onClose} /> : root ?
        <FileRefPalette root={root} keyword={keyword} onSelect={onSelect} onClose={onClose} /> :
        <div className="mention-ref-picker__empty"><span>选择工作区后可引用文件与目录</span><button type="button" data-mention-list-control className="mention-ref-picker__retry" onClick={() => changeTab('agents')}>选择协作 Agent</button></div>}
    </div>
    <div className="mention-ref-picker__footer">{kind === 'agents' ? '作为子代理协作 · 保留上下文续跑' : '引用文件或整个目录'}<span>↑↓ 选择 · Enter / Tab 确认 · Alt + ←→ 切换 · Esc 关闭</span></div>
  </div>
}
