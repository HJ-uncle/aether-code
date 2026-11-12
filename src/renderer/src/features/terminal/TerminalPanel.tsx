import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import type { CommandJobSnapshot } from '@shared/command-job'
import { useApp } from '@renderer/core/app-context'
import { getEngineSource, subscribeEngineSource } from '@renderer/core/engine/source'
import { commandJobActive, commandJobDisplayLabel, commandJobInvocation, commandJobStopMessage, mergeCommandJob } from '@renderer/core/engine/command-job-state'
import { activateCommandSession, cancelCommandJob, commandJobMissing, deactivateCommandSession, deleteCommandJob, getCommandJobs, ingestCommandJob, refreshCommandOutput, restartCommandJob, subscribeCommandJobs, useCommandJob } from '@renderer/core/engine/command-job-store'
import { useWorkbenchVisible } from '@renderer/core/platform/workbench-visibility'
import { confirmDialog } from '@renderer/ui/ConfirmDialog'
import { Icon } from '@renderer/ui/icons'
import { Popover } from '@renderer/ui/Popover'
import { Spinner } from '@renderer/ui/ui-primitives'
import { TerminalView } from './TerminalView'
import { partitionCommandJobs } from '@renderer/core/engine/command-job-state'
import './terminal-panel.css'

export interface TerminalPanelProps {
  sessionId: string
  cwd?: string | null
  jobs: CommandJobSnapshot[]
  active: boolean
  reveal?: { jobId: string | null; revision: number; view?: 'jobs' | 'terminal' } | null
}

interface LogPosition {
  top: number
  follow: boolean
  anchor?: { seq: string; offset: number }
}

interface PanelMemory {
  view: 'jobs' | 'terminal'
  selectedId: string | null
  positions: Map<string, LogPosition>
  lastAppliedRevealRevision?: number
}

// Closing the workspace releases its output buffers, while these small browsing preferences survive.
const panelMemories = new Map<string, PanelMemory>()
subscribeEngineSource(() => panelMemories.clear())

function rememberPanel(source: number, sessionId: string, initialize: () => PanelMemory): PanelMemory {
  const key = JSON.stringify([source, sessionId])
  const memory = panelMemories.get(key) ?? initialize()
  panelMemories.delete(key)
  panelMemories.set(key, memory)
  if (panelMemories.size > 32) panelMemories.delete(panelMemories.keys().next().value!)
  return memory
}

function findOutputAnchor(element: HTMLPreElement, sequence: string): Element | undefined {
  const target = Number(sequence)
  let low = 0, high = element.children.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (Number(element.children[middle].getAttribute('data-output-seq')) < target) low = middle + 1
    else high = middle
  }
  const child = element.children[low]
  return child?.getAttribute('data-output-seq') === sequence ? child : undefined
}

/** Session and engine changes cannot lend a new task an old terminal selection. */
export function TerminalPanel(props: TerminalPanelProps): JSX.Element {
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  return <ScopedSessionTerminalPanel key={JSON.stringify([source, props.sessionId])} {...props} source={source} />
}

