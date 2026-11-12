/** Pure service ownership/status and bounded notification semantics; no Electron or engine. */
import { expect, test } from '@playwright/test'
import type { CommandJobSnapshot } from '../src/shared/command-job'
import { buildServiceItems, clearReadServiceNotifications, emptyServiceNotifications, readAllServiceNotifications, reconcileServiceNotifications, SERVICE_NOTIFICATION_LIMIT, setServiceNotificationRead, type ServiceContribution } from '../src/renderer/src/features/services/service-model'
import { ServiceNotificationStore } from '../src/renderer/src/features/services/notification-store'

const job = (patch: Partial<CommandJobSnapshot> = {}): CommandJobSnapshot => ({
  schemaVersion: 1, jobId: 'command', sessionId: 'task-a', ownerSessionId: 'task-a', version: 1,
  status: 'running', command: 'node', args: ['serve.js'], cwd: '/project', background: true,
  createdAt: 1, updatedAt: 1, exitCode: null, signal: null, cursor: 0, earliestCursor: 0, ...patch
})
const plugin = (patch: Partial<ServiceContribution> = {}): ServiceContribution => ({
  id: 'timer', pluginId: 'sample', instanceId: 'sample@one', revision: 1,
  label: '专注计时', status: 'running', updatedAt: 2, ...patch
})

test('服务列表只包含当前会话后台命令，旧事件不会复活已完成任务', () => {
  const complete = job({ status: 'succeeded', version: 4, updatedAt: 4 })
  const items = buildServiceItems([job(), job({ sessionId: 'task-b', jobId: 'foreign' }),
    job({ background: false, jobId: 'foreground' }), complete, job({ version: 9, updatedAt: 9 })], 'task-a')
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({ id: 'command:command', status: 'succeeded', active: false, revision: 4 })
  expect(items[0].job).toBe(complete)
})

test('插件服务按实例隔离，作用域过滤，并保留最新回执', () => {
  const otherInstance = plugin({ instanceId: 'sample@two' })
  const items = buildServiceItems([], 'task-a', [plugin(), plugin({ sessionId: 'task-b', id: 'foreign' }),
    plugin({ revision: 3, status: 'completed', updatedAt: 4 }), otherInstance])
  expect(items).toHaveLength(2)
  expect(items.map(item => item.id)).toEqual(['plugin:["sample@two","timer"]', 'plugin:["sample@one","timer"]'])
  expect(items[0]).toMatchObject({ active: true, status: 'running' })
  expect(items[1]).toMatchObject({ active: false, status: 'completed', revision: 3 })
})

test('历史终态默认已读，运行结束才新增未读；重复回执不重复通知', () => {
  const restored = buildServiceItems([job({ jobId: 'past', status: 'succeeded' }), job()], 'task-a')
  const baseline = reconcileServiceNotifications(emptyServiceNotifications, restored)
  expect(baseline.notifications).toHaveLength(1)
  expect(baseline.notifications[0].read).toBe(true)
  const finished = buildServiceItems([job({ jobId: 'past', status: 'succeeded' }), job({ status: 'failed', version: 2, updatedAt: 5 })], 'task-a')
  const next = reconcileServiceNotifications(baseline, finished)
  expect(next.notifications).toHaveLength(2)
  expect(next.notifications[0]).toMatchObject({ serviceId: 'command:command', read: false, status: 'failed' })
  expect(reconcileServiceNotifications(next, finished)).toBe(next)
  const outputUpdate = buildServiceItems([job({ jobId: 'past', status: 'succeeded' }), job({ status: 'failed', version: 3, updatedAt: 6 })], 'task-a')
  const repeated = reconcileServiceNotifications(next, outputUpdate)
  expect(repeated.notifications.map(value => value.id)).toEqual(next.notifications.map(value => value.id))
  expect(repeated.notifications[0].read).toBe(false)
})

test('已读和未读是通知状态，不会修改真实服务状态或启动动作', () => {
  let opened = 0
  const items = buildServiceItems([], 'task-a', [plugin({ status: 'error', open: () => { opened++ } })])
  const baseline = reconcileServiceNotifications(emptyServiceNotifications, items)
  const unread = setServiceNotificationRead(baseline, items[0].id, false)
  expect(unread.notifications[0].read).toBe(false)
  expect(readAllServiceNotifications(unread).notifications[0].read).toBe(true)
  expect(setServiceNotificationRead(unread, 'missing')).toBe(unread)
  expect(items[0].status).toBe('error')
  expect(opened).toBe(0)
})

test('清除已读后不会被同一终态的后续输出重新生成，下一次状态变化仍通知', () => {
  const running = buildServiceItems([], 'task-a', [plugin()])
  const waiting = buildServiceItems([], 'task-a', [plugin({ status: 'waiting', revision: 2 })])
  const baseline = reconcileServiceNotifications(emptyServiceNotifications, running)
  const next = reconcileServiceNotifications(baseline, waiting)
  expect(next.notifications[0].read).toBe(false)
  const cleared = clearReadServiceNotifications(readAllServiceNotifications(next))
  expect(cleared.notifications).toEqual([])
  expect(reconcileServiceNotifications(cleared, waiting)).toBe(cleared)
  const completed = reconcileServiceNotifications(cleared, buildServiceItems([], 'task-a', [plugin({ status: 'completed', revision: 3 })]))
  expect(completed.notifications).toHaveLength(1)
  expect(completed.notifications[0]).toMatchObject({ read: false, status: 'completed' })
})

