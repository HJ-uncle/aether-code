import { expect, test } from '@playwright/test'
import { createSecurityModeStore } from '../src/renderer/src/core/engine/security-state'
import { getSecurityMode, type SecurityMode } from '../src/renderer/src/core/engine/security'
import { publishEngineSource } from '../src/renderer/src/core/engine/source'

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

/** Install a small localStorage double; the production store treats storage as optional. */
function localStorageFixture(initial: Record<string, string> = {}, options: { throwOnGet?: boolean; throwOnSet?: boolean } = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const values = new Map(Object.entries(initial))
  const storage = {
    getItem(key: string): string | null {
      if (options.throwOnGet) throw new Error('storage read blocked')
      return values.get(key) ?? null
    },
    setItem(key: string, value: string): void {
      if (options.throwOnSet) throw new Error('storage write blocked')
      values.set(key, value)
    }
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } })
  return {
    values,
    restore(): void {
      if (previous) Object.defineProperty(globalThis, 'window', previous)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  }
}

function publishEmbeddedSource(): void {
  publishEngineSource({ mode: 'embedded', baseUrl: '', phase: 'ready' })
}

function publishRemoteSource(baseUrl: string): void {
  publishEngineSource({ mode: 'remote', baseUrl, phase: 'ready', accountId: null, instanceId: 'fixture-instance' })
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
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

test('显式选择会写入本地偏好；引擎重启后读取默认值会补写已记忆模式', async () => {
  publishEmbeddedSource()
  const storage = localStorageFixture()
  try {
    const first = fixture()
    const change = first.store.change('A', 'full-access')
    await Promise.resolve()
    first.writes[0].result.resolve()
    await change
    expect(storage.values.get('aether:security-mode:A')).toBe('full-access')

    const next = fixture()
    const refresh = next.store.refresh('A')
    await Promise.resolve()
    next.reads[0].result.resolve('safe')
    await flushMicrotasks()
    expect(next.writes).toHaveLength(1)
    expect(next.writes[0]).toMatchObject({ sessionId: 'A', mode: 'full-access' })
    next.writes[0].result.resolve()
    await refresh
    expect(next.store.getSnapshot()).toMatchObject({ mode: 'full-access', loaded: true, error: null })
  } finally {
    storage.restore()
    publishEmbeddedSource()
  }
})

test('记忆按会话和引擎端点隔离，连接切换中的迟到响应不会写入新端点', async () => {
  publishEmbeddedSource()
  const storage = localStorageFixture()
  try {
    const embedded = fixture()
    const embeddedChange = embedded.store.change('A', 'full-access')
    await Promise.resolve()
    embedded.writes[0].result.resolve()
    await embeddedChange

    // Start an embedded refresh, then switch endpoint before its response arrives.
    // The stale request must not restore into either the new endpoint or the old
    // endpoint after the source identity is no longer current.
    const pending = fixture()
    const refresh = pending.store.refresh('A')
    await Promise.resolve()
    publishRemoteSource('https://remote.example.test/api')
    pending.reads[0].result.resolve('safe')
    await refresh
    expect(pending.writes).toHaveLength(0)

    const remote = fixture()
    const remoteRefresh = remote.store.refresh('A')
    await Promise.resolve()
    remote.reads[0].result.resolve('standard')
    await remoteRefresh
    expect(remote.store.getSnapshot()).toMatchObject({ mode: 'standard', loaded: true })
    expect(remote.writes).toHaveLength(0)

    const remoteChange = remote.store.change('B', 'safe')
    await Promise.resolve()
    remote.writes[0].result.resolve()
    await remoteChange
    expect([...storage.values.keys()].some(key => key.includes(encodeURIComponent('remote:https://remote.example.test/api')))).toBe(true)
    expect(storage.values.get('aether:security-mode:A')).toBe('full-access')
  } finally {
    storage.restore()
    publishEmbeddedSource()
  }
})

test('本地存储不可用不会阻断成功的安全模式切换，也不会伪造恢复状态', async () => {
  publishEmbeddedSource()
  const storage = localStorageFixture({}, { throwOnGet: true, throwOnSet: true })
  try {
    const { store, writes } = fixture()
    const change = store.change('A', 'full-access')
    await Promise.resolve()
    writes[0].result.resolve()
    await change
    expect(store.getSnapshot()).toMatchObject({ mode: 'full-access', loaded: true, error: null })
  } finally {
    storage.restore()
    publishEmbeddedSource()
  }
})

test('恢复记忆时写回引擎失败，保持未知状态并暴露错误，不假装已恢复', async () => {
  publishEmbeddedSource()
  const storage = localStorageFixture({ 'aether:security-mode:A': 'full-access' })
  try {
    const { store, reads, writes } = fixture()
    const refresh = store.refresh('A')
    await Promise.resolve()
    reads[0].result.resolve('safe')
    await flushMicrotasks()
    writes[0].result.reject(new Error('restore failed'))
    await refresh
    expect(store.getSnapshot()).toMatchObject({ mode: null, loaded: false, loading: false, error: 'restore failed' })
  } finally {
    storage.restore()
    publishEmbeddedSource()
  }
})

test('同一会话连续选择按顺序写入，旧 PUT 完成后不会覆盖最新的本地偏好', async () => {
  publishEmbeddedSource()
  const storage = localStorageFixture()
  try {
    const { store, writes } = fixture()
    const first = store.change('A', 'standard')
    const second = store.change('A', 'full-access')
    await flushMicrotasks()
    expect(writes).toHaveLength(1)
    writes[0].result.resolve()
    await flushMicrotasks()
    expect(writes).toHaveLength(2)
    expect(writes[1]).toMatchObject({ sessionId: 'A', mode: 'full-access' })
    writes[1].result.resolve()
    await Promise.all([first, second])
    expect(storage.values.get('aether:security-mode:A')).toBe('full-access')
    expect(store.getSnapshot()).toMatchObject({ mode: 'full-access', loaded: true, error: null })
  } finally {
    storage.restore()
    publishEmbeddedSource()
  }
})

test('用户新选择优先于在途恢复，不会被迟到的默认 GET 覆盖', async () => {
  publishEmbeddedSource()
  const storage = localStorageFixture({ 'aether:security-mode:A': 'full-access' })
  try {
    const { store, reads, writes } = fixture()
    const refresh = store.refresh('A')
    const change = store.change('A', 'standard')
    await flushMicrotasks()
    expect(reads).toHaveLength(1)
    expect(writes).toHaveLength(1)
    expect(writes[0].mode).toBe('standard')
    reads[0].result.resolve('safe')
    writes[0].result.resolve()
    await Promise.all([refresh, change])
    expect(writes).toHaveLength(1)
    expect(storage.values.get('aether:security-mode:A')).toBe('standard')
    expect(store.getSnapshot()).toMatchObject({ mode: 'standard', loaded: true, error: null })
  } finally {
    storage.restore()
    publishEmbeddedSource()
  }
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
