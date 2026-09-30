/** Pure contracts: endpoint state isolation, stale in-flight model responses, and IPC identity. No Electron. */
import { expect, test } from '@playwright/test'
import { selectSessionId, settingsPatchForSource } from '../src/renderer/src/core/engine/session-selection'
import {
  assertEngineSource, engineStorageKey, getEngineSource, getEngineStorageKey,
  getExpectedEngine, publishEngineSource, sessionStorageKey
} from '../src/renderer/src/core/engine/source'
import { loadChatDraft, saveChatDraft } from '../src/renderer/src/contrib/chat/draft-store'
import { registerPendingSession, listPendingSessions } from '../src/renderer/src/contrib/history/pending-sessions'
import { getSessionMeta, patchSessionMeta } from '../src/renderer/src/contrib/history/session-meta'
import { getModelState, refreshModels, resetModelStore } from '../src/renderer/src/core/engine/model-store'

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
  clear(): void { this.values.clear() }
}
const readyRemote = (name: string, instanceId = name): Parameters<typeof publishEngineSource>[0] => ({
  mode: 'remote', baseUrl: 'http://' + name + ':12323', instanceId, phase: 'ready'
})

test.beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true })
  Object.defineProperty(globalThis, 'sessionStorage', { value: new MemoryStorage(), configurable: true })
})

test('相同会话ID的草稿、名称与占位会话按远端服务隔离', () => {
  publishEngineSource(readyRemote('store-a'))
  const sourceA = getEngineStorageKey()
  saveChatDraft('same-id', 'draft A')
  patchSessionMeta('same-id', { name: 'name A', workspacePath: 'C:/must-not-open' })
  registerPendingSession('same-id')
  expect(getSessionMeta('same-id').workspacePath).toBeUndefined()
  publishEngineSource(readyRemote('store-b'))
  expect(loadChatDraft('same-id')).toBe('')
  expect(getSessionMeta('same-id')).toEqual({})
  expect(listPendingSessions()).toEqual([])
  saveChatDraft('same-id', 'draft B')
  saveChatDraft('same-id', 'delayed A draft', sourceA)
  expect(loadChatDraft('same-id')).toBe('draft B')
  publishEngineSource(readyRemote('store-a', 'new-instance'))
  expect(loadChatDraft('same-id')).toBe('delayed A draft')
  expect(getSessionMeta('same-id').name).toBe('name A')
  expect(listPendingSessions().map(item => item.sessionId)).toEqual(['same-id'])
})

test('断开使旧操作失效，进程重启保留endpoint偏好，空连接不覆盖存储来源', () => {
  publishEngineSource(readyRemote('identity'))
  const old = getEngineSource()
  const storage = getEngineStorageKey()
  expect(getExpectedEngine()).toEqual({ mode: 'remote', baseUrl: 'http://identity:12323', instanceId: 'identity' })
  publishEngineSource({ mode: 'remote', baseUrl: '', phase: 'starting' })
  expect(() => assertEngineSource(old)).toThrow('引擎连接已变化')
  expect(getEngineStorageKey()).toBe(storage)
  publishEngineSource(readyRemote('identity', 'restarted'))
  expect(getEngineSource()).not.toBe(old)
  expect(getEngineStorageKey()).toBe(storage)
  expect(engineStorageKey({ mode: 'embedded', baseUrl: 'http://localhost:12399' })).toBe('')
  expect(sessionStorageKey('legacy', '')).toBe('legacy')
})

test('旧模型请求完成后不能覆盖新源列表或清除新请求', async () => {
  type Reply = { ok: boolean; code: number; message: string; data: unknown }
  const pending: Array<(value: Reply) => void> = []
  const requests: Array<{ expectedEngine?: { baseUrl: string } }> = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    aether: { engine: { request: (input: { expectedEngine?: { baseUrl: string } }) => {
      requests.push(input)
      return new Promise<Reply>(resolve => pending.push(resolve))
    } } }
  } })
  publishEngineSource(readyRemote('model-a'))
  resetModelStore()
  const first = refreshModels()
  publishEngineSource(readyRemote('model-b'))
  resetModelStore()
  const second = refreshModels()
  expect(requests.map(input => input.expectedEngine?.baseUrl)).toEqual(['http://model-a:12323', 'http://model-b:12323'])
  pending[0]({ ok: true, code: 200, message: '', data: [{ id: 'a', modelId: 'model-a' }] })
  await first
  expect(getModelState().models).toEqual([])
  expect(refreshModels()).toBe(second)
  pending[1]({ ok: true, code: 200, message: '', data: [{ id: 'b', modelId: 'model-b' }] })
  await second
  expect(getModelState().models.map(model => model.modelId)).toEqual(['model-b'])
})

test('embedded显式主进程会话选择优先，旧localStorage会话不能覆盖它', () => {
  expect(selectSessionId('', 'main-explicit-session', 'stale-local-cache', () => 'new-session')).toBe('main-explicit-session')
  expect(selectSessionId('', '', 'stale-local-cache', () => 'new-session')).toBe('new-session')
  expect(selectSessionId('remote:http://a:12323', 'embedded-session', 'remote-a-session', () => 'new-session')).toBe('remote-a-session')
  expect(selectSessionId('remote:http://b:12323', 'embedded-session', '', () => 'remote-b-new')).toBe('remote-b-new')
})

test('远端选择仅留在endpoint映射，不持久化到embedded legacy字段', () => {
  const patch = { lastSessionId: 'remote-session', lastModelId: 'chosen-model' }
  expect(settingsPatchForSource('remote:http://a:12323', patch)).toEqual({ lastModelId: 'chosen-model' })
  expect(settingsPatchForSource('remote:http://a:12323', { lastSessionId: 'remote-only' })).toEqual({})
  expect(settingsPatchForSource('', { lastSessionId: 'embedded-explicit' })).toEqual({ lastSessionId: 'embedded-explicit' })
  expect(patch).toEqual({ lastSessionId: 'remote-session', lastModelId: 'chosen-model' })
  const main = { lastSessionId: 'embedded-selected', lastModelId: 'old-model' }
  Object.assign(main, settingsPatchForSource('remote:http://a:12323', patch))
  expect(main).toEqual({ lastSessionId: 'embedded-selected', lastModelId: 'chosen-model' })
  expect(selectSessionId('', main.lastSessionId, 'remote-session', () => 'unexpected')).toBe('embedded-selected')
})
