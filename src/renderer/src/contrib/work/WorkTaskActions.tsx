import { useEffect, useState, type JSX } from 'react'
import { toast } from '@renderer/core/toast'
import type { WorkTask } from './work-state'
import { WorkTaskMenu } from './WorkTaskMenu'
import { useWorkTaskActions, type WorkTaskActionController } from './useWorkTaskActions'

/** Task actions are deliberately plain buttons so keyboard users get the same
 * operations as pointer users and a future task list can reuse the controller. */
export function WorkTaskActions({
  task,
  controller,
  compact = false,
  showStop = true,
  onSelectConversation,
  conversationSelected = false,
  conversationDisabled = false
}: {
  task: WorkTask
  controller: WorkTaskActionController
  compact?: boolean
  showStop?: boolean
  /** Opens the task's message selection mode from the overflow menu. */
  onSelectConversation?: () => void
  conversationSelected?: boolean
  conversationDisabled?: boolean
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(task.title)
  const [busy, setBusy] = useState(false)
  const actions = useWorkTaskActions(task, controller, {
    showStop,
    onRename: () => setEditing(true),
    extraItems: onSelectConversation ? [{ id: 'select-conversation',
      label: conversationSelected ? '退出选择对话' : '选择对话', separatorBefore: true,
      onSelect: onSelectConversation, disabled: conversationDisabled }] : []
  })
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
        <input className="ui-input ui-input--compact"
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
      {compact ? <WorkTaskMenu key={task.id} label="任务更多操作" disabled={busy || actions.busy !== null} items={actions.items} /> : <>
      <button type="button" disabled={busy || !controller.ready} onClick={() => runAction(() => controller.addConversationReference(task.id))}>添加到对话</button>
      {active && showStop ? (
        <button type="button" disabled={busy} onClick={() => runAction(() => controller.stopTask(task.id))} aria-label="停止任务">
          停止
        </button>
      ) : null}
      <button type="button" onClick={() => controller.archiveTask(task.id, !task.archived)}>
        {task.archived ? '恢复' : '归档'}
      </button>
      <button type="button" disabled={busy} onClick={() => runAction(() => controller.exportTask(task.id))}>导出</button>
      <button type="button" disabled={busy} onClick={() => runAction(() => controller.deleteTask(task.id))}>删除</button>
      </>}
      {actions.dialogs}
    </div>
  )
}

