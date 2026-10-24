import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AetherIdeApi } from '../src/preload'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'

/** Real embedded-engine memory policies: isolated account + profile + SQLite,
 * production JSONL replay, renderer menus and settings, and engine restart.
 * Only history fixtures are seeded on disk because no public history-append API
 * exists. Policy reads/writes always use real renderer IPC and engine routes.
 * Run serially after a fresh client/engine build; this makes no model calls.
 */
declare global { interface Window { aether: AetherIdeApi } }

type Preferences = { globalEnabled: boolean; sessionDefaultEnabled: boolean; enabled: boolean }
type SessionMemory = Preferences & {
  sessionId: string; sessionOverride: boolean | null; sessionEnabled: boolean
  effectiveScopes: ('global' | 'session')[]
}
type HistoryMessage = { id: string; role: string; content: unknown }

const root = resolve(__dirname, '..')
const fixtureParent = join(root, '.e2e-tmp')
const firstId = 'memory-embedded-policy-A'
const secondId = 'memory-embedded-policy-B'
const firstHistory = '记忆集成探针 A：关闭记忆仍保留这轮历史'
const secondHistory = '记忆集成探针 B：独立会话历史'
let fixture = ''
let app: ElectronApplication | undefined
let page: Page
let accountId = ''
const errors: string[] = []
const evidence: unknown[] = []
const historyFiles = new Map<string, { file: string; sha256: string; body: string }>()

async function readEngine<T>(path: string, sessionId?: string): Promise<T> {
  const result = await page.evaluate(async ({ path, sessionId }) => window.aether.engine.request<T>({
    method: 'GET', path, ...(sessionId ? { query: { sessionId } } : {})
  }), { path, sessionId })
  expect(result.ok, `${path}: ${result.message}`).toBe(true)
  expect(result.data, `${path} returned no data`).not.toBeNull()
  return result.data as T
}

async function readSession(sessionId: string): Promise<SessionMemory> {
  const settings = await readEngine<SessionMemory>('/memory/settings', sessionId)
  expect(settings.sessionId).toBe(sessionId)
  return settings
}

async function ready(): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.aether.engine.getSnapshot()).then(snapshot => snapshot.phase), { timeout: 90_000 }).toBe('ready')
  await expect.poll(() => page.evaluate(() => window.aether.engine.getSnapshot()).then(snapshot => snapshot.accountId)).toBe(accountId)
}

async function closePreferences(): Promise<void> {
  if (await page.locator('.composer-options__dd-menu').isVisible()) await page.keyboard.press('Escape')
  if (await page.locator('.composer-options__popup').isVisible()) await page.keyboard.press('Escape')
}

async function closeSettings(): Promise<void> {
  if (await page.locator('.app-settings').isVisible()) await page.getByRole('button', { name: '关闭 设置', exact: true }).click()
}

async function openSettings(): Promise<void> {
  await closePreferences()
  if (!await page.locator('.app-settings').isVisible()) await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: '记忆', exact: true }).click()
  await expect(page.getByRole('heading', { name: '记忆偏好', exact: true })).toBeVisible()
  await expect(page.getByRole('switch', { name: '默认开启会话记忆', exact: true })).toBeEnabled()
}

async function openPreferences(): Promise<void> {
  await closeSettings()
  if (!await page.locator('.composer-options__popup').isVisible()) await page.getByRole('button', { name: '对话偏好', exact: true }).filter({ visible: true }).click()
  await expect(page.getByRole('button', { name: /^本会话记忆：/ }).filter({ visible: true })).toBeEnabled()
}

function memoryButton() { return page.getByRole('button', { name: /^本会话记忆：/ }).filter({ visible: true }) }

async function chooseMemory(label: string): Promise<void> {
  await openPreferences()
  await memoryButton().click()
  await page.getByRole('menuitem').filter({ hasText: label }).click()
  await expect(memoryButton()).toBeEnabled()
}

async function selectSession(id: string, history: string): Promise<void> {
  await closePreferences()
  await closeSettings()
  const historyButton = page.getByRole('button', { name: '会话历史', exact: true })
  if ((await historyButton.getAttribute('aria-pressed')) !== 'true') await historyButton.click()
  await page.locator('.history-view__item').filter({ hasText: history }).click()
  // Signed-in sessions persist under the account-scoped endpoint key; the
  // installation setting intentionally remains the signed-out session.
  const snapshot = await page.evaluate(() => window.aether.engine.getSnapshot())
  const storageKey = sessionStorageKey('aether:lastSessionId', engineStorageKey(snapshot))
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(id)
  await expect(page.locator('.chat-panel')).toContainText(history)
  await openPreferences()
}

