import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { EngineSnapshot } from '@shared/ipc'
import { useApp } from '@renderer/core/app-context'
import { getEngineSource } from '@renderer/core/engine/source'
import { requestOrThrow } from '@renderer/core/engine/client'
import { Icon } from '@renderer/workbench/icons'
import { SectionHeading } from '@renderer/workbench/ui-primitives'
import type { WorkTask, WorkTaskStatus } from './work-state'
import { listAutomations, type AutomationJob } from '../automations/automation-client'
import { EngineResourceHealth } from './EngineResourceHealth'

const STATUS_LABEL: Record<WorkTaskStatus, string> = {
  draft: '草稿',
  running: '进行中',
  waiting: '等待处理',
  done: '已完成',
  error: '失败',
  stopped: '已停止',
  interrupted: '已中断'
}

function snapshotState(snapshot: EngineSnapshot): 'ready' | 'busy' | 'error' | 'idle' {
  if (snapshot.phase === 'ready') return 'ready'
  if (snapshot.phase === 'error') return 'error'
  if (
    snapshot.phase === 'starting' ||
    snapshot.phase === 'installing' ||
    snapshot.phase === 'stopping'
  )
    return 'busy'
  return 'idle'
}

function phaseLabel(snapshot: EngineSnapshot): string {
  const labels: Record<EngineSnapshot['phase'], string> = {
    idle: '未启动',
    installing: '安装中',
    starting: '启动中',
    ready: '已就绪',
    stopping: '停止中',
    error: '错误'
  }
  return labels[snapshot.phase]
}

function formatTime(value: number | null | undefined): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function formatSchedule(job: AutomationJob): string {
  const schedule = job.configuration?.schedule
  if (!schedule) return job.cronExpr || '旧版计划'
  if (schedule.kind === 'interval') return `每 ${schedule.everyMinutes} 分钟`
  if (schedule.kind === 'calendar') return `${schedule.localTime} · ${schedule.timeZone}`
  return `${schedule.expression} · ${schedule.timeZone}`
}

interface EngineMetrics {
  totalRequests?: number
  totalTokens?: number
  toolCallStats?: Array<{ toolName: string; avgDurationMs: number; count: number; successRate: number }>
}

function shortPath(value: string | null): string {
  if (!value) return '独立任务'
  const normalized = value.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : normalized
}

function taskStatus(task: WorkTask, ready: boolean): { label: string; state: string } {
  const disconnected = !ready && (task.status === 'running' || task.status === 'waiting')
  return {
    label: disconnected ? '连接中断' : STATUS_LABEL[task.status],
    state: disconnected ? 'interrupted' : task.status
  }
}

function Stat({
  label,
  value,
  hint,
  state
}: {
  label: string
  value: string
  hint?: string
  state?: string
}): JSX.Element {
  return (
    <div className="engine-monitor__stat" data-state={state}>
      <span className="engine-monitor__label">{label}</span>
      <strong>{value}</strong>
      {hint ? <small>{hint}</small> : null}
    </div>
  )
}

function Lane({
  title,
  tasks,
  ready,
  empty,
  onSelectTask
}: {
  title: string
  tasks: readonly WorkTask[]
  ready: boolean
  empty: string
  onSelectTask?: (id: string) => void
}): JSX.Element {
  return (
    <section className="engine-monitor__lane" aria-label={title}>
      <header>
        <h3>{title}</h3>
        <span>{tasks.length}</span>
      </header>
      {tasks.length ? (
        <div className="engine-monitor__task-list">
          {tasks.slice(0, 24).map((task) => {
            const status = taskStatus(task, ready)
            return (
              <button
                type="button"
                className="engine-monitor__task"
                key={task.id}
                onClick={() => onSelectTask?.(task.id)}
                title={onSelectTask ? '打开任务，查看对话与子 Agent' : undefined}
              >
                <span
                  className="engine-monitor__task-indicator"
                  data-state={status.state}
                  aria-hidden="true"
                />
                <div className="engine-monitor__task-main">
                  <strong title={task.title}>{task.title || '未命名任务'}</strong>
                  <span>
                    {task.modelId || '跟随引擎模型'} · {shortPath(task.workspacePath)}
                  </span>
                </div>
                <div className="engine-monitor__task-meta">
                  <span data-state={status.state}>{status.label}</span>
                  <small>{formatTime(task.updatedAt)}</small>
                </div>
              </button>
            )
          })}
        </div>
      ) : (
        <p className="engine-monitor__empty">{empty}</p>
      )}
      {tasks.length > 24 ? (
        <p className="engine-monitor__more">仅显示前 24 项，完整列表仍由 Work 页面负责分页。</p>
      ) : null}
    </section>
  )
}

