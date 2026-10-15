import { useEffect, useMemo, useState, type JSX } from 'react'
import type { EngineSnapshot } from '@shared/ipc'
import { useApp } from '@renderer/core/app-context'
import { Icon } from '@renderer/workbench/icons'
import { SectionHeading } from '@renderer/workbench/ui-primitives'
import type { WorkTask, WorkTaskStatus } from './work-state'

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
  empty
}: {
  title: string
  tasks: readonly WorkTask[]
  ready: boolean
  empty: string
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
              <article className="engine-monitor__task" key={task.id}>
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
              </article>
            )
          })}
        </div>
      ) : (
        <p className="engine-monitor__empty">{empty}</p>
      )}
      {tasks.length > 24 ? (
        <p className="engine-monitor__more">仅显示最近 24 项，完整列表仍由 Work 页面负责分页。</p>
      ) : null}
    </section>
  )
}

/**
 * Compact, read-only engine diagnostics. It consumes the existing snapshot
 * subscription and Work state; it deliberately does not poll raw engine logs
 * or retain an event history in the renderer.
 */
export function EngineMonitorView({
  tasks,
  ready
}: {
  tasks: readonly WorkTask[]
  ready: boolean
}): JSX.Element {
  const { engine } = useApp()
  const [showDetails, setShowDetails] = useState(false)
  const [now, setNow] = useState(() => Date.now())
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
          description="以低频快照观察引擎、Work 与定时任务。页面不保留原始事件历史，适合长时间打开。"
        />
        <section className="engine-monitor__overview" aria-label="引擎概览">
          <div className="engine-monitor__status" data-state={state}>
            <span className="engine-monitor__status-dot" aria-hidden="true" />
            <div>
              <strong>{phaseLabel(snapshot)}</strong>
              <span>
                {snapshot.mode === 'embedded' ? '本地内置引擎' : '远端引擎'} · 状态更新时间{' '}
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

        <div className="engine-monitor__toolbar">
          <span>任务分布</span>
          <button
            type="button"
            className="btn btn--sm"
            aria-expanded={showDetails}
            onClick={() => setShowDetails((value) => !value)}
          >
            {showDetails ? '收起身份详情' : '展开身份详情'}
          </button>
        </div>
        {showDetails ? (
          <dl className="engine-monitor__details">
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
          <Lane title="Work 任务" tasks={workTasks} ready={ready} empty="暂无独立 Work 任务。" />
          <Lane
            title="定时任务"
            tasks={cronTasks}
            ready={ready}
            empty="暂无由定时任务创建的会话。"
          />
        </div>
      </div>
    </div>
  )
}
