import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import type { CommandJobSnapshot } from '@shared/command-job'
import { commandJobActive, mergeCommandJob } from '@renderer/core/engine/command-job-state'
import { Icon } from '@renderer/workbench/icons'
import { MotionPresence } from '@renderer/workbench/MotionPresence'
import { Popover } from '@renderer/workbench/Popover'
import { CommandJobCard } from '../chat/CommandJobCard'
import './work-service-tray.css'

interface WorkServiceTrayProps {
  sessionId: string
  jobs: CommandJobSnapshot[]
  active?: boolean
  placement?: 'heading' | 'rail'
}

export function partitionWorkServices(jobs: readonly CommandJobSnapshot[], sessionId: string): {
  running: CommandJobSnapshot[]
  history: CommandJobSnapshot[]
} {
  const byId = new Map<string, CommandJobSnapshot>()
  for (const job of jobs) {
    if (!job.background || job.sessionId !== sessionId) continue
    byId.set(job.jobId, mergeCommandJob(byId.get(job.jobId), job))
  }
  const services = [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt)
  return { running: services.filter(commandJobActive), history: services.filter(job => !commandJobActive(job)) }
}

/** Background commands are a shared service surface, rather than transcript prose. */
export function WorkServiceTray({ sessionId, jobs, active = true, placement = 'heading' }: WorkServiceTrayProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const panelId = useId()
  const historyId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const services = useMemo(() => partitionWorkServices(jobs, sessionId), [jobs, sessionId])
  const { running, history } = services
  const close = (): void => {
    setOpen(false)
    triggerRef.current?.focus({ preventScroll: true })
  }
  useEffect(() => {
    if (!open) { setHistoryOpen(false); return }
    // The panel is portalled, so keyboard focus must follow the visible surface.
    const frame = requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [open])
  useEffect(() => { if (!active) setOpen(false) }, [active])
  useEffect(() => { setOpen(false); setHistoryOpen(false) }, [sessionId])
  return <Popover className={`work-service-tray work-service-tray--${placement}`} panelClassName="work-service-tray__popover"
    open={open} onOpenChange={setOpen} disabled={!active} width={360} flush label="后台服务面板" trigger={() =>
    <button ref={triggerRef} type="button" className={`work-service-tray__button${open ? ' is-open' : ''}`} aria-label="查看后台服务" aria-expanded={open}
      aria-controls={open ? panelId : undefined} aria-haspopup="dialog" title="查看后台服务">
      <Icon name="terminal" size={15} />
      <span className="work-service-tray__label">服务</span>
      {running.length ? <b aria-label={`${running.length} 个运行中的服务`}>{running.length}</b> : null}
    </button>}>
      <aside id={panelId} className="work-service-tray__panel" aria-label="后台服务" onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
      }}>
        <header className="work-service-tray__header">
          <strong>后台服务</strong>
          {running.length ? <span>{running.length} 个运行中</span> : null}
          <button ref={closeRef} type="button" className="work-service-tray__close" aria-label="关闭后台服务" title="关闭 · Esc" onClick={close}><Icon name="close" size={14} /></button>
        </header>
        <div className="work-service-tray__body">
          {running.length ? <section aria-label="运行中的服务" className="work-service-tray__section">
            {running.map(job => <CommandJobCard key={job.jobId} job={job} sessionId={sessionId} surfaceMode="work" presentation="service" active={active && open} />)}
          </section> : <p className="work-service-tray__empty">没有正在运行的服务</p>}
          {history.length ? <section className="work-service-tray__section work-service-tray__history">
            <button type="button" className="work-service-tray__history-toggle" aria-expanded={historyOpen} aria-controls={historyId} onClick={() => setHistoryOpen(value => !value)}>
              <Icon name={historyOpen ? 'chevron-down' : 'chevron-right'} size={13} /><span>历史记录</span><small>{history.length}</small>
            </button>
            <MotionPresence id={historyId} show={historyOpen} className="work-service-tray__history-list">
              {history.map(job => <CommandJobCard key={job.jobId} job={job} sessionId={sessionId} surfaceMode="work" presentation="service" active={active && open && historyOpen} preserveHistory />)}
            </MotionPresence>
          </section> : null}
        </div>
      </aside>
  </Popover>
}