function AutomationHealth({ jobs, loading, error, truncated, onRetry, onRefresh }: {
  jobs: readonly AutomationJob[]
  loading: boolean
  error: string
  truncated: boolean
  onRetry: () => void
  onRefresh: () => void
}): JSX.Element {
  const visible = jobs.slice(0, 24)
  const enabled = jobs.filter(job => job.enabled).length
  return <section className="engine-monitor__automation" aria-label="定时计划监控">
    <header className="engine-monitor__automation-heading">
      <div>
        <h3>定时计划</h3>
        <p>读取引擎实际计划；会话记录与计划健康分开统计。</p>
      </div>
      <div className="engine-monitor__automation-actions">
        <div className="engine-monitor__automation-summary">
          <strong>{enabled}/{truncated ? '64+' : jobs.length}</strong><span>{truncated ? '前 64 项已启用' : '已启用'}</span>
        </div>
        <button type="button" className="btn btn--sm" disabled={loading} onClick={onRefresh}>
          {loading ? '读取中…' : '刷新计划'}
        </button>
      </div>
    </header>
    {error ? <p className="engine-monitor__error" role="alert"><Icon name="warning" size={14} />{error}<button type="button" className="btn btn--sm" onClick={onRetry}>重试</button></p> : null}
    {loading && !jobs.length ? <p className="engine-monitor__empty" role="status">正在读取计划状态…</p> : null}
    {!loading && !error && !jobs.length ? <p className="engine-monitor__empty">当前引擎没有可见的定时计划。</p> : null}
    {visible.length ? <div className="engine-monitor__automation-list">
      {visible.map(job => <article className="engine-monitor__automation-row" key={job.id} data-job-id={job.id}>
        <span className="engine-monitor__task-indicator" data-state={job.enabled ? 'running' : 'idle'} aria-hidden="true" />
        <div className="engine-monitor__automation-main"><strong title={job.name}>{job.name}</strong><span>{formatSchedule(job)}</span></div>
        <div className="engine-monitor__automation-meta"><span data-state={job.enabled ? 'running' : 'idle'}>{job.enabled ? '已启用' : '已暂停'}</span><small>{job.nextRunAt ? `下次 ${formatTime(job.nextRunAt)}` : job.lastRunAt ? `上次 ${formatTime(job.lastRunAt)}` : '尚未运行'}</small></div>
      </article>)}
    </div> : null}
    {truncated || jobs.length > visible.length ? <p className="engine-monitor__more">仅显示前 24 个计划，完整管理仍在自动化页面。</p> : null}
  </section>
}

function PerformanceSummary(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [metrics, setMetrics] = useState<EngineMetrics | null>(null)
  const generation = useRef(0)
  const pending = useRef(false)
  useEffect(() => () => { generation.current += 1 }, [])
  const load = async (): Promise<void> => {
    setOpen(true)
    if (pending.current) return
    pending.current = true
    const stamp = ++generation.current
    const source = getEngineSource()
    setLoading(true)
    setError('')
    try {
      const raw: unknown = await requestOrThrow<unknown>({ method: 'GET', path: '/metrics' })
      if (stamp !== generation.current || source !== getEngineSource()) return
      const value = raw && typeof raw === 'object' ? raw as Partial<EngineMetrics> : {}
      const stats = Array.isArray(value.toolCallStats) ? value.toolCallStats
        .filter((item): item is NonNullable<EngineMetrics['toolCallStats']>[number] => Boolean(item) && typeof item.toolName === 'string' && Number.isFinite(item.avgDurationMs) && Number.isFinite(item.count) && Number.isFinite(item.successRate))
        .slice(0, 8) : []
      setMetrics({ totalRequests: Number.isFinite(value.totalRequests) ? value.totalRequests : undefined,
        totalTokens: Number.isFinite(value.totalTokens) ? value.totalTokens : undefined, toolCallStats: stats })
    } catch (cause) {
      if (stamp === generation.current && source === getEngineSource()) setError(cause instanceof Error ? cause.message : '当前引擎不提供性能摘要')
    } finally {
      pending.current = false
      if (stamp === generation.current) setLoading(false)
    }
  }
  return <section className="engine-monitor__performance" aria-label="引擎业务统计">
    <header className="engine-monitor__toolbar">
      <span>业务统计</span>
      <button type="button" className="btn btn--sm" aria-expanded={open} onClick={() => {
        if (open) { setOpen(false); generation.current += 1 }
        else void load()
      }}>{open ? '收起业务统计' : '按需加载业务统计'}</button>
    </header>
    {open ? <div className="engine-monitor__performance-body">
      {loading ? <p className="engine-monitor__empty" role="status">正在读取引擎指标…</p> : null}
      {error ? <p className="engine-monitor__error" role="alert"><Icon name="warning" size={14} />{error}</p> : null}
      {!loading && !error && metrics ? <>
        <div className="engine-monitor__performance-stats"><Stat label="请求数" value={metrics.totalRequests == null ? '—' : String(metrics.totalRequests)} /><Stat label="Token 总量" value={metrics.totalTokens == null ? '—' : String(metrics.totalTokens)} /><Stat label="工具统计" value={String(metrics.toolCallStats?.length ?? 0)} hint="最多显示 8 项" /></div>
        {metrics.toolCallStats?.length ? <div className="engine-monitor__tool-stats">{metrics.toolCallStats.map(item => <div key={item.toolName}><strong>{item.toolName}</strong><span>{Math.round(item.avgDurationMs)} ms · {item.count} 次 · {Math.round(item.successRate * 100)}% 成功</span></div>)}</div> : <p className="engine-monitor__empty">引擎尚未记录工具调用。</p>}
      </> : null}
    </div> : null}
  </section>
}

