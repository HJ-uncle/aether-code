/** Pure host event observers: history stays silent, live messages emit once,
 * pagination and repeated streaming renders cannot produce duplicate hooks. */
import { expect, test } from '@playwright/test'
import { observeExtensionMessages, type ExtensionMessage } from '../src/renderer/src/features/conversation/extension-message-events'
import { publishFileMutation, subscribeFileMutations, type FileMutationEvent } from '../src/renderer/src/core/workspace/file-mutation-events'
import { revertChanges, type RevertReport } from '../src/renderer/src/core/engine/change-revert'

const message = (id: string, createdAt: number, role = 'user', status = 'done'): ExtensionMessage => ({ id, createdAt, role, status, content: id })

test('历史基线与分页不触发消息事件，新消息和完成事件分别只触发一次', () => {
  const history = [message('old-user', 100), message('old-assistant', 101, 'assistant')]
  const baseline = observeExtensionMessages(null, history)
  expect(baseline.events).toEqual([])
  const streaming = [...history, message('new-user', 200), message('new-assistant', 201, 'assistant', 'streaming')]
  const appended = observeExtensionMessages(baseline.state, streaming)
  expect(appended.events.map(event => [event.name, event.message.id])).toEqual([
    ['message.created', 'new-user'], ['message.created', 'new-assistant']
  ])
  const chunk = observeExtensionMessages(appended.state, streaming.map(item => ({ ...item, content: item.content + ' chunk' })))
  expect(chunk.events).toEqual([])
  const completed = observeExtensionMessages(chunk.state, [...streaming.slice(0, -1), message('new-assistant', 201, 'assistant')])
  expect(completed.events.map(event => [event.name, event.message.id])).toEqual([['message.completed', 'new-assistant']])
  const page = [message('paged-user', 1), message('paged-assistant', 2, 'assistant'), ...streaming.slice(0, -1), message('new-assistant', 201, 'assistant')]
  const paged = observeExtensionMessages(completed.state, page)
  expect(paged.events).toEqual([])
  expect(observeExtensionMessages(paged.state, page).events).toEqual([])
})

test('短回复完成和错误结束均有唯一完成事件，用户消息不会产生助手完成事件', () => {
  const baseline = observeExtensionMessages(null, []).state
  const instant = observeExtensionMessages(baseline, [message('user', 1), message('assistant', 2, 'assistant')])
  expect(instant.events.map(event => [event.name, event.message.id])).toEqual([
    ['message.created', 'user'], ['message.created', 'assistant'], ['message.completed', 'assistant']
  ])
  const pending = observeExtensionMessages(instant.state, [message('waiting', 3, 'assistant', 'waiting')])
  const failed = observeExtensionMessages(pending.state, [message('waiting', 3, 'assistant', 'error')])
  expect(failed.events.map(event => event.name)).toEqual(['message.completed'])
  expect(observeExtensionMessages(failed.state, [message('waiting', 3, 'assistant', 'interrupted')]).events).toEqual([])
})

test('消息观察缓存有上限，重载旧分页不会再次触发已完成消息', () => {
  const history = Array.from({ length: 2500 }, (_, index) => message(String(index), index + 1, index % 2 ? 'assistant' : 'user'))
  const baseline = observeExtensionMessages(null, history)
  expect(baseline.state.seen.size).toBe(2000)
  expect(observeExtensionMessages(baseline.state, history).events).toEqual([])
})

test('文件成功写入事件保留会话归属，监听器异常和卸载不会改变写入结果', () => {
  const events: FileMutationEvent[] = []
  const offThrow = subscribeFileMutations(() => { throw new Error('observer only') })
  const off = subscribeFileMutations(event => events.push(event))
  const event: FileMutationEvent = { source: 7, sessionId: 'session-a', workspacePath: '/workspace/a', path: '/workspace/a/report.md', operation: 'write' }
  try {
    expect(() => publishFileMutation(event)).not.toThrow()
    expect(events).toEqual([event])
    off()
    publishFileMutation({ ...event, operation: 'delete' })
    expect(events).toHaveLength(1)
  } finally { off(); offThrow() }
})

test('文件回退仅成功改动发布事件，相同路径去重，冲突和此前已回退不重放', async () => {
  const events: FileMutationEvent[] = [], off = subscribeFileMutations(event => events.push(event))
  const report: RevertReport = { results: [
    { id: 'a', path: '/report.md', status: 'reverted' }, { id: 'b', path: '/report.md', status: 'reverted' },
    { id: 'c', path: '/conflict.md', status: 'conflict' }, { id: 'd', path: '/old.md', status: 'already_reverted' }
  ], total: 4, reverted: 2, conflicts: 1, unavailable: 0, failed: 0, removedDirectories: ['/empty'] }
  try {
    await revertChanges(async <T>() => report as T, { sessionId: 'revert-session' })
    expect(events.map(({ sessionId, path, operation }) => ({ sessionId, path, operation }))).toEqual([
      { sessionId: 'revert-session', path: '/report.md', operation: 'revert' },
      { sessionId: 'revert-session', path: '/empty', operation: 'revert' }
    ])
  } finally { off() }
})
