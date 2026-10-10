/** Pure contracts: requested model restoration and durable source/session manual choices. No Electron. */
import { expect, test } from '@playwright/test'
import { sessionStorageKey } from '../src/renderer/src/core/engine/source'
import {
  loadSessionModelSelection,
  resolveSessionComposerModel,
  saveSessionModelSelection
} from '../src/renderer/src/contrib/chat/session-model-store'

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

const selectionKey = (source = '') => sessionStorageKey('aether:sessionModelSelections', source)
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

test.beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true })
})

test.afterAll(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

test('composer restores the requested run model while actual fallback remains a message concern', () => {
  const run = { runId: 'qwen-run', modelId: 'qwen', actualModelId: 'deepseek' }
  expect(resolveSessionComposerModel({
    configuredModelId: run.modelId,
    runId: run.runId,
    defaultModelId: 'global-default'
  })).toBe('qwen')
  expect(run.actualModelId).toBe('deepseek')
})

test('manual unsent choice survives storage reload on its anchored run', () => {
  saveSessionModelSelection('session', { modelId: 'deepseek', anchorRunId: 'qwen-run' }, '')
  const reloaded = loadSessionModelSelection('session', '')
  expect(reloaded).toEqual({ modelId: 'deepseek', anchorRunId: 'qwen-run' })
  expect(resolveSessionComposerModel({
    configuredModelId: 'qwen', runId: 'qwen-run', selection: reloaded, defaultModelId: 'global-default'
  })).toBe('deepseek')
})

test('an external new run overrides an old manual choice when its requested model differs', () => {
  const selection = { modelId: 'deepseek', anchorRunId: 'old-run' }
  expect(resolveSessionComposerModel({
    configuredModelId: 'qwen', runId: 'external-new-run', selection, defaultModelId: 'global-default'
  })).toBe('qwen')
  expect(resolveSessionComposerModel({
    configuredModelId: 'deepseek', runId: 'accepted-local-run', selection, defaultModelId: 'global-default'
  })).toBe('deepseek')
})

test('only a new session uses the global default, and its manual choice can survive before a first run', () => {
  expect(resolveSessionComposerModel({ defaultModelId: 'global-default' })).toBe('global-default')
  const selection = { modelId: 'qwen' }
  saveSessionModelSelection('new-session', selection, '')
  expect(resolveSessionComposerModel({
    selection: loadSessionModelSelection('new-session', ''), defaultModelId: 'global-default'
  })).toBe('qwen')
  expect(resolveSessionComposerModel({
    runId: 'existing-run', selection, defaultModelId: 'global-default'
  })).toBe('')
})

test('the same session ID is isolated by endpoint/account and delayed old-source writes keep their ownership', () => {
  const sourceA = 'remote:http://engine-a:12323:account:a'
  const sourceB = 'remote:http://engine-a:12323:account:b'
  saveSessionModelSelection('same-session', { modelId: 'qwen', anchorRunId: 'local-run' }, '')
  saveSessionModelSelection('same-session', { modelId: 'remote-a', anchorRunId: 'run-a' }, sourceA)
  saveSessionModelSelection('same-session', { modelId: 'remote-b', anchorRunId: 'run-b' }, sourceB)
  saveSessionModelSelection('other-session', { modelId: 'other-model' }, sourceB)
  saveSessionModelSelection('same-session', { modelId: 'delayed-a', anchorRunId: 'run-a' }, sourceA)
  expect(loadSessionModelSelection('same-session', '')).toEqual({ modelId: 'qwen', anchorRunId: 'local-run' })
  expect(loadSessionModelSelection('same-session', sourceA)).toEqual({ modelId: 'delayed-a', anchorRunId: 'run-a' })
  expect(loadSessionModelSelection('same-session', sourceB)).toEqual({ modelId: 'remote-b', anchorRunId: 'run-b' })
  expect(loadSessionModelSelection('other-session', sourceB)).toEqual({ modelId: 'other-model' })
  expect(loadSessionModelSelection('missing-session', sourceB)).toBeNull()
})

test('invalid JSON and invalid selection fields cannot become a model choice', () => {
  for (const raw of ['{broken', 'null', '[]', '"string"', '42']) {
    localStorage.setItem(selectionKey(), raw)
    expect(loadSessionModelSelection('session', '')).toBeNull()
  }
  localStorage.setItem(selectionKey(), JSON.stringify({
    missing: {}, blank: { modelId: '   ' }, numeric: { modelId: 3 },
    array: ['qwen'], invalidAnchor: { modelId: 'qwen', anchorRunId: 9 },
    emptyAnchor: { modelId: 'qwen', anchorRunId: '' },
    valid: { modelId: 'qwen', anchorRunId: 'run', ignored: 'extra' }
  }))
  for (const sessionId of ['missing', 'blank', 'numeric', 'array', 'invalidAnchor', 'emptyAnchor']) {
    expect(loadSessionModelSelection(sessionId, '')).toBeNull()
  }
  expect(loadSessionModelSelection('valid', '')).toEqual({ modelId: 'qwen', anchorRunId: 'run' })
})

test('unavailable storage does not interrupt loading, saving, or clearing a choice', () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => { throw new Error('storage denied') },
    setItem: () => { throw new Error('quota exceeded') }
  } })
  expect(loadSessionModelSelection('session', '')).toBeNull()
  expect(() => saveSessionModelSelection('session', { modelId: 'qwen' }, '')).not.toThrow()
  expect(() => saveSessionModelSelection('session', null, '')).not.toThrow()
})

