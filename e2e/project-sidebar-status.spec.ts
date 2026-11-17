/** Project heading summaries: priority, hidden-page sessions, connection state and quiet history. */
import { expect, test } from '@playwright/test'
import { projectSidebarStatus } from '../src/renderer/src/features/sessions/sidebar-task'
import type { SessionTask } from '../src/renderer/src/features/sessions/state'

function task(id: string, status: SessionTask['status'], patch: Partial<SessionTask> = {}): SessionTask {
  return { id, title: id, status, draft: '', createdAt: 1, updatedAt: 2, workspacePath: '/projects/example', modelId: '', attachments: [], sources: [], ...patch }
}

function waiting(id: string, pendingPermission: number, pendingAsk: number): SessionTask {
  return task(id, 'waiting', { activity: { runId: `run-${id}`, seq: 1, version: 1, status: 'waiting', updatedAt: 2, pendingAsk, pendingPermission } })
}

test('full project includes running sessions beyond the first six rows and counts sessions', () => {
  const tasks = Array.from({ length: 6 }, (_, index) => task(String(index), 'done'))
  tasks.push(task('hidden-running', 'running'), task('another-running', 'running'), task('unread', 'done', { completionUnread: true }))
  expect(projectSidebarStatus(tasks, true)).toEqual({ kind: 'running', label: '运行中', active: true, count: 2, detail: '运行中 · 2 个会话；已完成，未查看 · 1 个会话' })
})

test('permissions and questions take priority and pending requests do not inflate the session count', () => {
  const summary = projectSidebarStatus([task('running', 'running'), waiting('permission', 4, 0), waiting('question', 0, 3), waiting('both', 2, 2), task('failed', 'error')], true)
  expect(summary).toMatchObject({ kind: 'permission', label: '待授权与补充', icon: 'shield', count: 3 })
  expect(summary?.active).toBeUndefined()
  expect(summary?.detail).toContain('待授权 · 1 个会话')
  expect(summary?.detail).toContain('待授权与补充 · 1 个会话')
  expect(summary?.detail).toContain('等你补充 · 1 个会话')
  expect(summary?.detail).toContain('执行失败 · 1 个会话')
  expect(summary?.detail).toContain('运行中 · 1 个会话')
})

test('questions and unknown waiting use the same session status labels', () => {
  expect(projectSidebarStatus([waiting('question', 0, 1), task('waiting', 'waiting')], true)).toMatchObject({ kind: 'question', label: '等你补充', icon: 'chat', count: 2 })
  expect(projectSidebarStatus([task('waiting', 'waiting')], true)).toMatchObject({ kind: 'question', label: '待处理', count: 1 })
  expect(projectSidebarStatus([waiting('permission', 1, 0)], true)).toMatchObject({ kind: 'permission', label: '待授权', count: 1 })
})

test('disconnected active sessions do not claim to be running or ready for a response', () => {
  expect(projectSidebarStatus([task('running', 'running'), waiting('permission', 1, 0), task('failed', 'error')], false)).toEqual({ kind: 'disconnected', label: '连接中断，等待恢复确认', icon: 'alert-circle', count: 2, detail: '连接中断，等待恢复确认 · 2 个会话；执行失败 · 1 个会话' })
})

test('current running work stays visible while failures remain in the project details', () => {
  const tasks = [task('running', 'running'), task('interrupted', 'interrupted'), task('failed-1', 'error'), task('failed-2', 'error')]
  expect(projectSidebarStatus(tasks, true)).toMatchObject({ kind: 'running', count: 1, detail: '运行中 · 1 个会话；执行失败 · 2 个会话；执行已中断 · 1 个会话' })
  expect(projectSidebarStatus(tasks.filter(item => item.status !== 'running'), true)).toMatchObject({ kind: 'error', label: '执行失败', count: 2 })
  expect(projectSidebarStatus(tasks.filter(item => item.status === 'interrupted'), true)).toMatchObject({ kind: 'interrupted', label: '执行已中断', count: 1 })
})

test('quiet history and archived work do not leave stale project indicators', () => {
  const tasks = [task('read', 'done'), task('stopped', 'stopped'), task('draft', 'draft'), task('archived', 'running', { archived: true })]
  expect(projectSidebarStatus(tasks, true)).toBeUndefined()
  expect(projectSidebarStatus([], false)).toBeUndefined()
  const unread = task('unread', 'done', { completionUnread: true })
  expect(projectSidebarStatus([...tasks, unread], true)).toMatchObject({ kind: 'unread', count: 1, label: '已完成，未查看' })
  expect(projectSidebarStatus([...tasks, { ...unread, completionUnread: false }], true)).toBeUndefined()
})

test('stale waiting metadata on a running session cannot produce an authorization warning', () => {
  const running = { ...waiting('resumed', 3, 2), status: 'running' as const }
  expect(projectSidebarStatus([running], true)).toMatchObject({ kind: 'running', count: 1, active: true })
})

test('archive collections summarize real active and waiting sessions only when explicitly included', () => {
  const running = task('archived-running', 'running', { archived: true })
  const permission = { ...waiting('archived-permission', 1, 0), archived: true }
  const quiet = task('archived-read', 'done', { archived: true })
  expect(projectSidebarStatus([running, permission, quiet], true)).toBeUndefined()
  expect(projectSidebarStatus([running, permission, quiet], true, { includeArchived: true })).toMatchObject({
    kind: 'permission', count: 1, detail: '待授权 · 1 个会话；运行中 · 1 个会话'
  })
  expect(projectSidebarStatus([running], true, { includeArchived: true })).toMatchObject({ kind: 'running', active: true, count: 1 })
  expect(projectSidebarStatus([running, permission], false, { includeArchived: true })).toMatchObject({ kind: 'disconnected', count: 2 })
  expect(projectSidebarStatus([quiet, { ...running, status: 'done' }], true, { includeArchived: true })).toBeUndefined()
  expect(running.status).toBe('running'); expect(permission.status).toBe('waiting'); expect(quiet.status).toBe('done')
})
