/** Pure current contracts: independent defaults, nullable session overrides, disabled capability and stale results. */
import { expect, test } from '@playwright/test'
import { createMemoryScopeStore, createMemoryPreferencesStore } from '../src/renderer/src/core/engine/memory-state'
import { MEMORY_DISABLED_MESSAGE, MemoryDisabledError, parseMemorySettings, parseMemoryPreferences,
  setMemoryScope, setSessionMemoryEnabled, type MemorySettings, type MemoryPreferences } from '../src/renderer/src/core/engine/memory'
import { changeMemoryPreferences, getMemoryPreferencesState, getMemoryScopeState, refreshMemoryPreferences,
  refreshMemoryScope, resetMemoryPreferencesStore, resetMemoryScopeStore } from '../src/renderer/src/core/engine/memory-store'
import { publishEngineSource } from '../src/renderer/src/core/engine/source'
import type { EngineRequestInput } from '../src/shared/ipc'

function settings(sessionId: string, patch: Partial<MemorySettings> = {}): MemorySettings {
  return { sessionId, memoryScope: 'session', effectiveScope: 'session', enabled: true,
    globalEnabled: false, sessionDefaultEnabled: true, sessionOverride: null, sessionEnabled: true, effectiveScopes: ['session'], ...patch }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve() }
