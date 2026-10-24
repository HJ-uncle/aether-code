import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { AetherIdeApi } from '../src/preload'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'

/** New memory policy UI: real renderer + IPC against an isolated HTTP contract.
 * Verifies confirmed writes, session inheritance, disabled capability and recovery.
 * No model calls; engine database persistence is covered by the engine contract tests.
 */
declare global { interface Window { aether: AetherIdeApi } }

const root = resolve(__dirname, '..')
const fixtureParent = join(root, '.e2e-tmp')
const sessionId = 'memory-policy-current'
const otherSessionId = 'memory-policy-other'
const historyText = '这条聊天历史在关闭记忆后仍须保留'
let fixture = ''
let app: ElectronApplication | undefined
let page: Page
let server: Server | undefined
let preferences = { globalEnabled: false, sessionDefaultEnabled: true, enabled: true }
let failNextPreferenceWrite = false
const overrides = new Map<string, boolean>()
const writes: { path: string; body: Record<string, unknown> }[] = []
const destructiveHistoryRequests: string[] = []
const pageErrors: string[] = []

function send(response: ServerResponse, data: unknown, code = 200, message = 'ok', pagination?: unknown): void {
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ code, message, data, ...(pagination ? { pagination } : {}) }))
}

async function bodyOf(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const chunk of request) raw += chunk.toString()
  return JSON.parse(raw || '{}')
}

function settingsFor(id: string): Record<string, unknown> {
  const sessionOverride = overrides.get(id) ?? null
  const sessionEnabled = sessionOverride ?? preferences.sessionDefaultEnabled
  const effectiveScopes = preferences.enabled
    ? [...(preferences.globalEnabled ? ['global'] : []), ...(sessionEnabled ? ['session'] : [])]
    : []
  const memoryScope = sessionEnabled ? 'session' : preferences.globalEnabled ? 'global' : 'off'
  return { sessionId: id, ...preferences, sessionOverride, sessionEnabled, memoryScope,
    effectiveScope: preferences.enabled ? memoryScope : 'off', effectiveScopes }
}

