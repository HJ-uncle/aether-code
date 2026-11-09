import { memo, useRef, useState, type JSX } from 'react'
import { ContextMenu, type ContextMenuItem } from '@renderer/workbench/ContextMenu'
import { Dialog } from '@renderer/workbench/Dialog'
import { PromptDialog } from '@renderer/workbench/PromptDialog'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { toast } from '@renderer/core/toast'
import type { WorkTask, WorkTaskLabelColor } from './work-state'
import { WORK_TASK_COLORS, workSidebarStatus } from './work-sidebar-task'
import { workTaskCopyMenu } from './work-conversation-reference'
import { useWorkOpenWithMenu } from './useWorkOpenWithMenu'
import './work-sidebar-task.css'

interface SidebarController {
  ready: boolean
  renameTask: (id: string, title: string) => void
  archiveTask: (id: string, archived?: boolean) => void
  stopTask: (id: string) => Promise<void>
  exportTask: (id: string) => Promise<string>
  addConversationReference: (id: string) => Promise<void>
  setTaskPinned: (id: string, pinned: boolean) => void
  setTaskLabelColor: (id: string, color: WorkTaskLabelColor | undefined) => void
}

export const WorkSidebarTask = memo(function WorkSidebarTask({ task, controller, selected, onOpen }: {
  task: WorkTask
  controller: SidebarController
  selected: boolean
  onOpen: (id: string) => void
}): JSX.Element {
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null)
  const taskButtonRef = useRef<HTMLButtonElement>(null)
  const [renaming, setRenaming] = useState(false)
  const [labeling, setLabeling] = useState(false)
  const [busy, setBusy] = useState<'stop' | 'export' | 'reference' | null>(null)
  const busyRef = useRef(false)
  const openWithMenu = useWorkOpenWithMenu(task)
  const status = workSidebarStatus(task, controller.ready, busy === 'stop')
  const active = task.status === 'running' || task.status === 'waiting'
  const label = WORK_TASK_COLORS.find(item => item.color === task.labelColor)?.label
  const description = [task.title, status.label, task.pinned && '已置顶', label && `${label}标记`].filter(Boolean).join(' · ')
  const perform = (kind: 'stop' | 'export' | 'reference', operation: () => Promise<unknown>): void => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(kind)
    void operation().catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
      .finally(() => { busyRef.current = false; setBusy(null) })
  }
  const items: ContextMenuItem[] = [
    ...(active ? [{ id: 'stop', label: busy === 'stop' ? '正在停止…' : '停止任务',
      disabled: !controller.ready || busy !== null, onSelect: () => perform('stop', () => controller.stopTask(task.id)) }]
      : []),
    { id: 'rename', label: '重命名任务', separatorBefore: true, onSelect: () => setRenaming(true) },
    { id: 'pin', label: task.pinned ? '取消置顶' : '置顶', onSelect: () => controller.setTaskPinned(task.id, !task.pinned) },
    { id: 'label', label: '颜色标记', onSelect: () => setLabeling(true) },
    { id: 'add-to-conversation', label: busy === 'reference' ? '正在添加…' : '添加到对话', separatorBefore: true,
      disabled: !controller.ready || busy !== null, onSelect: () => perform('reference', () => controller.addConversationReference(task.id)) },
    workTaskCopyMenu(task),
    openWithMenu,
    { id: 'export', label: '导出任务', disabled: busy !== null || !controller.ready && task.status !== 'draft',
      onSelect: () => perform('export', () => controller.exportTask(task.id)) },
    { id: 'archive', label: task.archived ? '恢复任务' : '归档任务', separatorBefore: true,
      onSelect: () => controller.archiveTask(task.id, !task.archived) }
  ]
  return <div className={`work-sidebar__task-row${task.archived ? ' work-sidebar__archived-row' : ''}`} data-task-id={task.id} data-selected={selected || undefined}
    onContextMenu={event => {
      // Portaled menu events still bubble through React; only the actual task
      // row owns the context-menu trigger, otherwise the menu can reopen itself.
      if (!event.currentTarget.contains(event.target as Node)) return
      event.preventDefault()
      event.stopPropagation()
      setMenuPosition({ x: event.clientX, y: event.clientY })
    }}
    onKeyDown={event => {
      if (!event.currentTarget.contains(event.target as Node)) return
      if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
        event.preventDefault()
        event.stopPropagation()
        const rect = event.currentTarget.getBoundingClientRect()
        setMenuPosition({ x: rect.left, y: rect.bottom + 4 })
      }
    }}>
    <button ref={taskButtonRef} type="button" className="work-sidebar__task" title={description} aria-label={description}
      aria-haspopup="menu" aria-expanded={Boolean(menuPosition)} aria-keyshortcuts="Shift+F10"
      aria-current={selected ? 'true' : undefined} onClick={() => onOpen(task.id)}>
      {label ? <i className="work-task-label-dot" data-label-color={task.labelColor} aria-hidden="true" /> : null}
      <span className="work-sidebar__task-title">{task.title}</span>
      {task.pinned ? <span className="work-sidebar__pin" aria-hidden="true"><Icon name="pin" size={12} /></span> : null}
      <span className="work-sidebar__task-status" data-task-status={status.kind} role="img" aria-label={status.label} title={status.label}>
        {status.active ? <Spinner size={14} /> : <Icon name={status.icon!} size={14} />}
      </span>
    </button>
    {menuPosition ? <ContextMenu x={menuPosition.x} y={menuPosition.y} anchor={taskButtonRef.current}
      items={items} onClose={() => setMenuPosition(null)} /> : null}
    {renaming ? <PromptDialog title="重命名任务" label="任务名称" initialValue={task.title}
      onConfirm={title => controller.renameTask(task.id, title)} onClose={() => setRenaming(false)} /> : null}
    {labeling ? <Dialog title="颜色标记" width={320} onClose={() => setLabeling(false)}>
      <div className="work-task-label-options" role="group" aria-label="任务颜色标记">
        {WORK_TASK_COLORS.map(item => <button key={item.color} type="button" data-label-color={item.color}
          aria-pressed={task.labelColor === item.color} onClick={() => { controller.setTaskLabelColor(task.id, item.color); setLabeling(false) }}>
          <i className="work-task-label-dot" aria-hidden="true" /><span>{item.label}</span>
          {task.labelColor === item.color ? <Icon name="check" size={14} /> : null}
        </button>)}
        <button type="button" onClick={() => { controller.setTaskLabelColor(task.id, undefined); setLabeling(false) }}>清除标记</button>
      </div>
    </Dialog> : null}
  </div>
})
