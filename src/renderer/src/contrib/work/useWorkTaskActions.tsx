import { useRef, useState, type ReactNode } from 'react'
import type { ContextMenuItem } from '@renderer/workbench/ContextMenu'
import { Dialog } from '@renderer/workbench/Dialog'
import { PromptDialog } from '@renderer/workbench/PromptDialog'
import { Icon } from '@renderer/workbench/icons'
import { toast } from '@renderer/core/toast'
import type { WorkTask, WorkTaskLabelColor } from './work-state'
import { WORK_TASK_COLORS } from './work-sidebar-task'
import { workTaskCopyMenu } from './work-conversation-reference'
import { useWorkOpenWithMenu } from './useWorkOpenWithMenu'
import './work-sidebar-task.css'

export interface WorkTaskActionController {
  ready: boolean
  renameTask: (id: string, title: string) => void
  archiveTask: (id: string, archived?: boolean) => void
  deleteTask: (id: string) => Promise<void>
  stopTask: (id: string) => Promise<void>
  exportTask: (id: string) => Promise<string>
  addConversationReference: (id: string) => Promise<void>
  setTaskPinned: (id: string, pinned: boolean) => void
  setTaskLabelColor: (id: string, color: WorkTaskLabelColor | undefined) => void
}

type Action = 'stop' | 'export' | 'reference' | 'delete'

/** Every task surface uses the same operations against its own task, without
 * selecting that conversation just to open a menu. */
export function useWorkTaskActions(task: WorkTask, controller: WorkTaskActionController, options: {
  showStop?: boolean
  onRename?: () => void
  extraItems?: ContextMenuItem[]
} = {}): { items: ContextMenuItem[]; dialogs: ReactNode; busy: Action | null } {
  const [renaming, setRenaming] = useState(false)
  const [labeling, setLabeling] = useState(false)
  const [busy, setBusy] = useState<Action | null>(null)
  const busyRef = useRef(false)
  const openWithMenu = useWorkOpenWithMenu(task)
  const active = task.status === 'running' || task.status === 'waiting'
  const perform = (kind: Action, operation: () => Promise<unknown>): void => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(kind)
    void operation().catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
      .finally(() => { busyRef.current = false; setBusy(null) })
  }
  const items: ContextMenuItem[] = [
    ...(active && options.showStop !== false ? [{ id: 'stop', label: busy === 'stop' ? '正在停止…' : '停止任务',
      disabled: !controller.ready || busy !== null, onSelect: () => perform('stop', () => controller.stopTask(task.id)) }] : []),
    { id: 'rename', label: '重命名任务', separatorBefore: active && options.showStop !== false,
      onSelect: options.onRename ?? (() => setRenaming(true)) },
    { id: 'pin', label: task.pinned ? '取消置顶' : '置顶', onSelect: () => controller.setTaskPinned(task.id, !task.pinned) },
    { id: 'label', label: '颜色标记', onSelect: () => setLabeling(true) },
    ...(options.extraItems ?? []),
    { id: 'add-to-conversation', label: busy === 'reference' ? '正在添加…' : '添加到对话', separatorBefore: true,
      disabled: !controller.ready || busy !== null, onSelect: () => perform('reference', () => controller.addConversationReference(task.id)) },
    workTaskCopyMenu(task),
    openWithMenu,
    { id: 'export', label: '导出任务', disabled: busy !== null || !controller.ready && task.status !== 'draft',
      onSelect: () => perform('export', () => controller.exportTask(task.id)) },
    { id: 'archive', label: task.archived ? '恢复任务' : '归档任务', separatorBefore: true,
      onSelect: () => controller.archiveTask(task.id, !task.archived) },
    { id: 'delete', label: busy === 'delete' ? '正在删除…' : '删除任务', danger: true, disabled: busy !== null,
      onSelect: () => perform('delete', () => controller.deleteTask(task.id)) }
  ]
  const dialogs = <>
    {renaming && <PromptDialog title="重命名任务" label="任务名称" initialValue={task.title}
      onConfirm={title => controller.renameTask(task.id, title)} onClose={() => setRenaming(false)} />}
    {labeling && <Dialog title="颜色标记" width={320} onClose={() => setLabeling(false)}>
      <div className="work-task-label-options" role="group" aria-label="任务颜色标记">
        {WORK_TASK_COLORS.map(item => <button key={item.color} type="button" data-label-color={item.color}
          aria-pressed={task.labelColor === item.color} onClick={() => { controller.setTaskLabelColor(task.id, item.color); setLabeling(false) }}>
          <i className="work-task-label-dot" aria-hidden="true" /><span>{item.label}</span>
          {task.labelColor === item.color ? <Icon name="check" size={14} /> : null}
        </button>)}
        <button type="button" onClick={() => { controller.setTaskLabelColor(task.id, undefined); setLabeling(false) }}>清除标记</button>
      </div>
    </Dialog>}
  </>
  return { items, dialogs, busy }
}
