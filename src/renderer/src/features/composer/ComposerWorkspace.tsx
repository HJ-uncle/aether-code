import { useCallback, useEffect, useId, useRef, useState, type JSX } from 'react'
import { getEngineSource } from '@renderer/core/engine/source'
import { sessionWorkspaceContext } from '@renderer/core/workspace/fs-client'
import { Icon } from '@renderer/ui/icons'
import { Popover } from '@renderer/ui/Popover'
import { Spinner } from '@renderer/ui/ui-primitives'
import { sessionWorkspacePathKey } from '../workspace/workspace-history'
import './composer-workspace.css'

interface WorkspaceSelection {
  history: readonly { path: string }[]
  defaultPath: string | null
  busy: boolean
  reason: string | null
  onSelect: (path: string | null) => Promise<boolean>
  onBrowse: () => Promise<boolean>
}

/** A task's saved folder is a selection hint. Existing conversations display
 * the engine's binding, including scratch and remote directories. */
export function ComposerWorkspace({ sessionId, selectedPath, runId, draft, ready, active, remote, selection }: {
  sessionId: string | null
  selectedPath: string | null
  runId?: string
  draft: boolean
  ready: boolean
  active: boolean
  remote: boolean
  selection?: WorkspaceSelection
}): JSX.Element {
  const source = getEngineSource()
  const scope = JSON.stringify([source, sessionId, selectedPath, runId, draft])
  const [resolved, setResolved] = useState<{ scope: string; root?: string; error?: string }>()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [editingPath, setEditingPath] = useState(false)
  const [path, setPath] = useState('')
  const [picking, setPicking] = useState(false)
  const [failed, setFailed] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const reasonId = useId()
  const openRef = useRef(open)
  openRef.current = open
  const focusChoices = useCallback((element: HTMLDivElement | null): void => {
    if (!element) return
    // The picker is portalled: move keyboard focus with it instead of tabbing through the page behind it.
    requestAnimationFrame(() => {
      if (!element.isConnected || !openRef.current) return
      const focus = element.querySelector<HTMLElement>('input[type="search"]')
        ?? element.querySelector<HTMLElement>('button[aria-pressed="true"]:not(:disabled)')
        ?? element.querySelector<HTMLElement>('button:not(:disabled)')
      focus?.focus({ preventScroll: true })
    })
  }, [])
  useEffect(() => { setOpen(false); setFailed(false) }, [source, sessionId])
  useEffect(() => {
    if (!active || !ready || draft || !sessionId) return
    let current = true
    void sessionWorkspaceContext(sessionId).then(context => {
      if (current && source === getEngineSource()) setResolved({ scope, root: context.root })
    }).catch((cause: unknown) => {
      if (current && source === getEngineSource()) setResolved({ scope, error: cause instanceof Error ? cause.message : '暂时无法确认工作区' })
    })
    return () => { current = false }
  }, [active, ready, draft, sessionId, scope, source])
  const current = resolved?.scope === scope ? resolved : undefined
  const root = draft ? selectedPath ?? selection?.defaultPath : current?.root
  const name = root?.split(/[\\/]/).filter(Boolean).at(-1) || root
  const label = name ? `${draft && !selectedPath ? '默认工作区' : '工作区'} · ${name}` : draft ? '默认工作区' : !ready ? '工作区未连接' : current?.error ? '工作区未确认' : '正在确认工作区…'
  const detail = root ?? (draft ? '使用引擎配置的默认工作区，为任务创建独立目录。' : current?.error ?? (!ready ? '连接引擎后可确认当前工作区。' : '正在读取当前会话的工作区。'))
  const busy = picking || selection?.busy
  const disabled = Boolean(busy || selection?.reason)
  const history = selection?.history.filter(item => item.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? []
  const select = async (next: string | null): Promise<void> => {
    if (!selection || disabled) return
    setFailed(false)
    setPicking(true)
    try {
      if (await selection.onSelect(next)) { setOpen(false); triggerRef.current?.focus() }
      else setFailed(true)
    } catch { setFailed(true) }
    finally { setPicking(false) }
  }
  return <div className="work-composer-workspace">
  <Popover key={JSON.stringify([source, sessionId, draft])} className="work-composer-workspace__popover"
    panelClassName={selection ? 'work-workspace-picker' : 'work-composer-workspace__details'}
    placement="up" align="start" width={360} label={selection ? '选择工作区' : '当前工作区'} disabled={!active}
    open={open} onOpenChange={next => { setOpen(next); if (next) { setQuery(''); setEditingPath(false); setFailed(false) } }}
    trigger={({ open }) => <button type="button" ref={triggerRef} className="work-composer-workspace__trigger"
      title={detail} aria-label={`当前工作区：${root ?? label}`} aria-haspopup="dialog" aria-expanded={open} aria-busy={busy}
      aria-describedby={open && selection?.reason ? reasonId : undefined}>
      {busy ? <Spinner size={13} /> : <Icon name="folder-outline" size={13} aria-hidden="true" />}
      <span>{label}</span>
      {selection && <Icon name="chevron-down" size={12} aria-hidden="true" />}
    </button>}>
    {selection ? <div ref={focusChoices} className="work-workspace-picker__content">
      <div className="work-workspace-picker__current">
        <div><strong>当前工作区</strong>{selection.reason && <span title={selection.reason}>已固定</span>}</div>
        <p title={detail}>{detail}</p>
      </div>
      {selection.history.length > 5 && <label className="work-workspace-picker__search">
        <Icon name="search" size={13} aria-hidden="true" />
        <input type="search" aria-label="搜索工作区" placeholder="搜索工作区" value={query} onChange={event => setQuery(event.target.value)} />
      </label>}
      <button type="button" className="work-workspace-picker__item work-workspace-picker__item--default" aria-label="使用默认工作区" aria-pressed={!selectedPath}
        title={selection.defaultPath ?? '使用设置中的默认位置，为每个任务创建独立目录。'}
        disabled={disabled} onClick={() => void select(null)}>
        <Icon name="folder-outline" size={15} aria-hidden="true" />
        <span><strong>默认工作区</strong><small>{selection.defaultPath ? '使用设置中的目录' : '每个任务独立目录'}</small></span>
        {!selectedPath && <Icon name="check" size={14} aria-hidden="true" />}
      </button>
      {!!selection.history.length && <>
        <div className="work-workspace-picker__section">最近使用</div>
        <div className="work-workspace-picker__history" aria-label="最近使用的工作区">
          {history.map(item => <button type="button" key={item.path} className="work-workspace-picker__item"
            aria-label={`使用工作区：${item.path}`} aria-pressed={Boolean(selectedPath && sessionWorkspacePathKey(selectedPath) === sessionWorkspacePathKey(item.path))} title={item.path}
            disabled={disabled} onClick={() => void select(item.path)}>
            <Icon name="folder-outline" size={15} aria-hidden="true" />
            <span><strong>{item.path.split(/[\\/]/).filter(Boolean).at(-1) || item.path}</strong><small dir="rtl"><bdi dir="ltr">{item.path}</bdi></small></span>
            {selectedPath && sessionWorkspacePathKey(selectedPath) === sessionWorkspacePathKey(item.path) && <Icon name="check" size={14} aria-hidden="true" />}
          </button>)}
          {!history.length && <p className="work-workspace-picker__empty">没有匹配的工作区</p>}
        </div>
      </>}
      {selection.reason && <p id={reasonId} className="work-workspace-picker__locked" title={selection.reason}>
        <Icon name="info" size={13} aria-hidden="true" />
        <span>{selection.reason}</span>
      </p>}
      <div className="work-workspace-picker__actions">
        {remote ? <button type="button" disabled={disabled} onClick={() => { setEditingPath(!editingPath); setPath(selectedPath ?? '') }}>
          <Icon name="plus" size={14} aria-hidden="true" />输入工作区路径…
        </button> : <button type="button" disabled={disabled} onClick={() => {
          setOpen(false); setPicking(true)
          void selection.onBrowse().catch(() => setFailed(true)).finally(() => setPicking(false))
        }}><Icon name="folder-outline" size={14} aria-hidden="true" />选择其他文件夹…</button>}
      </div>
      {editingPath && <form className="work-workspace-picker__path" onSubmit={event => { event.preventDefault(); void select(path.trim()) }}>
        <input autoFocus aria-label="远端工作区路径" placeholder="远端绝对路径" value={path} disabled={disabled} onChange={event => setPath(event.target.value)} />
        <button type="submit" disabled={disabled || !path.trim()}>使用此工作区</button>
      </form>}
      {failed && <p className="work-workspace-picker__notice" role="alert">未能切换工作区，请检查目录和连接后重试。</p>}
    </div> : <><strong>{draft ? '已选工作区' : remote ? '当前远端工作区' : '当前工作区'}</strong><p>{detail}</p></>}
  </Popover>
  {selection && selectedPath && <button type="button" className="work-composer-workspace__clear"
    aria-label="清除工作区选择，使用默认工作区" title={selection.reason ?? '清除选择，使用默认工作区'}
    disabled={disabled} onClick={() => void select(null)}><Icon name="close" size={12} aria-hidden="true" /></button>}
  </div>
}