function ScopedSessionTerminalPanel({ sessionId, cwd, jobs, active, reveal, source }: TerminalPanelProps & { source: number }): JSX.Element {
  const { ready } = useApp()
  const visible = useWorkbenchVisible()
  const enabled = active && visible
  const owner = `work-terminal:${useId()}`
  const [, redraw] = useState(0)
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(new Set())
  const [localJobs, setLocalJobs] = useState<CommandJobSnapshot[]>([])
  const cachedJobs = getCommandJobs(sessionId)
  const services = partitionCommandJobs([...jobs, ...localJobs, ...cachedJobs].filter(job => !deleted.has(job.jobId)), sessionId)
  const available = [...services.running, ...services.history]
  const [memory] = useState(() => rememberPanel(source, sessionId, () => ({
    view: reveal ? reveal.view ?? 'jobs' : services.running.length ? 'jobs' : 'terminal',
    selectedId: reveal?.jobId ?? available[0]?.jobId ?? null,
    positions: new Map(),
    lastAppliedRevealRevision: reveal?.revision
  })))
  const [view, updateView] = useState(memory.view)
  const [selectedId, updateSelectedId] = useState(memory.selectedId)
  const setView = (next: PanelMemory['view']): void => { memory.view = next; updateView(next) }
  const setSelectedId = (next: string | null): void => { memory.selectedId = next; updateSelectedId(next) }
  const selected = available.find(job => job.jobId === selectedId)
  const live = useRef({ available, enabled, view })
  live.current = { available, enabled, view }
  const mounted = useRef(false)
  useLayoutEffect(() => {
    mounted.current = true
    activateCommandSession(sessionId, owner)
    return () => { mounted.current = false; deactivateCommandSession(owner) }
  }, [sessionId, owner])
  useEffect(() => subscribeCommandJobs(() => redraw(value => value + 1)), [])
  useEffect(() => { for (const job of jobs) if (job.sessionId === sessionId && job.background) ingestCommandJob(job) }, [jobs, sessionId])
  useLayoutEffect(() => {
    if (!reveal || memory.lastAppliedRevealRevision === reveal.revision) return
    memory.lastAppliedRevealRevision = reveal.revision
    setView(reveal.view ?? 'jobs')
    if (reveal.view !== 'terminal') setSelectedId(reveal.jobId ?? live.current.available[0]?.jobId ?? null)
  }, [reveal])
  // An empty list can receive its first job after the panel is opened.
  useEffect(() => {
    if (!selectedId && !reveal?.jobId && available.length) setSelectedId(available[0].jobId)
  }, [selectedId, reveal?.jobId, available[0]?.jobId])
  const positionFor = (id: string): LogPosition => {
    let position = memory.positions.get(id)
    if (!position) {
      position = { top: 0, follow: true }
    }
    memory.positions.delete(id)
    memory.positions.set(id, position)
    if (memory.positions.size > 32) memory.positions.delete(memory.positions.keys().next().value!)
    return position
  }
  const restarted = (job: CommandJobSnapshot, originalId: string): void => {
    if (!mounted.current || source !== getEngineSource()) return
    setLocalJobs(previous => [...previous.filter(item => item.jobId !== job.jobId), job])
    if (live.current.enabled && live.current.view === 'jobs' && memory.selectedId === originalId) setSelectedId(job.jobId)
  }
  const removed = (id: string): void => {
    if (!mounted.current || source !== getEngineSource()) return
    setDeleted(previous => new Set([...previous, id]))
    memory.positions.delete(id)
    if (memory.selectedId === id) setSelectedId(live.current.available.find(job => job.jobId !== id)?.jobId ?? null)
  }
  const panelId = `work-terminal-${useId().replace(/:/g, '')}`
  const row = (job: CommandJobSnapshot): JSX.Element => <button type="button" key={job.jobId}
    className="work-terminal-panel__job" data-job-id={job.jobId} data-status={job.status}
    aria-current={selectedId === job.jobId ? 'true' : undefined} aria-label={`查看后台运行：${commandJobInvocation(job)}`}
    title={`${commandJobInvocation(job)}\n${job.cwd}\n${commandJobDisplayLabel(job)}`} onClick={() => setSelectedId(job.jobId)}>
    <Icon name={job.status === 'succeeded' ? 'check' : job.status === 'cancelled' ? 'stop' : 'terminal'} size={13} />
    <span><strong>{commandJobInvocation(job)}</strong><small>{commandJobDisplayLabel(job)}</small></span>
  </button>
  return <section className="work-terminal-panel" aria-label="任务终端" data-session-id={sessionId}>
    <div className="work-terminal-panel__tabs" role="tablist" aria-label="终端视图" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const next = event.key === 'Home' ? 'jobs' : event.key === 'End' ? 'terminal' : view === 'jobs' ? 'terminal' : 'jobs'
      setView(next)
      event.currentTarget.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus()
    }}>
      <button type="button" role="tab" data-view="jobs" id={`${panelId}-jobs-tab`} tabIndex={view === 'jobs' ? 0 : -1} aria-selected={view === 'jobs'} aria-controls={`${panelId}-jobs`} onClick={() => setView('jobs')}>后台运行{services.running.length ? <span>{services.running.length}</span> : null}</button>
      <button type="button" role="tab" data-view="terminal" id={`${panelId}-terminal-tab`} tabIndex={view === 'terminal' ? 0 : -1} aria-selected={view === 'terminal'} aria-controls={`${panelId}-terminal`} onClick={() => setView('terminal')}>终端</button>
    </div>
    <div className="work-terminal-panel__jobs" id={`${panelId}-jobs`} role="tabpanel" aria-labelledby={`${panelId}-jobs-tab`} hidden={view !== 'jobs'}>
      {available.length ? <nav className="work-terminal-panel__list" aria-label="后台运行列表">
        {services.running.length ? <><h4>运行中</h4>{services.running.map(row)}</> : null}
        {services.history.length ? <><h4>历史记录</h4>{services.history.map(row)}</> : null}
      </nav> : null}
      {selected ? <JobOutput key={selected.jobId} initial={selected} sessionId={sessionId} source={source}
        enabled={enabled && view === 'jobs'} ready={ready} position={positionFor(selected.jobId)} onRestart={restarted} onDelete={removed} />
        : <div className="work-terminal-panel__empty" role="status"><Icon name="terminal" size={24} /><p>{selectedId ? '此后台运行记录暂不可用，请选择其他记录。' : '此任务还没有后台运行记录。'}</p></div>}
    </div>
    <div className="work-terminal-panel__terminal" id={`${panelId}-terminal`} role="tabpanel" aria-labelledby={`${panelId}-terminal-tab`} hidden={view !== 'terminal'}>
      <TerminalView sessionId={sessionId} cwd={cwd} active={enabled && view === 'terminal'} />
    </div>
  </section>
}

