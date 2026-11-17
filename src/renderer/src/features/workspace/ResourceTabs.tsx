import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Icon, type IconName } from '@renderer/ui/icons'
import { Popover } from '@renderer/ui/Popover'
import { browserAction, initializeBrowser, selectBrowserTab } from '../browser/browser-store'
import { openExternalSessionFileResource, selectSessionResource } from './resource-store'
import { getEngineSource, getEngineStorageKey } from '@renderer/core/engine/source'
import { getBrowserSurfaceOwner } from '@renderer/core/browser/presentation'
import { browserTabInScope } from '@renderer/core/browser/scope'
import { getSessionState } from '../sessions/state'
import { toast } from '@renderer/core/toast'
import type { ActionMenuItem } from '@renderer/ui/ActionMenu'
import { isExtensionDestination } from '../../app/navigation'
import { useWorkspaceActivity, type WorkspaceActivityItem, type WorkspaceActivityKind } from '../services/workspace-activity'
import './resource-tabs.css'

interface ActivityEntry extends Pick<WorkspaceActivityItem, 'id' | 'label' | 'detail' | 'statusLabel' | 'icon' | 'open' | 'tone'> {}

interface ActivitySection {
  id: string
  label: string
  icon: IconName
  count: number
  entry: ActivityEntry
}

/**
 * The heading owns this card so destinations remain available with the pane
 * collapsed. It also surfaces live work from the same session context as the
 * global activity tray; empty activity sections stay hidden.
 */
