import { useMemo, type JSX } from 'react'
import type { EngineSnapshot } from '@shared/ipc'
import { useApp } from '@renderer/core/app-context'
import { accountConnectionIssue, connectionLabel, runtimeSourceLabel } from '@renderer/core/engine/connection-status'
import { Icon } from '@renderer/ui/icons'
import { SectionHeading } from '@renderer/ui/ui-primitives'
import type { SessionTask } from '../sessions/state'
import { EngineResourceHealth } from './EngineResourceHealth'

function snapshotState(snapshot: EngineSnapshot): 'ready' | 'busy' | 'error' | 'idle' {
  if (snapshot.phase === 'ready') return 'ready'
  if (snapshot.phase === 'error') return accountConnectionIssue(snapshot) ? 'idle' : 'error'
  if (
    snapshot.phase === 'starting' ||
    snapshot.phase === 'installing' ||
    snapshot.phase === 'stopping'
  )
    return 'busy'
  return 'idle'
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
export function EngineMonitorView({ tasks }: { tasks: readonly SessionTask[] }): JSX.Element {
  const { engine } = useApp()
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

  return (
    <div className="work-page work-page--monitor">
      <div className="work-page__inner">
        <SectionHeading
          eyebrow="ENGINE · 只读监控"
          title="引擎监控"
          description="查看引擎 CPU、内存、进程 I/O、存储容量和连接健康。进入页面读取一次，之后点击按钮手动刷新。"
        />
        <section className="engine-monitor__overview" aria-label="引擎概览">
          <div className="engine-monitor__status" data-state={state}>
            <span className="engine-monitor__status-dot" aria-hidden="true" />
            <div>
              <strong>{connectionLabel(snapshot)}</strong>
              <span>
                {snapshot.mode === 'embedded' ? '本机引擎' : '其他引擎'}
              </span>
            </div>
          </div>
          <div className="engine-monitor__stats">
            <Stat
              label="PID"
              value={snapshot.mode === 'embedded' && snapshot.phase === 'ready' && snapshot.pid ? String(snapshot.pid) : '—'}
              hint={snapshot.mode === 'remote' ? '服务端进程不可见' : snapshot.adopted ? '复用已有进程' : snapshot.pid && snapshot.phase === 'ready' ? '由当前应用启动' : '没有可用的本机进程'}
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
              value={snapshot.phase === 'ready' ? snapshot.version || '未知' : '—'}
              hint={snapshot.phase === 'ready' ? snapshot.buildId || '未提供构建标识' : undefined}
            />
          </div>
        </section>

        {snapshot.error ? (
          <p className="engine-monitor__error" role="alert">
            <Icon name="alert-circle" size={14} />
            {snapshot.error}
          </p>
        ) : null}

        <EngineResourceHealth snapshot={snapshot} />

        <section className="engine-monitor__identity" aria-label="引擎身份">
          <div>
            <span>实例</span>
            <strong>{snapshot.phase === 'ready' ? snapshot.instanceId || '—' : '—'}</strong>
          </div>
          <div>
            <span>数据库文件</span>
            <strong title={snapshot.phase === 'ready' && snapshot.mode === 'embedded' ? snapshot.dataDir || undefined : undefined}>{snapshot.mode === 'remote' ? '服务端未提供' : snapshot.phase === 'ready' ? snapshot.dataDir || '—' : '—'}</strong>
          </div>
          <div>
            <span>运行时来源</span>
            <strong>{snapshot.mode === 'remote' || snapshot.phase === 'ready' ? runtimeSourceLabel(snapshot) : '—'}</strong>
          </div>
          <div>
            <span>连接状态更新时间</span>
            <strong>{formatTime(snapshot.updatedAt)}</strong>
          </div>
        </section>

      </div>
    </div>
  )
}
