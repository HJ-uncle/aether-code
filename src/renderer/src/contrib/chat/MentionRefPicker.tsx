import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import { AgentRefPicker } from './AgentRefPicker'
import { agentMentionSearch } from './agent-references'
import { FileRefPalette } from './FileRefPalette'
import { AttachmentRefPicker } from './AttachmentRefPicker'
import type { AttachmentReference } from './attachment-references'
import type { Mention } from './mention-context'
import { isMotionInteractive } from '@renderer/workbench/motion'
import { isTopOverlay } from '@renderer/workbench/overlay'
import './mention-ref-picker.css'

type ReferenceKind = 'attachments' | 'files' | 'agents'
const NO_ATTACHMENTS: readonly AttachmentReference[] = []

/** Modes share discovery and keyboard behavior; the composer still owns its draft. */
export function MentionRefPicker({ root, query, open = true, showSearch = false, attachments = NO_ATTACHMENTS, sessionId, onSelect, onClose }: {
  root: string | null
  query: string
  open?: boolean
  showSearch?: boolean
  attachments?: readonly AttachmentReference[]
  sessionId?: string
  onSelect: (mention: Mention) => void
  onClose: () => void
}): JSX.Element {
  const [kind, setKind] = useState<ReferenceKind>(() => agentMentionSearch(query) !== null ? 'agents' : attachments.length ? 'attachments' : root ? 'files' : 'agents')
  const hasAttachments = attachments.length > 0
  const kinds = useMemo<ReferenceKind[]>(() => hasAttachments ? ['attachments', 'files', 'agents'] : ['files', 'agents'], [hasAttachments])
  const [search, setSearch] = useState('')
  const id = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const wasOpen = useRef(false)
  const keyword = showSearch ? search : query
  useEffect(() => {
    // Exit animations keep this component mounted across a quick reopen.
    const opening = open && !wasOpen.current
    wasOpen.current = open
    if (!opening) return
    setKind(agentMentionSearch(query) !== null ? 'agents' : hasAttachments ? 'attachments' : root ? 'files' : 'agents')
    setSearch('')
  }, [open, query, hasAttachments, root])
  useEffect(() => {
    if (!showSearch && agentMentionSearch(query) !== null) setKind('agents')
  }, [query, showSearch])
  useEffect(() => {
    if (!hasAttachments && kind === 'attachments') setKind(root ? 'files' : 'agents')
  }, [hasAttachments, kind, root])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!isMotionInteractive(rootRef.current)) return
      const owner = rootRef.current?.closest<HTMLElement>('[data-overlay-id]')?.dataset.overlayId
      if (owner && !isTopOverlay(owner)) return
      if (event.isComposing || event.keyCode === 229 || !event.altKey || event.ctrlKey || event.metaKey ||
        !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      setKind(current => kinds[(kinds.indexOf(current) + (event.key === 'ArrowRight' ? 1 : -1) + kinds.length) % kinds.length])
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [kinds])
  const changeTab = (next: ReferenceKind, focusTab = false): void => {
    setKind(next)
    if (focusTab) tabRefs.current[kinds.indexOf(next)]?.focus()
  }
  return <div ref={rootRef} className="mention-ref-picker">
    <div className="mention-ref-picker__tabs" role="tablist" aria-label="引用类型">
      {kinds.map((value, index) => <button key={value} ref={node => { tabRefs.current[index] = node }}
        type="button" role="tab" id={`${id}-${value}`} aria-controls={`${id}-list`} aria-selected={kind === value}
        tabIndex={kind === value ? 0 : -1} data-mention-list-control
        onMouseDown={event => event.preventDefault()} onClick={() => changeTab(value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          event.stopPropagation()
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? kinds.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + kinds.length) % kinds.length
          changeTab(kinds[next], true)
        }}>{value === 'attachments' ? '当前附件' : value === 'files' ? '文件与目录' : '协作 Agent'}</button>)}
    </div>
    {showSearch ? <input className="mention-ref-picker__search ui-input ui-input--compact" aria-label="搜索引用" autoFocus value={search}
      placeholder={kind === 'attachments' ? '搜索图号或附件名称…' : kind === 'files' ? '搜索文件或目录…' : '搜索 Agent 名称…'} onChange={event => setSearch(event.target.value)} /> : null}
    <div id={`${id}-list`} role="tabpanel" aria-labelledby={`${id}-${kind}`} className="mention-ref-picker__content">
      {kind === 'attachments' ? <AttachmentRefPicker root={root} sessionId={sessionId} references={attachments} query={keyword} onSelect={onSelect} onClose={onClose} /> :
        kind === 'agents' ? <AgentRefPicker query={keyword} onSelect={agent => onSelect({ source: 'agent', path: agent.id, displayText: agent.name })} onClose={onClose} /> : root ?
        <FileRefPalette root={root} keyword={keyword} onSelect={onSelect} onClose={onClose} /> :
        <div className="mention-ref-picker__empty"><span>选择工作区后可引用文件与目录</span><button type="button" data-mention-list-control className="mention-ref-picker__retry" onClick={() => changeTab('agents')}>选择协作 Agent</button></div>}
    </div>
    <div className="mention-ref-picker__footer">{kind === 'attachments' ? '可多次引用同一附件 · 拖入正文也可插入' : kind === 'agents' ? '内置角色可多次添加 · 已有代理可在详情中继续' : '引用文件或整个目录'}<span>↑↓ 选择 · Enter / Tab 确认 · Alt + ←→ 切换 · Esc 关闭</span></div>
  </div>
}