async function engineFixture(request: (input: EngineRequestInput) => Promise<unknown>, run: () => Promise<void>) {
  publishEngineSource({ mode: 'embedded', baseUrl: 'http://127.0.0.1:12447', instanceId: 'memory-preferences-fixture', phase: 'ready' })
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { aether: { engine: { request } } } })
  try { await run() } finally {
    resetMemoryScopeStore(); resetMemoryPreferencesStore()
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

test('独立记忆开关解析保留双范围、拒绝非法字段，服务端禁用时有效范围始终为空', () => {
  const both = settings('A', { globalEnabled: true, effectiveScopes: ['global', 'session'] })
  expect(parseMemorySettings(both, 'A')).toMatchObject({ globalEnabled: true, sessionOverride: null, effectiveScopes: ['global', 'session'] })
  expect(parseMemorySettings({ ...both, enabled: false }, 'A')).toMatchObject({ enabled: false, effectiveScope: 'off', effectiveScopes: [] })
  expect(() => parseMemorySettings({ ...both, effectiveScopes: ['session', 'session'] }, 'A')).toThrow('未知')
  expect(() => parseMemorySettings({ ...both, sessionOverride: 'inherit' }, 'A')).toThrow('覆盖值')
  expect(() => parseMemorySettings({ ...both, sessionEnabled: 'true' }, 'A')).toThrow('开关')
  expect(parseMemoryPreferences({ globalEnabled: false, sessionDefaultEnabled: true, enabled: false })).toEqual({ globalEnabled: false, sessionDefaultEnabled: true, enabled: false })
  expect(() => parseMemoryPreferences({ globalEnabled: false })).toThrow('升级引擎')
})

test('已知服务端禁用时不会发出开启请求或清空已确认会话状态', async () => {
  let writes = 0
  const store = createMemoryScopeStore({
    read: async sessionId => settings(sessionId, { enabled: false, effectiveScope: 'off', effectiveScopes: [] }),
    write: async sessionId => { writes++; return settings(sessionId) },
    writeSession: async sessionId => { writes++; return settings(sessionId) }
  })
  await store.refresh('A')
  await expect(store.changeSession('A', true)).rejects.toThrow(MEMORY_DISABLED_MESSAGE)
  await expect(store.change('A', 'global')).rejects.toThrow(MEMORY_DISABLED_MESSAGE)
  expect(writes).toBe(0)
  expect(store.getSnapshot()).toMatchObject({ sessionId: 'A', scope: 'session', sessionOverride: null, sessionEnabled: true,
    enabled: false, effectiveScopes: [], loaded: true, loading: false })
})

test('服务端禁用仍可保存会话关闭及恢复继承，不修改全局偏好', async () => {
  const saved: Array<boolean | null> = []
  const store = createMemoryScopeStore({
    read: async sessionId => settings(sessionId, { enabled: false, effectiveScope: 'off', effectiveScopes: [] }),
    write: async sessionId => settings(sessionId),
    writeSession: async (sessionId, choice) => { saved.push(choice); return settings(sessionId, { enabled: false, effectiveScope: 'off', effectiveScopes: [], sessionOverride: choice, sessionEnabled: choice ?? true }) }
  })
  await store.refresh('A'); await store.changeSession('A', false)
  expect(store.getSnapshot()).toMatchObject({ sessionOverride: false, sessionEnabled: false, globalEnabled: false, loaded: true })
  await store.changeSession('A', null)
  expect(saved).toEqual([false, null])
  expect(store.getSnapshot()).toMatchObject({ sessionOverride: null, sessionEnabled: true, enabled: false, effectiveScopes: [] })
})

test('开启过程中服务端关闭能力时采用409返回的已确认状态，无额外PUT或GET循环', async () => {
  let reads = 0, writes = 0
  const refused = settings('A', { enabled: false, effectiveScope: 'off', effectiveScopes: [], sessionOverride: false, sessionEnabled: false })
  const store = createMemoryScopeStore({
    read: async sessionId => { reads++; return settings(sessionId, { sessionOverride: false, sessionEnabled: false }) },
    write: async sessionId => settings(sessionId),
    writeSession: async () => { writes++; throw new MemoryDisabledError(refused) }
  })
  await store.refresh('A')
  await expect(store.changeSession('A', true)).rejects.toThrow(MEMORY_DISABLED_MESSAGE)
  expect({ reads, writes }).toEqual({ reads: 1, writes: 1 })
  expect(store.getSnapshot()).toMatchObject({ sessionOverride: false, sessionEnabled: false, enabled: false, loaded: true, effectiveScopes: [], error: MEMORY_DISABLED_MESSAGE })
})

test('旧引擎禁用拒绝只补一次GET确认，迟到结果不能污染切换后的会话', async () => {
  const recovery = deferred<MemorySettings>()
  let reads = 0
  const store = createMemoryScopeStore({
    read: async sessionId => { reads++; return reads === 2 ? recovery.promise : settings(sessionId) },
    write: async sessionId => settings(sessionId),
    writeSession: async () => { throw new MemoryDisabledError() }
  })
  await store.refresh('A')
  const rejected = store.changeSession('A', true).catch(() => undefined)
  await flush()
  expect(reads).toBe(2)
  await store.refresh('B')
  recovery.resolve(settings('A', { enabled: false, effectiveScope: 'off', effectiveScopes: [] }))
  await rejected
  expect(store.getSnapshot()).toMatchObject({ sessionId: 'B', enabled: true, loaded: true, effectiveScopes: ['session'], error: null })
})

test('旧引擎英文禁用错误归一化中文，其他409保留实际原因', async () => {
  let response = { ok: false, code: 40900, message: 'Long-term memory is disabled by server configuration; choose memoryScope=off or enable ENABLE_LONG_TERM_MEMORY', data: null }
  await engineFixture(async () => response, async () => {
    await expect(setMemoryScope('A', 'session')).rejects.toThrow(MEMORY_DISABLED_MESSAGE)
    await expect(setSessionMemoryEnabled('A', true)).rejects.toThrow(MEMORY_DISABLED_MESSAGE)
    response = { ...response, message: '配置版本冲突，请重新读取' }
    await expect(setSessionMemoryEnabled('A', true)).rejects.toThrow('配置版本冲突')
  })
})

test('会话开关只发送boolean或null，不通过会话接口改全局设置', async () => {
  const requests: EngineRequestInput[] = []
  await engineFixture(async input => { requests.push(input); return { ok: true, code: 200, message: '', data: settings('A') } }, async () => {
    await setSessionMemoryEnabled('A', false); await setSessionMemoryEnabled('A', null)
    expect(requests.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: 'PUT', path: '/memory/settings', body: { sessionId: 'A', sessionEnabled: false } },
      { method: 'PUT', path: '/memory/settings', body: { sessionId: 'A', sessionEnabled: null } }
    ])
  })
})

test('默认值状态禁止已知不可用的全局开启，但允许编辑会话默认值', async () => {
  const saved: unknown[] = []
  let preferences: MemoryPreferences = { globalEnabled: false, sessionDefaultEnabled: true, enabled: false }
  const store = createMemoryPreferencesStore({ read: async () => preferences,
    write: async patch => { saved.push(patch); preferences = { ...preferences, ...patch }; return preferences } })
  await store.refresh()
  await expect(store.change({ globalEnabled: true })).rejects.toThrow(MEMORY_DISABLED_MESSAGE)
  expect(saved).toEqual([])
  expect(store.getSnapshot()).toMatchObject({ loaded: true, preferences: { globalEnabled: false, enabled: false } })
  await store.change({ sessionDefaultEnabled: false })
  expect(saved).toEqual([{ sessionDefaultEnabled: false }])
  expect(store.getSnapshot()).toMatchObject({ loaded: true, preferences: { sessionDefaultEnabled: false, enabled: false }, error: null })
})

