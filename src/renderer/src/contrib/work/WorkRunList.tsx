import { useEffect, useMemo, useState, type JSX } from 'react'
import { Icon } from '@renderer/workbench/icons'
import { useMotionPresence } from '@renderer/workbench/MotionPresence'
import { Popover } from '@renderer/workbench/Popover'
import { toast } from '@renderer/core/toast'
import type { WorkTask } from './work-state'
import { getRunningWorkTasks } from './work-run-list'
import { workSidebarStatus } from './work-sidebar-task'

export { getRunningWorkTasks } from './work-run-list'

interface WorkRunListProps {
  tasks: readonly WorkTask[]
  activeTaskId: string | null
  ready: boolean
  onSelect: (id: string) => void
  onStop?: (id: string) => Promise<void>
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
 * The new-task home hosts this cross-conversation list. Conversation headings
 * retain only their own status and actions, and the sidebar stays compact.
 */
export function WorkRunList({
  tasks,
  activeTaskId,
  ready,
  onSelect,
  onStop
}: WorkRunListProps): JSX.Element | null {
  const runs = useMemo(() => getRunningWorkTasks(tasks), [tasks])
  const [open, setOpen] = useState(false)
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)
  const shown = runs.length > 0
  const presence = useMotionPresence(shown)

  useEffect(() => {
    if (!shown) {
      // A later run must not reopen a popover left open by the last task.
      setOpen(false)
      return
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [shown])

  if (!presence.present) return null

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
    <div className="work-run-list" {...presence.motionProps}>
      <Popover open={open && shown} onOpenChange={setOpen} align="end" width={360} label="运行列表" panelClassName="work-run-list__popover" flush
        trigger={() => (
      <button
        type="button"
        className="work-run-list__trigger"
        aria-expanded={open && shown}
        aria-haspopup="dialog"
        aria-label={`查看运行列表，共 ${runs.length} 项任务`}
        title="所有会话的运行和待处理任务"
      >
        <Icon name="list-play" size={16} />
        <span className="work-run-list__label">运行列表</span>
        <b className="work-run-list__count" aria-hidden="true">{runs.length}</b>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} />
      </button>
        )}>
          <header className="work-run-list__header">
            <strong>运行列表</strong>
            <span>所有会话 · {runs.length} 项任务</span>
          </header>
          <ul className="work-run-list__items">
            {runs.map((run) => (
              <li key={run.id} className="work-run-list__item">
                <button
                  type="button"
                  className={`work-run-list__item-main${run.id === activeTaskId ? ' is-active' : ''}`}
                  aria-current={run.id === activeTaskId ? 'true' : undefined}
                  onClick={() => {
                    onSelect(run.id)
                    setOpen(false)
                  }}
                >
                  <span
                    className={`work-run-list__status work-run-list__status--${run.status}`}
                    aria-hidden="true"
                  >
                    <Icon name={workSidebarStatus(run, ready, stoppingId === run.id).icon ?? 'activity'} size={14} />
                  </span>
                  <span className="work-run-list__item-copy">
                    <strong title={run.title}>{run.title}</strong>
                    <span title={run.workspacePath ?? undefined}>
                      {workSidebarStatus(run, ready, stoppingId === run.id).label} · 已运行 {formatElapsed(run.runStartedAt ?? run.updatedAt, now)} ·{' '}
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
      </Popover>
    </div>
  )
}