export function ResourceTabs({ sessionId, onSelect, onNewTab, items, activeTab, visibleWorkspaceIds, focusRequest = 0 }: {
  sessionId: string
  onSelect: () => void
  /** Opens the Work landing page as a new workspace tab. */
  onNewTab: () => void
  items: ActionMenuItem[]
  /** The mounted pane already exposes this destination; keep the card deduplicated. */
  activeTab?: string
  /** Optional content gate for destinations which are only useful when populated. */
  visibleWorkspaceIds?: readonly string[]
  /** Increment only for an explicit pane collapse, not ordinary visibility changes. */
  focusRequest?: number
}): JSX.Element {
  const fileInput = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const consumedFocusRequest = useRef(focusRequest)
  const menuRef = useRef<HTMLElement>(null)
  const [open, setOpen] = useState(false)
  const [collapsedKinds, setCollapsedKinds] = useState<ReadonlySet<string>>(new Set())
  const { activities } = useWorkspaceActivity(sessionId)
  useLayoutEffect(() => {
    // Starting at the current request prevents a previous session's collapse
    // from taking focus when this menu later mounts for another session.
    if (consumedFocusRequest.current === focusRequest) return
    consumedFocusRequest.current = focusRequest
    triggerRef.current?.focus({ preventScroll: true })
  }, [focusRequest])
  useEffect(() => { void initializeBrowser() }, [])
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  const openFiles = (files: readonly File[]): void => {
    const candidate = files.find(file => file.size >= 0 && file.name)
    if (!candidate) return
    try {
      openExternalSessionFileResource(candidate, sessionId)
      onSelect()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    openFiles(Array.from(event.currentTarget.files ?? []))
    event.currentTarget.value = ''
  }
  const openBrowser = (): void => {
    void browserAction(async () => {
      const source = getEngineSource()
      const current = (): boolean => source === getEngineSource() && getSessionState(getEngineStorageKey()).activeTaskId === sessionId
      const presentation = getBrowserSurfaceOwner()
      if (!current() || presentation.mode !== 'work' || presentation.sessionId !== sessionId) return
      const tab = await window.aether.browser.create({})
      if (!current() || !browserTabInScope(tab, presentation)) return
      selectBrowserTab(tab.tabId)
      selectSessionResource(sessionId, `web:${tab.tabId}`)
      onSelect()
    })
  }

  const activityLabels: Record<WorkspaceActivityKind, { label: string; icon: IconName }> = {
    subagent: { label: '子代理', icon: 'users' },
    terminal: { label: '终端', icon: 'terminal' },
    git: { label: 'Git', icon: 'git' },
    service: { label: '插件', icon: 'plug' }
  }
  // The card is a status index, not a second activity feed. Keep one stable
  // row per kind and let the destination show the full list when opened.
  const activitySections: ActivitySection[] = (['subagent', 'terminal', 'git', 'service'] as WorkspaceActivityKind[]).flatMap(kind => {
    const entries = activities.filter(item => item.kind === kind).map(item => ({
      id: item.id, label: item.label, detail: item.detail, statusLabel: item.statusLabel, icon: item.icon, open: item.open, tone: item.tone
    }))
    const entry = entries[0]
    return entry ? [{ id: kind, label: activityLabels[kind].label, icon: activityLabels[kind].icon, count: entries.length, entry }] : []
  })

  const close = (): void => setOpen(false)
  const workspaceRow = (item: ActionMenuItem): JSX.Element => <button key={item.id} type="button" className="work-workspace-card__row" role="menuitem" title={item.description || item.label} disabled={item.disabled} onClick={() => { close(); void item.onSelect() }}>
    <span className="work-workspace-card__row-icon">{item.icon ? <Icon name={item.icon} size={16} /> : null}</span>
    <span className="work-workspace-card__row-copy"><strong>{item.label}</strong></span>
    <Icon name="chevron-right" size={14} />
  </button>

  const activityCopy = (section: ActivitySection): JSX.Element => <>
    <span className="work-workspace-card__row-icon" data-tone={section.entry.tone ?? 'active'}><Icon name={section.icon} size={16} /></span>
    <span className="work-workspace-card__row-copy"><strong title={section.entry.detail || section.entry.label}>{section.id === 'git' ? section.entry.label : section.label}</strong></span>
    <span className="work-workspace-card__status" data-tone={section.entry.tone ?? 'active'}>{section.id === 'git' ? section.entry.statusLabel : section.id === 'subagent' ? `${section.count} 个运行中` : `${section.count} 项${section.count > 1 ? '进行中' : ` ${section.entry.statusLabel}`}`}</span>
  </>
  const activityRow = (section: ActivitySection): JSX.Element => section.entry.open
    ? <button key={section.id} type="button" className="work-workspace-card__row work-workspace-card__row--activity" role="menuitem" onClick={() => {
      close()
      // This row represents the terminal category, not its newest job. Only
      // an explicit job row should replace the user's remembered selection.
      const open = section.id === 'terminal' ? items.find(item => item.id === 'terminal')?.onSelect ?? section.entry.open : section.entry.open
      void Promise.resolve().then(() => open?.()).catch(error => toast.error(error instanceof Error ? error.message : String(error)))
    }}>{activityCopy(section)}</button>
    : <div key={section.id} className="work-workspace-card__row work-workspace-card__row--summary">{activityCopy(section)}</div>

  const activityDestinationIds = new Set(['subagents', 'terminal', 'git'])
  const activityKindForDestination: Record<string, WorkspaceActivityKind> = { subagents: 'subagent', terminal: 'terminal', git: 'git' }
  // Home already has a dedicated + control in the card header.
  const sections = items.filter(item => item.id !== 'home' && item.id !== 'open-file' && item.id !== 'new-webpage' && item.id !== activeTab &&
    // These destinations are represented by the live summary above only when
    // they have work. When a destination has retained content but is no
    // longer running, keep its static row so it remains discoverable.
    (!activityDestinationIds.has(item.id) || !activitySections.some(section => section.id === activityKindForDestination[item.id])) &&
    (!visibleWorkspaceIds || visibleWorkspaceIds.includes(item.id) || isExtensionDestination(item.id)))
  const workspaceSections = sections.filter(item => !isExtensionDestination(item.id))
  const runningSections = workspaceSections.filter(item => activityDestinationIds.has(item.id))
  const navigationSections = workspaceSections.filter(item => !activityDestinationIds.has(item.id))
  const pluginSections = sections.filter(item => isExtensionDestination(item.id))
  // A mounted pane is already the source of truth for that category. Do not
  // repeat its live row above the pane (especially the terminal, which used
  // to appear both in the card and in the open terminal surface).
  const displayedActivitySections = activitySections.filter(section => section.id !== activeTab)
  const hasActivity = displayedActivitySections.length > 0

  const moveMenuFocus = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const entries = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
    if (!entries.length) return
    const current = entries.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') {
      event.preventDefault(); close(); triggerRef.current?.focus(); return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length
    entries[next]?.focus()
  }

  return <>
    <Popover
      className="work-workspace__more"
      panelClassName="work-workspace-menu"
      label="更多工作区"
      placement="down"
      align="end"
      width={320}
      flush
      open={open}
      onOpenChange={setOpen}
      trigger={({ open }) => <button ref={triggerRef} type="button" className={`work-workspace-card__trigger${open ? ' is-open' : ''}`} aria-label="更多工作区" aria-haspopup="dialog" aria-expanded={open} title="工作区与进行中内容" onKeyDown={event => {
        if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true) }
      }}>
        <Icon name={hasActivity ? 'activity' : 'panels'} size={16} />
        {hasActivity ? <span className="work-workspace-card__badge" aria-label={`${displayedActivitySections.reduce((count, section) => count + section.count, 0)} 项进行中`}>{displayedActivitySections.reduce((count, section) => count + section.count, 0)}</span> : null}
      </button>}
    >
      <section ref={menuRef} className="work-workspace-card" role="menu" aria-label="更多工作区" onKeyDown={moveMenuFocus}>
        <header className="work-workspace-card__header">
          <div><strong>{hasActivity ? '正在进行' : '工作区'}</strong><span>{hasActivity ? '实时活动' : '选择要打开的区域'}</span></div>
          {activeTab !== 'home' ? <button type="button" className="work-workspace-card__new-tab" role="menuitem" aria-label="新建首页标签" title="新建首页标签" onClick={() => { close(); onNewTab() }}><Icon name="plus" size={15} /></button> : null}
        </header>
        <div className="work-workspace-card__scroll">
          <>
            {hasActivity ? <div className="work-workspace-card__activity" aria-label="正在进行的内容">{displayedActivitySections.map(section => {
              const collapsed = collapsedKinds.has(section.id)
              return <section className="work-workspace-card__section" key={section.id} aria-label={section.label}>
                <button type="button" role="menuitem" className="work-workspace-card__section-toggle" aria-expanded={!collapsed} onClick={() => setCollapsedKinds(previous => {
                  const next = new Set(previous)
                  if (next.has(section.id)) next.delete(section.id); else next.add(section.id)
                  return next
                })}><span><Icon name={section.icon} size={13} />{section.label}</span><small>{section.count}</small><Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={13} /></button>
                {!collapsed ? activityRow(section) : null}
              </section>
            })}</div> : null}
            {runningSections.length ? <div className="work-workspace-card__workspaces" aria-label="运行区域">{hasActivity ? <div className="work-workspace-card__divider" /> : null}<div className="work-workspace-card__section-title"><span><Icon name="activity" size={13} />运行区域</span><small>{runningSections.length}</small></div>{runningSections.map(workspaceRow)}</div> : null}
            {navigationSections.length ? <div className="work-workspace-card__workspaces" aria-label="工作区导航">{hasActivity || runningSections.length ? <div className="work-workspace-card__divider" /> : null}{navigationSections.map(workspaceRow)}</div> : null}
            {pluginSections.length ? <div className="work-workspace-card__workspaces work-workspace-card__plugins" aria-label="插件">{hasActivity || runningSections.length || navigationSections.length ? <div className="work-workspace-card__divider" /> : null}<div className="work-workspace-card__section-title"><span><Icon name="plug" size={13} />插件</span><small>{pluginSections.length}</small></div>{pluginSections.map(workspaceRow)}</div> : null}
          </>
        </div>
        <footer className="work-workspace-card__footer"><button type="button" role="menuitem" onClick={() => { close(); fileInput.current?.click() }}><Icon name="file" size={15} />打开文件…</button><button type="button" role="menuitem" onClick={() => { close(); openBrowser() }}><Icon name="plus" size={15} />新建网页</button></footer>
      </section>
    </Popover>
    <input ref={fileInput} type="file" className="work-resource-tabs__file-input" aria-hidden="true" tabIndex={-1} onChange={onPick} />
  </>
}