function JobOutput({ initial, sessionId, source, enabled, ready, position, onRestart, onDelete }: {
  initial: CommandJobSnapshot; sessionId: string; source: number; enabled: boolean; ready: boolean; position: LogPosition
  onRestart: (job: CommandJobSnapshot, originalId: string) => void; onDelete: (id: string) => void
}): JSX.Element {
  const cached = useCommandJob(sessionId, initial.jobId)
  const job = cached ? mergeCommandJob(initial, cached.job) : initial
  const output = cached?.output
  const running = commandJobActive(job)
  const [error, setError] = useState('')
  const [outputError, setOutputError] = useState('')
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [working, setWorking] = useState<'stop' | 'restart' | 'delete' | null>(null)
  const [retry, setRetry] = useState(0)
  const [copied, setCopied] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [following, setFollowing] = useState(position.follow)
  const scroller = useRef<HTMLPreElement>(null)
  const scrollFrame = useRef<number | null>(null)
  const mounted = useRef(true)
  const busy = useRef(false)
  const live = useRef({ enabled, ready, job })
  live.current = { enabled, ready, job }
  const current = (): boolean => mounted.current && source === getEngineSource()
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (!enabled) setInfoOpen(false) }, [enabled])
  useEffect(() => {
    if (!enabled || !ready) { setLoading(false); return }
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      if (!alive || !current() || !live.current.enabled || !live.current.ready) return
      let again = true
      setLoading(true)
      try {
        const next = await refreshCommandOutput(sessionId, initial.jobId)
        again = commandJobActive(next.job) || next.output.cursor < next.job.cursor
        if (alive && current()) setOutputError('')
      } catch (cause) {
        again = !commandJobMissing(cause)
        if (alive && current()) setOutputError(`日志读取失败：${cause instanceof Error ? cause.message : String(cause)}`)
      } finally { if (alive && current()) { setLoading(false); setLoaded(true) } }
      if (alive && current() && again) timer = setTimeout(() => { void refresh() }, 1000)
    }
    void refresh()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [enabled, ready, sessionId, initial.jobId, source, retry])
  const remember = (): void => {
    const element = scroller.current
    if (!element?.children.length) return
    position.top = element.scrollTop
    if (position.follow) { position.anchor = undefined; return }
    const top = element.getBoundingClientRect().top
    let low = 0, high = element.children.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (element.children[middle].getBoundingClientRect().bottom <= top) low = middle + 1
      else high = middle
    }
    const anchor = element.children[low]
    const seq = anchor?.getAttribute('data-output-seq')
    position.anchor = seq ? { seq, offset: anchor.getBoundingClientRect().top - top } : undefined
  }
  const sampleScroll = (): void => {
    const element = scroller.current
    if (!current() || !live.current.enabled || !element?.children.length) return
    position.follow = element.scrollHeight - element.scrollTop - element.clientHeight <= 32
    setFollowing(position.follow)
    remember()
  }
  useLayoutEffect(() => () => {
    if (scrollFrame.current === null) return
    cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = null
    sampleScroll()
  }, [])
  useLayoutEffect(() => {
    const element = scroller.current
    if (!enabled || !element || !output?.entries.length) return
    if (scrollFrame.current !== null) {
      cancelAnimationFrame(scrollFrame.current)
      scrollFrame.current = null
      sampleScroll()
    }
    if (position.follow) element.scrollTop = element.scrollHeight
    else {
      // A remounted view may need several pages before its saved line becomes available again.
      if (position.anchor && Number(position.anchor.seq) > output.cursor) return
      element.scrollTop = position.top
      const anchor = position.anchor && findOutputAnchor(element, position.anchor.seq)
      if (anchor) element.scrollTop += anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - position.anchor!.offset
      else if (position.anchor && Number(element.children[0].getAttribute('data-output-seq')) > Number(position.anchor.seq)) element.scrollTop = 0
    }
    remember()
  }, [output, enabled, position])
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(timer)
  }, [copied])
  const action = async (kind: 'stop' | 'restart' | 'delete'): Promise<void> => {
    if (!current() || !enabled || !ready || busy.current || (kind === 'stop') !== running) return
    busy.current = true
    setWorking(kind); setError('')
    try {
      if (kind === 'delete' && !await confirmDialog({ title: '删除后台运行记录', body: '删除这条服务历史及其日志？此操作无法撤销。', confirmText: '删除', danger: true })) return
      if (!current() || !live.current.enabled || !live.current.ready || (kind === 'stop') !== commandJobActive(live.current.job)) return
      if (kind === 'stop') { await cancelCommandJob(sessionId, job.jobId); if (current()) setRetry(value => value + 1) }
      else if (kind === 'restart') { const next = await restartCommandJob(sessionId, job.jobId); if (source === getEngineSource()) onRestart(next, job.jobId) }
      else { await deleteCommandJob(sessionId, job.jobId); if (source === getEngineSource()) onDelete(job.jobId) }
    } catch (cause) {
      if (current()) setError(`${kind === 'stop' ? '停止' : kind === 'restart' ? '重启' : '删除'}失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally { busy.current = false; if (current()) setWorking(null) }
  }
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(output?.entries.map(entry => entry.text).join('') ?? ''); if (current()) setCopied(true) }
    catch (cause) { if (current()) setError(`复制失败：${cause instanceof Error ? cause.message : String(cause)}`) }
  }
  const stopMessage = commandJobStopMessage(job)
  const stamp = new Date(job.createdAt)
  return <div className="work-terminal-panel__detail" data-job-id={job.jobId} data-status={job.status}>
    <header className="work-terminal-panel__job-header">
      <code title={commandJobInvocation(job)}>{commandJobInvocation(job)}</code>
      <span className="work-terminal-panel__status" role="status">{commandJobDisplayLabel(job)}</span>
      <Popover label="后台运行信息" align="end" width={320} open={enabled && infoOpen} onOpenChange={setInfoOpen} disabled={!enabled} panelClassName="work-terminal-panel__info" trigger={({ open }) =>
        <button type="button" aria-label="后台运行信息" aria-expanded={open} title="命令与工作目录"><Icon name="info" size={14} /></button>}>
        <dl><div><dt>命令</dt><dd><code>{commandJobInvocation(job)}</code></dd></div><div><dt>工作目录</dt><dd>{job.cwd}</dd></div>
          {Number.isFinite(stamp.getTime()) ? <div><dt>开始时间</dt><dd>{stamp.toLocaleString()}</dd></div> : null}
          {job.ownerSessionId !== sessionId ? <div><dt>执行代理</dt><dd>{job.ownerRunId ?? job.ownerSessionId}</dd></div> : null}
          {job.exitCode !== null ? <div><dt>退出码</dt><dd>{job.exitCode}</dd></div> : null}{job.signal ? <div><dt>信号</dt><dd>{job.signal}</dd></div> : null}
        </dl>
      </Popover>
      <button type="button" aria-label={copied ? '已复制日志' : '复制日志'} title={copied ? '已复制' : '复制当前保留的完整日志'} disabled={!output?.entries.length} onClick={() => void copy()}><Icon name={copied ? 'check' : 'copy'} size={14} /></button>
      {running ? <button type="button" aria-label="停止命令" title="停止后台运行" disabled={!enabled || !ready || working !== null || job.status === 'cancelling'} onClick={() => void action('stop')}>{working === 'stop' ? <Spinner size={14} /> : <Icon name="stop" size={14} />}</button> : <>
        <button type="button" aria-label="重启服务" title="按原命令重新启动" disabled={!enabled || !ready || working !== null} onClick={() => void action('restart')}>{working === 'restart' ? <Spinner size={14} /> : <Icon name="restart" size={14} />}</button>
        <button type="button" aria-label="删除服务历史" title="删除历史及日志" disabled={!enabled || !ready || working !== null} onClick={() => void action('delete')}>{working === 'delete' ? <Spinner size={14} /> : <Icon name="trash" size={14} />}</button>
      </>}
    </header>
    {error ? <p className="work-terminal-panel__error" role="alert">{error}</p> : null}
    {outputError ? <div className="work-terminal-panel__error" role="alert"><span>{outputError}</span><button type="button" disabled={!enabled || !ready || loading} onClick={() => setRetry(value => value + 1)}>重试</button></div> : null}
    {job.error && !stopMessage ? <p className="work-terminal-panel__error" role="alert">{job.error.message}</p> : stopMessage ? <p className="work-terminal-panel__notice">{stopMessage}</p> : null}
    {output?.truncated ? <p className="work-terminal-panel__notice">仅显示最近保留的日志，较早内容已截断。</p> : null}
    <pre ref={scroller} className="work-terminal-panel__output" aria-label="命令输出" tabIndex={0} onScroll={() => {
      if (!enabled || scrollFrame.current !== null) return
      scrollFrame.current = requestAnimationFrame(() => { scrollFrame.current = null; sampleScroll() })
    }}>{output?.entries.length ? output.entries.map(entry => <span key={entry.seq} data-output-seq={entry.seq} data-stream={entry.stream}>{entry.text}</span>) : loading && !loaded ? '正在读取日志…' : '暂无输出'}</pre>
    {!following ? <button type="button" className="work-terminal-panel__latest" onClick={() => {
      position.follow = true; setFollowing(true)
      if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
      remember()
    }}><Icon name="chevron-down" size={13} />回到最新</button> : null}
  </div>
}