test('the 100-slot limit evicts the least recently saved session and keeps other sources', () => {
  saveSessionModelSelection('other-source-session', { modelId: 'other-source-model' }, 'remote:other')
  for (let index = 0; index < 100; index++) {
    saveSessionModelSelection(`slot-${index}`, { modelId: `model-${index}` }, '')
  }
  saveSessionModelSelection('slot-0', { modelId: 'refreshed-model' }, '')
  saveSessionModelSelection('slot-100', { modelId: 'newest-model' }, '')
  expect(Object.keys(JSON.parse(localStorage.getItem(selectionKey())!))).toHaveLength(100)
  expect(loadSessionModelSelection('slot-1', '')).toBeNull()
  expect(loadSessionModelSelection('slot-0', '')).toEqual({ modelId: 'refreshed-model' })
  expect(loadSessionModelSelection('slot-100', '')).toEqual({ modelId: 'newest-model' })
  expect(loadSessionModelSelection('other-source-session', 'remote:other')).toEqual({ modelId: 'other-source-model' })
})

test('clearing is explicit and special session keys cannot access or mutate object prototypes', () => {
  expect(loadSessionModelSelection('constructor', '')).toBeNull()
  saveSessionModelSelection('__proto__', { modelId: 'qwen' }, '')
  expect(loadSessionModelSelection('__proto__', '')).toEqual({ modelId: 'qwen' })
  saveSessionModelSelection('__proto__', null, '')
  expect(loadSessionModelSelection('__proto__', '')).toBeNull()
  saveSessionModelSelection('', { modelId: 'ignored-model' }, '')
  expect(loadSessionModelSelection('', '')).toBeNull()
})

test('engine default placeholders and empty requested values never become catalog or global replacements', () => {
  for (const configuredModelId of ['当前配置 of AI', '', undefined]) {
    expect(resolveSessionComposerModel({configuredModelId,runId:'default-run',defaultModelId:'unrelated-global'})).toBe('')
  }
  expect(resolveSessionComposerModel({configuredModelId:'当前配置 of AI',runId:'default-run',selection:{modelId:'explicit-user-choice',anchorRunId:'default-run'},defaultModelId:'unrelated-global'})).toBe('explicit-user-choice')
})
