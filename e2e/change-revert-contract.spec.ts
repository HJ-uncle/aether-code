/** D2 batch selection and history truncation semantics; no Electron/provider requests. */
import { expect, test } from '@playwright/test'
import type { EngineRequestInput } from '../src/shared/ipc'
import {
  getRevertOutcome, getRevertReport, groupRevertResults, locateRevertRow, revertChanges,
  revertComplete, revertConversationFrom, revertSummary, subscribeReverts, type RevertReport, type RevertStatus
} from '../src/renderer/src/core/engine/change-revert'
import { getExpectedEngine, publishEngineSource } from '../src/renderer/src/core/engine/source'

let sourceSerial = 0
function changeSource(): void {
  publishEngineSource({ mode: 'embedded', baseUrl: 'http://engine.test', instanceId: `engine-${++sourceSerial}`, phase: 'idle' })
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
test.beforeEach(changeSource)

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
  expect(fixture.calls).toEqual([{ method: 'POST', path: '/changes/revert-batch', body: { sessionId: 'all', scope: 'pending' }, expectedEngine: getExpectedEngine() }])
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
  expect(fixture.calls.every(call => JSON.stringify(call.expectedEngine) === JSON.stringify(getExpectedEngine()))).toBe(true)
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

test('引擎代次变化清空报告和卡片结果，并通知订阅者', async () => {
  const batch = report(['reverted'])
  await revertChanges(mock(batch).request, { sessionId: 'shared-session' })
  expect(getRevertReport('shared-session')).toEqual(batch)
  expect(getRevertOutcome('0')).toEqual(batch.results[0])
  let notifications = 0
  const unsubscribe = subscribeReverts(() => { notifications++ })
  try {
    changeSource()
    expect(getRevertReport('shared-session')).toBeNull()
    expect(getRevertOutcome('0')).toBeNull()
    expect(notifications).toBe(1)
  } finally {
    unsubscribe()
  }
})

test('旧引擎晚到的batch结果不能覆盖新引擎同名会话或卡片', async () => {
  const delayed = deferred<RevertReport>()
  const oldRequest = async <T>(_input: EngineRequestInput): Promise<T> => await delayed.promise as T
  const pending = revertChanges(oldRequest, { sessionId: 'shared-session' })
  const rejected = expect(pending).rejects.toThrow('引擎连接已变化')
  changeSource()
  const current = report(['conflict'])
  await revertChanges(mock(current).request, { sessionId: 'shared-session' })
  delayed.resolve(report(['reverted']))
  await rejected
  expect(getRevertReport('shared-session')).toEqual(current)
  expect(getRevertOutcome('0')).toEqual(current.results[0])
})

test('请求已返回但发布报告前的微任务切源不能留下旧缓存', async () => {
  const delayed = deferred<RevertReport>()
  const request = <T>(_input: EngineRequestInput): Promise<T> => delayed.promise as Promise<T>
  const pending = revertChanges(request, { sessionId: 'continuation-switch' })
  const rejected = expect(pending).rejects.toThrow('引擎连接已变化')
  delayed.resolve(report(['reverted']))
  queueMicrotask(changeSource)
  await rejected
  expect(getRevertReport('continuation-switch')).toBeNull()
  expect(getRevertOutcome('0')).toBeNull()
})

test('读取历史期间切换引擎，旧历史不得向新引擎发起文件回退', async () => {
  const history = deferred<typeof rows>()
  const calls: EngineRequestInput[] = []
  const expected = getExpectedEngine()
  const request = async <T>(input: EngineRequestInput): Promise<T> => {
    calls.push(input)
    return await history.promise as T
  }
  const pending = revertConversationFrom(request, 'history-switch', target)
  const rejected = expect(pending).rejects.toThrow('引擎连接已变化')
  changeSource()
  history.resolve(rows)
  await rejected
  expect(calls.map(call => call.path)).toEqual(['/conversation/history'])
  expect(calls[0].expectedEngine).toEqual(expected)
  expect(getRevertReport('history-switch')).toBeNull()
})

test('文件回退期间切换引擎，不得发布旧报告或截断新引擎历史', async () => {
  const batch = deferred<RevertReport>()
  const started = deferred<void>()
  const calls: EngineRequestInput[] = []
  const request = async <T>(input: EngineRequestInput): Promise<T> => {
    calls.push(input)
    if (input.path === '/conversation/history') return rows as T
    started.resolve()
    return await batch.promise as T
  }
  const pending = revertConversationFrom(request, 'batch-switch', target)
  const rejected = expect(pending).rejects.toThrow('引擎连接已变化')
  await started.promise
  changeSource()
  batch.resolve(report(['reverted']))
  await rejected
  expect(calls.map(call => call.path)).toEqual(['/conversation/history', '/changes/revert-batch'])
  expect(getRevertReport('batch-switch')).toBeNull()
  expect(getRevertOutcome('0')).toBeNull()
})

test('报告通知期间切换引擎也会阻止后续历史截断', async () => {
  const fixture = mock(report(['reverted']))
  const unsubscribe = subscribeReverts(() => {
    if (getRevertReport('listener-switch')) changeSource()
  })
  try {
    await expect(revertConversationFrom(fixture.request, 'listener-switch', target)).rejects.toThrow('引擎连接已变化')
    expect(fixture.calls.map(call => call.path)).toEqual(['/conversation/history', '/changes/revert-batch'])
    expect(getRevertReport('listener-switch')).toBeNull()
  } finally {
    unsubscribe()
  }
})

test('旧引擎截断响应晚到不能向当前引擎报告整条操作成功', async () => {
  const truncated = deferred<object>()
  const started = deferred<void>()
  const calls: EngineRequestInput[] = []
  const request = async <T>(input: EngineRequestInput): Promise<T> => {
    calls.push(input)
    if (input.path === '/conversation/history') return rows as T
    if (input.path === '/changes/revert-batch') return report(['reverted']) as T
    started.resolve()
    return await truncated.promise as T
  }
  const pending = revertConversationFrom(request, 'truncate-switch', target)
  const rejected = expect(pending).rejects.toThrow('引擎连接已变化')
  await started.promise
  changeSource()
  truncated.resolve({})
  await rejected
  expect(calls.map(call => call.path)).toEqual(['/conversation/history', '/changes/revert-batch', '/conversation/truncate'])
  expect(getRevertReport('truncate-switch')).toBeNull()
})