function historyFor(id: string): Record<string, unknown>[] {
  return id === sessionId ? [{ id: 'policy-history-marker', role: 'user', content: historyText, createdAt: Date.now() - 1000 }] : []
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  const method = request.method ?? 'GET'
  const id = url.searchParams.get('sessionId') ?? sessionId
  if (method === 'DELETE' && /conversation|history/.test(path)) destructiveHistoryRequests.push(path)
  if (path === '/health') return send(response, { status: 'ok' })
  if (path === '/meta') return send(response, { version: '1.0.0', buildId: `sha256:${'c'.repeat(64)}`,
    protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'memory-policy-ui-fixture' })
  if (path === '/api/v1/tools' || path === '/api/v1/models') return send(response, [])
  if (path === '/api/v1/subagent/capabilities') return send(response, {
    schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'],
    toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true,
    activeDiscovery: true, lifecycleChanges: true, discoveryProtocol: 1
  })
  if (path === '/api/v1/subagent/runs') return send(response, {
    schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'memory-policy-directory'
  })
  if (path === '/api/v1/subagent/discovery') return send(response, {
    protocolVersion: 1, source: 'durable-lifecycle', generation: 'memory-policy-generation',
    scope: { tenantId: 'default', parentSessionId: url.searchParams.get('parentSessionId') ?? id,
      ...(url.searchParams.has('rootSessionId') ? { rootSessionId: url.searchParams.get('rootSessionId') } : {}),
      ...(url.searchParams.has('parentConversationId') ? { parentConversationId: url.searchParams.get('parentConversationId') } : {}) },
    mode: url.searchParams.get('mode') ?? 'active', asOfRevision: 0, floorRevision: 0, activeCount: 0,
    items: [], includedCount: 0, scannedCount: 0,
    ...(url.searchParams.get('mode') === 'changes' ? { nextRevision: 0 } : {}),
    hasMore: false, nextCursor: null, membershipCompleteness: 'complete'
  })
  if (path === '/api/v1/collaboration/capabilities') return send(response, { userControllerMutation: false })
  if (path === '/api/v1/chat/runs') return send(response, { runs: [] })
  if (path === '/api/v1/security/mode') return send(response, { sessionId: id, mode: 'safe' })
  if (path === '/api/v1/conversation/sessions') return send(response, [
    { sessionId, title: '记忆策略当前会话', lastAt: Date.now() },
    { sessionId: otherSessionId, title: '记忆策略另一会话', lastAt: Date.now() - 1 }
  ])
  if (path === '/api/v1/conversation/history') return send(response, historyFor(id))
  if (path === '/api/v1/chat/snapshot') return send(response, {
    schemaVersion: 1, source: 'persisted', sessionId: id, eventId: null, finished: true,
    projection: [], runs: [], history: historyFor(id), todos: [], changes: []
  })
  if (path === '/api/v1/memory/preferences') {
    if (method === 'PUT') {
      const body = await bodyOf(request)
      writes.push({ path, body })
      if (failNextPreferenceWrite) {
        failNextPreferenceWrite = false
        return send(response, null, 50000, 'fixture preference storage unavailable')
      }
      if (!preferences.enabled && body.globalEnabled === true) {
        return send(response, { reason: 'MEMORY_DISABLED_BY_SERVER' }, 40900, 'Long-term memory is disabled by server configuration')
      }
      if (typeof body.globalEnabled === 'boolean') preferences.globalEnabled = body.globalEnabled
      if (typeof body.sessionDefaultEnabled === 'boolean') preferences.sessionDefaultEnabled = body.sessionDefaultEnabled
    }
    return send(response, preferences)
  }
  if (path === '/api/v1/memory/settings') {
    if (method === 'PUT') {
      const body = await bodyOf(request)
      writes.push({ path, body })
      const target = String(body.sessionId)
      if (!preferences.enabled && body.sessionEnabled === true) {
        return send(response, { ...settingsFor(target), reason: 'MEMORY_DISABLED_BY_SERVER' }, 40900, 'Long-term memory is disabled by server configuration')
      }
      if (body.sessionEnabled === null) overrides.delete(target)
      else if (typeof body.sessionEnabled === 'boolean') overrides.set(target, body.sessionEnabled)
      else return send(response, null, 40000, 'sessionEnabled must be a boolean or null')
      return send(response, settingsFor(target))
    }
    return send(response, settingsFor(id))
  }
  if (path === '/api/v1/memory/list') return send(response, [], 200, 'ok', { current: 1, pageSize: 20, total: 0, totalPages: 1 })
  return send(response, [])
}

async function openSettings(): Promise<void> {
  if (await page.locator('.composer-options__popup').isVisible()) await page.keyboard.press('Escape')
  if (!await page.locator('.app-settings').isVisible()) await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: '记忆', exact: true }).click()
  await expect(page.getByRole('heading', { name: '记忆偏好', exact: true })).toBeVisible()
  await expect(page.getByRole('switch', { name: '默认开启会话记忆', exact: true })).toBeEnabled()
}

async function openConversationPreferences(): Promise<void> {
  if (await page.locator('.app-settings').isVisible()) {
    await page.getByRole('button', { name: '关闭 设置', exact: true }).click()
  }
  if (!await page.locator('.composer-options__popup').isVisible()) await page.getByRole('button', { name: '对话偏好', exact: true }).click()
  await expect(page.getByRole('button', { name: /^本会话记忆：/ })).toBeEnabled()
}

async function chooseSessionMemory(label: string): Promise<void> {
  await openConversationPreferences()
  await page.getByRole('button', { name: /^本会话记忆：/ }).click()
  await page.getByRole('menuitem').filter({ hasText: label }).click()
  await expect(page.getByRole('button', { name: /^本会话记忆：/ })).toBeEnabled()
}

async function selectFixtureConversation(): Promise<void> {
  if (await page.locator('.app-settings').isVisible()) await page.getByRole('button', { name: '关闭 设置', exact: true }).click()
  const historyButton = page.getByRole('button', { name: '会话历史', exact: true })
  if ((await historyButton.getAttribute('aria-pressed')) !== 'true') await historyButton.click()
  await page.locator('.history-view__item').filter({ hasText: '记忆策略当前会话' }).click()
  const snapshot = await page.evaluate(() => window.aether.engine.getSnapshot())
  const storageKey = sessionStorageKey('aether:lastSessionId', engineStorageKey(snapshot))
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(sessionId)
  await expect(page.locator('.chat-panel')).toContainText(historyText)
}