function seedHistory(tenantId: string): void {
  if (!/^account_[a-zA-Z0-9-]+$/.test(tenantId)) throw new Error('Unexpected isolated account tenant')
  const directory = join(fixture, 'engine', 'state', 'sessions', tenantId)
  mkdirSync(directory, { recursive: true })
  for (const [id, content] of [[firstId, firstHistory], [secondId, secondHistory]]) {
    const now = Date.now() - 1000
    const messages = [{ id: `${id}-user`, role: 'user', content },
      { id: `${id}-assistant`, role: 'assistant', content: `${id} 的历史回复保留探针` }]
    const body = messages.map((message, index) => JSON.stringify({
      uuid: message.id, parentUuid: index ? messages[0].id : null, type: message.role,
      timestamp: new Date(now + index).toISOString(), sessionId: id, tenantId,
      isSidechain: false, dbSeq: index, payload: { ...message, tokens: 8, createdAt: now + index }
    })).join('\n') + '\n'
    const file = join(directory, `${id}.jsonl`)
    writeFileSync(file, body, 'utf8')
    historyFiles.set(id, { file, body, sha256: createHash('sha256').update(body).digest('hex') })
  }
}

async function assertHistoryPreserved(): Promise<void> {
  for (const [id, expectedText] of [[firstId, firstHistory], [secondId, secondHistory]]) {
    const rows = await readEngine<HistoryMessage[]>('/conversation/history', id)
    expect(rows.map(row => ({ id: row.id, role: row.role, content: row.content }))).toEqual([
      { id: `${id}-user`, role: 'user', content: expectedText },
      { id: `${id}-assistant`, role: 'assistant', content: `${id} 的历史回复保留探针` }
    ])
    const original = historyFiles.get(id)!
    const bytes = readFileSync(original.file)
    expect(bytes.toString('utf8')).toBe(original.body)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(original.sha256)
  }
}

