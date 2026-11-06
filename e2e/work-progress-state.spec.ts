/** Pure progress-panel contracts: session isolation, durable status precedence,
 * multi-file command receipts and path-level summaries without fabricated edits. */
import { expect, test } from '@playwright/test'
import type { EngineFileChange } from '../src/shared/ipc'
import type { ToolActivity } from '../src/renderer/src/core/engine/useChat'
import { workProgressChanges, workProgressChangeStatus, workProgressPath, workProgressRetryDelay } from '../src/renderer/src/contrib/work/work-progress-state'

const change = (id: string, patch: Partial<EngineFileChange> = {}): EngineFileChange => ({
  id, path: `D:/work/${id}.md`, kind: 'write', oldContent: null, newContent: '# Report',
  truncated: false, status: 'pending', createdAt: 1, ...patch
})
const tool = (patch: Partial<ToolActivity>): ToolActivity => ({ id: 'tool', name: 'write_file',
  args: '{}', result: '', state: 'done', ...patch })

test('同一改动在工具与服务器去重，服务器确认状态覆盖旧 pending 回执', () => {
  const streamed = change('report')
  const files = workProgressChanges('session', [tool({ change: streamed, changes: [streamed] })], [
    { ...streamed, sessionId: 'session', status: 'kept' }
  ])
  expect(files).toHaveLength(1)
  expect(files[0].records).toHaveLength(1)
  expect(files[0].latest.status).toBe('kept')
  expect(streamed.status).toBe('pending')
  expect(workProgressChanges('session', [tool({ change: { ...streamed, status: 'reverted' } })], [
    { ...streamed, sessionId: 'session', status: 'pending' }
  ])[0].latest.status).toBe('reverted')
})

test('不同会话和缺少归属的 HTTP 记录不可混入，切换任务不会靠同 ID 合并', () => {
  const files = workProgressChanges('session', [tool({ change: change('wrong', { sessionId: 'other' }) })], [
    change('wrong', { sessionId: 'other' }), change('no-owner'), change('mine', { sessionId: 'session' })
  ])
  expect(files.map(file => file.latest.id)).toEqual(['mine'])
  expect(workProgressChanges('', [tool({ change: change('report') })], [])).toEqual([])
})

test('命令一次修改多个文件全部保留，同路径重复编辑只占一个文件且显示最近记录', () => {
  const first = change('first', { path: 'D:/work/report.md', createdAt: 1 })
  const second = change('second', { path: 'd:\\work\\report.md', createdAt: 3, isNew: false })
  const third = change('third', { path: 'D:/work/data.csv', createdAt: 2 })
  const job = { schemaVersion: 1 as const, jobId: 'job', sessionId: 'session', ownerSessionId: 'session',
    version: 1, command: 'node', args: [], cwd: 'D:/work', background: true, status: 'running' as const,
    createdAt: 1, updatedAt: 2, cursor: 0, earliestCursor: 0, exitCode: null, signal: null,
    changes: [second, third] }
  const files = workProgressChanges('session', [tool({ change: first }), tool({ name: 'execute_cmd', commandJob: job })], [])
  expect(files.map(file => file.latest.id)).toEqual(['second', 'third'])
  expect(files[0].records.map(item => item.id)).toEqual(['first', 'second'])
  expect(workProgressChanges('other', [tool({ name: 'execute_cmd', commandJob: job })], [])).toEqual([])
})

test('文件路径或普通工具产出不冒充改动，文件名相同的不同目录各自显示', () => {
  expect(workProgressChanges('session', [tool({ name: 'office_document', args: '{"path":"report.xlsx"}',
    result: '{"path":"report.xlsx","status":"success"}' })], [])).toEqual([])
  const files = workProgressChanges('session', [tool({ changes: [
    change('one', { path: 'sales/report.md' }), change('two', { path: 'support/report.md' })
  ] })], [], 'D:/work')
  expect(files).toHaveLength(2)
  expect(workProgressPath('D:\\work\\sales\\report.md', 'D:/work')).toBe('sales/report.md')
  expect(workProgressPath('D:/work-backup/report.md', 'D:/work')).toBe('D:/work-backup/report.md')
})

test('最后一条已保留不能掩盖同文件之前的待确认记录', () => {
  const files = workProgressChanges('session', [tool({ changes: [
    change('earlier', { path: 'report.md', status: 'pending', createdAt: 1 }),
    change('latest', { path: 'report.md', status: 'kept', createdAt: 2 })
  ] })], [])
  expect(files[0].latest.status).toBe('kept')
  expect(workProgressChangeStatus(files[0].records)).toEqual({
    label: '1 / 2 待确认', detail: '2 条记录 · 1 条待确认 · 1 条已保留', pending: 1
  })
  expect(workProgressChangeStatus(files[0].records.map(item => ({ ...item, status: 'kept' })))).toEqual({
    label: '已保留', detail: '2 条记录 · 2 条已保留', pending: 0
  })
  expect(workProgressChangeStatus([change('a', { status: 'kept' }), change('b', { status: 'reverted' })]).label).toBe('2 条已处理')
  expect(workProgressChangeStatus([change('a', { status: 'reverted' })]).label).toBe('已撤回')
})

test('同步失败从两秒开始退避，连续失败最多每三十秒重试', () => {
  expect([1, 2, 3, 4, 5, 6].map(workProgressRetryDelay)).toEqual([2000, 4000, 8000, 16000, 30000, 30000])
  expect(workProgressRetryDelay(1)).toBe(2000)
})
