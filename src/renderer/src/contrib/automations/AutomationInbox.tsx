import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { CronAutomationRun, CronNotification } from '@shared/automation'
import { getEngineSource } from '@renderer/core/engine/source'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { getAutomationNotifications, getAutomationRun, markAutomationNotificationRead } from './automation-client'
import { RUN_LABELS } from './automation-draft'

export function AutomationInbox({ onUnreadCount, onOpenRun }: { onUnreadCount: (count: number) => void; onOpenRun: (run: CronAutomationRun) => void | Promise<void> }): JSX.Element {
  const [items, setItems] = useState<CronNotification[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState<string | null>(null)
  const owned = useRef(true), requestId = useRef(0), pending = useRef(false)
  const load = useCallback(async (cursor?: string): Promise<void> => {
    if (pending.current) return
    pending.current = true
    const id = ++requestId.current, source = getEngineSource()
    setLoading(true)
    try {
      const page = await getAutomationNotifications(cursor)
      if (!owned.current || id !== requestId.current || source !== getEngineSource()) return
      setItems(previous => cursor ? [...new Map([...previous, ...page.items].map(item => [item.id, item])).values()] : page.items)
      setNextCursor(page.nextCursor); onUnreadCount(page.unreadCount); setError('')
    } catch (cause) { if (owned.current && id === requestId.current && source === getEngineSource()) setError(cause instanceof Error ? cause.message : '无法读取通知') }
    finally { pending.current = false; if (owned.current && id === requestId.current) setLoading(false) }
  }, [onUnreadCount])
  useEffect(() => { owned.current = true; void load(); return () => { owned.current = false; requestId.current += 1 } }, [load])
  const open = async (item: CronNotification): Promise<void> => {
    if (busy) return
    setBusy(item.id)
    const source = getEngineSource()
    try {
      const run = await getAutomationRun(item.runId)
      if (!owned.current || source !== getEngineSource()) return
      const updated = await markAutomationNotificationRead(item.id)
      if (!owned.current || source !== getEngineSource()) return
      setItems(previous => previous.map(value => value.id === updated.id ? updated : value))
      await onOpenRun(run)
      if (owned.current && source === getEngineSource()) void load()
    } catch (cause) { if (owned.current && source === getEngineSource()) setError(cause instanceof Error ? cause.message : '打开通知失败') }
    finally { if (owned.current && source === getEngineSource()) setBusy(null) }
  }
  return <section className="automation-inbox" aria-label="自动化通知">
    <header className="automation-section-heading"><div><h3>通知</h3><p>需要回复与运行结果会保存在这里，已读状态在重启后保留。</p></div><button type="button" className="btn btn--sm" disabled={loading} onClick={() => void load()}>刷新通知</button></header>
    {error ? <p className="automation-error" role="alert">{error}</p> : null}
    {!items.length ? <div className="automation-empty">{loading ? <Spinner size={20} /> : <Icon name="clock-outline" size={24} />}<h3>{loading ? '正在读取通知…' : '没有通知'}</h3></div> : <div className="automation-inbox__list">{items.map(item => <button type="button" key={item.id} className="automation-notification" data-read={Boolean(item.readAt)} disabled={Boolean(busy)} onClick={() => void open(item)}>
      <span className="automation-notification__indicator" aria-hidden="true">{busy === item.id ? <Spinner size={14} /> : <Icon name={item.payload.status === 'waiting' ? 'chat' : 'clock-outline'} size={16} />}</span>
      <span><strong>{item.payload.jobName}</strong><small>{RUN_LABELS[item.payload.status]}{!item.readAt ? ' · 未读' : ''}</small></span>
      <time>{new Date(item.createdAt).toLocaleString()}</time><Icon name="chevron-right" size={14} />
    </button>)}</div>}
    {nextCursor ? <button type="button" className="btn automation-load-more" disabled={loading} onClick={() => void load(nextCursor)}>加载更早的通知</button> : null}
  </section>
}
