/** Pure contracts: manual thinking preferences survive reload and stay in their source/session. No Electron. */
import { expect, test } from '@playwright/test'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'
import {
  loadSessionThinkingMode,
  saveSessionThinkingMode,
  type SessionThinkingMode
} from '../src/renderer/src/contrib/chat/session-thinking-store'

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

const modesKey = (source = '') => sessionStorageKey('aether:sessionThinkingModes', source)
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

test.beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true })
})

test.afterAll(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

test('all explicit thinking modes survive a reload without inventing a choice for a new session', () => {
  expect(loadSessionThinkingMode('new-session', '')).toBeNull()
  const modes: SessionThinkingMode[] = ['off', 'low', 'high', 'max']
  for (const mode of modes) {
    saveSessionThinkingMode('session', mode, '')
    expect(loadSessionThinkingMode('session', '')).toBe(mode)
  }
  expect(loadSessionThinkingMode('new-session', '')).toBeNull()
})

test('manual modes are isolated by session, endpoint/account, and delayed old-source writes', () => {
  const sourceA = 'remote:http://engine-a:12323:account:a'
  const sourceB = 'remote:http://engine-a:12323:account:b'
  saveSessionThinkingMode('same-session', 'off', '')
  saveSessionThinkingMode('same-session', 'low', sourceA)
  saveSessionThinkingMode('same-session', 'high', sourceB)
  saveSessionThinkingMode('other-session', 'max', sourceB)
  saveSessionThinkingMode('same-session', 'max', sourceA)
  expect(loadSessionThinkingMode('same-session', '')).toBe('off')
  expect(loadSessionThinkingMode('same-session', sourceA)).toBe('max')
  expect(loadSessionThinkingMode('same-session', sourceB)).toBe('high')
  expect(loadSessionThinkingMode('other-session', sourceB)).toBe('max')
  expect(loadSessionThinkingMode('missing-session', sourceB)).toBeNull()
})

test('an engine restart preserves a manual mode because persistence uses endpoint identity', () => {
  const before = { mode: 'remote' as const, baseUrl: 'http://engine:12323/', accountId: 'account', instanceId: 'old' }
  const after = { ...before, baseUrl: 'http://engine:12323', instanceId: 'new' }
  saveSessionThinkingMode('session', 'low', engineStorageKey(before))
  expect(loadSessionThinkingMode('session', engineStorageKey(after))).toBe('low')
})

test('corrupt tables and invalid modes cannot be restored, and a valid save repairs the table', () => {
  for (const raw of ['{broken', 'null', '[]', '"low"', '42']) {
    localStorage.setItem(modesKey(), raw)
    expect(loadSessionThinkingMode('session', '')).toBeNull()
  }
  localStorage.setItem(modesKey(), JSON.stringify({
    invalid: 'medium', empty: '', boolean: false, numeric: 1, object: { mode: 'low' }, valid: 'off'
  }))
  for (const sessionId of ['invalid', 'empty', 'boolean', 'numeric', 'object']) {
    expect(loadSessionThinkingMode(sessionId, '')).toBeNull()
  }
  expect(loadSessionThinkingMode('valid', '')).toBe('off')
  localStorage.setItem(modesKey(), '{broken')
  saveSessionThinkingMode('session', 'max', '')
  expect(loadSessionThinkingMode('session', '')).toBe('max')
})

test('denied reads and failed writes cannot interrupt the composer', () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => { throw new Error('storage denied') },
    setItem: () => { throw new Error('quota exceeded') }
  } })
  expect(loadSessionThinkingMode('session', '')).toBeNull()
  expect(() => saveSessionThinkingMode('session', 'low', '')).not.toThrow()
})

test('the 100-slot limit retains a recently changed session and isolates the eviction from other sources', () => {
  saveSessionThinkingMode('other-source-session', 'off', 'remote:other')
  for (let index = 0; index < 100; index++) saveSessionThinkingMode(`slot-${index}`, 'low', '')
  saveSessionThinkingMode('slot-0', 'max', '')
  saveSessionThinkingMode('slot-100', 'high', '')
  expect(Object.keys(JSON.parse(localStorage.getItem(modesKey())!))).toHaveLength(100)
  expect(loadSessionThinkingMode('slot-1', '')).toBeNull()
  expect(loadSessionThinkingMode('slot-0', '')).toBe('max')
  expect(loadSessionThinkingMode('slot-100', '')).toBe('high')
  expect(loadSessionThinkingMode('other-source-session', 'remote:other')).toBe('off')
})

test('empty session IDs are ignored and special session keys never expose inherited values', () => {
  expect(loadSessionThinkingMode('constructor', '')).toBeNull()
  saveSessionThinkingMode('__proto__', 'max', '')
  expect(loadSessionThinkingMode('__proto__', '')).toBe('max')
  saveSessionThinkingMode('', 'low', '')
  expect(loadSessionThinkingMode('', '')).toBeNull()
})
