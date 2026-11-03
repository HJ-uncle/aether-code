import { expect, test } from '@playwright/test'
import { sessionConnectionPresentation } from '../src/renderer/src/contrib/chat/session-connection-presentation'
import { cancelWorkTask } from '../src/renderer/src/contrib/work/work-task-cancel'
import { applyRootRun } from '../src/renderer/src/core/engine/root-run-state'
import type { RootRun } from '../src/shared/root-run'

test('断连反馈不把旧的运行中状态当成任务仍在执行的证据', () => {
  const options = { ready: true, sessionId: 'session', source: 2, active: true,
    connection: { scope: { source: 2, sessionId: 'session', viewEpoch: 1 }, phase: 'retrying' as const, failures: 1 } }
  expect(sessionConnectionPresentation(options)).toEqual({ label: '连接中断，正在恢复；任务状态待确认', busy: true, retry: false })
  expect(sessionConnectionPresentation({ ...options, source: 3 })).toBeNull()
  expect(sessionConnectionPresentation({ ...options, sessionId: 'another' })).toBeNull()
  expect(sessionConnectionPresentation({ ...options, connection: { ...options.connection, phase: 'blocked' } })).toMatchObject({ retry: true, busy: false })
  expect(sessionConnectionPresentation({ ...options, connection: { ...options.connection, phase: 'attached' } })).toBeNull()
})

test('正常停止只显示取消状态，不生成错误提示；真实异常仍保留诊断', () => {
  const run: RootRun = { schemaVersion: 1, runId: 'run', sessionId: 'session', turnId: 'turn', userMessageId: 'user', assistantMessageId: 'assistant',
    status: 'cancelled', seq: 1, version: 1, pending: [], createdAt: 1, updatedAt: 2 }
  const messages = [{ id: 'user', role: 'user' as const, content: '任务', thinking: '', tools: [], status: 'done' as const, createdAt: 1 }]
  expect(applyRootRun(messages, run)[1]).toMatchObject({ status: 'aborted', error: undefined })
  expect(applyRootRun(messages, { ...run, status: 'failed', error: { code: 'CHAT_FAILED', message: '真实执行异常' } })[1].error).toBe('真实执行异常')
})

const status = (state: string, runId = 'original') => ({ run: { sessionId: 'session', runId, status: state } })
test('后台停止精确指向捕获的运行，收到完成状态后不误标已停止', async () => {
  const calls: unknown[] = [], reads = [status('running'), status('succeeded')]
  const result = await cancelWorkTask({ sessionId: 'session', isCurrent: () => true,
    readStatus: async () => reads.shift()!, cancel: async body => { calls.push(body); return { cancelled: false, settled: false } } })
  expect(calls).toEqual([{ sessionId: 'session', runId: 'original' }])
  expect(result).toBe('done')
})
test('后台取消以权威状态确认，不把成功回执等同于取消终态', async () => {
  const reads = [status('running'), status('running')]
  await expect(cancelWorkTask({ sessionId: 'session', isCurrent: () => true,
    readStatus: async () => reads.shift()!, cancel: async () => ({ cancelled: true, settled: true }) })).rejects.toThrow('尚未确认停止')
})
test('取消后新一轮已经开始时保留其运行状态，并且不取消新运行', async () => {
  const reads = [status('waiting'), status('running', 'next')], calls: unknown[] = []
  const result = await cancelWorkTask({ sessionId: 'session', isCurrent: () => true,
    readStatus: async () => reads.shift()!, cancel: async body => { calls.push(body); return { cancelled: true, settled: true } } })
  expect(result).toBe('running')
  expect(calls).toEqual([{ sessionId: 'session', runId: 'original' }])
})
test('已结束运行无需取消，未知或不匹配身份拒绝修改', async () => {
  let cancellations = 0
  const cancel = async () => { cancellations++; return {} }
  expect(await cancelWorkTask({ sessionId: 'session', isCurrent: () => true, readStatus: async () => status('cancelled'), cancel })).toBe('stopped')
  for (const run of [undefined, { sessionId: 'other', runId: 'run', status: 'running' }, { sessionId: 'session', runId: 'run', status: 'unknown' }]) {
    await expect(cancelWorkTask({ sessionId: 'session', isCurrent: () => true, readStatus: async () => ({ run }), cancel })).rejects.toThrow('尚未确认')
  }
  expect(cancellations).toBe(0)
})
test('引擎切换或取消失败不提交假的已停止状态', async () => {
  let current = true, cancellations = 0
  await expect(cancelWorkTask({ sessionId: 'session', isCurrent: () => current,
    readStatus: async () => { current = false; return status('running') },
    cancel: async () => { cancellations++; return {} } })).rejects.toThrow('连接已变化')
  expect(cancellations).toBe(0)
  await expect(cancelWorkTask({ sessionId: 'session', isCurrent: () => true,
    readStatus: async () => status('running'), cancel: async () => { throw new Error('停止服务不可用') } })).rejects.toThrow('停止服务不可用')
})
