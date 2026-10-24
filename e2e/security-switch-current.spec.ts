/** Current regression: real Electron menus + real isolated embedded engine.
 * Exercise signed-out/signed-in Code/Work menus without model calls. */
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

for (const signedIn of [false, true]) {
test(`安全模式在 Code 与 Work 中反复切换（${signedIn ? '已登录' : '未登录'}），确认真实引擎状态`, async ({}, testInfo) => {
  const root = resolve(__dirname, '..'), parent = join(root, '.e2e-tmp')
  mkdirSync(parent, { recursive: true })
  const fixture = mkdtempSync(join(parent, 'security-switch-current-'))
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'embedded', autoStartEngine: true,
    preferredPort: 12447, lastSessionId: 'security-current-code', lastFolder: '', appearance: 'light' }))
  const env = { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global'),
    AETHER_IDE_ENGINE_ENTRY: resolve(root, '..', 'ai-agent-engine', 'dist', 'main.js'),
    WORKSPACE_ROOT: join(fixture, 'workspace'), DEFAULT_SECURITY_MODE: 'safe', AUTH_ENABLED: 'false',
    ENABLE_LONG_TERM_MEMORY: 'false', MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills') }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env })
  const errors: string[] = []
  const operations: unknown[] = []
  try {
    const page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1450, 980))
    await expect.poll(() => page.evaluate(() => window.aether.engine.getSnapshot()).then(snapshot => snapshot.phase), { timeout: 90_000 }).toBe('ready')
    if (signedIn) {
      const account = await page.evaluate(() => window.aether.account.register())
      expect(account.status).toBe('authenticated')
      await expect.poll(() => page.evaluate(() => window.aether.engine.getSnapshot()).then(snapshot => snapshot.accountId)).toBe(account.user?.id)
    }
    for (const surface of ['code', 'work', 'code', 'work']) {
      await page.getByRole('tab', { name: surface === 'work' ? 'Work 办公' : 'Code 开发', exact: true }).click()
      const trigger = page.getByRole('button', { name: /^切换本会话访问权限：/ }).filter({ visible: true })
      await expect(trigger).toBeEnabled()
      for (const [label, mode] of [['标准模式', 'standard'], ['完全访问', 'full-access'], ['安全模式', 'safe']]) {
        await trigger.click()
        await page.getByRole('menuitem', { name: new RegExp(`^${label}`) }).click()
        await expect(trigger).toContainText(label)
        await expect(trigger).toBeEnabled()
        const result = await page.evaluate(async () => {
          return { persisted: Object.entries(localStorage).filter(([key]) => key.startsWith('aether:security-mode')) }
        })
        const sessionId = result.persisted.filter(([key, value]) => key.includes('work-home-') === (surface === 'work') && value === mode).at(-1)?.[0].split(':').at(-1)
        expect(sessionId).toBeTruthy()
        const actual = await page.evaluate(id => window.aether.engine.request<{ sessionId: string; mode: string }>({
          method: 'GET', path: '/security/mode', query: { sessionId: id }
        }), decodeURIComponent(sessionId!))
        operations.push({ surface, mode, actual })
        expect(actual.ok, actual.message).toBe(true)
        expect(actual.data?.mode).toBe(mode)
      }
    }
    expect(errors).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('security-switch-current.png') })
  } finally {
    await testInfo.attach('security-switch-evidence', { body: JSON.stringify({ operations, errors }, null, 2), contentType: 'application/json' })
    await app.close()
    if (dirname(resolve(fixture)) !== parent || !basename(fixture).startsWith('security-switch-current-')) throw new Error('Unsafe security fixture cleanup')
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5 })
  }
})
}