test.describe.serial('独立记忆偏好与会话覆盖真实窗口', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureParent, { recursive: true })
    fixture = mkdtempSync(join(fixtureParent, 'memory-policy-ui-'))
    mkdirSync(join(fixture, 'workspace'), { recursive: true })
    server = createServer((request, response) => { void handle(request, response).catch(error => send(response, null, 50000, String(error))) })
    await new Promise<void>(done => server!.listen(0, '127.0.0.1', done))
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: baseUrl,
      remoteWorkspaceRoot: '', autoStartEngine: true, preferredPort: 12489, lastFolder: join(fixture, 'workspace'),
      lastSessionId: sessionId, lastModelId: '', thinkingMode: 'off' }))
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL'].includes(key.toUpperCase())) env[key] = value
    }
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root,
      env: { ...env, AETHER_GLOBAL_DIR: join(fixture, 'global'), WORKSPACE_ROOT: join(fixture, 'workspace'),
        MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills') } })
    page = await app.firstWindow()
    page.on('pageerror', error => pageErrors.push(error.message))
    await expect(page.locator('.status-bar')).toBeVisible()
    await expect.poll(async () => (await page.evaluate(() => window.aether.engine.getSnapshot())).phase).toBe('ready')
    // A remote endpoint has a separate current-session key. Choose the actual
    // history row instead of assuming the installation's lastSessionId applies.
    await selectFixtureConversation()
  })

  test.beforeEach(async () => {
    preferences = { globalEnabled: false, sessionDefaultEnabled: true, enabled: true }
    overrides.clear()
    writes.length = 0
    destructiveHistoryRequests.length = 0
    pageErrors.length = 0
    failNextPreferenceWrite = false
    await page.reload()
    await expect(page.locator('.status-bar')).toBeVisible()
    await expect.poll(async () => (await page.evaluate(() => window.aether.engine.getSnapshot())).phase).toBe('ready')
    await selectFixtureConversation()
  })

  test.afterEach(async ({}, testInfo) => {
    await testInfo.attach('memory-policy-fixture-evidence', { body: JSON.stringify({
      preferences, writes, overrides: [...overrides],
      currentSessionStorage: await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('aether:lastSessionId')))
    }, null, 2), contentType: 'application/json' })
    expect(destructiveHistoryRequests).toEqual([])
    expect(pageErrors).toEqual([])
  })

  test.afterAll(async () => {
    await app?.close()
    server?.closeAllConnections()
    if (server) await new Promise<void>(done => server!.close(() => done()))
    if (fixture) {
      if (dirname(fixture) !== fixtureParent || !basename(fixture).startsWith('memory-policy-ui-')) throw new Error('Unsafe memory policy fixture cleanup')
      rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })

  test('全局默认关闭、会话默认开启，保存以确认值更新且对话菜单没有全局选项', async ({}, testInfo) => {
    await openSettings()
    const global = page.getByRole('switch', { name: '全局记忆', exact: true })
    const sessionDefault = page.getByRole('switch', { name: '默认开启会话记忆', exact: true })
    await expect(global).toHaveAttribute('aria-checked', 'false')
    await expect(sessionDefault).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('.memory-settings')).toContainText('不会删除或停用聊天历史')
    await global.click()
    await expect.poll(() => preferences.globalEnabled).toBe(true)
    await expect(global).toHaveAttribute('aria-checked', 'true')
    await expect(global).toHaveClass(/is-on/)
    await expect(global).toBeEnabled()
    expect(writes.at(-1)).toEqual({ path: '/api/v1/memory/preferences', body: { globalEnabled: true } })
    await page.screenshot({ path: testInfo.outputPath('memory-preferences-settings.png'), animations: 'disabled' })
    await openConversationPreferences()
    await page.getByRole('button', { name: /^本会话记忆：/ }).click()
    const menu = page.locator('.composer-options__dd-menu')
    await expect(menu.getByRole('menuitem')).toHaveCount(3)
    await expect(menu).toContainText('本会话开启')
    await expect(menu).toContainText('本会话关闭')
    await expect(menu).toContainText('恢复默认')
    await expect(menu).not.toContainText('全局记忆')
  })

  test('会话显式选择覆盖默认值，恢复默认后重新继承且另一会话不受改写', async () => {
    await chooseSessionMemory('本会话关闭')
    await expect.poll(() => overrides.get(sessionId)).toBe(false)
    await expect(page.getByRole('button', { name: /^本会话记忆：/ })).toContainText('本会话关闭')
    await openSettings()
    const sessionDefault = page.getByRole('switch', { name: '默认开启会话记忆', exact: true })
    await sessionDefault.click()
    await expect.poll(() => preferences.sessionDefaultEnabled).toBe(false)
    await sessionDefault.click()
    await expect.poll(() => preferences.sessionDefaultEnabled).toBe(true)
    expect(overrides.get(sessionId)).toBe(false)
    await chooseSessionMemory('恢复默认')
    await expect.poll(() => overrides.has(sessionId)).toBe(false)
    expect(writes.at(-1)).toEqual({ path: '/api/v1/memory/settings', body: { sessionId, sessionEnabled: null } })
    await expect(page.getByRole('button', { name: /^本会话记忆：/ })).toContainText('跟随默认 · 开启')
    await chooseSessionMemory('本会话开启')
    await expect.poll(() => overrides.get(sessionId)).toBe(true)
    await openSettings()
    await sessionDefault.click()
    await expect.poll(() => preferences.sessionDefaultEnabled).toBe(false)
    await openConversationPreferences()
    await expect(page.getByRole('button', { name: /^本会话记忆：/ })).toContainText('本会话开启')
    await chooseSessionMemory('恢复默认')
    await expect(page.getByRole('button', { name: /^本会话记忆：/ })).toContainText('跟随默认 · 关闭')
    expect(overrides.has(otherSessionId)).toBe(false)
    expect(writes.filter(write => write.path.endsWith('/settings')).every(write => write.body.sessionId === sessionId)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(page.getByText(historyText, { exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByText(historyText, { exact: true })).toBeVisible()
  })

  test('服务端禁用显示中文解释，禁止开启但仍可关闭、改默认和恢复继承', async () => {
    preferences = { globalEnabled: true, sessionDefaultEnabled: true, enabled: false }
    overrides.set(sessionId, true)
    await page.reload()
    await openSettings()
    await expect(page.locator('.memory-settings')).toContainText('服务端已关闭长期记忆，当前无法启用')
    const global = page.getByRole('switch', { name: '全局记忆', exact: true })
    await expect(global).toBeEnabled()
    await global.click()
    await expect.poll(() => preferences.globalEnabled).toBe(false)
    await expect(global).toBeDisabled()
    await page.getByRole('switch', { name: '默认开启会话记忆', exact: true }).click()
    await expect.poll(() => preferences.sessionDefaultEnabled).toBe(false)
    await openConversationPreferences()
    await expect(page.locator('.composer-options__popup')).toContainText('服务端已关闭长期记忆。聊天历史会继续保留。')
    await page.getByRole('button', { name: /^本会话记忆：/ }).click()
    await expect(page.getByRole('menuitem').filter({ hasText: '本会话开启' })).toBeDisabled()
    await page.getByRole('menuitem').filter({ hasText: '本会话关闭' }).click()
    await expect.poll(() => overrides.get(sessionId)).toBe(false)
    await chooseSessionMemory('恢复默认')
    await expect.poll(() => overrides.has(sessionId)).toBe(false)
    expect(writes.some(write => write.body.globalEnabled === true || write.body.sessionEnabled === true)).toBe(false)
    expect(settingsFor(sessionId).effectiveScopes).toEqual([])
  })

  test('写入失败显示可恢复的中文状态，诊断折叠且重读后可再次保存', async () => {
    await openSettings()
    failNextPreferenceWrite = true
    await page.getByRole('switch', { name: '全局记忆', exact: true }).click()
    await expect(page.getByText('记忆偏好未能同步，请重新读取后再试。', { exact: true })).toBeVisible()
    expect(preferences.globalEnabled).toBe(false)
    const diagnostics = page.locator('.memory-settings__preference-error')
    await expect(diagnostics).not.toHaveAttribute('open', '')
    await expect(diagnostics.locator('p')).not.toBeVisible()
    await page.getByRole('button', { name: '重新读取记忆偏好', exact: true }).click()
    const global = page.getByRole('switch', { name: '全局记忆', exact: true })
    await expect(global).toBeEnabled()
    await expect(global).toHaveAttribute('aria-checked', 'false')
    await global.click()
    await expect.poll(() => preferences.globalEnabled).toBe(true)
    await expect(global).toHaveAttribute('aria-checked', 'true')
  })
})