test('全局开启被服务端新禁用能力拒绝后保留偏好并更新已知能力，不反复发送开启请求', async () => {
  let writes = 0
  const preferences: MemoryPreferences = { globalEnabled: false, sessionDefaultEnabled: true, enabled: true }
  const store = createMemoryPreferencesStore({ read: async () => preferences, write: async () => {
    writes++; throw new MemoryDisabledError(undefined, { ...preferences, enabled: false })
  } })
  await store.refresh()
  await expect(store.change({ globalEnabled: true })).rejects.toThrow(MEMORY_DISABLED_MESSAGE)
  expect(store.getSnapshot()).toMatchObject({ loaded: true, loading: false, preferences: { globalEnabled: false, sessionDefaultEnabled: true, enabled: false } })
  await expect(store.change({ globalEnabled: true })).rejects.toThrow(MEMORY_DISABLED_MESSAGE)
  expect(writes).toBe(1)
})

test('修改默认值后刷新当前继承会话，切换引擎会清空两种设置快照', async () => {
  let preferences: MemoryPreferences = { globalEnabled: false, sessionDefaultEnabled: true, enabled: true }
  const paths: string[] = []
  await engineFixture(async input => {
    paths.push(`${input.method} ${input.path}`)
    if (input.path === '/memory/preferences') {
      if (input.method === 'PUT') preferences = { ...preferences, ...input.body as object }
      return { ok: true, code: 200, message: '', data: preferences }
    }
    return { ok: true, code: 200, message: '', data: settings('A', { ...preferences, sessionEnabled: preferences.sessionDefaultEnabled,
      effectiveScope: preferences.sessionDefaultEnabled ? 'session' : 'off', effectiveScopes: preferences.sessionDefaultEnabled ? ['session'] : [] }) }
  }, async () => {
    publishEngineSource({ mode: 'remote', baseUrl: 'http://memory-preferences-a:12323', instanceId: 'preferences-a', phase: 'ready' })
    await refreshMemoryPreferences(); await refreshMemoryScope('A')
    await changeMemoryPreferences({ sessionDefaultEnabled: false })
    expect(getMemoryPreferencesState()).toMatchObject({ preferences: { sessionDefaultEnabled: false }, loaded: true })
    expect(getMemoryScopeState()).toMatchObject({ sessionOverride: null, sessionEnabled: false, effectiveScopes: [], loaded: true })
    expect(paths).toEqual(['GET /memory/preferences', 'GET /memory/settings', 'PUT /memory/preferences', 'GET /memory/settings'])
    publishEngineSource({ mode: 'remote', baseUrl: 'http://memory-preferences-b:12323', instanceId: 'preferences-b', phase: 'ready' })
    expect(getMemoryPreferencesState()).toMatchObject({ preferences: null, loaded: false })
    expect(getMemoryScopeState()).toMatchObject({ sessionId: '', loaded: false })
  })
})

test('A记忆写入未完成时切到B再切回A，等待PUT后重新GET确认范围', async () => {
  const gate = deferred<void>(), reads: string[] = []
  let serverEnabled = true
  const store = createMemoryScopeStore({ read: async sessionId => {
    reads.push(sessionId); return settings(sessionId, { sessionEnabled: serverEnabled, sessionOverride: serverEnabled,
      effectiveScope: serverEnabled ? 'session' : 'off', effectiveScopes: serverEnabled ? ['session'] : [] })
  }, write: async sessionId => settings(sessionId), writeSession: async (sessionId, choice) => {
    await gate.promise; serverEnabled = choice ?? true
    return settings(sessionId, { sessionEnabled: serverEnabled, sessionOverride: choice })
  } })
  await store.refresh('A')
  const pending = store.changeSession('A', false)
  await flush(); await store.refresh('B')
  const back = store.refresh('A')
  await flush()
  expect(reads).toEqual(['A', 'B'])
  expect(store.getSnapshot()).toMatchObject({ sessionId: 'A', loaded: false, loading: true })
  gate.resolve(); await Promise.all([pending, back])
  expect(reads).toEqual(['A', 'B', 'A'])
  expect(store.getSnapshot()).toMatchObject({ sessionId: 'A', sessionEnabled: false, effectiveScopes: [], loaded: true, error: null })
})

