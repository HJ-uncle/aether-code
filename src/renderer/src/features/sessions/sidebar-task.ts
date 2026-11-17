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

export interface ProjectSidebarStatus extends SessionSidebarStatus {
  /** Number of sessions sharing the most urgent state, not pending requests. */
  count: number
  detail: string
}

/** Summarize the full project, including sessions outside the visible page. */
export function projectSidebarStatus(tasks: readonly SessionTask[], ready: boolean, options: { includeArchived?: boolean } = {}): ProjectSidebarStatus | undefined {
  const waiting: SessionSidebarStatus[] = []
  const counts = new Map<string, { status: SessionSidebarStatus; count: number }>()
  for (const task of tasks) {
    if (task.archived && !options.includeArchived) continue
    let status = sessionSidebarStatus(task, ready)
    if (status.kind === 'done' && task.completionUnread) status = { kind: 'unread', label: '已完成，未查看' }
    if (['done', 'stopped', 'draft'].includes(status.kind)) continue
    if (status.kind === 'permission' || status.kind === 'question') waiting.push(status)
    // Dependency progress belongs to each session; the project counts running
    // sessions without suggesting that their different progress can be summed.
    if (status.kind === 'running') status = { ...status, label: '运行中' }
    const key = status.kind + ':' + status.label
    const previous = counts.get(key)
    if (previous) previous.count++
    else counts.set(key, { status, count: 1 })
  }
  const priority = ['permission', 'question', 'disconnected', 'running', 'error', 'interrupted', 'unread']
  const states = [...counts.values()].sort((a, b) => priority.indexOf(a.status.kind) - priority.indexOf(b.status.kind) || a.status.label.localeCompare(b.status.label, 'zh-CN'))
  if (!states.length) return undefined
  const detail = states.map(({ status, count }) => `${status.label} · ${count} 个会话`).join('；')
  if (waiting.length) {
    const permission = waiting.some(status => status.kind === 'permission')
    const question = waiting.some(status => status.label === '等你补充' || status.label === '待授权与补充')
    return {
      kind: permission ? 'permission' : 'question',
      label: permission ? question ? '待授权与补充' : '待授权' : question ? '等你补充' : '待处理',
      icon: permission ? 'shield' : 'chat', count: waiting.length, detail
    }
  }
  return { ...states[0].status, count: states[0].count, detail }
}

/** Pinning is a reading preference; process activity never displaces pinned rows. */
export function sortSessionSidebarTasks(tasks: readonly SessionTask[]): SessionTask[] {
  return [...tasks].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
    Math.max(b.runStartedAt ?? 0, b.updatedAt) - Math.max(a.runStartedAt ?? 0, a.updatedAt) || b.createdAt - a.createdAt)
}