test('插件卸载和会话移除同时撤销对应通知及状态观察，不遗留可操作记录', () => {
  const items = buildServiceItems([job({ status: 'failed' })], 'task-a', [plugin({ status: 'completed' })])
  const initial = reconcileServiceNotifications(emptyServiceNotifications, items)
  expect(initial.notifications).toHaveLength(2)
  const unloaded = reconcileServiceNotifications(initial, items.filter(item => item.kind === 'command'))
  expect(unloaded.notifications.map(value => value.serviceId)).toEqual(['command:command'])
  expect([...unloaded.observed.keys()]).toEqual(['command:command'])
  const removed = reconcileServiceNotifications(unloaded, [])
  expect(removed.notifications).toEqual([])
  expect(removed.observed.size).toBe(0)
})

test('通知只保留最近100条摘要，不保留输出缓冲或无界的详情文本', () => {
  const items = buildServiceItems([], 'task-a', Array.from({ length: 125 }, (_, index) => plugin({
    id: `timer-${index}`, status: 'completed', updatedAt: index, label: 'n'.repeat(2000), detail: 'x'.repeat(50_000)
  })))
  const state = reconcileServiceNotifications(emptyServiceNotifications, items)
  expect(state.notifications).toHaveLength(SERVICE_NOTIFICATION_LIMIT)
  expect(state.notifications[0].updatedAt).toBe(124)
  expect(state.notifications.at(-1)?.updatedAt).toBe(25)
  expect(state.notifications.every(value => value.label.length === 512 && value.detail.length === 1024)).toBe(true)
  expect(Object.keys(state.notifications[0]).sort()).toEqual(['detail', 'id', 'label', 'read', 'serviceId', 'status', 'statusLabel', 'tone', 'updatedAt'])
})

test('停止回执前保持运行态，正在停止不会误报完成', () => {
  const baseline = reconcileServiceNotifications(emptyServiceNotifications, buildServiceItems([job()], 'task-a'))
  const cancelling = buildServiceItems([job({ status: 'cancelling', version: 2 })], 'task-a')
  const waiting = reconcileServiceNotifications(baseline, cancelling)
  expect(cancelling[0]).toMatchObject({ active: true, statusLabel: '正在停止' })
  expect(waiting.notifications).toHaveLength(0)
  const stopped = reconcileServiceNotifications(waiting, buildServiceItems([job({ status: 'cancelled', version: 3 })], 'task-a'))
  expect(stopped.notifications[0]).toMatchObject({ status: 'cancelled', statusLabel: '已停止', read: false })
})

test('同任务的rail和侧栏共享已读状态，全局通知不随当前任务切换', () => {
  const store = new ServiceNotificationStore()
  const rail = store.scope(1, 'task-a'), sidebar = store.scope(1, 'task-a'), global = store.scope(1, null)
  expect(rail).toBe(sidebar)
  expect(store.scope(1, 'task-b')).not.toBe(rail)
  expect(store.scope(2, 'task-a')).not.toBe(rail)
  let updates = 0
  const unsubscribe = sidebar.subscribe(() => updates++)
  const items = buildServiceItems([job({ status: 'failed' })], 'task-a')
  rail.update(previous => reconcileServiceNotifications(previous, items))
  rail.update(previous => setServiceNotificationRead(previous, items[0].id, false))
  expect(sidebar.getSnapshot().notifications[0].read).toBe(false)
  sidebar.update(readAllServiceNotifications)
  expect(rail.getSnapshot().notifications[0].read).toBe(true)
  expect(updates).toBe(3)
  global.update(previous => reconcileServiceNotifications(previous, buildServiceItems([], 'task-a', [plugin({ status: 'completed' })])))
  global.update(previous => setServiceNotificationRead(previous, global.getSnapshot().notifications[0].serviceId, false))
  store.scope(1, 'task-b')
  expect(store.scope(1, null)).toBe(global)
  expect(global.getSnapshot().notifications[0].read).toBe(false)
  unsubscribe()
})

test('不观察的会话缓存按容量淘汰，仍在显示的面板保持同一memory', () => {
  const store = new ServiceNotificationStore(2)
  const current = store.scope(1, 'task-current')
  const unsubscribe = current.subscribe(() => {})
  const old = store.scope(1, 'task-old')
  store.scope(1, 'task-new')
  expect(store.size).toBe(2)
  expect(store.scope(1, 'task-current')).toBe(current)
  expect(store.scope(1, 'task-old')).not.toBe(old)
  expect(store.size).toBe(2)
  unsubscribe()
})

test('引擎切换清除通知，同时让旧面板订阅收到失效信号', () => {
  const store = new ServiceNotificationStore()
  const memory = store.scope(1, null)
  memory.update(previous => reconcileServiceNotifications(previous, buildServiceItems([], '', [plugin({ status: 'completed' })])))
  let invalidated = 0
  const unsubscribe = memory.subscribe(() => invalidated++)
  store.clear()
  expect(invalidated).toBe(1)
  expect(memory.getSnapshot()).toBe(emptyServiceNotifications)
  expect(store.size).toBe(0)
  expect(store.scope(2, null)).not.toBe(memory)
  unsubscribe()
})
