import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Icon } from '@renderer/workbench/icons'
import { toast } from '@renderer/core/toast'
import type { WorkTask } from './work-state'
import { getRunningWorkTasks } from './work-run-list'

export { getRunningWorkTasks } from './work-run-list'

interface WorkRunListProps {
  tasks: readonly WorkTask[]
  activeTaskId: string | null
  ready: boolean
  onSelect: (id: string) => void
  onStop?: (id: string) => Promise<void>
  /** Embed the switcher in the active task heading instead of the shell. */
  inline?: boolean
}

function runStatusLabel(status: WorkTask['status']): string {
  return status === 'waiting' ? '等待处理' : '运行中'
}

function formatElapsed(start: number | undefined, now: number): string {
  const seconds = Math.max(0, Math.floor((now - (start ?? now)) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`
}

/**
 * A compact Codex-style run switcher for long-running Work jobs.  It stays
 * mounted in the shell but renders nothing when there is no live run, keeping
 * idle sessions free of another toolbar control.  The component intentionally
 * accepts task callbacks instead of reaching into the controller so it can
 * later host scheduled runs, commands, or child-agent actions.
 */
export function WorkRunList({
  tasks,
  activeTaskId,
  ready,
  onSelect,
  onStop,
  inline = false
}: WorkRunListProps): JSX.Element | null {
  const runs = useMemo(() => getRunningWorkTasks(tasks), [tasks])
  const [open, setOpen] = useState(false)
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!runs.length) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [runs.length])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // The active task already exposes its running status and stop action in the
  // heading. Keep the switcher for parallel work (or a background task) where
  // it provides an actual task-switching affordance.
  if (!runs.length || (inline && runs.length === 1 && runs[0]?.id === activeTaskId)) return null

  const stop = (id: string): void => {
    if (!onStop || !ready || stoppingId) return
    setStoppingId(id)
    void onStop(id)
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setStoppingId(null))
  }

  return (
    <div className={`work-run-list${inline ? ' work-run-list--inline' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="work-run-list__trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`查看运行中的任务，共 ${runs.length} 项`}
        title="查看运行中的任务"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="work-run-list__pulse" aria-hidden="true" />
        <span className="work-run-list__label">{inline ? '后台' : '运行中'}</span>
        <b className="work-run-list__count" aria-live="polite" aria-atomic="true">{runs.length}</b>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} />
      </button>
      {open && (
        <section className="work-run-list__popover" role="dialog" aria-label="运行列表">
          <header className="work-run-list__header">
            <strong>运行列表</strong>
            <span>{runs.length} 项任务</span>
          </header>
          <ul className="work-run-list__items">
            {runs.map((run) => (
              <li key={run.id} className="work-run-list__item">
                <button
                  type="button"
                  className={`work-run-list__item-main${run.id === activeTaskId ? ' is-active' : ''}`}
                  onClick={() => {
                    onSelect(run.id)
                    setOpen(false)
                  }}
                >
                  <span
                    className={`work-run-list__status work-run-list__status--${run.status}`}
                    aria-hidden="true"
                  >
                    <Icon name={run.status === 'running' ? 'engine' : 'circle-dot'} size={14} />
                  </span>
                  <span className="work-run-list__item-copy">
                    <strong title={run.title}>{run.title}</strong>
                    <span title={run.workspacePath ?? undefined}>
                      {runStatusLabel(run.status)} · 已运行 {formatElapsed(run.runStartedAt ?? run.updatedAt, now)} ·{' '}
                      {run.workspacePath
                        ? run.workspacePath.split(/[\\/]/).filter(Boolean).at(-1)
                        : '独立任务'}
                    </span>
                  </span>
                </button>
                {onStop && run.status === 'running' && (
                  <button
                    type="button"
                    className="work-run-list__stop"
                    aria-label={`停止任务：${run.title}`}
                    title="停止任务"
                    disabled={!ready || stoppingId !== null}
                    onClick={(event) => {
                      event.stopPropagation()
                      stop(run.id)
                    }}
                  >
                    <Icon name="stop" size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
