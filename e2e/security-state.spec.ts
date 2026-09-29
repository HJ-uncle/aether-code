import { expect, test } from '@playwright/test'
import { createSecurityModeStore } from '../src/renderer/src/core/engine/security-state'
import { getSecurityMode, type SecurityMode } from '../src/renderer/src/core/engine/security'

/** Pure transport races: deferred promises exercise the same store used by all React consumers. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture() {
  const reads: Array<{ sessionId: string; result: ReturnType<typeof deferred<SecurityMode>> }> = []
  const writes: Array<{ sessionId: string; mode: SecurityMode; result: ReturnType<typeof deferred<void>> }> = []
  const store = createSecurityModeStore({
    read(sessionId) {
      const result = deferred<SecurityMode>()
      reads.push({ sessionId, result })
      return result.promise
    },
    write(sessionId, mode) {
      const result = deferred<void>()
      writes.push({ sessionId, mode, result })
      return result.promise
    }
  })
  return { store, reads, writes }
}

test('A 未返回就切 B：B 发独立请求，迟到 A 不能改变 B 的已确认模式', async () => {
  const { store, reads } = fixture()
  const a = store.refresh('A')
  const b = store.refresh('B')
  await Promise.resolve()
  expect(reads.map(request => request.sessionId)).toEqual(['A', 'B'])
  expect(store.getSnapshot()).toMatchObject({ sessionId: 'B', mode: null, loading: true, loaded: false })
  reads[1].result.resolve('standard')
  await b
  reads[0].result.resolve('safe')
  await a
  expect(store.getSnapshot()).toMatchObject({ sessionId: 'B', mode: 'standard', loading: false, loaded: true })
})

test('A→B→A 不复用上一代 A 请求，新 A 请求独立完成', async () => {
  const { store, reads } = fixture()
  const oldA = store.refresh('A')
  const b = store.refresh('B')
  const newA = store.refresh('A')
  await Promise.resolve()
  expect(reads.map(request => request.sessionId)).toEqual(['A', 'B', 'A'])
  reads[2].result.resolve('full-access')
  await newA
  reads[0].result.resolve('safe')
  reads[1].result.reject(new Error('Old B failed'))
  await Promise.all([oldA, b])
  expect(store.getSnapshot()).toMatchObject({ sessionId: 'A', mode: 'full-access', error: null })
})

test('同会话同一代请求去重，错误保持未知并允许显式重试', async () => {
  const { store, reads } = fixture()
  const first = store.refresh('A')
  expect(store.refresh('A')).toBe(first)
  await Promise.resolve()
  expect(reads).toHaveLength(1)
  reads[0].result.reject(new Error('offline'))
  await first
  expect(store.getSnapshot()).toMatchObject({ sessionId: 'A', mode: null, loaded: false, loading: false, error: 'offline' })
  const retry = store.refresh('A')
  await Promise.resolve()
  reads[1].result.resolve('standard')
  await retry
  expect(store.getSnapshot()).toMatchObject({ mode: 'standard', loaded: true, error: null })
})

test('重置使在途请求失效，即使随后重新打开同一会话', async () => {
  const { store, reads } = fixture()
  const old = store.refresh('A')
  store.reset()
  expect(store.getSnapshot()).toMatchObject({ sessionId: '', mode: null, loaded: false })
  const next = store.refresh('A')
  await Promise.resolve()
  reads[0].result.resolve('full-access')
  await old
  expect(store.getSnapshot()).toMatchObject({ mode: null, loading: true })
  reads[1].result.resolve('safe')
  await next
  expect(store.getSnapshot().mode).toBe('safe')
})

test('PUT 完成前不显示已切换，旧 GET 不能覆盖成功的 PUT', async () => {
  const { store, reads, writes } = fixture()
  const read = store.refresh('A')
  const change = store.change('A', 'full-access')
  await Promise.resolve()
  expect(store.getSnapshot()).toMatchObject({ mode: null, loaded: false, loading: true })
  writes[0].result.resolve()
  await change
  reads[0].result.resolve('safe')
  await read
  expect(store.getSnapshot()).toMatchObject({ mode: 'full-access', loaded: true, loading: false })
})

test('切 B 后 A 的失败 PUT 不回滚 B；当前 PUT 失败也不猜测旧模式仍有效', async () => {
  const { store, reads, writes } = fixture()
  const a = store.change('A', 'standard').catch(() => undefined)
  const b = store.refresh('B')
  await Promise.resolve()
  reads[0].result.resolve('full-access')
  await b
  writes[0].result.reject(new Error('Old A failed'))
  await a
  expect(store.getSnapshot()).toMatchObject({ sessionId: 'B', mode: 'full-access', error: null })
  const bChange = store.change('B', 'safe').catch(() => undefined)
  await Promise.resolve()
  writes[1].result.reject(new Error('Connection lost after write'))
  await bChange
  expect(store.getSnapshot()).toMatchObject({ sessionId: 'B', mode: null, loaded: false, loading: false, error: 'Connection lost after write' })
})

test('PUT 在途时刷新等待该请求，不能以旧服务端 GET 抹掉修改', async () => {
  const { store, reads, writes } = fixture()
  const change = store.change('A', 'standard')
  const refresh = store.refresh('A')
  await Promise.resolve()
  expect(reads).toHaveLength(0)
  writes[0].result.resolve()
  await Promise.all([change, refresh])
  expect(store.getSnapshot().mode).toBe('standard')
})

test('安全客户端拒绝未知值与会话错配，不把非法响应转换为 safe', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let response: unknown = { sessionId: 'A', mode: 'new-unrecognized-mode' }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { aether: { engine: {
    request: async () => ({ ok: true, data: response })
  } } } })
  try {
    await expect(getSecurityMode('A')).rejects.toThrow('未知')
    response = { sessionId: 'B', mode: 'safe' }
    await expect(getSecurityMode('A')).rejects.toThrow('不匹配')
    response = { sessionId: 'A', mode: 'standard' }
    expect(await getSecurityMode('A')).toBe('standard')
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
