import { memo, useRef, useState, type JSX } from 'react'
import { ActionMenu, type ActionMenuItem } from '@renderer/workbench/ActionMenu'
import { Dialog } from '@renderer/workbench/Dialog'
import { PromptDialog } from '@renderer/workbench/PromptDialog'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { toast } from '@renderer/core/toast'
import type { WorkTask, WorkTaskLabelColor } from './work-state'
import { WORK_TASK_COLORS, workSidebarStatus } from './work-sidebar-task'
import './work-sidebar-task.css'

interface SidebarController {
  ready: boolean
  renameTask: (id: string, title: string) => void
  archiveTask: (id: string, archived?: boolean) => void
  continueTask: (id: string) => void
  stopTask: (id: string) => Promise<void>
  exportTask: (id: string) => Promise<string>
  setTaskPinned: (id: string, pinned: boolean) => void
  setTaskLabelColor: (id: string, color: WorkTaskLabelColor | undefined) => void
}

export const WorkSidebarTask = memo(function WorkSidebarTask({ task, controller, selected, onOpen }: {
  task: WorkTask
  controller: SidebarController
  selected: boolean
  onOpen: (id: string) => void
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [labeling, setLabeling] = useState(false)
  const [busy, setBusy] = useState<'stop' | 'export' | null>(null)
  const busyRef = useRef(false)
  const status = workSidebarStatus(task, controller.ready, busy === 'stop')
  const active = task.status === 'running' || task.status === 'waiting'
  const label = WORK_TASK_COLORS.find(item => item.color === task.labelColor)?.label
  const description = [task.title, status.label, task.pinned && '已置顶', label && `${label}标记`].filter(Boolean).join(' · ')
  const perform = (kind: 'stop' | 'export', operation: () => Promise<unknown>): void => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(kind)
    void operation().catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
      .finally(() => { busyRef.current = false; setBusy(null) })
  }
  const items: ActionMenuItem[] = [
    { id: 'pin', label: task.pinned ? '取消置顶' : '置顶', icon: 'pin', onSelect: () => controller.setTaskPinned(task.id, !task.pinned) },
    { id: 'rename', label: '重命名任务', icon: 'pencil', onSelect: () => setRenaming(true) },
    { id: 'label', label: '颜色标记', icon: 'palette', onSelect: () => setLabeling(true) },
    ...(active ? [{ id: 'stop', label: busy === 'stop' ? '正在停止…' : '停止任务', icon: 'stop' as const,
      disabled: !controller.ready || busy !== null, separatorBefore: true, onSelect: () => perform('stop', () => controller.stopTask(task.id)) }]
      : [{ id: 'continue', label: '继续任务', icon: 'play' as const, separatorBefore: true, onSelect: () => { controller.continueTask(task.id); onOpen(task.id) } }]),
    { id: 'archive', label: task.archived ? '恢复任务' : '归档任务', icon: 'package-variant-closed',
      onSelect: () => controller.archiveTask(task.id, !task.archived) },
    { id: 'export', label: '导出任务', icon: 'upload-outline', disabled: busy !== null || !controller.ready && task.status !== 'draft',
      onSelect: () => perform('export', () => controller.exportTask(task.id)) }
  ]
  return <div className={`work-sidebar__task-row${task.archived ? ' work-sidebar__archived-row' : ''}`} data-task-id={task.id} data-selected={selected || undefined}
    onContextMenu={event => {
      if (!event.currentTarget.contains(event.target as Node)) return
      event.preventDefault(); setMenuOpen(true)
    }}
    onKeyDown={event => {
      if (!event.currentTarget.contains(event.target as Node)) return
      if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
        event.preventDefault(); setMenuOpen(true)
      }
    }}>
    <button type="button" className="work-sidebar__task" title={description} aria-label={description}
      aria-current={selected ? 'true' : undefined} onClick={() => onOpen(task.id)}>
      {label ? <i className="work-task-label-dot" data-label-color={task.labelColor} aria-hidden="true" /> : null}
      <span className="work-sidebar__task-title">{task.title}</span>
      {task.pinned ? <span className="work-sidebar__pin" aria-hidden="true"><Icon name="pin" size={12} /></span> : null}
      <span className="work-sidebar__task-status" data-task-status={status.kind} role="img" aria-label={status.label} title={status.label}>
        {status.active ? <Spinner size={14} /> : <Icon name={status.icon!} size={14} />}
      </span>
    </button>
    <ActionMenu label={`${task.title} 更多操作`} className="work-sidebar__task-menu" items={items} open={menuOpen} onOpenChange={setMenuOpen} />
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
