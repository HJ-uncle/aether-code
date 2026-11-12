/** Pure extension lifecycle and scope regressions; does not launch Electron or touch app data. */
import { expect, test } from '@playwright/test'
import { ExtensionRegistry, extensionVisible } from '../src/renderer/src/features/extensions/registry'
import { ExtensionServices } from '../src/renderer/src/features/extensions/services'
import type { ExtensionRegistration } from '../src/renderer/src/features/extensions/types'
import { extensionWebviewDocument } from '../src/renderer/src/features/extensions/webview-document'
import { getCommand, registerCommand } from '../src/renderer/src/core/platform/commands'

const registration = (instanceId: string, revision = 1): ExtensionRegistration => ({
  identity: { pluginId: 'timer', source: 1, instanceId, revision, hash: `hash-${revision}` },
  contributes: { pages: [{ id: 'timer', title: '计时器', kind: 'webview', entry: 'ui.html', tools: [] }],
    navigation: [{ id: 'timer', title: '计时器', page: 'timer' }], workspaceTabs: [{ id: 'timer', title: '计时器', page: 'timer', scope: 'session' }],
    services: [{ id: 'timer', title: '计时器', tool: 'start', stopTool: 'stop', page: 'timer' }] },
})
test('replacing a plugin revision isolates old disposers and removes all contribution kinds', () => {
  const registry = new ExtensionRegistry(), disposed: string[] = [], first = registration('first'), second = registration('second', 2)
  const oldDispose = registry.register(first, () => disposed.push('first'))
  const newDispose = registry.register(second, () => disposed.push('second'))
  expect(disposed).toEqual(['first'])
  oldDispose()
  expect(registry.getPage('plugin:timer:timer')?.identity.instanceId).toBe('second')
  expect(registry.getSnapshot().navigation).toHaveLength(1)
  expect(registry.getSnapshot().workspaceTabs).toHaveLength(1)
  newDispose()
  expect(registry.getSnapshot().pages).toEqual([])
  expect(registry.getSnapshot().navigation).toEqual([])
  expect(registry.getSnapshot().workspaceTabs).toEqual([])
  expect(disposed).toEqual(['first', 'second'])
})
test('session and declared conditions are evaluated without global state mutations', () => {
  expect(extensionVisible('session', undefined, {})).toBe(false)
  expect(extensionVisible('session', { workspace: true, engineReady: true }, { sessionId: 'a', workspacePath: '/a', engineReady: true })).toBe(true)
  expect(extensionVisible('global', { session: false }, { sessionId: 'a' })).toBe(false)
  const registry = new ExtensionRegistry(), value = registration('x')
  value.contributes.navigation![0].page = 'missing'
  expect(() => registry.register(value)).toThrow('页面不存在')
  expect(registry.getSnapshot().pages).toEqual([])
})
test('service completion occurs without a mounted page', async () => {
  const registry = new ExtensionRegistry(), value = registration('x')
  registry.register(value)
  const services = new ExtensionServices(async () => ({ result: { status: 'running', completesAt: Date.now() + 10 }, artifacts: [], stderr: '', durationMs: 1, plugin: { id: 'timer', revision: 1, hash: 'hash-1' } }), identity => registry.has(identity), id => registry.getRegistration(id))
  services.ensure(value, {})
  await services.action('plugin:timer:timer', {}, 'start')
  expect(services.getSnapshot()[0].status).toBe('running')
  await expect.poll(() => services.getSnapshot()[0].status).toBe('completed')
  services.remove(value.identity)
})
test('unload suppresses a late service result and its deadline', async () => {
  const registry = new ExtensionRegistry(), value = registration('x')
  registry.register(value)
  let finish: ((value: { result: unknown; artifacts: []; stderr: string; durationMs: number; plugin: { id: string; revision: number; hash: string } }) => void) | undefined
  const services = new ExtensionServices(async () => new Promise(resolve => { finish = resolve }), identity => registry.has(identity), id => registry.getRegistration(id))
  services.ensure(value, {})
  const stop = services.action('plugin:timer:timer', {}, 'start')
  expect(services.getSnapshot()).toHaveLength(1)
  services.remove(value.identity)
  finish!({ result: { status: 'running', completesAt: Date.now() + 10 }, artifacts: [], stderr: '', durationMs: 1, plugin: { id: 'timer', revision: 1, hash: 'hash-1' } })
  await stop
  expect(services.getSnapshot()).toEqual([])
})
test('expired deadlines finish immediately and switching sessions retains bounded inactive state', async () => {
  const registry = new ExtensionRegistry(), value = registration('x')
  value.contributes.services![0].scope = 'session'
  registry.register(value)
  const services = new ExtensionServices(async () => ({ result: { status: 'running', completesAt: Date.now() - 100 }, artifacts: [], stderr: '', durationMs: 1, plugin: { id: 'timer', revision: 1, hash: 'hash-1' } }), identity => registry.has(identity), id => registry.getRegistration(id))
  services.ensure(value, { sessionId: 'unused' })
  services.ensure(value, { sessionId: 'first' })
  expect(services.getSnapshot().map(item => item.sessionId)).toEqual(['first'])
  await services.action('plugin:timer:timer', { sessionId: 'first' }, 'start')
  expect(services.getSnapshot()[0].status).toBe('completed')
  for (let index = 0; index < 100; index++) await services.action('plugin:timer:timer', { sessionId: `session-${index}` }, 'start')
  expect(services.getSnapshot().length).toBeLessThanOrEqual(65)
  expect(services.getSnapshot().some(item => item.sessionId === 'first')).toBe(false)
  services.clear()
})
test('an old command disposer cannot remove its replacement', () => {
  const oldDispose = registerCommand({ id: 'test.extension.identity', title: 'old', run: () => {} })
  const newDispose = registerCommand({ id: 'test.extension.identity', title: 'new', run: () => {} })
  oldDispose()
  expect(getCommand('test.extension.identity')?.title).toBe('new')
  newDispose()
  expect(getCommand('test.extension.identity')).toBeUndefined()
})
test('custom UI gets a constrained opaque-frame bridge and a restrictive network policy', () => {
  const html = extensionWebviewDocument('<h1>timer</h1>', 'nonce')
  expect(html).toContain("connect-src 'none'")
  expect(html).toContain("frame-src 'none'")
  expect(html).toContain('event.source !== parent')
  expect(html).toContain('aetherPlugin')
  expect(html).not.toContain('window.aether.engine')
})