/**
 * Compact, read-only engine diagnostics. It consumes the existing snapshot
 * subscription and Work state; it deliberately does not poll raw engine logs
 * or retain an event history in the renderer.
 */
export function EngineMonitorView({
  tasks,
  ready,
  onSelectTask
}: {
  tasks: readonly WorkTask[]
  ready: boolean
  onSelectTask?: (id: string) => void
}): JSX.Element {
  const { engine } = useApp()
  const [showDetails, setShowDetails] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [automationJobs, setAutomationJobs] = useState<AutomationJob[]>([])
  const [automationLoading, setAutomationLoading] = useState(false)
  const [automationError, setAutomationError] = useState('')
  const [automationTruncated, setAutomationTruncated] = useState(false)
  const [automationReload, setAutomationReload] = useState(0)
  const automationGeneration = useRef(0)
  const automationPending = useRef(false)
  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      if (!alive || document.hidden || !ready || automationPending.current) return
      automationPending.current = true
      const stamp = ++automationGeneration.current
      const source = getEngineSource()
      setAutomationLoading(true)
      try {
        const jobs = await listAutomations()
        if (!alive || stamp !== automationGeneration.current || source !== getEngineSource()) return
        setAutomationTruncated(jobs.length > 64)
        setAutomationJobs(jobs.slice(0, 64))
        setAutomationError('')
      } catch (cause) {
        if (alive && stamp === automationGeneration.current && source === getEngineSource()) {
          setAutomationJobs([])
          setAutomationTruncated(false)
          setAutomationError(cause instanceof Error ? cause.message : '无法读取定时计划')
        }
      } finally {
        automationPending.current = false
        if (alive && stamp === automationGeneration.current) setAutomationLoading(false)
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 30_000)
    const onVisibility = (): void => { if (!document.hidden) void load() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => { alive = false; automationGeneration.current += 1; document.removeEventListener('visibilitychange', onVisibility); window.clearInterval(timer) }
  }, [ready, automationReload])
  useEffect(() => {
    if (!ready) {
      setAutomationJobs([])
      setAutomationTruncated(false)
      setAutomationError('')
      setAutomationLoading(false)
    }
  }, [ready])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const snapshot = engine.snapshot
  const state = snapshotState(snapshot)
  const taskView = useMemo(() => {
    const workTasks: WorkTask[] = []
    const cronTasks: WorkTask[] = []
    let running = 0
    let waiting = 0
    for (const task of tasks) {
      if (task.archived) continue
      if (task.origin?.kind === 'automation') cronTasks.push(task)
      else workTasks.push(task)
      if (task.status === 'running') running += 1
      else if (task.status === 'waiting') waiting += 1
    }
    return { workTasks, cronTasks, running, waiting }
  }, [tasks])
  const { workTasks, cronTasks, running, waiting } = taskView
  const age = snapshot.updatedAt ? Math.max(0, now - snapshot.updatedAt) : null

  return (
    <div className="work-page work-page--monitor">
      <div className="work-page__inner">
        <SectionHeading
          eyebrow="ENGINE · 只读监控"
          title="引擎监控"
          description="查看引擎 CPU、内存、进程 I/O、存储容量和连接健康。资源按需采样，页面隐藏时停止刷新。"
        />
        <section className="engine-monitor__overview" aria-label="引擎概览">
          <div className="engine-monitor__status" data-state={state}>
            <span className="engine-monitor__status-dot" aria-hidden="true" />
            <div>
              <strong>{phaseLabel(snapshot)}</strong>
              <span>
                {snapshot.mode === 'embedded' ? '本地内置引擎' : '远端引擎'} · 上次状态变化{' '}
                {age === null ? '未知' : `${Math.round(age / 1000)} 秒前`}
              </span>
            </div>
          </div>
          <div className="engine-monitor__stats">
            <Stat
              label="PID"
              value={snapshot.pid ? String(snapshot.pid) : '—'}
              hint={snapshot.adopted ? '复用中的进程' : '当前应用启动'}
            />
            <Stat
              label="端口"
              value={snapshot.port ? String(snapshot.port) : '—'}
              hint={snapshot.baseUrl || '未分配地址'}
            />
            <Stat
              label="活动任务"
              value={String(running)}
              hint={`${waiting} 项等待处理`}
              state={running ? 'busy' : undefined}
            />
            <Stat
              label="版本"
              value={snapshot.version || '未知'}
              hint={snapshot.buildId || '无 build 标识'}
            />
          </div>
        </section>

        {snapshot.error ? (
          <p className="engine-monitor__error" role="alert">
            <Icon name="warning" size={14} />
            {snapshot.error}
          </p>
        ) : null}

        <EngineResourceHealth snapshot={snapshot} />

        <section className="engine-monitor__identity" aria-label="引擎身份">
          <div>
            <span>实例</span>
            <strong>{snapshot.instanceId || '—'}</strong>
          </div>
          <div>
            <span>数据目录</span>
            <strong title={snapshot.dataDir || undefined}>{snapshot.dataDir || '—'}</strong>
          </div>
          <div>
            <span>运行时</span>
            <strong>{snapshot.runtimeSource || '—'}</strong>
          </div>
          <div>
            <span>采样时间</span>
            <strong>{formatTime(snapshot.updatedAt)}</strong>
          </div>
        </section>

        <div className="engine-monitor__toolbar" role="group" aria-label="任务分布控制">
          <div>
            <strong>任务分布</strong>
            <span>按运行来源与当前状态分组</span>
          </div>
          <button
            type="button"
            className="btn btn--sm"
            aria-expanded={showDetails}
            aria-controls="engine-monitor-details"
            onClick={() => setShowDetails((value) => !value)}
          >
            {showDetails ? '收起身份详情' : '展开身份详情'}
          </button>
        </div>
        {showDetails ? (
          <dl className="engine-monitor__details" id="engine-monitor-details">
            <div>
              <dt>入口</dt>
              <dd>{snapshot.entryPath || '—'}</dd>
            </div>
            <div>
              <dt>协议</dt>
              <dd>{snapshot.protocolVersion == null ? '—' : String(snapshot.protocolVersion)}</dd>
            </div>
            <div>
              <dt>账号边界</dt>
              <dd>{snapshot.accountId || '未登录'}</dd>
            </div>
            <div>
              <dt>更新</dt>
              <dd>{formatTime(snapshot.updatedAt)}</dd>
            </div>
          </dl>
        ) : null}
        <div className="engine-monitor__lanes">
          <Lane title="Work 任务" tasks={workTasks} ready={ready} onSelectTask={onSelectTask} empty="暂无独立 Work 任务。" />
          <Lane
            title="定时任务"
            tasks={cronTasks}
            ready={ready}
            onSelectTask={onSelectTask}
            empty="暂无由定时任务创建的会话。"
          />
        </div>
        <AutomationHealth jobs={automationJobs} loading={automationLoading} error={automationError} truncated={automationTruncated} onRetry={() => {
          setAutomationError('')
          setAutomationReload(value => value + 1)
        }} onRefresh={() => {
          setAutomationError('')
          setAutomationReload(value => value + 1)
        }} />
        <PerformanceSummary />
        <p className="engine-monitor__note"><Icon name="account-outline" size={14} /> 子 Agent 详情沿用任务页的按需加载；点击任务后打开“子 Agent”面板，监控页不会扫描全量会话或保留事件历史。</p>
      </div>
    </div>
  )
}
