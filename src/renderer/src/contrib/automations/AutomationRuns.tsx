import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { CronAutomationRun, CronCapabilities } from '@shared/automation'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { getEngineSource } from '@renderer/core/engine/source'
import { cancelAutomationRun, getAutomationRuns } from './automation-client'
import { RUN_LABELS } from './automation-draft'

const date = (value?: number): string => value ? new Date(value).toLocaleString() : '—'
const active = (run: CronAutomationRun): boolean => ['claimed', 'running', 'waiting'].includes(run.status)
export function AutomationRuns({ jobId, capabilities, onOpenRun }: {
  jobId: string
  capabilities: CronCapabilities
  onOpenRun: (run: CronAutomationRun) => void | Promise<void>
}): JSX.Element {
  const [runs, setRuns] = useState<CronAutomationRun[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const generation = useRef(0), pending = useRef(false), owned = useRef(true)
  const load = useCallback(async (cursor?: string, quiet = false): Promise<void> => {
    if (pending.current) return
    pending.current = true
    const stamp = ++generation.current, source = getEngineSource()
    if (!quiet) setLoading(true)
    try {
      const page = await getAutomationRuns(jobId, cursor)
      if (!owned.current || stamp !== generation.current || source !== getEngineSource()) return
      setRuns(previous => cursor || quiet
        ? [...new Map([...previous, ...page.items].map(run => [run.id, run])).values()].sort((a, b) => b.scheduledAt - a.scheduledAt)
        : page.items)
      if (!quiet) setNextCursor(page.nextCursor)
      setError('')
    } catch (cause) {
      if (owned.current && stamp === generation.current && source === getEngineSource()) setError(cause instanceof Error ? cause.message : '无法读取运行记录')
    } finally {
      pending.current = false
      if (owned.current && stamp === generation.current) setLoading(false)
    }
  }, [jobId])
  useEffect(() => {
    owned.current = true
    setRuns([]); setNextCursor(null)
    void load()
    return () => { owned.current = false; generation.current += 1 }
  }, [load])
  useEffect(() => {
    if (!runs.some(active)) return
    const timer = window.setInterval(() => { if (!document.hidden) void load(undefined, true) }, 5000)
    return () => window.clearInterval(timer)
  }, [runs, load])
  const perform = async (run: CronAutomationRun, stop: boolean): Promise<void> => {
    if (busy) return
    const source = getEngineSource()
    setBusy(run.id)
    try {
      if (stop) {
        const updated = await cancelAutomationRun(run.id)
        if (owned.current && source === getEngineSource()) setRuns(previous => previous.map(item => item.id === updated.id ? updated : item))
      } else await onOpenRun(run)
    } catch (cause) {
      if (owned.current && source === getEngineSource()) setError(cause instanceof Error ? cause.message : '操作失败')
    } finally { if (owned.current && source === getEngineSource()) setBusy(null) }
  }
  return <section className="automation-runs" aria-label="自动化运行记录">
    <header className="automation-section-heading"><div><h3>运行记录</h3><p>暂停计划影响未来触发；停止只作用于选中的这一次运行。</p></div>
      <button type="button" className="btn btn--sm" disabled={loading} onClick={() => void load()}><Icon name="restart" size={14} />刷新记录</button>
    </header>
    {error ? <p className="automation-error" role="alert">{error}<button className="btn btn--sm" type="button" onClick={() => void load()}>重试</button></p> : null}
    {!runs.length && loading ? <p className="automation-loading" role="status"><Spinner size={16} />正在读取运行记录…</p> : !runs.length ? <div className="automation-empty"><Icon name="clock-outline" size={24} /><h3>还没有运行记录</h3><p>按计划触发后，这里会显示实际结果。</p></div> : <div className="automation-runs__list">
      {runs.map(run => <article className="automation-run" key={run.id} data-run-id={run.id} data-status={run.status}>
        <div className="automation-run__heading"><strong className={`automation-run__status automation-run__status--${run.status}`}>
          {run.status === 'running' || run.status === 'claimed' ? <Spinner size={14} /> : <Icon name={run.status === 'succeeded' ? 'check' : run.status === 'waiting' ? 'chat' : run.status === 'failed' || run.status === 'interrupted' ? 'warning' : 'clock-outline'} size={14} />}
          {RUN_LABELS[run.status]}</strong><time dateTime={new Date(run.scheduledAt).toISOString()}>{date(run.scheduledAt)}</time></div>
        <div className="automation-run__facts"><span>Agent <b>{run.snapshot.effectiveAgentName || run.snapshot.effectiveAgentId || run.snapshot.agentId || '引擎默认'}</b></span>
          <span>有效模型 <b>{run.snapshot.effectiveModelId || '运行时由引擎确认'}</b></span>
          {run.deadlineAt && active(run) ? <span>截止 <b>{date(run.deadlineAt)}</b></span> : null}</div>
        {run.reason ? <p className="automation-run__reason">{run.reason}</p> : null}
        {run.jobDeleted ? <p className="automation-note">计划已删除，本次运行记录仍然保留。</p> : null}
        <footer><button className="btn btn--sm" type="button" disabled={Boolean(busy) || !run.rootRunId} onClick={() => void perform(run, false)}>{busy === run.id ? <Spinner size={13} /> : <Icon name="chat" size={13} />}打开运行聊天</button>
          {capabilities.ownedCancellation && run.rootRunId && ['running', 'waiting'].includes(run.status) ? <button className="btn btn--sm" type="button" disabled={Boolean(busy)} onClick={() => void perform(run, true)}><Icon name="stop" size={13} />停止本次运行</button> : null}</footer>
      </article>)}
    </div>}
    {nextCursor ? <button type="button" className="btn automation-load-more" disabled={loading} onClick={() => void load(nextCursor)}>{loading ? <Spinner size={14} /> : null}加载更早的记录</button> : null}
  </section>
}
