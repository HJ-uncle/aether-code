import { useCallback, useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import { selectedAgentReference, useAgentReferences } from './AgentRefPicker'
import { agentMentionSearch, type AgentReferenceIdentity } from './agent-references'
import { useFileReferences, type FileReferenceEntry } from './FileRefPalette'
import { AttachmentOption } from './AttachmentRefPicker'
import { attachmentMention, type AttachmentReference } from './attachment-references'
import { formatPathDisplay, type Mention } from './mention-context'
import { agentReferenceIcon } from './agent-mention-icon'
import { useToolkitCatalogue } from '@renderer/core/engine/toolkit-catalogue'
import { FileGlyph } from '@renderer/contrib/explorer/FileGlyph'
import { Icon } from '@renderer/workbench/icons'
import { isPluginToolkitId } from '@shared/toolkits'
import { ToolkitIcon } from './toolkit-icons'
import { isMotionInteractive } from '@renderer/workbench/motion'
import { isTopOverlay } from '@renderer/workbench/overlay'
import { usePickerPointerSelection } from '@renderer/workbench/usePickerPointerSelection'
import './mention-ref-picker.css'

const NO_ATTACHMENTS: readonly AttachmentReference[] = []
const NO_TOOLKITS: readonly string[] = []
type ReferenceOption = { id: string } & (
  | { kind: 'attachment'; reference: AttachmentReference }
  | { kind: 'file'; entry: FileReferenceEntry }
  | { kind: 'agent'; agent: AgentReferenceIdentity }
  | { kind: 'toolkit'; toolkitId: string; name: string; description: string; available: boolean; reason?: string }
)

/** One list owns keyboard selection; data providers never compete for events. */
export function MentionRefPicker({ root, query, open = true, showSearch = false, attachments = NO_ATTACHMENTS, sessionId,
  selectedToolkits = NO_TOOLKITS, toolkitSessionId, toolkitAgentId, toolkitSelectionReady = true, onSelectToolkit, onSelect, onClose }: {
  root: string | null
  query: string
  open?: boolean
  showSearch?: boolean
  attachments?: readonly AttachmentReference[]
  sessionId?: string
  selectedToolkits?: readonly string[]
  toolkitSessionId?: string
  toolkitAgentId?: string
  toolkitSelectionReady?: boolean
  onSelectToolkit?: (id: string, name: string) => void
  onSelect: (mention: Mention) => void
  onClose: () => void
}): JSX.Element {
  const [search, setSearch] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const id = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const pointerSelection = usePickerPointerSelection(open)
  const wasOpen = useRef(false)
  const keyword = showSearch ? search : query
  const agentAlias = agentMentionSearch(keyword)
  const agents = useAgentReferences(keyword)
  const files = useFileReferences(agentAlias === null ? root : null, keyword)
  const toolkits = useToolkitCatalogue(open && Boolean(onSelectToolkit), toolkitSessionId, toolkitAgentId, root)
  const attachmentOptions = useMemo<ReferenceOption[]>(() => agentAlias !== null ? [] : attachments
    .filter(reference => `${reference.label} ${reference.file.name}`.toLowerCase().includes(keyword.trim().toLowerCase()))
    .map(reference => ({ id: `attachment:${reference.id}`, kind: 'attachment', reference })), [attachments, keyword, agentAlias])
  const fileOptions = useMemo<ReferenceOption[]>(() => agentAlias !== null ? [] : (keyword.trim() ? files.filtered : files.filtered.slice(0, 3))
    .map(entry => ({ id: `${entry.isDir ? 'dir' : 'file'}:${entry.path}`, kind: 'file', entry })), [files.filtered, agentAlias, keyword])
  const agentOptions = useMemo<ReferenceOption[]>(() => agents.filtered
    .map(agent => ({ id: `agent:${agent.id}`, kind: 'agent', agent })), [agents.filtered])
  const toolkitOptions = useMemo<ReferenceOption[]>(() => !onSelectToolkit ? [] : toolkits.items
    .filter(toolkit => `${toolkit.name} ${toolkit.description} ${toolkit.id} ${isPluginToolkitId(toolkit.id) ? '插件工具包' : '内置工具包'}`.toLowerCase().includes(keyword.replace(/[ \u00a0\u3000]+/g, ' ').trim().toLowerCase()))
    .map(toolkit => ({ id: `toolkit:${toolkit.id}`, kind: 'toolkit', toolkitId: toolkit.id, name: toolkit.name, description: toolkit.description,
      available: toolkit.available && toolkitSelectionReady, reason: toolkitSelectionReady ? toolkit.reason : '正在读取会话工具包选择…' })), [keyword, onSelectToolkit, toolkits.items, toolkitSelectionReady])
  const toolkitGroups = useMemo(() => [
    { name: '内置工具包', items: toolkitOptions.filter(option => option.kind === 'toolkit' && !isPluginToolkitId(option.toolkitId)) },
    { name: '插件工具包', items: toolkitOptions.filter(option => option.kind === 'toolkit' && isPluginToolkitId(option.toolkitId)) },
  ].filter(group => group.items.length), [toolkitOptions])
  // Keyboard traversal must follow the visible groups even if the engine interleaves sources.
  const options = useMemo(() => [...attachmentOptions, ...fileOptions, ...agentOptions, ...toolkitGroups.flatMap(group => group.items)],
    [attachmentOptions, fileOptions, agentOptions, toolkitGroups])
  const active = options.find(option => option.id === activeId) ?? options[0]
  const activeIndex = active ? options.indexOf(active) : -1
  const optionId = (option: ReferenceOption): string => `${id}-option-${encodeURIComponent(option.id)}`

  useEffect(() => {
    const opening = open && !wasOpen.current
    wasOpen.current = open
    if (opening) { setSearch(''); setActiveId(null) }
  }, [open])
  useEffect(() => setActiveId(null), [keyword])
  useEffect(() => {
    // Async discovery may add rows ahead of the active item. Preserve its identity.
    setActiveId(previous => options.some(option => option.id === previous) ? previous : options[0]?.id ?? null)
  }, [options])
  useEffect(() => {
    if (!open || !isMotionInteractive(rootRef.current)) return
    rootRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active?.id, open])

  const select = useCallback((option: ReferenceOption): void => {
    if (option.kind === 'toolkit' && !option.available) return
    if (option.kind === 'attachment') onSelect(attachmentMention(option.reference))
    else if (option.kind === 'file') onSelect({ source: option.entry.isDir ? 'dir' : 'file', path: option.entry.path, displayText: formatPathDisplay(option.entry.path) })
    else if (option.kind === 'agent') {
      const agent = selectedAgentReference(option.agent)
      onSelect({ source: 'agent', path: agent.id, displayText: agent.name })
    } else onSelectToolkit?.(option.toolkitId, option.name)
    onClose()
  }, [onSelect, onSelectToolkit, onClose])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!open || !isMotionInteractive(rootRef.current)) return
      const owner = rootRef.current?.closest<HTMLElement>('[data-overlay-id]')?.dataset.overlayId
      if (owner && (!isTopOverlay(owner) || event.key === 'Escape')) return
      if (event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.target instanceof Element && event.target.closest('[data-mention-list-control]')) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Tab'].includes(event.key)) return
      pointerSelection.markKeyboard()
      event.preventDefault()
      event.stopPropagation()
      if (!options.length) return
      if (event.key === 'Enter' || event.key === 'Tab') { if (active) select(active); return }
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
        : (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
      setActiveId(options[next].id)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, options, active, activeIndex, select, onClose, pointerSelection.markKeyboard])

  const renderOption = (option: ReferenceOption): JSX.Element => {
    const selected = active?.id === option.id
    if (option.kind === 'attachment') return <AttachmentOption key={option.id} optionId={optionId(option)} tabIndex={-1}
      root={root} sessionId={sessionId} reference={option.reference} active={selected}
      onActivate={event => { if (pointerSelection.canActivate(event)) setActiveId(option.id) }} onSelect={() => select(option)} />
    const isFile = option.kind === 'file'
    const name = isFile ? option.entry.path.split('/').pop() ?? option.entry.path : option.kind === 'agent' ? option.agent.name : option.name
    const description = isFile ? option.entry.path : option.kind === 'agent' ? option.agent.description || option.agent.id : option.reason || option.description
    const enabled = option.kind === 'toolkit' && selectedToolkits.includes(option.toolkitId)
    return <button key={option.id} id={optionId(option)} type="button" role="option" aria-selected={selected} tabIndex={-1}
      aria-disabled={option.kind === 'toolkit' && !option.available || undefined}
      className={`mention-ref-picker__item${selected ? ' is-active' : ''}${isFile ? ' mention-ref-picker__item--file' : ''}`}
      data-reference-kind={option.kind} data-toolkit-id={option.kind === 'toolkit' ? option.toolkitId : undefined}
      data-toolkit-selected={option.kind === 'toolkit' ? enabled : undefined}
      title={`${name}\n${description}`}
      aria-label={enabled ? `${name}，已添加，${description}` : undefined}
      onMouseDown={event => event.preventDefault()} onClick={() => select(option)}
      onPointerEnter={event => { if (pointerSelection.canActivate(event)) setActiveId(option.id) }}
      onPointerMove={event => { if (pointerSelection.canActivate(event)) setActiveId(option.id) }}>
      <span className="mention-ref-picker__icon" aria-hidden="true">{isFile
        ? option.entry.isDir ? <span className="file-palette__dir" /> : <FileGlyph name={name} size={16} />
        : option.kind === 'agent' ? <Icon name={agentReferenceIcon(option.agent.id, option.agent.builtinRole)} size={16} />
        : <ToolkitIcon id={option.toolkitId} />}</span>
      <span className="mention-ref-picker__copy"><strong>{name}</strong><small className={isFile ? 'file-palette__path' : undefined}>{description}</small></span>
      {enabled ? <span className="mention-ref-picker__check" aria-hidden="true"><Icon name="check" size={14} /></span> : null}
    </button>
  }
  const showFiles = agentAlias === null && Boolean(root) && (fileOptions.length > 0 || files.loading || files.error)
  const showAgents = agentOptions.length > 0 || agents.loading || agents.error
  const loading = agents.loading || toolkits.loading || Boolean(root && agentAlias === null && files.loading)
  return <div ref={rootRef} className="mention-ref-picker">
    {showSearch ? <input className="mention-ref-picker__search ui-input ui-input--compact" aria-label="搜索引用" autoFocus value={search}
      aria-controls={`${id}-list`} aria-activedescendant={active ? optionId(active) : undefined}
      placeholder="搜索文件、附件、Agent 或工具包…" onChange={event => setSearch(event.target.value)} /> : null}
    <div id={`${id}-list`} className="mention-ref-picker__list" role="listbox" aria-label="选择引用或工具包" aria-busy={loading}
      aria-activedescendant={active ? optionId(active) : undefined}>
      {attachmentOptions.length ? <div role="group" aria-label="当前附件" className="mention-ref-picker__group">
        <div className="mention-ref-picker__heading" aria-hidden="true">当前附件</div>{attachmentOptions.map(renderOption)}
      </div> : null}
      {showFiles ? <div role="group" aria-label="文件与目录" className="mention-ref-picker__group">
        <div className="mention-ref-picker__heading" aria-hidden="true">文件与目录</div>{fileOptions.map(renderOption)}
        {!keyword.trim() && files.filtered.length > 3 ? <div className="mention-ref-picker__more">输入名称查找更多文件</div> : null}
        {files.loading ? <div className="mention-ref-picker__empty" role="status">正在加载文件与目录…</div> : files.error ?
          <div className="mention-ref-picker__empty" role="alert">{files.error}<button type="button" data-mention-list-control className="mention-ref-picker__retry" onClick={files.retry}>重试</button></div> : null}
      </div> : null}
      {showAgents ? <div role="group" aria-label="协作 Agent" aria-busy={agents.loading} className="mention-ref-picker__group">
        <div className="mention-ref-picker__heading" aria-hidden="true">协作 Agent</div>{agentOptions.map(renderOption)}
        {agents.loading ? <div className="mention-ref-picker__empty" role="status">正在加载自定义 Agent…</div> : agents.error ?
          <div className="mention-ref-picker__empty" role="alert">{agents.error}<button type="button" data-mention-list-control className="mention-ref-picker__retry" onClick={agents.retry}>重试</button></div> : null}
      </div> : null}
      {toolkitGroups.map(group => <div key={group.name} role="group" aria-label={group.name} className="mention-ref-picker__group">
        <div className="mention-ref-picker__heading" aria-hidden="true">{group.name}</div>{group.items.map(renderOption)}
      </div>)}
      {!options.length && !loading && !files.error && !agents.error ? <div className="mention-ref-picker__empty">没有匹配的引用或工具包</div> : null}
    </div>
  </div>
}
