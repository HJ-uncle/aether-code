import type { IconName } from '@renderer/workbench/icons'
import type { WorkTask, WorkTaskLabelColor } from './work-state'

export const WORK_TASK_COLORS: ReadonlyArray<{ color: WorkTaskLabelColor; label: string }> = [
  { color: 'red', label: '红色' }, { color: 'orange', label: '橙色' }, { color: 'yellow', label: '黄色' },
  { color: 'green', label: '绿色' }, { color: 'blue', label: '蓝色' }, { color: 'purple', label: '紫色' }
]

export interface WorkSidebarStatus { kind: string; label: string; icon?: IconName; active?: boolean }
export function workSidebarStatus(task: WorkTask, ready: boolean, stopping = false): WorkSidebarStatus {
  const active = task.status === 'running' || task.status === 'waiting'
  if (stopping) return { kind: 'stopping', label: '正在停止', active: true }
  if (!ready && active) return { kind: 'disconnected', label: '连接中断，等待恢复确认', icon: 'warning' }
  if (task.status === 'waiting') {
    const activity = task.activity?.status === 'waiting' ? task.activity : undefined
    if (activity?.pendingPermission) return { kind: 'permission', label: activity.pendingAsk ? '等待授权与回答' : '等待授权', icon: 'shield' }
    return { kind: 'question', label: activity?.pendingAsk ? '等待回答' : '等待处理', icon: 'chat' }
  }
  if (task.status === 'running') return { kind: 'running', label: '运行中', active: true }
  return {
    done: { kind: 'done', label: '已完成', icon: 'check' },
    error: { kind: 'error', label: '执行失败', icon: 'warning' },
    interrupted: { kind: 'interrupted', label: '执行已中断', icon: 'warning' },
    stopped: { kind: 'stopped', label: '已停止', icon: 'stop' },
    draft: { kind: 'draft', label: '草稿', icon: 'pencil' }
  }[task.status] as WorkSidebarStatus
}

/** Pinning is a reading preference; process activity never displaces pinned rows. */
export function sortWorkSidebarTasks(tasks: readonly WorkTask[]): WorkTask[] {
  return [...tasks].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
    Math.max(b.runStartedAt ?? 0, b.updatedAt) - Math.max(a.runStartedAt ?? 0, a.updatedAt) || b.createdAt - a.createdAt)
}
