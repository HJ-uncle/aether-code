import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { AetherIdeApi } from '../src/preload'

/**
 * D1: real Electron renderer/IPC/embedded-engine security modes, session switching,
 * confirmed PUTs, and unknown state after the owned engine fails. No LLM calls.
 * Deferred response ordering is covered by security-state.spec.ts, not a fake server.
 * Build both projects first; the root runner uses one Playwright worker.
 */
declare global { interface Window { aether: AetherIdeApi } }
const root = resolve(__dirname, '..')
const engineRoot = resolve(root, '..', 'ai-agent-engine')
const FIRST_SESSION = 'd1-security-A'
const SECOND_SESSION = 'd1-security-B'
let app: ElectronApplication | undefined
let page: Page
let fixtureRoot = ''

async function openPreferences(): Promise<void> {
  if (!await page.locator('.composer-options__popup').isVisible()) {
    await page.getByRole('button', { name: '对话偏好', exact: true }).click()
  }
}

async function readMode(sessionId: string): Promise<string | undefined> {
  const response = await page.evaluate(id => window.aether.engine.request<{ sessionId: string; mode: string }>({
    method: 'GET', path: '/security/mode', query: { sessionId: id }
  }), sessionId)
  expect(response.ok, response.message).toBe(true)
  expect(response.data?.sessionId).toBe(sessionId)
  return response.data?.mode
}

async function selectSession(name: string, sessionId: string): Promise<void> {
  if (await page.locator('.composer-options__popup').isVisible()) await page.keyboard.press('Escape')
  if (!await page.locator('.history-view').isVisible()) {
    await page.getByRole('button', { name: '会话历史', exact: true }).click()
  }
  await page.locator('.history-view__item').filter({ hasText: name }).click()
  await expect.poll(async () => (await page.evaluate(() => window.aether.settings.get())).lastSessionId).toBe(sessionId)
  await openPreferences()
}