for (const applied of [false, true]) {
  test(`A写入响应失败后切回，GET读取实际${applied ? '已关闭' : '仍开启'}状态，不猜测PUT是否生效`, async () => {
    const gate = deferred<void>(), reads: string[] = []
    let serverEnabled = true
    const store = createMemoryScopeStore({ read: async sessionId => {
      reads.push(sessionId); return settings(sessionId, { sessionEnabled: serverEnabled, sessionOverride: serverEnabled,
        effectiveScope: serverEnabled ? 'session' : 'off', effectiveScopes: serverEnabled ? ['session'] : [] })
    }, write: async sessionId => settings(sessionId), writeSession: async () => {
      await gate.promise; if (applied) serverEnabled = false; throw new Error('response lost')
    } })
    await store.refresh('A')
    const failed = store.changeSession('A', false).catch(() => undefined)
    await flush(); await store.refresh('B')
    const back = store.refresh('A')
    await flush(); expect(reads).toEqual(['A', 'B'])
    gate.resolve(); await Promise.all([failed, back])
    expect(reads).toEqual(['A', 'B', 'A'])
    expect(store.getSnapshot()).toMatchObject({ sessionId: 'A', sessionEnabled: !applied,
      effectiveScopes: applied ? [] : ['session'], loaded: true, error: null })
  })
}

test('切回A等待旧PUT时更换引擎，不向新连接发送旧GET或应用旧结果', async () => {
  publishEngineSource({ mode: 'remote', baseUrl: 'http://memory-race-a:12323', instanceId: 'memory-race-a', phase: 'ready' })
  const gate = deferred<MemorySettings>(), reads: string[] = []
  const store = createMemoryScopeStore({ read: async sessionId => { reads.push(sessionId); return settings(sessionId) },
    write: async sessionId => settings(sessionId), writeSession: async () => gate.promise })
  await store.refresh('A')
  const write = store.changeSession('A', false)
  await flush(); await store.refresh('B')
  const oldBack = store.refresh('A')
  await flush(); expect(reads).toEqual(['A', 'B'])
  publishEngineSource({ mode: 'remote', baseUrl: 'http://memory-race-b:12323', instanceId: 'memory-race-b', phase: 'ready' })
  await store.refresh('new-source-session')
  gate.resolve(settings('A', { sessionEnabled: false, sessionOverride: false, effectiveScope: 'off', effectiveScopes: [] }))
  await Promise.all([write, oldBack])
  expect(reads).toEqual(['A', 'B', 'new-source-session'])
  expect(store.getSnapshot()).toMatchObject({ sessionId: 'new-source-session', sessionEnabled: true, loaded: true, error: null })
})

test('同一会话连续记忆选择按顺序落到服务端，较早PUT不能覆盖较新选择', async () => {
  const first = deferred<MemorySettings>(), second = deferred<MemorySettings>(), choices: Array<boolean | null> = []
  const store = createMemoryScopeStore({ read: async sessionId => settings(sessionId), write: async sessionId => settings(sessionId),
    writeSession: async (_sessionId, choice) => { choices.push(choice); return choices.length === 1 ? first.promise : second.promise } })
  const one = store.changeSession('A', false), two = store.changeSession('A', true)
  await flush(); expect(choices).toEqual([false])
  first.resolve(settings('A', { sessionEnabled: false, sessionOverride: false }))
  await one; await flush(); expect(choices).toEqual([false, true])
  second.resolve(settings('A', { sessionEnabled: true, sessionOverride: true }))
  await two
  expect(store.getSnapshot()).toMatchObject({ sessionId: 'A', sessionEnabled: true, sessionOverride: true, loaded: true })
})

test('默认设置PUT等待期间切换引擎，不刷新新引擎当前会话', async () => {
  const gate = deferred<unknown>(), calls: string[] = []
  await engineFixture(async input => {
    calls.push(`${input.method} ${input.path} ${input.query?.sessionId ?? ''}`)
    if (input.method === 'PUT') return gate.promise
    return { ok: true, code: 200, message: '', data: input.path === '/memory/preferences'
      ? { globalEnabled: false, sessionDefaultEnabled: true, enabled: true } : settings(String(input.query?.sessionId)) }
  }, async () => {
    await refreshMemoryPreferences(); await refreshMemoryScope('old-session')
    const pending = changeMemoryPreferences({ sessionDefaultEnabled: false }).catch(error => String(error))
    await flush()
    publishEngineSource({ mode: 'remote', baseUrl: 'http://memory-new-preferences:12323', instanceId: 'memory-new-preferences', phase: 'ready' })
    await refreshMemoryScope('new-session')
    gate.resolve({ ok: true, code: 200, message: '', data: { globalEnabled: false, sessionDefaultEnabled: false, enabled: true } })
    expect(await pending).toContain('引擎连接已变化')
    expect(calls.filter(call => call.includes('new-session'))).toEqual(['GET /memory/settings new-session'])
    expect(getMemoryScopeState()).toMatchObject({ sessionId: 'new-session', loaded: true, sessionEnabled: true })
    expect(getMemoryPreferencesState()).toMatchObject({ preferences: null, loaded: false })
  })
})
