import { useEffect, useState, type JSX } from 'react'
import { toast } from '@renderer/core/toast'
import type { WorkTask } from './work-state'
import { ActionMenu } from '@renderer/workbench/ActionMenu'

type Controller = {
  renameTask: (id: string, title: string) => void
  archiveTask: (id: string, archived?: boolean) => void
  continueTask: (id: string) => void
  stopTask: (id: string) => Promise<void>
  exportTask: (id: string) => Promise<string>
}

/** Task actions are deliberately plain buttons so keyboard users get the same
 * operations as pointer users and a future task list can reuse the controller. */
export function WorkTaskActions({
  task,
  controller,
  compact = false,
  showStop = true
}: {
  task: WorkTask
  controller: Controller
  compact?: boolean
  showStop?: boolean
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(task.title)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setEditing(false)
    setTitle(task.title)
  }, [task.id, task.title])
  const active = task.status === 'running' || task.status === 'waiting'
  const runAction = (action: () => Promise<unknown>): void => {
    if (busy) return
    setBusy(true)
    void action().catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error))
    }).finally(() => setBusy(false))
  }
  const commit = (): void => {
    try {
      controller.renameTask(task.id, title)
      setEditing(false)
    } catch {
      setTitle(task.title)
    }
  }
  return (
    <div className="work-task-actions" role="group" aria-label={`${task.title} 操作`}>
      {editing ? (
        <input
          aria-label="任务名称"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') setEditing(false)
          }}
          onBlur={commit}
          autoFocus
        />
      ) : !compact ? (
        <button type="button" onClick={() => setEditing(true)} aria-label="重命名任务">
          重命名
        </button>
      ) : null}
      {compact ? <ActionMenu label="任务更多操作" disabled={busy} items={[
        { id: 'rename', label: '重命名任务', onSelect: () => setEditing(true) },
        ...(active ? showStop ? [{ id: 'stop', label: '停止任务', onSelect: () => runAction(() => controller.stopTask(task.id)) }] : []
          : [{ id: 'continue', label: '继续任务', onSelect: () => controller.continueTask(task.id) }]),
        { id: 'archive', label: task.archived ? '恢复任务' : '归档任务', onSelect: () => controller.archiveTask(task.id, !task.archived) },
        { id: 'export', label: '导出任务', onSelect: () => runAction(() => controller.exportTask(task.id)) }
      ]} /> : <>
      {active && showStop ? (
        <button type="button" disabled={busy} onClick={() => runAction(() => controller.stopTask(task.id))} aria-label="停止任务">
          停止
        </button>
      ) : !active ? (
        <button type="button" onClick={() => controller.continueTask(task.id)} aria-label="继续任务">
          继续
        </button>
      ) : null}
      <button type="button" onClick={() => controller.archiveTask(task.id, !task.archived)}>
        {task.archived ? '恢复' : '归档'}
      </button>
      <button type="button" disabled={busy} onClick={() => runAction(() => controller.exportTask(task.id))}>导出</button>
      </>}
    </div>
  )
}

