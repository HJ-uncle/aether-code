/** Display catalogue request reuse, bounds and mutation/source isolation. No Electron or credentials. */
import { expect, test } from '@playwright/test'
import { CatalogueCache } from '../src/renderer/src/core/engine/catalogue-cache'
import { agentReferenceCache, startReferenceCatalogues, toolkitReferenceCache } from '../src/renderer/src/core/engine/reference-catalogues'
import { notifyAgentCatalogueChanged } from '../src/renderer/src/core/engine/agent-catalogue'
import { notifyResourceCatalogueChanged } from '../src/renderer/src/core/engine/resource-catalogue'
import { getEngineSource, publishEngineSource } from '../src/renderer/src/core/engine/source'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('concurrent picker loads share one request and reopening uses the resolved value', async () => {
  const cache = new CatalogueCache<string[]>(), gate = deferred<string[]>()
  let calls = 0
  const load = () => { calls++; return gate.promise }
  const first = cache.load('same-scope', load), second = cache.load('same-scope', load)
  expect(second).toBe(first)
  await Promise.resolve()
  expect(calls).toBe(1)
  gate.resolve(['tool'])
  expect(await first).toEqual(['tool'])
  expect(cache.peek('same-scope')).toEqual(['tool'])
  expect(await cache.load('same-scope', load)).toEqual(['tool'])
  expect(calls).toBe(1)
})

test('expired catalogues reload and least recently used scopes are bounded', async () => {
  let now = 100
  const cache = new CatalogueCache<number>(2, 30, () => now)
  await cache.load('a', async () => 1)
  await cache.load('b', async () => 2)
  expect(cache.peek('a')).toBe(1)
  await cache.load('c', async () => 3)
  expect(cache.peek('b')).toBeUndefined()
  expect(cache.peek('a')).toBe(1)
  now = 130
  expect(cache.peek('a')).toBeUndefined()
  expect(await cache.load('a', async () => 4)).toBe(4)
})

test('request errors are not cached and the next explicit request can succeed', async () => {
  const cache = new CatalogueCache<number>(), gate = deferred<number>()
  const first = cache.load('scope', () => gate.promise)
  gate.reject(new Error('catalogue offline'))
  await expect(first).rejects.toThrow('catalogue offline')
  expect(cache.peek('scope')).toBeUndefined()
  expect(await cache.load('scope', async () => 9)).toBe(9)
})

test('a late request cannot replace a value loaded after mutation invalidation', async () => {
  const cache = new CatalogueCache<string>(), old = deferred<string>()
  const pending = cache.load('scope', () => old.promise)
  cache.invalidate()
  expect(await cache.load('scope', async () => 'new revision')).toBe('new revision')
  old.resolve('deleted revision')
  await pending
  expect(cache.peek('scope')).toBe('new revision')
  expect(cache.getRevision()).toBe(1)
})

test('session, agent, path and engine identities do not share cached values', async () => {
  const cache = new CatalogueCache<string>(), scopes = [
    [1, 'session-a', null, '/one'], [1, 'session-b', null, '/one'],
    [1, null, 'agent-a', '/one'], [1, null, 'agent-b', '/one'],
    [1, 'session-a', null, '/two'], [2, 'session-a', null, '/one']
  ].map(value => JSON.stringify(value))
  for (const [index, key] of scopes.entries()) await cache.load(key, async () => String(index))
  expect(scopes.map(key => cache.peek(key))).toEqual(['0', '1', '2', '3', '4', '5'])
})

test('closed pickers invalidate on real management changes and engine/account switches', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true })
  try {
    publishEngineSource({ mode: 'remote', baseUrl: 'https://catalogue-one.test', instanceId: 'one', phase: 'ready', accountId: 'a' })
    startReferenceCatalogues()
    const source = getEngineSource(), key = String(source)
    await agentReferenceCache.load(key, async () => [{ id: 'custom', name: 'Before' }])
    await toolkitReferenceCache.load(key, async () => [])
    notifyResourceCatalogueChanged({ kind: 'plugin', action: 'publish', id: 'plugin-one' })
    expect(agentReferenceCache.peek(key)?.[0].name).toBe('Before')
    expect(toolkitReferenceCache.peek(key)).toBeUndefined()
    notifyAgentCatalogueChanged()
    expect(agentReferenceCache.peek(key)).toBeUndefined()
    await toolkitReferenceCache.load(key, async () => [])
    // A receipt from an expired connection cannot invalidate current values.
    notifyResourceCatalogueChanged({ kind: 'plugin', action: 'delete', id: 'plugin-one' }, source - 1)
    expect(toolkitReferenceCache.peek(key)).toEqual([])
    publishEngineSource({ mode: 'remote', baseUrl: 'https://catalogue-one.test', instanceId: 'one', phase: 'ready', accountId: 'b' })
    expect(toolkitReferenceCache.peek(key)).toBeUndefined()
    const newKey = String(getEngineSource())
    await toolkitReferenceCache.load(newKey, async () => [])
    // The source-bound resource subscription must rebind after the connection changes.
    notifyResourceCatalogueChanged({ kind: 'plugin', action: 'set_enabled', id: 'plugin-two' })
    expect(toolkitReferenceCache.peek(newKey)).toBeUndefined()
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
