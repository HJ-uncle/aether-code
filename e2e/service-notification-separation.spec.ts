/** Targeted service/notification separation contract; no Electron or legacy UI suite. */
import { expect, test } from '@playwright/test'
import type { CommandJobSnapshot } from '../src/shared/command-job'
import { buildServiceItems, emptyServiceNotifications, getActiveServiceItems, getHistoryServiceItems, getNotificationServiceItems, getSessionServiceItems, reconcileServiceNotifications, serviceNotificationToItem, type ServiceContribution } from '../src/renderer/src/features/services/service-model'
import { getPersistedHistoryEntries, historyEntryToServiceItem, type ActivityHistoryEntry } from '../src/renderer/src/features/services/activity-history'
import { ExtensionServices } from '../src/renderer/src/features/extensions/services'
import type { ExtensionRegistration } from '../src/renderer/src/features/extensions/types'

const job = (patch: Partial<CommandJobSnapshot> = {}): CommandJobSnapshot => ({
  schemaVersion: 1, jobId: 'command', sessionId: 'task-a', ownerSessionId: 'task-a', version: 1,
  status: 'running', command: 'node', args: ['serve.js'], cwd: '/project', background: true,
  createdAt: 1, updatedAt: 1, exitCode: null, signal: null, cursor: 0, earliestCursor: 0, ...patch
})
const plugin = (patch: Partial<ServiceContribution> = {}): ServiceContribution => ({
  id: 'timer', pluginId: 'sample', instanceId: 'sample@one', revision: 1,
  label: '专注计时', status: 'running', updatedAt: 2, ...patch
})

test('服务标签只显示活动服务，后台命令终态不冒充通知', () => {
  const items = buildServiceItems([
    job({ jobId: 'running', updatedAt: 2 }),
    job({ jobId: 'stopped', status: 'cancelled', version: 2, updatedAt: 3 }),
  ], 'task-a', [plugin({ id: 'done', status: 'completed', revision: 2, updatedAt: 4 })])

  expect(getActiveServiceItems(items).map(item => item.id)).toEqual(['command:running'])
  expect(getHistoryServiceItems(items).map(item => item.id)).toEqual(['plugin:["sample@one","done"]', 'command:stopped'])
  expect(getNotificationServiceItems(items)).toHaveLength(0)
  expect(reconcileServiceNotifications(emptyServiceNotifications, getNotificationServiceItems(items)).notifications).toEqual([])

  const notice = buildServiceItems([], 'task-a', [plugin({ id: 'notice', notification: true, status: 'completed', revision: 2, updatedAt: 5 })])[0]
  expect(getNotificationServiceItems([notice]).map(item => item.id)).toEqual(['plugin:["sample@one","notice"]'])
  expect(reconcileServiceNotifications(emptyServiceNotifications, [notice]).notifications[0]).toMatchObject({ serviceId: notice.id, read: false })
})

test('服务历史只属于当前会话，全球托盘不会收到会话命令', () => {
  const items = buildServiceItems([
    job({ jobId: 'session-running', updatedAt: 2 }),
    job({ jobId: 'session-stopped', status: 'cancelled', version: 2, updatedAt: 3 }),
    job({ jobId: 'other-session', sessionId: 'task-b', ownerSessionId: 'task-b', updatedAt: 4 })
  ], 'task-a')
  expect(getSessionServiceItems(items, 'task-a').map(item => item.id)).toEqual(['command:session-running', 'command:session-stopped'])
  expect(getSessionServiceItems(items, null)).toEqual([])
})

test('历史弹窗保留跨会话已读通知，并能转换为可展示的历史行', () => {
  const notification: ActivityHistoryEntry = {
    id: 'plugin:sample:notification-1', kind: 'notification', sessionId: 'task-old',
    label: '构建完成', detail: '输出已写入工作区', status: 'completed', statusLabel: '已完成', tone: 'quiet',
    updatedAt: 20, readAt: 21
  }
  const service: ActivityHistoryEntry = {
    id: 'command:old', kind: 'service', sessionId: 'task-old',
    label: 'node build.mjs', detail: '/project', status: 'completed', statusLabel: '已完成', tone: 'quiet',
    updatedAt: 10, readAt: 11
  }

  const visible = getPersistedHistoryEntries([notification, service], new Set(['command:old']))
  expect(visible).toEqual([notification])
  expect(historyEntryToServiceItem(notification)).toMatchObject({
    id: notification.id, kind: 'plugin', label: notification.label, active: false, attention: false
  })
})

test('插件通知是全局活动，不随发出通知的会话切换而隐藏', () => {
  const registration = {
    identity: { pluginId: 'sample', instanceId: 'sample@one', revision: 1, hash: 'hash', source: 1 },
    contributes: {}
  } as ExtensionRegistration
  const services = new ExtensionServices(async () => ({ result: {} }), () => true, () => registration)
  services.notify(registration, { sessionId: 'task-a', workspacePath: '/project', engineReady: true }, '构建完成', '输出已写入工作区')
  expect(services.getSnapshot()).toHaveLength(1)
  expect(services.getSnapshot()[0]).toMatchObject({ label: '构建完成', notification: true, status: 'completed' })
  expect(services.getSnapshot()[0].sessionId).toBeUndefined()
})

test('插件卸载后未读活动仍可打开，已读活动才进入历史', () => {
  const notice = {
    id: 'plugin:sample:notification-1', serviceId: 'plugin:sample:notification-1', label: '构建完成', detail: '输出已写入工作区',
    status: 'completed', statusLabel: '已完成', tone: 'quiet' as const, updatedAt: 20, read: false
  }
  const state = reconcileServiceNotifications({ observed: new Map([[notice.serviceId, notice.status]]), notifications: [notice] }, [])
  expect(state.notifications).toEqual([notice])
  expect(serviceNotificationToItem(state.notifications[0])).toMatchObject({ id: notice.serviceId, label: notice.label, active: false })
})