test.describe.serial('D1 安全模式真实界面状态', () => {
  test.beforeAll(async () => {
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
    fixtureRoot = mkdtempSync(join(root, '.e2e-tmp', 'd1-security-'))
    writeFileSync(join(fixtureRoot, 'settings.json'), JSON.stringify({
      engineMode: 'embedded', preferredPort: 12409, autoStartEngine: true,
      lastSessionId: FIRST_SESSION, lastFolder: fixtureRoot, thinkingMode: 'off'
    }))
    app = await electron.launch({
      args: ['.', '--user-data-dir=' + fixtureRoot], cwd: root,
      env: { ...process.env, AETHER_IDE_ENGINE_ENTRY: join(engineRoot, 'dist/main.js'),
        AUTH_ENABLED: 'false', DEFAULT_SECURITY_MODE: 'safe',
        AETHER_GLOBAL_DIR: join(fixtureRoot, 'global'), WORKSPACE_ROOT: join(fixtureRoot, 'workspace'),
        MCP_CONFIG_PATH: join(fixtureRoot, 'mcp.json'), SKILLS_ROOT: join(fixtureRoot, 'skills'),
        ENABLE_LONG_TERM_MEMORY: 'false' }
    })
    page = await app.firstWindow()
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const seeded = await page.evaluate(async ({ first, second }) => {
      const a = await window.aether.engine.request({ method: 'PUT', path: '/security/mode', body: { sessionId: first, mode: 'full-access' } })
      const b = await window.aether.engine.request({ method: 'PUT', path: '/security/mode', body: { sessionId: second, mode: 'standard' } })
      // Empty sessions have no engine history. These are ordinary local list fixtures;
      // mode reads/writes and session selection still use production paths.
      const now = Date.now()
      sessionStorage.setItem('aether-pending-sessions', JSON.stringify([
        { sessionId: first, createdAt: now - 1, lastAt: now - 1 },
        { sessionId: second, createdAt: now, lastAt: now }
      ]))
      localStorage.setItem('aether:sessionMeta', JSON.stringify({
        [first]: { name: 'D1 session A' }, [second]: { name: 'D1 session B' }
      }))
      return [a, b]
    }, { first: FIRST_SESSION, second: SECOND_SESSION })
    for (const response of seeded) expect(response.ok, response.message).toBe(true)
    await page.reload()
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 30_000 })
  })

  test.afterAll(async () => {
    await app?.close()
    if (fixtureRoot) {
      const target = resolve(fixtureRoot)
      if (!target.startsWith(resolve(root, '.e2e-tmp') + sep) || !target.split(sep).pop()?.startsWith('d1-security-')) throw new Error('Unsafe fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })

  test('实际切换 A/B 会话读取各自模式，标准模式明确显示工作区外权限', async () => {
    await openPreferences()
    await expect(page.getByTitle('选择安全模式')).toContainText('完全访问')
    await selectSession('D1 session B', SECOND_SESSION)
    await expect(page.getByTitle('选择安全模式')).toContainText('标准模式')
    await expect(page.locator('.composer-options__popup')).toContainText('工作区以外')
    expect(await readMode(SECOND_SESSION)).toBe('standard')
    await selectSession('D1 session A', FIRST_SESSION)
    await expect(page.getByTitle('选择安全模式')).toContainText('完全访问')
    await selectSession('D1 session B', SECOND_SESSION)
    await expect(page.getByTitle('选择安全模式')).toContainText('标准模式')
  })

  test('对话偏好与设置页的切换真实写入同一会话的引擎状态', async () => {
    await page.getByTitle('选择安全模式').click()
    await page.getByRole('menuitem').filter({ hasText: '完全访问' }).click()
    await expect.poll(() => readMode(SECOND_SESSION)).toBe('full-access')
    await expect(page.getByTitle('选择安全模式')).toContainText('完全访问')
    expect(await readMode(FIRST_SESSION)).toBe('full-access')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+Shift+P')
    await page.locator('.palette__input').fill('安全策略')
    await page.locator('.palette__item').first().click()
    await expect(page.getByRole('radio', { name: '完全访问', exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('.settings-view')).toContainText('允许 Agent 读写工作区以外的文件')
    await page.getByRole('radio', { name: '标准模式', exact: true }).click()
    await expect.poll(() => readMode(SECOND_SESSION)).toBe('standard')
    await expect(page.getByRole('radio', { name: '标准模式', exact: true })).toHaveAttribute('aria-checked', 'true')
  })

  test('自有引擎异常退出后显示状态未知，重启后重新确认真实默认模式', async () => {
    const owned = await page.evaluate(() => window.aether.engine.getSnapshot())
    expect(owned.mode).toBe('embedded')
    expect(owned.adopted).toBe(false)
    expect(owned.entryPath).toBe(join(engineRoot, 'dist/main.js'))
    expect(owned.dataDir).toBe(join(fixtureRoot, 'engine/state/agent.db'))
    expect(owned.phase).toBe('ready')
    if (!owned.pid) throw new Error('Fixture engine has no owned process')
    process.kill(owned.pid, 'SIGKILL')
    await expect.poll(async () => (await page.evaluate(() => window.aether.engine.getSnapshot())).phase).toBe('error')
    await expect(page.locator('.settings-view')).toContainText('安全模式状态未知')
    await expect(page.locator('.settings-view')).toContainText('引擎未就绪')
    await expect(page.getByRole('radio', { name: '安全模式', exact: true })).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByRole('radio', { name: '标准模式', exact: true })).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByRole('radio', { name: '完全访问', exact: true })).toHaveAttribute('aria-checked', 'false')
    const restarted = await page.evaluate(() => window.aether.engine.start())
    expect(restarted.phase, restarted.error ?? '').toBe('ready')
    await expect(page.getByRole('radio', { name: '安全模式', exact: true })).toHaveAttribute('aria-checked', 'true')
    expect(await readMode(SECOND_SESSION)).toBe('safe')
  })
})
