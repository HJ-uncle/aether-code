/** Real Electron settings: account help icon, readable hover details, keyboard
 * dismissal and both appearances. An isolated profile keeps the engine stopped;
 * only the test instance's account IPC is replaced with a read-only fixture. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AccountState } from '../src/shared/account'
import { IPC } from '../src/shared/ipc'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const account: AccountState = {
  status: 'signed-out', user: null, providers: [], serviceUrl: 'http://127.0.0.1:12543',
  persistence: 'none', message: null, registrationEnabled: true, transport: 'local'
}
const errors: string[] = []
let app: ElectronApplication | undefined, page: Page, fixture = ''
const settings = () => page.getByRole('dialog', { name: '设置', exact: true })
const trigger = () => settings().getByRole('button', { name: '查看个人账号登录说明', exact: true })
const tooltip = () => page.getByRole('tooltip', { name: '个人账号登录说明', exact: true })

async function openAccount(appearance: 'dark' | 'light'): Promise<void> {
  await settings().getByRole('tab', { name: '外观', exact: true }).click()
  await settings().getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await settings().getByRole('tab', { name: '个人账号', exact: true }).click()
  await expect(settings().locator('.account-status')).toHaveText('未登录')
  await expect(trigger()).toBeVisible()
}

test.describe.serial('个人账号登录说明', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'account-help-profile-'))
    const profile = join(fixture, 'profile'); mkdirSync(profile)
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, engineMode: 'embedded',
      lastFolder: '', lastSessionId: '', appearance: 'dark' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY',
      'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_REMOTE_INSTANCE_TOKEN'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${profile}`], cwd: root, env })
    page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow, ipcMain }, { channel, account }) => {
      const fixtureState = globalThis as typeof globalThis & { __accountHelpActions?: string[] }
      fixtureState.__accountHelpActions = []
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event, action: unknown) => {
        fixtureState.__accountHelpActions!.push(String(action))
        if (action !== 'getState') return { ok: false, message: '账号说明测试不允许修改账号。' }
        return { ok: true, value: account }
      })
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(1440, 1000); window.show(); window.focus()
    }, { channel: IPC.invoke.accountAction, account })
    await expect(page.locator('.workbench')).toBeVisible()
    await page.evaluate(() => localStorage.setItem('aether.app.mode', 'work'))
    await page.reload(); await expect(page.locator('.work-view')).toBeVisible()
    await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
    await expect(settings()).toBeVisible()
  })

  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && page && !page.isClosed()) {
      const path = info.outputPath('account-help-failure.png')
      await page.screenshot({ path }); await info.attach('账号说明失败窗口', { path, contentType: 'image/png' })
    }
    expect(errors).toEqual([])
    if (app) {
      const actions = await app.evaluate(() => (globalThis as typeof globalThis & { __accountHelpActions?: string[] }).__accountHelpActions ?? [])
      expect(actions.length).toBeGreaterThan(0)
      expect(actions.filter(action => action !== 'getState')).toEqual([])
    }
  })

  test.afterAll(async () => {
    try { await app?.close() }
    finally {
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('account-help-profile-')) throw new Error(`Unsafe account-help fixture cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  for (const appearance of ['dark', 'light'] as const) test(`${appearance}：圆圈感叹号悬浮说明可停留阅读，离开关闭`, async ({}, info) => {
    await openAccount(appearance)
    await expect(tooltip()).toHaveCount(0)
    await expect(trigger().locator('svg circle')).toHaveCount(1)
    await expect(trigger().locator('svg path')).toHaveCount(2)
    await trigger().hover()
    await expect(tooltip()).toBeVisible()
    await expect(tooltip()).toContainText('当前未登录账号')
    for (const name of ['一键登录', '已有账号', '使用恢复码登录']) await expect(tooltip()).toContainText(name)
    await expect(trigger()).toHaveAttribute('aria-describedby', await tooltip().getAttribute('id') ?? '')
    await tooltip().hover()
    await expect.poll(() => tooltip().evaluate(element => element.matches(':hover'))).toBe(true)
    // Passing the 160 ms leave delay verifies that reading the panel does not
    // close it after the pointer has left the small icon.
    await page.waitForTimeout(250)
    await expect(tooltip()).toBeVisible()
    const bounds = await tooltip().evaluate(element => ({ rect: element.getBoundingClientRect().toJSON(), width: innerWidth, height: innerHeight }))
    expect(bounds.rect.left).toBeGreaterThanOrEqual(0); expect(bounds.rect.right).toBeLessThanOrEqual(bounds.width)
    expect(bounds.rect.top).toBeGreaterThanOrEqual(0); expect(bounds.rect.bottom).toBeLessThanOrEqual(bounds.height)
    const path = info.outputPath(`account-help-${appearance}.png`)
    await page.screenshot({ path }); await info.attach(`账号登录说明-${appearance}`, { path, contentType: 'image/png' })
    await page.mouse.move(4, 4)
    await expect(tooltip()).toHaveCount(0)
  })

  test('Tab 聚焦显示说明，Escape 只关闭说明并保留设置页', async () => {
    await openAccount('dark'); await page.mouse.move(4, 4)
    await settings().getByRole('button', { name: '刷新账号状态', exact: true }).focus()
    await page.keyboard.press('Tab')
    await expect(trigger()).toBeFocused(); await expect(tooltip()).toBeVisible()
    await expect(trigger()).toHaveCSS('outline-style', 'solid')
    await page.keyboard.press('Escape')
    await expect(tooltip()).toHaveCount(0); await expect(settings()).toBeVisible(); await expect(trigger()).toBeFocused()
  })
})