test.describe.serial('记忆偏好与会话覆盖：真实嵌入引擎', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureParent, { recursive: true })
    fixture = mkdtempSync(join(fixtureParent, 'memory-embedded-policy-'))
    mkdirSync(join(fixture, 'workspace'), { recursive: true })
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'embedded', autoStartEngine: true,
      preferredPort: 12449, lastSessionId: firstId, lastFolder: join(fixture, 'workspace'), appearance: 'light', thinkingMode: 'off' }))
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL'].includes(key.toUpperCase())) env[key] = value
    }
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root,
      env: { ...env, AETHER_IDE_ENGINE_ENTRY: resolve(root, '..', 'ai-agent-engine', 'dist', 'main.js'),
        AETHER_GLOBAL_DIR: join(fixture, 'global'), WORKSPACE_ROOT: join(fixture, 'workspace'),
        DEFAULT_SECURITY_MODE: 'safe', AUTH_ENABLED: 'false', ENABLE_LONG_TERM_MEMORY: 'true', HISTORY_BACKEND: 'jsonl',
        MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills') } })
    page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1450, 980))
    await expect.poll(() => page.evaluate(() => window.aether.engine.getSnapshot()).then(snapshot => snapshot.phase), { timeout: 90_000 }).toBe('ready')
    const account = await page.evaluate(() => window.aether.account.register())
    expect(account.status, account.message ?? '').toBe('authenticated')
    expect(account.user?.tenantId).toMatch(/^account_/)
    accountId = account.user!.id
    await ready()
    const snapshot = await page.evaluate(() => window.aether.engine.getSnapshot())
    expect(snapshot.adopted).toBe(false)
    expect(snapshot.mode).toBe('embedded')
    expect(snapshot.entryPath).toBe(resolve(root, '..', 'ai-agent-engine', 'dist', 'main.js'))
    expect(resolve(snapshot.dataDir!)).toBe(join(fixture, 'engine', 'state', 'agent.db'))
    seedHistory(account.user!.tenantId)
    await page.reload()
    await ready()
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    await selectSession(firstId, firstHistory)
    await assertHistoryPreserved()
  })

  test.afterEach(async ({}, testInfo) => {
    expect(errors).toEqual([])
    await testInfo.attach('embedded-memory-evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
  })

  test.afterAll(async () => {
    await app?.close()
    if (fixture) {
      if (dirname(resolve(fixture)) !== fixtureParent || !basename(fixture).startsWith('memory-embedded-policy-')) throw new Error('Unsafe memory embedded fixture cleanup')
      rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })

  test('新账号全局默认关闭、会话默认开启，设置页和两会话真实引擎一致', async () => {
    const preferences = await readEngine<Preferences>('/memory/preferences')
    expect(preferences).toEqual({ globalEnabled: false, sessionDefaultEnabled: true, enabled: true })
    for (const id of [firstId, secondId]) {
      expect(await readSession(id)).toMatchObject({ sessionOverride: null, sessionEnabled: true,
        globalEnabled: false, sessionDefaultEnabled: true, effectiveScopes: ['session'] })
    }
    await expect(memoryButton()).toContainText('跟随默认 · 开启')
    await openSettings()
    await expect(page.getByRole('switch', { name: '全局记忆', exact: true })).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByRole('switch', { name: '默认开启会话记忆', exact: true })).toHaveAttribute('aria-checked', 'true')
    evidence.push({ step: 'fresh-defaults', preferences, first: await readSession(firstId), second: await readSession(secondId) })
  })

  test('设置全局开启与默认关闭，显式会话选择优先、恢复默认且另一会话独立', async ({}, testInfo) => {
    await openSettings()
    await page.getByRole('switch', { name: '全局记忆', exact: true }).click()
    await expect.poll(() => readEngine<Preferences>('/memory/preferences').then(value => value.globalEnabled)).toBe(true)
    await page.getByRole('switch', { name: '默认开启会话记忆', exact: true }).click()
    await expect.poll(() => readEngine<Preferences>('/memory/preferences').then(value => value.sessionDefaultEnabled)).toBe(false)
    await openPreferences()
    await expect(memoryButton()).toContainText('跟随默认 · 关闭')
    await chooseMemory('本会话开启')
    await expect.poll(() => readSession(firstId).then(value => value.sessionOverride)).toBe(true)
    await expect(memoryButton()).toContainText('本会话开启')
    expect(await readSession(firstId)).toMatchObject({ sessionEnabled: true, effectiveScopes: ['global', 'session'] })
    expect(await readSession(secondId)).toMatchObject({ sessionOverride: null, sessionEnabled: false, effectiveScopes: ['global'] })
    await selectSession(secondId, secondHistory)
    await expect(memoryButton()).toContainText('跟随默认 · 关闭')
    await chooseMemory('本会话关闭')
    await expect.poll(() => readSession(secondId).then(value => value.sessionOverride)).toBe(false)
    expect((await readSession(firstId)).sessionOverride).toBe(true)
    await selectSession(firstId, firstHistory)
    await expect(memoryButton()).toContainText('本会话开启')
    await chooseMemory('恢复默认')
    await expect.poll(() => readSession(firstId).then(value => value.sessionOverride)).toBeNull()
    await expect(memoryButton()).toContainText('跟随默认 · 关闭')
    expect(await readSession(firstId)).toMatchObject({ sessionEnabled: false, effectiveScopes: ['global'] })
    expect((await readSession(secondId)).sessionOverride).toBe(false)
    await assertHistoryPreserved()
    evidence.push({ step: 'overrides-and-reset', preferences: await readEngine<Preferences>('/memory/preferences'),
      first: await readSession(firstId), second: await readSession(secondId) })
    await page.screenshot({ path: testInfo.outputPath('embedded-memory-session-default.png'), animations: 'disabled' })
  })

  test('渲染页面重载与自有引擎重启后偏好及覆盖持久化，两会话历史完整保留', async ({}, testInfo) => {
    test.setTimeout(240_000)
    await page.reload()
    await ready()
    await openPreferences()
    await expect(memoryButton()).toContainText('跟随默认 · 关闭')
    expect(await readEngine<Preferences>('/memory/preferences')).toEqual({ globalEnabled: true, sessionDefaultEnabled: false, enabled: true })
    expect((await readSession(firstId)).sessionOverride).toBeNull()
    expect((await readSession(secondId)).sessionOverride).toBe(false)
    await assertHistoryPreserved()
    const before = await page.evaluate(() => window.aether.engine.getSnapshot())
    expect(before.adopted).toBe(false)
    const restarted = await page.evaluate(() => window.aether.engine.restart())
    expect(restarted.phase, restarted.error ?? '').toBe('ready')
    await ready()
    expect(restarted.pid).not.toBe(before.pid)
    expect(await readEngine<Preferences>('/memory/preferences')).toEqual({ globalEnabled: true, sessionDefaultEnabled: false, enabled: true })
    expect((await readSession(firstId)).sessionOverride).toBeNull()
    expect((await readSession(secondId)).sessionOverride).toBe(false)
    await selectSession(secondId, secondHistory)
    await expect(memoryButton()).toContainText('本会话关闭')
    await selectSession(firstId, firstHistory)
    await expect(memoryButton()).toContainText('跟随默认 · 关闭')
    await assertHistoryPreserved()
    await openSettings()
    await expect(page.getByRole('switch', { name: '全局记忆', exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByRole('switch', { name: '全局记忆', exact: true })).toHaveClass(/is-on/)
    await expect(page.getByRole('switch', { name: '默认开启会话记忆', exact: true })).toHaveAttribute('aria-checked', 'false')
    await page.screenshot({ path: testInfo.outputPath('embedded-memory-persisted-settings.png'), animations: 'disabled' })
    evidence.push({ step: 'renderer-and-engine-restart', preferences: await readEngine<Preferences>('/memory/preferences'),
      first: await readSession(firstId), second: await readSession(secondId), historyHashes: [...historyFiles].map(([id, value]) => ({ id, sha256: value.sha256 })) })
  })
})
