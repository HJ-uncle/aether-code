/** D2 batch selection and history truncation semantics; no Electron/provider requests. */
import { expect, test } from '@playwright/test'
import type { EngineRequestInput } from '../src/shared/ipc'
import {
  getRevertReport, groupRevertResults, locateRevertRow, revertChanges,
  revertComplete, revertConversationFrom, revertSummary, type RevertReport, type RevertStatus
} from '../src/renderer/src/core/engine/change-revert'

function report(statuses: RevertStatus[]): RevertReport {
  return {
    results: statuses.map((status, index) => ({ id: String(index), path: index < 2 ? 'chain.txt' : `${index}.txt`, status })),
    total: statuses.length, reverted: statuses.filter(s => s === 'reverted').length,
    conflicts: statuses.filter(s => s === 'conflict').length,
    unavailable: statuses.filter(s => s === 'unavailable').length,
    failed: statuses.filter(s => s === 'failed').length
  }
}
const target = { id: 'user-2', role: 'user', content: '继续' }
const rows = [
  { id: 'user-1', role: 'user', content: '继续', createdAt: 1000 },
  { id: 'assistant-1', role: 'assistant', content: '上轮已完成', createdAt: 1999 },
  { ...target, createdAt: 2000, conversationId: 'turn-2' }
]
function mock(batch: RevertReport, history = rows) {
  const calls: EngineRequestInput[] = []
  return {
    calls,
    request: async <T>(input: EngineRequestInput): Promise<T> => {
      calls.push(input)
      return (input.path === '/conversation/history' ? history : input.path === '/changes/revert-batch' ? batch : {}) as T
    }
  }
}

test('全部撤回由服务端选择完整session范围，不从可见列表生成ids', async () => {
  const fixture = mock(report(['reverted']))
  await revertChanges(fixture.request, { sessionId: 'all', scope: 'pending' })
  expect(fixture.calls).toEqual([{ method: 'POST', path: '/changes/revert-batch', body: { sessionId: 'all', scope: 'pending' } }])
})

test('单条撤回仍走同一batch且明确限定id', async () => {
  const fixture = mock(report(['conflict']))
  await revertChanges(fixture.request, { sessionId: 'single', ids: ['older'], scope: 'all' })
  expect(fixture.calls[0].body).toEqual({ sessionId: 'single', ids: ['older'], scope: 'all' })
  expect(getRevertReport('single')?.results[0].status).toBe('conflict')
})

for (const status of ['conflict', 'unavailable', 'failed'] as const) {
  test(`${status}部分结果保留全部历史，且发布可审查结果`, async () => {
    const batch = report(['reverted', status])
    const fixture = mock(batch)
    await expect(revertConversationFrom(fixture.request, `partial-${status}`, target)).rejects.toThrow('对话历史已保留')
    expect(fixture.calls.map(call => call.path)).toEqual(['/conversation/history', '/changes/revert-batch'])
    expect(getRevertReport(`partial-${status}`)).toEqual(batch)
    expect(fixture.calls[1].body).toEqual({ sessionId: `partial-${status}`, scope: 'all', fromTurnId: 'turn-2' })
  })
}

test('完全成功及重复已撤回后，才按精确引擎messageId截断', async () => {
  const fixture = mock(report(['reverted', 'already_reverted']))
  await revertConversationFrom(fixture.request, 'done', target)
  expect(fixture.calls.map(call => call.path)).toEqual(['/conversation/history', '/changes/revert-batch', '/conversation/truncate'])
  expect(fixture.calls[2].body).toEqual({ sessionId: 'done', messageId: 'user-2' })
})

test('前端临时ID遇到重复正文时拒绝写入，不选第一条继续', async () => {
  const fixture = mock(report([]))
  await expect(revertConversationFrom(fixture.request, 'ambiguous', { ...target, id: 'frontend-id' })).rejects.toThrow('稳定轮次')
  expect(fixture.calls).toHaveLength(1)
  expect(locateRevertRow(rows, target).id).toBe('user-2')
  expect(() => locateRevertRow([rows[2]], { ...target, id: 'frontend-id' })).toThrow('稳定轮次')
})

test('缺失轮次不能猜测边界；时间戳不再参与选择', () => {
  expect(() => locateRevertRow([{ ...target }], target)).toThrow('稳定轮次')
  expect(locateRevertRow([{ ...target, createdAt: NaN, conversationId: 'turn-2' }], target).conversationId).toBe('turn-2')
})

test('API失败及不完整响应不得截断历史', async () => {
  const paths: string[] = []
  const request = async <T>(input: EngineRequestInput): Promise<T> => {
    paths.push(input.path)
    if (input.path === '/changes/revert-batch') throw new Error('HTTP connection failed')
    return rows as T
  }
  await expect(revertConversationFrom(request, 'transport', target)).rejects.toThrow('HTTP connection failed')
  expect(paths).not.toContain('/conversation/truncate')
  const malformed = { ...report(['reverted']), total: 2 }
  expect(revertComplete(malformed)).toBe(false)
  expect(revertComplete({ ...report(['conflict']), conflicts: 0, reverted: 1 })).toBe(false)
})

test('相同路径的多个操作按文件分组，汇总不把操作数说成文件数', () => {
  const batch = report(['reverted', 'reverted', 'conflict', 'unavailable'])
  expect(revertSummary(batch)).toBe('已撤回 1 个文件（2 处改动）；版本冲突 1 处；不可自动回退 1 处')
  expect(groupRevertResults(batch).map(group => [group.path, group.items.length])).toEqual([
    ['chain.txt', 2], ['2.txt', 1], ['3.txt', 1]
  ])
})
