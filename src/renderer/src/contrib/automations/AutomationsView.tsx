import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import type { CronAutomationRun, CronCapabilities, CronThinkingMode } from '@shared/automation'
import { getEngineSource, subscribeEngineSource } from '@renderer/core/engine/source'
import { Dialog } from '@renderer/workbench/Dialog'
import { ActionMenu } from '@renderer/workbench/ActionMenu'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { automationCapabilities, deleteAutomation, getAutomation, getAutomationNotifications, listAutomations, setAutomationEnabled,
  type AutomationJob, type AutomationSession } from './automation-client'
import { automationTimeoutLabel, scheduleLabel } from './automation-draft'
import { AutomationEditor } from './AutomationEditor'
import { AutomationInbox } from './AutomationInbox'
import './automations.css'

export function AutomationsView(props: {
  ready: boolean
  sessions: AutomationSession[]
  currentSessionId?: string
  currentAgentId?: string
  thinkingMode?: CronThinkingMode
  openRequest?: { jobId: string; revision: number } | null
  onOpenRun: (run: CronAutomationRun) => void | Promise<void>
  onManageAgent: () => void
}): JSX.Element {
  const { ready, sessions, currentSessionId, currentAgentId, thinkingMode, openRequest, onOpenRun, onManageAgent } = props
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const [jobs, setJobs] = useState<AutomationJob[]>([]), [capabilities, setCapabilities] = useState<CronCapabilities | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [query, setQuery] = useState('')
  const [editor, setEditor] = useState<{ job?: AutomationJob; tab: 'settings' | 'runs'; key: number } | null>(null)
  const [removing, setRemoving] = useState<AutomationJob | null>(null), [busy, setBusy] = useState<string | null>(null)
  const [inbox, setInbox] = useState(false), [unreadCount, setUnreadCount] = useState(0)
  const [loadedSource, setLoadedSource] = useState<number | null>(null)
  const handledRequest = useRef<number | null>(null)
  const generation = useRef(0), owned = useRef(true), mutationPending = useRef<{ source: number } | null>(null), editorKey = useRef(0)
  const refresh = useCallback(async (): Promise<void> => {
    const id = ++generation.current, stamp = getEngineSource()
    if (!ready) { setLoading(false); return }
    setLoading(true)
    try {
      const [caps, list] = await Promise.all([automationCapabilities(), listAutomations()])
      if (!owned.current || id !== generation.current || stamp !== getEngineSource()) return
      setCapabilities(caps); setJobs(list); setLoadedSource(stamp); setError('')
      if (caps?.persistentNotifications) {
        const feed = await getAutomationNotifications()
        if (owned.current && id === generation.current && stamp === getEngineSource()) setUnreadCount(feed.unreadCount)
      }
    } catch (cause) { if (owned.current && id === generation.current && stamp === getEngineSource()) setError(cause instanceof Error ? cause.message : '无法读取自动化') }
    finally { if (owned.current && id === generation.current && stamp === getEngineSource()) setLoading(false) }
  }, [ready])
  useEffect(() => { setBusy(null) }, [source])
  useEffect(() => {
    owned.current = true; setJobs([]); setCapabilities(null); setLoadedSource(null); setEditor(null); setRemoving(null); setInbox(false); setUnreadCount(0); setError(''); handledRequest.current = null
    void refresh()
    return () => { owned.current = false; generation.current += 1 }
  }, [source, refresh])
  const updateJob = useCallback((job: AutomationJob): void => setJobs(previous => previous.some(item => item.id === job.id) ? previous.map(item => item.id === job.id ? job : item) : [job, ...previous]), [])
  useEffect(() => {
    if (!openRequest || !ready || loading || handledRequest.current === openRequest.revision) return
    handledRequest.current = openRequest.revision
    let alive = true
    const stamp = getEngineSource()
    const known = jobs.find(job => job.id === openRequest.jobId)
    if (known) { setEditor({ job: known, tab: 'settings', key: ++editorKey.current }); return }
    void getAutomation(openRequest.jobId).then(job => {
      if (alive && stamp === getEngineSource()) { updateJob(job); setEditor({ job, tab: 'settings', key: ++editorKey.current }) }
    }).catch(cause => { if (alive && stamp === getEngineSource()) setError(cause instanceof Error ? cause.message : '无法打开自动化') })
    return () => { alive = false }
    // Requests are explicit navigation events; list refreshes must not reopen a closed draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest?.revision, ready, loading])
  const mutate = async (job: AutomationJob, remove = false): Promise<void> => {
    const stamp = getEngineSource()
    if (mutationPending.current?.source === stamp) return
    // A new connection can act immediately; a late result must only release its own lock.
    const operation = { source: stamp }
    mutationPending.current = operation; setBusy(job.id)
    try {
      if (remove) {
        await deleteAutomation(job.id)
        if (owned.current && stamp === getEngineSource()) { setJobs(previous => previous.filter(item => item.id !== job.id)); setRemoving(null) }
      } else {
        const updated = await setAutomationEnabled(job.id, !job.enabled)
        if (owned.current && stamp === getEngineSource()) updateJob(updated)
      }
      if (owned.current && stamp === getEngineSource()) setError('')
    } catch (cause) { if (owned.current && stamp === getEngineSource()) setError(cause instanceof Error ? cause.message : '操作失败') }
    finally { if (mutationPending.current === operation) mutationPending.current = null; if (owned.current && stamp === getEngineSource()) setBusy(null) }
  }
  const currentScope = loadedSource === source
  const visibleJobs = currentScope ? jobs.filter(job => !query.trim() || `${job.name} ${job.description ?? ''} ${job.message}`.toLowerCase().includes(query.trim().toLowerCase())) : []
  const open = (job?: AutomationJob, tab: 'settings' | 'runs' = 'settings'): void => setEditor({ job, tab, key: ++editorKey.current })
  return <section className="automations-view" aria-label="自动化管理">
    <header className="automations-toolbar"><div><p>让重复工作按计划完成，运行与结果随时可查看。</p></div><div>
      {capabilities?.persistentNotifications ? <button className="btn" type="button" aria-pressed={inbox} onClick={() => setInbox(value => !value)}>通知{unreadCount ? <span className="automation-unread">{unreadCount}</span> : null}</button> : null}
      <button className="btn" type="button" disabled={!ready || loading} onClick={() => void refresh()} aria-label="刷新自动化"><Icon name="restart" size={14} /></button>
      <button className="btn btn--primary" type="button" disabled={!ready || loading || !currentScope || (!capabilities && !currentSessionId)} title={!capabilities && !currentSessionId ? '旧版引擎需要已有聊天，新版引擎支持独立新建' : undefined} onClick={() => open()}><Icon name="plus" size={15} />新建自动化</button>
    </div></header>
    {error ? <div className="automation-error" role="alert"><span>{error}</span><button className="btn btn--sm" type="button" disabled={loading} onClick={() => void refresh()}>重试</button></div> : null}
    {!ready ? <div className="automation-empty"><Icon name="engine" size={26} /><h3>引擎尚未就绪</h3><p>连接引擎后即可创建、查看与管理计划。</p></div> : inbox && capabilities?.persistentNotifications ? <AutomationInbox key={source} onUnreadCount={setUnreadCount} onOpenRun={onOpenRun} /> : loading && !jobs.length ? <p className="automation-loading" role="status"><Spinner size={18} />正在读取自动化…</p> : <>
      {jobs.length ? <label className="automations-search"><Icon name="search" size={15} /><input aria-label="搜索自动化" value={query} placeholder="搜索名称或任务内容" onChange={event => setQuery(event.target.value)} /></label> : null}
      {visibleJobs.length ? <div className="automation-list">{visibleJobs.map(job => <article className="automation-list-row" data-job-id={job.id} key={job.id}>
        <span className="automation-list-row__icon"><Icon name="clock-outline" size={20} /></span>
        <button className="automation-list-row__main" type="button" onClick={() => open(job)} aria-label={`编辑自动化 ${job.name}`}>
          <span className="automation-list-row__name"><strong>{job.name}</strong><span className="automation-state" data-enabled={job.enabled}>{job.enabled ? '已启用' : '已暂停'}</span></span>
          <span className="automation-list-row__description">{job.description || job.message}</span>
          <span className="automation-list-row__schedule">{scheduleLabel(job)}<span>单次最长 {automationTimeoutLabel(job.timeoutSeconds)}</span></span>
          <span className="automation-list-row__next">{job.enabled ? job.nextRunAt ? `下一次 ${new Date(job.nextRunAt).toLocaleString()}` : '下一次执行时间待确认' : '已暂停未来触发'}</span>
          {job.lastRunAt ? <span className="automation-list-row__next">最近运行 {new Date(job.lastRunAt).toLocaleString()}</span> : null}
        </button>
        <ActionMenu label={`自动化 ${job.name} 更多操作`} disabled={Boolean(busy)} items={[
          { id: 'edit', label: '编辑计划', icon: 'pencil', onSelect: () => open(job) },
          ...(capabilities?.runHistory ? [{ id: 'runs', label: '运行记录', icon: 'output' as const, onSelect: () => open(job, 'runs') }] : []),
          { id: 'enabled', label: job.enabled ? '暂停未来触发' : '恢复计划', icon: job.enabled ? 'stop' : 'play', disabled: !job.enabled && capabilities?.executionSupported === false, onSelect: () => mutate(job) },
          { id: 'delete', label: '删除计划', icon: 'trash', danger: true, onSelect: () => setRemoving(job) }
        ]} />
      </article>)}</div> : <div className="automation-empty"><Icon name="clock-outline" size={28} /><h3>{jobs.length ? '没有匹配的自动化' : '还没有自动化'}</h3><p>{jobs.length ? '换一个名称或关键词试试。' : capabilities?.targets.includes('standalone') ? '写下重复任务，选择时间即可开始，无需先打开项目。' : '从已有聊天创建定时计划。'}</p></div>}
    </>}
    {editor && currentScope ? <AutomationEditor key={`${source}:${editor.key}`} job={editor.job} capabilities={capabilities} sessions={sessions} currentSessionId={currentSessionId} currentAgentId={currentAgentId} thinkingMode={thinkingMode} initialTab={editor.tab} onClose={() => setEditor(null)} onSaved={updateJob} onOpenRun={onOpenRun} onManageAgent={() => { setEditor(null); onManageAgent() }} /> : null}
    {removing && currentScope ? <Dialog title="删除自动化" onClose={() => { if (!busy) setRemoving(null) }} footer={<><button className="btn" type="button" disabled={Boolean(busy)} onClick={() => setRemoving(null)}>取消</button><button className="btn btn--danger" type="button" disabled={Boolean(busy)} onClick={() => void mutate(removing, true)}>{busy ? <Spinner size={14} /> : null}删除计划</button></>}><p>删除“{removing.name}”后不再按计划触发。已有运行与记录保留，停止当前运行请在运行记录中操作。</p></Dialog> : null}
  </section>
}
