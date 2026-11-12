import type { CommandJobSnapshot } from '@shared/command-job'
import { commandJobActive, commandJobDisplayLabel, commandJobInvocation, mergeCommandJob } from '../../core/engine/command-job-state'

/** Runtime callbacks belong to the contribution owner and are withdrawn on unload. */
export interface ServiceContribution {
  id: string
  pluginId: string
  instanceId: string
  revision: number
  label: string
  status: 'idle' | 'running' | 'waiting' | 'completed' | 'stopped' | 'error'
  detail?: string
  updatedAt: number
  sessionId?: string
  open?: () => void | Promise<void>
  stop?: () => Promise<void>
}

export interface ServiceItem {
  id: string
  kind: 'command' | 'plugin'
  label: string
  detail: string
  status: string
  statusLabel: string
  active: boolean
  attention: boolean
  tone: 'quiet' | 'active' | 'warning' | 'error'
  updatedAt: number
  revision: number
  job?: CommandJobSnapshot
  contribution?: ServiceContribution
}

const pluginLabels: Record<ServiceContribution['status'], string> = {
  idle: '未运行', running: '运行中', waiting: '等待处理', completed: '已完成', stopped: '已停止', error: '失败'
}

/** A terminal snapshot cannot be revived by a late running event from the same job. */
export function buildServiceItems(jobs: readonly CommandJobSnapshot[], sessionId: string, contributions: readonly ServiceContribution[] = []): ServiceItem[] {
  const commands = new Map<string, CommandJobSnapshot>()
  for (const job of jobs) {
    if (!job.background || job.sessionId !== sessionId) continue
    commands.set(job.jobId, mergeCommandJob(commands.get(job.jobId), job))
  }
  const items: ServiceItem[] = [...commands.values()].map(job => ({
    id: `command:${job.jobId}`, kind: 'command', label: commandJobInvocation(job),
    detail: job.error?.message ?? job.cwd, status: job.status, statusLabel: commandJobDisplayLabel(job),
    active: commandJobActive(job), attention: !['running', 'cancelling'].includes(job.status),
    tone: ['failed', 'timed_out', 'interrupted'].includes(job.status) ? 'error' : commandJobActive(job) ? 'active' : 'quiet',
    updatedAt: job.updatedAt, revision: job.version, job
  }))
  const plugins = new Map<string, ServiceContribution>()
  for (const contribution of contributions) {
    if (contribution.sessionId && contribution.sessionId !== sessionId) continue
    const id = JSON.stringify([contribution.instanceId, contribution.id])
    const previous = plugins.get(id)
    if (!previous || contribution.revision > previous.revision || contribution.revision === previous.revision && contribution.updatedAt > previous.updatedAt) plugins.set(id, contribution)
  }
  for (const [id, contribution] of plugins) items.push({
    id: `plugin:${id}`, kind: 'plugin', label: contribution.label, detail: contribution.detail ?? '',
    status: contribution.status, statusLabel: pluginLabels[contribution.status],
    active: contribution.status === 'running' || contribution.status === 'waiting',
    attention: ['waiting', 'completed', 'stopped', 'error'].includes(contribution.status),
    tone: contribution.status === 'error' ? 'error' : contribution.status === 'waiting' ? 'warning' : contribution.status === 'running' ? 'active' : 'quiet',
    updatedAt: contribution.updatedAt, revision: contribution.revision, contribution
  })
  return items.sort((left, right) => Number(right.active) - Number(left.active) || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
}

export interface ServiceNotification {
  id: string
  serviceId: string
  label: string
  detail: string
  status: string
  statusLabel: string
  tone: ServiceItem['tone']
  updatedAt: number
  read: boolean
}
export interface ServiceNotificationState {
  observed: ReadonlyMap<string, string>
  notifications: readonly ServiceNotification[]
}
export const SERVICE_NOTIFICATION_LIMIT = 100
export const emptyServiceNotifications: ServiceNotificationState = { observed: new Map(), notifications: [] }

/** Restored history starts read. Only a newly observed status transition asks for attention. */
export function reconcileServiceNotifications(previous: ServiceNotificationState, items: readonly ServiceItem[]): ServiceNotificationState {
  const observed = new Map<string, string>()
  const current = new Map(previous.notifications.map(notification => [notification.serviceId, notification]))
  const notifications: ServiceNotification[] = []
  for (const item of items) {
    const oldStatus = previous.observed.get(item.id)
    observed.set(item.id, item.status)
    if (!item.attention) continue
    const old = current.get(item.id)
    // Dismissing a notice must survive output/revision updates of the same status.
    if (!old && oldStatus === item.status) continue
    const changed = oldStatus !== item.status
    notifications.push({
      id: changed || !old ? `${item.id}:${item.status}:${item.revision}` : old.id,
      serviceId: item.id, label: item.label.slice(0, 512), detail: item.detail.slice(0, 1024),
      status: item.status, statusLabel: item.statusLabel, tone: item.tone, updatedAt: item.updatedAt,
      read: changed || !old ? oldStatus === undefined : old.read
    })
  }
  notifications.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
  if (notifications.length > SERVICE_NOTIFICATION_LIMIT) notifications.length = SERVICE_NOTIFICATION_LIMIT
  if (observed.size === previous.observed.size && [...observed].every(([id, status]) => previous.observed.get(id) === status) &&
    notifications.length === previous.notifications.length && notifications.every((notice, index) => {
      const old = previous.notifications[index]
      return Object.keys(notice).every(key => notice[key as keyof ServiceNotification] === old[key as keyof ServiceNotification])
    })) return previous
  return { observed, notifications }
}

export function setServiceNotificationRead(state: ServiceNotificationState, serviceId: string, read = true): ServiceNotificationState {
  let changed = false
  const notifications = state.notifications.map(notification => {
    if (notification.serviceId !== serviceId || notification.read === read) return notification
    changed = true
    return { ...notification, read }
  })
  return changed ? { ...state, notifications } : state
}

export function readAllServiceNotifications(state: ServiceNotificationState): ServiceNotificationState {
  if (state.notifications.every(notification => notification.read)) return state
  return { ...state, notifications: state.notifications.map(notification => notification.read ? notification : { ...notification, read: true }) }
}

export function clearReadServiceNotifications(state: ServiceNotificationState): ServiceNotificationState {
  const notifications = state.notifications.filter(notification => !notification.read)
  return notifications.length === state.notifications.length ? state : { ...state, notifications }
}
