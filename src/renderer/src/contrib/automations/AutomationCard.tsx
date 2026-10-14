import { useEffect, useState, useSyncExternalStore, type JSX } from 'react'
import type { AutomationReceipt } from '@shared/automation'
import { useApp } from '@renderer/core/app-context'
import { getEngineSource, subscribeEngineSource } from '@renderer/core/engine/source'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { getAutomation, type AutomationJob } from './automation-client'
import { scheduleLabel } from './automation-draft'
import { openAutomationEditor } from './automation-navigation'
import './automations.css'

/** A receipt identifies a saved plan; its current status always comes from the engine. */
export function AutomationCard({ receipt }: { receipt: AutomationReceipt }): JSX.Element {
  const { ready } = useApp()
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const [job, setJob] = useState<AutomationJob | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [retry, setRetry] = useState(0)
  const [loadedSource, setLoadedSource] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    setJob(null); setError(''); setLoading(ready); setLoadedSource(null)
    const stamp = getEngineSource()
    if (!ready) return () => { alive = false }
    void getAutomation(receipt.jobId).then(value => { if (alive && stamp === getEngineSource()) { setJob(value); setLoadedSource(stamp); setLoading(false) } })
      .catch(cause => { if (alive && stamp === getEngineSource()) { setError(cause instanceof Error ? cause.message : '无法读取计划'); setLoadedSource(stamp); setLoading(false) } })
    return () => { alive = false }
  }, [receipt.jobId, receipt.operation, ready, source, retry])
  // Source changes invalidate display and actions in the first render, before effects run.
  const currentJob = ready && loadedSource === source && job?.id === receipt.jobId ? job : null
  const currentError = loadedSource === source ? error : ''
  const currentLoading = ready && (loading || loadedSource !== source)
  return <div className="automation-card" data-job-id={receipt.jobId}>
    <span className="automation-card__icon">{currentLoading ? <Spinner size={20} /> : <Icon name="clock-outline" size={22} />}</span>
    <div className="automation-card__body"><strong>{currentJob?.name || '自动化计划'}</strong>
      <span>{currentLoading ? '正在读取计划…' : currentError || (!ready ? '连接引擎后可查看计划' : currentJob ? scheduleLabel(currentJob) : '计划不可用')}</span>
      {currentJob ? <small>{currentJob.enabled ? currentJob.nextRunAt ? `下一次 ${new Date(currentJob.nextRunAt).toLocaleString()}` : '已启用 · 下一次时间待确认' : '已暂停未来触发'}</small> : null}
    </div>
    {currentError ? <button className="btn btn--sm" type="button" onClick={() => setRetry(value => value + 1)}>重试</button> : <button className="btn btn--sm" type="button" disabled={!currentJob} onClick={() => openAutomationEditor(receipt.jobId)}>打开</button>}
  </div>
}
