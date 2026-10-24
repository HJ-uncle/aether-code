import { useEffect, useMemo, useState, type JSX } from 'react'
import type { EngineSnapshot } from '@shared/ipc'
import { useApp } from '@renderer/core/app-context'
import { useWorkbenchVisible } from '@renderer/core/platform/workbench-visibility'
import { Icon } from '@renderer/workbench/icons'
import { SectionHeading } from '@renderer/workbench/ui-primitives'
import type { WorkTask } from './work-state'
import { EngineResourceHealth } from './EngineResourceHealth'

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

/** Resource monitoring reuses the existing connection and Work snapshots.
 * Task/automation management stays in its own pages, without extra requests or
 * page-performance observers on this long-lived diagnostic surface. */
export function EngineMonitorView({ tasks }: { tasks: readonly WorkTask[] }): JSX.Element {
  const { engine } = useApp()
  const visible = useWorkbenchVisible()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!visible) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [visible])
  const snapshot = engine.snapshot
  const state = snapshotState(snapshot)
  const { running, waiting } = useMemo(() => {
    let running = 0
    let waiting = 0
    for (const task of tasks) {
      if (task.archived) continue
      if (task.status === 'running') running += 1
      else if (task.status === 'waiting') waiting += 1
    }
    return { running, waiting }
  }, [tasks])
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

      </div>
    </div>
  )
}
