import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type JSX, type MouseEvent } from 'react'
import type { CommandJobSnapshot } from '@shared/command-job'
import { activateCommandSession, cancelCommandJob, deactivateCommandSession, getCommandJobs, ingestCommandJob, isCommandJobDeleted, subscribeCommandJobs } from '../../core/engine/command-job-store'
import { commandJobInvocation } from '../../core/engine/command-job-state'
import { getEngineSource, subscribeEngineSource } from '../../core/engine/source'
import { ContextMenu, type ContextMenuItem } from '../../ui/ContextMenu'
import { Icon } from '../../ui/icons'
import { Popover } from '../../ui/Popover'
import { Spinner } from '../../ui/ui-primitives'
import { getExtensionContext, useExtensionMenuItems, useExtensionServices } from '../extensions'
import { extensionIcon } from '@renderer/app/navigation'
import { buildServiceItems, getActiveServiceItems, getHistoryServiceItems, getNotificationServiceItems, getSessionServiceItems, readAllServiceNotifications, reconcileServiceNotifications, SERVICE_NOTIFICATION_LIMIT, serviceNotificationToItem, setServiceNotificationRead, type ServiceItem, type ServiceNotification, type ServiceNotificationState } from './service-model'
import { ServiceNotificationStore } from './notification-store'
import { getActivityHistory, getPersistedHistoryEntries, historyEntryToServiceItem, rememberNotificationHistory, rememberServiceHistory, subscribeActivityHistory } from './activity-history'
import './services.css'

export interface ServiceTrayProps {
  sessionId?: string | null
  jobs: CommandJobSnapshot[]
  active?: boolean
  variant?: 'activity' | 'services' | 'history'
  placement?: 'up' | 'down'
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
  return <ScopedServiceTray key={JSON.stringify([source, props.sessionId, props.variant, props.placement])} {...props} source={source} />
}

