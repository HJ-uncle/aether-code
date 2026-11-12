import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type JSX, type MouseEvent } from 'react'
import type { CommandJobSnapshot } from '@shared/command-job'
import { activateCommandSession, cancelCommandJob, deactivateCommandSession, getCommandJobs, ingestCommandJob, isCommandJobDeleted, subscribeCommandJobs } from '../../core/engine/command-job-store'
import { commandJobInvocation } from '../../core/engine/command-job-state'
import { getEngineSource, subscribeEngineSource } from '../../core/engine/source'
import { ContextMenu, type ContextMenuItem } from '../../ui/ContextMenu'
import { Icon } from '../../ui/icons'
import { Popover } from '../../ui/Popover'
import { Spinner } from '../../ui/ui-primitives'
import { useExtensionServices } from '../extensions'
import { buildServiceItems, clearReadServiceNotifications, readAllServiceNotifications, reconcileServiceNotifications, SERVICE_NOTIFICATION_LIMIT, setServiceNotificationRead, type ServiceItem, type ServiceNotification, type ServiceNotificationState } from './service-model'
import { ServiceNotificationStore } from './notification-store'
import './services.css'

export interface ServiceTrayProps {
  sessionId?: string | null
  jobs: CommandJobSnapshot[]
  active?: boolean
  placement?: 'heading' | 'rail'
  /** Existing zero-argument handlers remain valid; a job id enables exact terminal reveal. */
  onOpenTerminal?: (jobId?: string) => void
  onOpenJob?: (jobId: string) => void
}

const notificationsStore = new ServiceNotificationStore()
subscribeEngineSource(() => notificationsStore.clear())
const inactiveSubscription = (): (() => void) => () => {}

/** Output remains in the terminal; this surface retains only bounded status notices. */
export function ServiceTray(props: ServiceTrayProps): JSX.Element {
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  return <ScopedServiceTray key={JSON.stringify([source, props.sessionId])} {...props} source={source} />
}

