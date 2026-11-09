import { useEffect, useState, type JSX } from 'react'
import { toast } from '@renderer/core/toast'
import type { WorkTask } from './work-state'
import { WorkTaskMenu } from './WorkTaskMenu'
import { workTaskCopyMenu } from './work-conversation-reference'
import { useWorkOpenWithMenu } from './useWorkOpenWithMenu'

type Controller = {
  ready: boolean
  renameTask: (id: string, title: string) => void
  archiveTask: (id: string, archived?: boolean) => void
  stopTask: (id: string) => Promise<void>
  exportTask: (id: string) => Promise<string>
  addConversationReference: (id: string) => Promise<void>
}

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
  controller: Controller
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
  const openWithMenu = useWorkOpenWithMenu(task)
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
      {compact ? <WorkTaskMenu key={task.id} label="任务更多操作" disabled={busy} items={[
        ...(active && showStop ? [{ id: 'stop', label: '停止任务', onSelect: () => runAction(() => controller.stopTask(task.id)) }] : []),
        { id: 'rename', label: '重命名任务', separatorBefore: true, onSelect: () => setEditing(true) },
        ...(onSelectConversation ? [{
          id: 'select-conversation',
          label: conversationSelected ? '退出选择对话' : '选择对话',
          separatorBefore: true,
          onSelect: onSelectConversation,
          disabled: conversationDisabled
        }] : []),
        { id: 'add-to-conversation', label: '添加到对话', separatorBefore: !onSelectConversation, disabled: !controller.ready,
          onSelect: () => runAction(() => controller.addConversationReference(task.id)) },
        workTaskCopyMenu(task),
        openWithMenu,
        { id: 'export', label: '导出任务', onSelect: () => runAction(() => controller.exportTask(task.id)) },
        { id: 'archive', label: task.archived ? '恢复任务' : '归档任务', separatorBefore: true, onSelect: () => controller.archiveTask(task.id, !task.archived) }
      ]} /> : <>
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
      </>}
    </div>
  )
}