function ScopedServiceTray({ sessionId, jobs, active = true, variant = 'activity', placement = 'up', onOpenTerminal, onOpenJob, source }: ServiceTrayProps & { source: number }): JSX.Element {
  const contributions = useExtensionServices({ sessionId })
  const owner = `service-tray:${useId()}`
  const [, redraw] = useState(0)
  const [globalMemory] = useState(() => notificationsStore.scope(source, null))
  const [sessionMemory] = useState(() => notificationsStore.scope(source, sessionId || null))
  const globalNotifications = useSyncExternalStore(active ? globalMemory.subscribe : inactiveSubscription, globalMemory.getSnapshot)
  const sessionNotifications = useSyncExternalStore(active && sessionMemory !== globalMemory ? sessionMemory.subscribe : inactiveSubscription, sessionMemory.getSnapshot)
  const persistedHistory = useSyncExternalStore(active ? subscribeActivityHistory : inactiveSubscription, getActivityHistory)
  const [open, setOpen] = useState(false)
  const [servicesView, setServicesView] = useState<'running' | 'history'>('running')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pending, setPending] = useState<{ id: string; action: 'open' | 'stop' | 'copy' } | null>(null)
  const [error, setError] = useState('')
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; anchor: HTMLElement; revision: number } | null>(null)
  const menuRevision = useRef(0)
  const backRef = useRef<HTMLButtonElement>(null)
  const restoreRow = useRef<string | null>(null)
  const closePopover = (): void => {
    setOpen(false)
    setMenu(null)
    setError('')
    setSelectedId(null)
    if (variant === 'services') setServicesView('running')
  }
  const items = buildServiceItems([...jobs, ...getCommandJobs(sessionId ?? null)].filter(job => !isCommandJobDeleted(job.sessionId, job.jobId)), sessionId ?? '', contributions)
  // Services are owned by the active session. Global trays never receive
  // command jobs or session history, even when a stale snapshot is available.
  const sessionItems = getSessionServiceItems(items, sessionId ?? null)
  const serviceItems = getActiveServiceItems(sessionItems)
  const notificationItems = getNotificationServiceItems(items)
  const globalNotices = reconcileServiceNotifications(globalNotifications, notificationItems.filter(item => item.contribution && !item.contribution.sessionId))
  const sessionNotices = sessionMemory === globalMemory ? null : reconcileServiceNotifications(sessionNotifications, notificationItems.filter(item => Boolean(item.contribution?.sessionId)))
  const notices = [...globalNotices.notifications, ...(sessionNotices?.notifications ?? [])]
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)).slice(0, SERVICE_NOTIFICATION_LIMIT)
  const running = serviceItems.length
  const unread = notices.filter(notification => !notification.read).length
  const activityNotices = notices.filter(notification => !notification.read)
  const historyNotices = notices.filter(notification => notification.read)
  const liveHistoryServices = variant === 'services' ? getHistoryServiceItems(sessionItems) : []
  const liveHistoryIds = new Set([...liveHistoryServices.map(item => item.id), ...historyNotices.map(notification => notification.serviceId)])
  // Session service history and global message history are separate streams.
  // A service record must never leak into the bottom global history popover.
  const persistedHistoryItems = getPersistedHistoryEntries(persistedHistory, liveHistoryIds).filter(entry =>
    variant === 'services' ? entry.kind === 'service' && entry.sessionId === (sessionId ?? null) : variant === 'history' && entry.kind === 'notification')
  const historyServices = [...liveHistoryServices, ...persistedHistoryItems.map(historyEntryToServiceItem)]
  const noticeItems = notices.map(serviceNotificationToItem)
  const displayItems = variant === 'services'
    ? [...sessionItems, ...historyServices.filter(item => !sessionItems.some(current => current.id === item.id))]
    : variant === 'activity'
      ? noticeItems.filter(item => activityNotices.some(notification => notification.serviceId === item.id))
      : [...noticeItems.filter(item => historyNotices.some(notification => notification.serviceId === item.id)), ...historyServices]
  const selected = displayItems.find(item => item.id === selectedId)
  const live = useRef({ items: displayItems, active, pending })
  live.current = { items: displayItems, active, pending }
  const mounted = useRef(false)

  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useLayoutEffect(() => {
    globalMemory.update(previous => reconcileServiceNotifications(previous, notificationItems.filter(item => item.contribution && !item.contribution.sessionId)))
    if (sessionMemory !== globalMemory) sessionMemory.update(previous => reconcileServiceNotifications(previous, notificationItems.filter(item => Boolean(item.contribution?.sessionId))))
  }, [globalMemory, sessionMemory, notificationItems])
  useEffect(() => {
    for (const item of liveHistoryServices) rememberServiceHistory(item, sessionId ?? null)
    for (const notification of historyNotices) {
      rememberNotificationHistory(items.find(value => value.id === notification.serviceId) ?? serviceNotificationToItem(notification), notification)
    }
  }, [items, liveHistoryServices, historyNotices, sessionId])
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
    setSelectedId(null)
    if (variant === 'services') setServicesView('running')
  }, [active, variant])
  useEffect(() => {
    if (!active) return
    for (const job of jobs) if (job.sessionId === sessionId && job.background) ingestCommandJob(job)
  }, [jobs, sessionId, active])
  useEffect(() => {
    if (menu && !displayItems.some(item => item.id === menu.id)) setMenu(null)
  }, [menu, displayItems])
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
        if (item.job) { closePopover(); (onOpenJob ?? onOpenTerminal)?.(item.job.jobId) }
        else if (item.contribution?.open) { await item.contribution.open(); if (mounted.current) closePopover() }
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
  const menuItem = menu ? displayItems.find(item => item.id === menu.id) : undefined
  const extensionContext = getExtensionContext()
  const pluginItems = useExtensionMenuItems('service.context', { ...extensionContext, sessionId: menuItem?.contribution?.sessionId ?? sessionId,
    targetId: menuItem?.contribution?.id ?? menuItem?.job?.jobId })
  const notice = menuItem ? notices.find(value => value.serviceId === menuItem.id) : undefined
  const menuItems: ContextMenuItem[] = menuItem ? [
    { id: 'details', label: '查看详情', icon: <Icon name="info" size={14} />, onSelect: () => details(menuItem.id) },
    ...(canOpen(menuItem) ? [{ id: 'open', label: menuItem.job ? '在终端中查看' : '打开服务', icon: <Icon name={menuItem.job ? 'terminal' : 'open-in-new'} size={14} />, disabled: Boolean(pending), onSelect: () => { void runAction(menuItem.id, 'open') } }] : []),
    ...(canStop(menuItem) ? [{ id: 'stop', label: '停止', icon: <Icon name="stop" size={14} />, danger: true, disabled: Boolean(pending), onSelect: () => { void runAction(menuItem.id, 'stop') } }] : []),
    { id: 'copy', label: menuItem.job ? '复制命令' : '复制详情', icon: <Icon name="copy" size={14} />, separatorBefore: true, disabled: Boolean(pending), onSelect: () => { void runAction(menuItem.id, 'copy') } },
    ...(notice ? [{ id: 'read', label: notice.read ? '标为未读' : '标为已读', onSelect: () => read(menuItem.id, !notice.read) }] : []),
    ...pluginItems.map((item, index) => ({ ...item, separatorBefore: index === 0, disabled: Boolean(pending) || item.disabled,
      icon: item.icon ? <Icon name={extensionIcon(item.icon)} size={14} /> : undefined }))
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

  const renderHistory = (): JSX.Element => {
    const entries = [
      ...historyServices.map(item => ({ kind: 'service' as const, updatedAt: item.updatedAt, item })),
      ...historyNotices.map(notification => ({ kind: 'notification' as const, updatedAt: notification.updatedAt, notification }))
    ].sort((left, right) => right.updatedAt - left.updatedAt)
    if (!entries.length) return <p className="service-tray__empty">暂无消息历史</p>
    return <>{entries.map(entry => entry.kind === 'service' ? row(entry.item) : (() => {
      return row(items.find(value => value.id === entry.notification.serviceId) ?? serviceNotificationToItem(entry.notification), entry.notification)
    })())}</>
  }
  const title = selected ? '详情' : variant === 'services' ? servicesView === 'history' ? '服务历史' : '服务' : variant === 'history' ? '消息历史' : '消息'
  const triggerIcon = variant === 'services' ? 'terminal' : variant === 'history' ? 'clock-outline' : 'bell'
  const triggerLabel = variant === 'services' ? `服务，${running} 个运行中` : variant === 'history' ? '消息历史' : `消息${unread ? `，${unread} 条未读` : ''}`

  return <div className={`service-tray service-tray--${variant}`}>
    {active ? <span className="service-tray__announcement" role="status" aria-atomic="true">{variant === 'services' ? `${running} 个服务运行中` : variant === 'activity' ? `${unread} 条未读消息` : '消息历史'}</span> : null}
    <Popover open={open && active} onOpenChange={next => { if (next) setOpen(true); else closePopover() }} disabled={!active} placement={placement} align="start" width={360} flush label={title} panelClassName="service-tray__popover" trigger={({ open: expanded }) => <button type="button" className={`service-tray__button${expanded ? ' is-open' : ''}`} disabled={!active}
      aria-label={triggerLabel} title={title} aria-expanded={expanded} aria-haspopup="dialog">
      <Icon name={triggerIcon} size={16} />
      {variant === 'services' && running ? <span className="service-tray__count" aria-hidden="true">{running > 99 ? '99+' : running}</span> : null}
      {variant === 'activity' && unread ? <span className="service-tray__badge" aria-hidden="true" /> : null}
    </button>}>
      <section className="service-tray__panel" aria-label={`${title}列表`}>
        <header className="service-tray__header">
          {selected ? <button ref={backRef} type="button" className="service-tray__icon" aria-label={`返回${title}列表`} title="返回" onClick={() => { restoreRow.current = selected.id; setSelectedId(null); setError('') }}><Icon name="chevron-left" size={15} /></button> : null}
          <strong>{title}</strong>
          <span className="service-tray__header-spacer" />
          {!selected && variant === 'activity' && unread ? <button type="button" className="service-tray__icon" aria-label="全部标为已读" title="全部标为已读" onClick={() => updateNotices(readAllServiceNotifications)}><Icon name="check-all" size={15} /></button> : null}
          {!selected && variant === 'services' ? <button type="button" className="service-tray__icon" aria-label={servicesView === 'history' ? '返回运行中服务' : '查看服务历史'} title={servicesView === 'history' ? '返回运行中服务' : '查看服务历史'} onClick={() => setServicesView(value => value === 'history' ? 'running' : 'history')}><Icon name={servicesView === 'history' ? 'terminal' : 'clock-outline'} size={15} /></button> : null}
          {variant !== 'activity' && onOpenTerminal && sessionId ? <button type="button" className="service-tray__icon" aria-label="打开终端" title="打开终端" onClick={() => { closePopover(); onOpenTerminal() }}><Icon name="terminal" size={15} /></button> : null}
          <button type="button" className="service-tray__icon" aria-label={`关闭${title}`} title="关闭" onClick={closePopover}><Icon name="close" size={14} /></button>
        </header>
        {!selected ? <div className="service-tray__body">
          {variant === 'services' ? servicesView === 'history' ? historyServices.length ? historyServices.map(item => row(item)) : <p className="service-tray__empty">暂无服务历史</p>
            : serviceItems.length ? serviceItems.map(item => row(item)) : <p className="service-tray__empty">暂无运行中的服务</p>
            : variant === 'activity' ? activityNotices.length ? activityNotices.map(notification => {
              return row(items.find(value => value.id === notification.serviceId) ?? serviceNotificationToItem(notification), notification)
            }) : <p className="service-tray__empty">暂无未读消息</p>
            : renderHistory()}
        </div> : <div className="service-tray__detail" data-service-id={selected.id}>
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