function ScopedServiceTray({ sessionId, jobs, active = true, placement = 'heading', onOpenTerminal, onOpenJob, source }: ServiceTrayProps & { source: number }): JSX.Element {
  const contributions = useExtensionServices({ sessionId })
  const owner = `service-tray:${useId()}`
  const panelId = useId()
  const [, redraw] = useState(0)
  const [globalMemory] = useState(() => notificationsStore.scope(source, null))
  const [sessionMemory] = useState(() => notificationsStore.scope(source, sessionId || null))
  const globalNotifications = useSyncExternalStore(active ? globalMemory.subscribe : inactiveSubscription, globalMemory.getSnapshot)
  const sessionNotifications = useSyncExternalStore(active && sessionMemory !== globalMemory ? sessionMemory.subscribe : inactiveSubscription, sessionMemory.getSnapshot)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'services' | 'notifications'>('services')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pending, setPending] = useState<{ id: string; action: 'open' | 'stop' | 'copy' } | null>(null)
  const [error, setError] = useState('')
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; anchor: HTMLElement; revision: number } | null>(null)
  const menuRevision = useRef(0)
  const backRef = useRef<HTMLButtonElement>(null)
  const restoreRow = useRef<string | null>(null)
  const items = buildServiceItems([...jobs, ...getCommandJobs(sessionId ?? null)].filter(job => !isCommandJobDeleted(job.sessionId, job.jobId)), sessionId ?? '', contributions)
  const globalItems = items.filter(item => item.contribution && !item.contribution.sessionId)
  const sessionItems = items.filter(item => !item.contribution || Boolean(item.contribution.sessionId))
  const globalNotices = reconcileServiceNotifications(globalNotifications, globalItems)
  const sessionNotices = sessionMemory === globalMemory ? null : reconcileServiceNotifications(sessionNotifications, sessionItems)
  const notices = [...globalNotices.notifications, ...(sessionNotices?.notifications ?? [])]
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)).slice(0, SERVICE_NOTIFICATION_LIMIT)
  const running = items.filter(item => item.active).length
  const unread = notices.filter(notification => !notification.read).length
  const selected = items.find(item => item.id === selectedId)
  const live = useRef({ items, active, pending })
  live.current = { items, active, pending }
  const mounted = useRef(false)

  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useLayoutEffect(() => {
    globalMemory.update(previous => reconcileServiceNotifications(previous, globalItems))
    if (sessionMemory !== globalMemory) sessionMemory.update(previous => reconcileServiceNotifications(previous, sessionItems))
  }, [globalMemory, sessionMemory, globalItems, sessionItems])
  useEffect(() => subscribeCommandJobs(() => redraw(value => value + 1)), [])
  useLayoutEffect(() => {
    if (!active || !sessionId) return
    activateCommandSession(sessionId, owner)
    return () => deactivateCommandSession(owner)
  }, [sessionId, owner, active])
  useEffect(() => {
    if (active) return
    setOpen(false)
    setMenu(null)
    setError('')
  }, [active])
  useEffect(() => {
    if (!active) return
    for (const job of jobs) if (job.sessionId === sessionId && job.background) ingestCommandJob(job)
  }, [jobs, sessionId, active])
  useEffect(() => {
    if (menu && !items.some(item => item.id === menu.id)) setMenu(null)
  }, [menu, items])
  useLayoutEffect(() => {
    if (active && open && selected) backRef.current?.focus({ preventScroll: true })
  }, [active, open, selected?.id])

  const updateNotices = (change: (state: ServiceNotificationState) => ServiceNotificationState): void => {
    globalMemory.update(change)
    if (sessionMemory !== globalMemory) sessionMemory.update(change)
  }
  const read = (id: string, value = true): void => updateNotices(state => setServiceNotificationRead(state, id, value))
  const details = (id: string): void => { setSelectedId(id); setError(''); read(id) }
  const runAction = async (id: string, action: 'open' | 'stop' | 'copy'): Promise<void> => {
    const item = live.current.items.find(candidate => candidate.id === id)
    if (!item || !live.current.active || live.current.pending || source !== getEngineSource()) return
    setPending({ id, action })
    setError('')
    try {
      if (action === 'stop') {
        if (item.job?.status === 'running' && sessionId) await cancelCommandJob(sessionId, item.job.jobId)
        else if (item.contribution?.stop && item.active) await item.contribution.stop()
      } else if (action === 'copy') {
        await navigator.clipboard.writeText(item.job ? commandJobInvocation(item.job) : [item.label, item.detail].filter(Boolean).join('\n'))
      } else {
        read(id)
        if (item.job) { setOpen(false); (onOpenJob ?? onOpenTerminal)?.(item.job.jobId) }
        else if (item.contribution?.open) { await item.contribution.open(); if (mounted.current) setOpen(false) }
      }
    } catch (failure) {
      if (mounted.current && source === getEngineSource()) setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (mounted.current && source === getEngineSource()) setPending(null)
    }
  }
  const canStop = (item: ServiceItem): boolean => item.job ? item.job.status === 'running' : item.active && Boolean(item.contribution?.stop)
  const canOpen = (item: ServiceItem): boolean => item.job ? Boolean(onOpenJob || onOpenTerminal) : Boolean(item.contribution?.open)
  const showMenu = (id: string, x: number, y: number, anchor: HTMLElement): void => {
    // Coordinates can repeat while the previous menu is still animating out.
    setMenu({ id, x, y, anchor, revision: ++menuRevision.current })
  }
  const openMenu = (event: MouseEvent<HTMLElement>, id: string): void => {
    event.preventDefault()
    event.stopPropagation()
    showMenu(id, event.clientX, event.clientY, event.currentTarget)
  }
  const menuItem = menu ? items.find(item => item.id === menu.id) : undefined
  const notice = menuItem ? notices.find(value => value.serviceId === menuItem.id) : undefined
  const menuItems: ContextMenuItem[] = menuItem ? [
    { id: 'details', label: '查看详情', icon: <Icon name="info" size={14} />, onSelect: () => details(menuItem.id) },
    ...(canOpen(menuItem) ? [{ id: 'open', label: menuItem.job ? '在终端中查看' : '打开服务', icon: <Icon name={menuItem.job ? 'terminal' : 'open-in-new'} size={14} />, disabled: Boolean(pending), onSelect: () => { void runAction(menuItem.id, 'open') } }] : []),
    ...(canStop(menuItem) ? [{ id: 'stop', label: '停止', icon: <Icon name="stop" size={14} />, danger: true, disabled: Boolean(pending), onSelect: () => { void runAction(menuItem.id, 'stop') } }] : []),
    { id: 'copy', label: menuItem.job ? '复制命令' : '复制详情', icon: <Icon name="copy" size={14} />, separatorBefore: true, disabled: Boolean(pending), onSelect: () => { void runAction(menuItem.id, 'copy') } },
    ...(notice ? [{ id: 'read', label: notice.read ? '标为未读' : '标为已读', onSelect: () => read(menuItem.id, !notice.read) }] : [])
  ] : []
  const row = (item: ServiceItem, notification?: ServiceNotification): JSX.Element => <div className="service-tray__row" key={item.id} data-service-id={item.id} data-service-status={item.status} data-unread={notification ? !notification.read : undefined} onContextMenu={event => openMenu(event, item.id)}>
    <button ref={element => { if (element && restoreRow.current === item.id) { restoreRow.current = null; element.focus({ preventScroll: true }) } }} className="service-tray__row-main" type="button" aria-busy={pending?.id === item.id} aria-label={`${notification && !notification.read ? '未读，' : ''}${item.label}，${item.statusLabel}`} onClick={() => details(item.id)} onKeyDown={event => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      showMenu(item.id, rect.left + 12, rect.bottom, event.currentTarget)
    }}>
      <span className="service-tray__glyph" data-tone={item.tone}>{pending?.id === item.id ? <Spinner size={15} /> : <Icon name={item.kind === 'command' ? 'terminal' : 'plug'} size={15} />}</span>
      <span className="service-tray__row-label">{item.label}</span>
      <span className="service-tray__status" data-tone={item.tone}>{item.statusLabel}</span>
      {notification && !notification.read ? <span className="service-tray__unread-dot" aria-hidden="true" /> : null}
    </button>
    <button type="button" className="service-tray__icon service-tray__more" aria-label={`更多操作：${item.label}`} title="更多操作" onClick={event => {
      const rect = event.currentTarget.getBoundingClientRect()
      showMenu(item.id, rect.right, rect.bottom, event.currentTarget)
    }}><Icon name="dots-horizontal" size={14} /></button>
  </div>

  return <div className={`service-tray service-tray--${placement}`}>
    {active ? <span className="service-tray__announcement" role="status" aria-atomic="true">{`${running} 个服务运行中，${unread} 条未读通知`}</span> : null}
    <Popover open={open && active} onOpenChange={next => { setOpen(next); if (!next) { setMenu(null); setError('') } }} disabled={!active} placement="down" align="start" width={360} flush label="服务与通知" panelClassName="service-tray__popover" trigger={({ open: expanded }) => <button type="button" className={`service-tray__button${expanded ? ' is-open' : ''}`} disabled={!active}
      aria-label={`服务与通知，${running} 个运行中${unread ? `，${unread} 条未读` : ''}`} title="服务与通知" aria-expanded={expanded} aria-haspopup="dialog">
      <Icon name="activity" size={16} />
      {running ? <span className="service-tray__count" aria-hidden="true">{running > 99 ? '99+' : running}</span> : null}
      {unread ? <span className="service-tray__badge" aria-hidden="true" /> : null}
    </button>}>
      <section className="service-tray__panel" aria-label="活动列表">
        <header className="service-tray__header">
          {selected ? <button ref={backRef} type="button" className="service-tray__icon" aria-label="返回活动列表" title="返回" onClick={() => { restoreRow.current = selected.id; setSelectedId(null); setError('') }}><Icon name="chevron-left" size={15} /></button> : null}
          <strong>{selected ? '详情' : '活动'}</strong>
          <span className="service-tray__header-spacer" />
          {!selected && tab === 'notifications' && unread ? <button type="button" className="service-tray__icon" aria-label="全部标为已读" title="全部标为已读" onClick={() => updateNotices(readAllServiceNotifications)}><Icon name="check-all" size={15} /></button> : null}
          {!selected && tab === 'notifications' && notices.some(value => value.read) ? <button type="button" className="service-tray__icon" aria-label="清除已读通知" title="清除已读通知" onClick={() => updateNotices(clearReadServiceNotifications)}><Icon name="trash" size={14} /></button> : null}
          {onOpenTerminal && sessionId ? <button type="button" className="service-tray__icon" aria-label="打开终端" title="打开终端" onClick={() => { setOpen(false); onOpenTerminal() }}><Icon name="terminal" size={15} /></button> : null}
          <button type="button" className="service-tray__icon" aria-label="关闭服务与通知" title="关闭" onClick={() => setOpen(false)}><Icon name="close" size={14} /></button>
        </header>
        {!selected ? <>
          <div className="service-tray__tabs" role="tablist" aria-label="活动类型" onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next = event.key === 'Home' ? 'services' : event.key === 'End' ? 'notifications' : tab === 'services' ? 'notifications' : 'services'
            setTab(next)
            event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus()
          }}>
            {(['services', 'notifications'] as const).map(value => <button key={value} type="button" role="tab" data-tab={value} id={`${panelId}-${value}-tab`} aria-controls={`${panelId}-${value}`} tabIndex={tab === value ? 0 : -1} aria-selected={tab === value} onClick={() => setTab(value)}>{value === 'services' ? '服务' : '通知'}{value === 'notifications' && unread ? <span>{unread}</span> : null}</button>)}
          </div>
          <div className="service-tray__body" role="tabpanel" id={`${panelId}-${tab}`} aria-labelledby={`${panelId}-${tab}-tab`}>
            {tab === 'services' ? items.length ? items.map(item => row(item)) : <p className="service-tray__empty">暂无后台服务</p>
              : notices.length ? notices.map(notification => {
                const item = items.find(value => value.id === notification.serviceId)
                return item ? row(item, notification) : null
              }) : <p className="service-tray__empty">暂无通知</p>}
          </div>
        </> : <div className="service-tray__detail" data-service-id={selected.id}>
          <div className="service-tray__detail-title"><Icon name={selected.kind === 'command' ? 'terminal' : 'plug'} size={16} /><strong>{selected.label}</strong></div>
          <span className="service-tray__status" data-tone={selected.tone}>{selected.statusLabel}</span>
          {selected.detail ? <p className="service-tray__detail-text">{selected.detail}</p> : null}
          {selected.job && selected.job.error ? <p className="service-tray__detail-path">{selected.job.cwd}</p> : null}
          {selected.contribution ? <p className="service-tray__detail-path">{selected.contribution.pluginId}</p> : null}
          <div className="service-tray__detail-actions">
            {canOpen(selected) ? <button type="button" disabled={Boolean(pending)} onClick={() => { void runAction(selected.id, 'open') }}><Icon name={selected.job ? 'terminal' : 'open-in-new'} size={14} />{selected.job ? '在终端中查看' : '打开服务'}</button> : null}
            {canStop(selected) ? <button type="button" className="service-tray__stop" disabled={Boolean(pending)} onClick={() => { void runAction(selected.id, 'stop') }}><Icon name="stop" size={12} />{pending?.id === selected.id && pending.action === 'stop' ? '正在停止…' : '停止'}</button> : null}
          </div>
        </div>}
        {error ? <p className="service-tray__error" role="alert">{error}</p> : null}
      </section>
      {menu && menuItem ? <ContextMenu key={menu.revision} x={menu.x} y={menu.y} anchor={menu.anchor} items={menuItems} onClose={() => setMenu(current => current?.revision === menu.revision ? null : current)} /> : null}
    </Popover>
  </div>
}
