/** Pure contracts for the per-session memory selector and its source boundary. */
import { expect, test } from '@playwright/test'
import { createMemoryScopeStore } from '../src/renderer/src/core/engine/memory-state'
import { parseMemorySettings } from '../src/renderer/src/core/engine/memory'
import {
  getMemoryScopeState,
  resetMemoryScopeStore,
  refreshMemoryScope
} from '../src/renderer/src/core/engine/memory-store'
import { publishEngineSource } from '../src/renderer/src/core/engine/source'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('记忆设置解析只接受合法范围并阻止会话错配', () => {
  expect(parseMemorySettings({ sessionId: 's-1', memoryScope: 'session', effectiveScope: 'session', enabled: true }, 's-1'))
    .toEqual({ sessionId: 's-1', memoryScope: 'session', effectiveScope: 'session', enabled: true })
  expect(parseMemorySettings({ sessionId: 's-1', scope: 'global' }, 's-1'))
    .toMatchObject({ sessionId: 's-1', memoryScope: 'global', effectiveScope: 'global', enabled: true })
  expect(() => parseMemorySettings({ sessionId: 's-2', memoryScope: 'session' }, 's-1')).toThrow('会话不匹配')
  expect(() => parseMemorySettings({ sessionId: 's-1', memoryScope: 'workspace' }, 's-1')).toThrow('未知')
})

test('切换会话时迟到的读取结果不能污染当前记忆范围', async () => {
  const reads: Array<{ sessionId: string; result: ReturnType<typeof deferred<{ sessionId: string; memoryScope: 'global' | 'session'; effectiveScope: 'global' | 'session'; enabled: boolean }>> }> = []
  const store = createMemoryScopeStore({
    read(sessionId) {
      const result = deferred<{ sessionId: string; memoryScope: 'global' | 'session'; effectiveScope: 'global' | 'session'; enabled: boolean }>()
      reads.push({ sessionId, result })
      return result.promise
    },
    write: async (_sessionId, scope) => ({ sessionId: 'unused', memoryScope: scope, effectiveScope: scope, enabled: true })
  })
  const first = store.refresh('A')
  const second = store.refresh('B')
  await Promise.resolve()
  expect(reads.map((item) => item.sessionId)).toEqual(['A', 'B'])
  reads[1].result.resolve({ sessionId: 'B', memoryScope: 'session', effectiveScope: 'session', enabled: true })
  await second
  reads[0].result.resolve({ sessionId: 'A', memoryScope: 'global', effectiveScope: 'global', enabled: true })
  await first
  expect(store.getSnapshot()).toMatchObject({ sessionId: 'B', scope: 'session', effectiveScope: 'session', loaded: true, error: null })
})

test('待写入时刷新不会用旧 GET 覆盖已确认范围，写入失败时保持未知', async () => {
  const writes: Array<{ scope: 'global' | 'session'; result: ReturnType<typeof deferred<{ sessionId: string; memoryScope: 'global' | 'session'; effectiveScope: 'global' | 'session'; enabled: boolean }>> }> = []
  const store = createMemoryScopeStore({
    read: async () => ({ sessionId: 'A', memoryScope: 'global', effectiveScope: 'global', enabled: true }),
    write(_sessionId, scope) {
      const result = deferred<{ sessionId: string; memoryScope: 'global' | 'session'; effectiveScope: 'global' | 'session'; enabled: boolean }>()
      writes.push({ scope, result })
      return result.promise
    }
  })
  const change = store.change('A', 'session')
  const refresh = store.refresh('A')
  await Promise.resolve()
  expect(writes).toHaveLength(1)
  writes[0].result.resolve({ sessionId: 'A', memoryScope: 'session', effectiveScope: 'session', enabled: true })
  await Promise.all([change, refresh])
  expect(store.getSnapshot()).toMatchObject({ sessionId: 'A', scope: 'session', loaded: true })

  const failed = store.change('A', 'global').catch(() => undefined)
  await Promise.resolve()
  writes[1].result.reject(new Error('offline'))
  await failed
  expect(store.getSnapshot()).toMatchObject({ sessionId: 'A', scope: null, loaded: false, error: 'offline' })
})

test('切换本地/远端引擎会清空旧会话的记忆设置快照', async () => {
  resetMemoryScopeStore()
  publishEngineSource({ mode: 'remote', baseUrl: 'http://memory-a:12323', instanceId: 'memory-a', phase: 'ready' })
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let response: unknown = { sessionId: 'same', memoryScope: 'session', effectiveScope: 'session', enabled: true }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { aether: { engine: {
    request: async () => ({ ok: true, code: 200, message: '', data: response })
  } } } })
  try {
    await refreshMemoryScope('same')
    expect(getMemoryScopeState()).toMatchObject({ sessionId: 'same', scope: 'session', loaded: true })
    publishEngineSource({ mode: 'remote', baseUrl: 'http://memory-b:12323', instanceId: 'memory-b', phase: 'ready' })
    expect(getMemoryScopeState()).toMatchObject({ sessionId: '', scope: null, loaded: false })
    // The next source can load its own value without reusing the prior source.
    response = { sessionId: 'same', memoryScope: 'global', effectiveScope: 'global', enabled: true }
    await refreshMemoryScope('same')
    expect(getMemoryScopeState()).toMatchObject({ sessionId: 'same', scope: 'global', loaded: true })
  } finally {
    resetMemoryScopeStore()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
