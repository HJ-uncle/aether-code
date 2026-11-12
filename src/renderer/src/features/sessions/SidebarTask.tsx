import { memo, useRef, useState, type JSX } from 'react'
import { ContextMenu } from '@renderer/ui/ContextMenu'
import { Icon } from '@renderer/ui/icons'
import { Spinner } from '@renderer/ui/ui-primitives'
import type { SessionTask } from './state'
import { SESSION_TASK_COLORS, sessionSidebarStatus } from './sidebar-task'
import { useSessionTaskActions, type SessionTaskActionController } from './useSessionTaskActions'
import './sidebar-task.css'

export const SidebarTask = memo(function SidebarTask({ task, controller, selected, onOpen }: {
  task: SessionTask
  controller: SessionTaskActionController
  selected: boolean
  onOpen: (id: string) => void
}): JSX.Element {
  const [menuPosition, setMenuPosition] = useState<{ id: number; x: number; y: number } | null>(null)
  const menuSequence = useRef(0)
  const taskButtonRef = useRef<HTMLButtonElement>(null)
  const { items, dialogs, busy } = useSessionTaskActions(task, controller)
  const status = sessionSidebarStatus(task, controller.ready, busy === 'stop')
  const unread = task.status === 'done' && task.completionUnread === true
  const showStatus = status.kind !== 'draft' && (task.status !== 'done' || unread)
  const statusLabel = unread ? '已完成，未查看' : status.label
  const statusText: Record<string, string> = {
    permission: status.label, question: status.label,
    error: '失败', interrupted: '已中断', disconnected: '连接中断', stopped: '已停止'
  }
  const label = SESSION_TASK_COLORS.find(item => item.color === task.labelColor)?.label
  const description = [task.title, showStatus && statusLabel, task.pinned && '已置顶', label && `${label}标记`].filter(Boolean).join(' · ')
  return <div className={`work-sidebar__task-row${task.archived ? ' work-sidebar__archived-row' : ''}`} data-task-id={task.id}
    data-selected={selected || undefined} data-unread={unread || undefined} data-menu-open={Boolean(menuPosition) || undefined}
    onContextMenu={event => {
      // Portaled menu events still bubble through React; only the actual task
      // row owns the context-menu trigger, otherwise the menu can reopen itself.
      if (!event.currentTarget.contains(event.target as Node)) return
      event.preventDefault()
      event.stopPropagation()
      setMenuPosition({ id: ++menuSequence.current, x: event.clientX, y: event.clientY })
    }}
    onKeyDown={event => {
      if (!event.currentTarget.contains(event.target as Node)) return
      if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
        event.preventDefault()
        event.stopPropagation()
        const rect = event.currentTarget.getBoundingClientRect()
        setMenuPosition({ id: ++menuSequence.current, x: rect.left, y: rect.bottom + 4 })
      }
    }}>
    <button ref={taskButtonRef} type="button" className="work-sidebar__task" title={description} aria-label={description}
      aria-haspopup="menu" aria-expanded={Boolean(menuPosition)} aria-keyshortcuts="Shift+F10"
      aria-current={selected ? 'true' : undefined} onClick={() => onOpen(task.id)}>
      {label ? <i className="work-task-label-dot" data-label-color={task.labelColor} aria-hidden="true" /> : null}
      <span className="work-sidebar__task-title">{task.title}</span>
      {task.pinned ? <span className="work-sidebar__pin" aria-hidden="true"><Icon name="pin" size={15} className="work-sidebar__pin-icon" /></span> : null}
      {showStatus ? <span className="work-sidebar__task-status" data-task-status={status.kind}
        data-text-status={Boolean(statusText[status.kind]) || undefined} role="img" aria-label={statusLabel} title={statusLabel}>
        {unread ? <i className="work-sidebar__completion-dot" aria-hidden="true" />
          : status.active ? <Spinner size={14} /> : statusText[status.kind]}
      </span> : null}
    </button>
    <div className="work-sidebar__task-actions" aria-label={`${task.title}的操作`}>
      <button type="button" title={task.pinned ? '取消置顶' : '置顶'} aria-label={task.pinned ? '取消置顶' : '置顶'}
        aria-pressed={Boolean(task.pinned)} onClick={() => controller.setTaskPinned(task.id, !task.pinned)}>
        <Icon name={task.pinned ? 'pin' : 'pin-outline'} size={15} className="work-sidebar__pin-icon" />
      </button>
    </div>
    {menuPosition ? <ContextMenu key={menuPosition.id} x={menuPosition.x} y={menuPosition.y} anchor={taskButtonRef.current}
      items={items} onClose={() => setMenuPosition(current => current?.id === menuPosition.id ? null : current)} /> : null}
    {dialogs}
  </div>
})
