import type { IconName } from '@renderer/ui/icons'
import type { SessionTask, SessionTaskLabelColor } from './state'
import { sessionDependencyProgress } from './dependency-progress'
import { sessionTaskWaitingStatus } from '../conversation/waiting-status'

export const SESSION_TASK_COLORS: ReadonlyArray<{ color: SessionTaskLabelColor; label: string }> = [
  { color: 'red', label: '红色' }, { color: 'orange', label: '橙色' }, { color: 'yellow', label: '黄色' },
  { color: 'green', label: '绿色' }, { color: 'blue', label: '蓝色' }, { color: 'purple', label: '紫色' }
]

export interface SessionSidebarStatus { kind: string; label: string; icon?: IconName; active?: boolean }
export function sessionSidebarStatus(task: SessionTask, ready: boolean, stopping = false): SessionSidebarStatus {
  const active = task.status === 'running' || task.status === 'waiting'
  if (stopping) return { kind: 'stopping', label: '正在停止', active: true }
  if (!ready && active) return { kind: 'disconnected', label: '连接中断，等待恢复确认', icon: 'alert-circle' }
  if (task.status === 'waiting') return sessionTaskWaitingStatus(task)
  if (task.status === 'running') {
    const progress = task.activity?.status === 'running' ? sessionDependencyProgress({ status: 'running', activity: task.activity.execution }) : undefined
    return { kind: 'running', label: progress?.accessibleLabel ?? '运行中', active: true }
  }
  return {
    done: { kind: 'done', label: '已完成' },
    error: { kind: 'error', label: '执行失败', icon: 'alert-circle' },
    interrupted: { kind: 'interrupted', label: '执行已中断', icon: 'alert-circle' },
    stopped: { kind: 'stopped', label: '已停止' },
    draft: { kind: 'draft', label: '草稿', icon: 'pencil' }
  }[task.status] as SessionSidebarStatus
}

/** Pinning is a reading preference; process activity never displaces pinned rows. */
export function sortSessionSidebarTasks(tasks: readonly SessionTask[]): SessionTask[] {
  return [...tasks].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
    Math.max(b.runStartedAt ?? 0, b.updatedAt) - Math.max(a.runStartedAt ?? 0, a.updatedAt) || b.createdAt - a.createdAt)
}
