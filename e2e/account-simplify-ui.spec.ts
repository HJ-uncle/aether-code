/** Real isolated Electron account UI. Fixture-only account IPC; no production engine,
 * credentials, browser authorization or clipboard. Build before running with the
 * existing e2e/config/playwright.config.ts; outputs belong in .e2e-tmp/account-simplify/. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AccountSession, AccountState, AccountUser } from '../src/shared/account'
import { IPC } from '../src/shared/ipc'

const root = resolve(__dirname, '..'), temporaryRoot = join(root, '.e2e-tmp', 'account-simplify')
const provider = { id: 'fixture-provider', name: '测试登录服务', type: 'oidc' as const }
const accountUser = (id = 'account-one', fresh = true): AccountUser => ({ id, tenantId: `tenant-${id}`, name: '测试账号', email: null, avatarUrl: null, bio: null, userData: {}, createdAt: '2026-11-01T00:00:00.000Z', identities: [{ providerId: provider.id, subject: 'fixture-subject' }], sessionId: 'current-session-one', authenticatedAt: new Date(Date.now() - (fresh ? 1_000 : 11 * 60_000)).toISOString(), roles: ['tenant-admin'] })
const signedOut = (): AccountState => ({ status: 'signed-out', user: null, serviceUrl: 'http://127.0.0.1:12543', connectionMode: 'embedded', providers: [provider], persistence: 'none', message: null, registrationEnabled: true, transport: 'local', recovery: { available: false, exportedAt: null } })
const signedIn = (fresh = true): AccountState => ({ ...signedOut(), status: 'authenticated', user: accountUser('account-one', fresh), persistence: 'encrypted', recovery: { available: true, exportedAt: '2026-11-01T00:00:00.000Z' } })
interface Fixture { account: AccountState; calls: Array<{ action: string; args: unknown[] }>; failNext: string | null; saveCanceled: boolean; sessions: AccountSession[] }
let app: ElectronApplication, page: Page, fixtureDirectory = ''
const errors: string[] = []
const settings = () => page.getByRole('dialog', { name: '设置', exact: true })
const accountPage = () => settings().locator('.account-settings')
async function fixture(account: AccountState, options: { failNext?: string; saveCanceled?: boolean } = {}): Promise<void> {
  await app.evaluate(({ BrowserWindow }, { account, channel, options }) => {
    const globals = globalThis as typeof globalThis & { __accountSimplify: Fixture }
    globals.__accountSimplify.account = account
    globals.__accountSimplify.calls = []
    globals.__accountSimplify.failNext = options.failNext ?? null
    globals.__accountSimplify.saveCanceled = options.saveCanceled ?? false
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, account)
  }, { account, channel: IPC.event.accountChanged, options })
  await expect(accountPage().locator('.account-status')).toHaveText(account.status === 'authenticated' ? '已登录' : account.status === 'expired' ? '登录已过期' : account.status === 'offline' ? '离线' : '未登录')
}
const calls = (): Promise<Fixture['calls']> => app.evaluate(() => (globalThis as typeof globalThis & { __accountSimplify: Fixture }).__accountSimplify.calls)
const actionCount = async (action: string): Promise<number> => (await calls()).filter(call => call.action === action).length
async function expectKeyboardFocus(previous: Locator, button: Locator): Promise<void> {
  const restingShadow = await button.evaluate(element => getComputedStyle(element).boxShadow)
  await previous.focus(); await page.keyboard.press('Tab')
  await expect(button).toBeFocused()
  expect(await button.evaluate(element => element.matches(':focus-visible'))).toBe(true)
  expect(await button.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe(restingShadow)
}
async function openSafety(): Promise<void> {
  const disclosure = accountPage().locator('.sg__disclosure-title').filter({ hasText: /^安全$/ }).locator('xpath=ancestor::details[1]')
  if (!await disclosure.evaluate(element => (element as HTMLDetailsElement).open)) await disclosure.locator(':scope > summary').click()
}
async function beginRegeneration(): Promise<void> {
  await openSafety()
  await accountPage().getByRole('button', { name: '重新生成', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: '重新生成恢复码', exact: true })
  await expect(confirm).toContainText('旧恢复码和旧 API Key 将失效')
  await confirm.getByRole('button', { name: '重新生成', exact: true }).click()
}
async function closeDialogs(): Promise<void> {
  for (const title of ['保存登录凭证', '重新验证身份']) {
    const dialog = page.getByRole('dialog', { name: title, exact: true })
    if (await dialog.count()) await dialog.getByRole('button', { name: title === '保存登录凭证' ? '稍后' : '取消', exact: true }).click()
  }
}

test.describe.serial('账号登录简化', () => {
  test.beforeAll(async () => {
    mkdirSync(temporaryRoot, { recursive: true }); fixtureDirectory = mkdtempSync(join(temporaryRoot, 'profile-'))
    const profile = join(fixtureDirectory, 'user-data'); mkdirSync(profile)
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, engineMode: 'embedded', lastFolder: '', lastSessionId: '', appearance: 'dark' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_REMOTE_INSTANCE_TOKEN'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_GLOBAL_DIR = join(fixtureDirectory, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${profile}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow, ipcMain }, { channel, eventChannel, initial, user }) => {
      const globals = globalThis as typeof globalThis & { __accountSimplify: Fixture }
      globals.__accountSimplify = { account: initial, calls: [], failNext: null, saveCanceled: false, sessions: [
        { id: 'current-session-one', current: true, createdAt: '2026-11-15T00:00:00.000Z', lastSeenAt: '2026-11-17T00:00:00.000Z', expiresAt: '2026-12-15T00:00:00.000Z' },
        { id: 'another-session-two', current: false, createdAt: '2026-11-10T00:00:00.000Z', lastSeenAt: '2026-11-16T00:00:00.000Z', expiresAt: '2026-12-10T00:00:00.000Z' }
      ] }
      const publish = (): AccountState => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send(eventChannel, globals.__accountSimplify.account); return globals.__accountSimplify.account }
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (_event, action: string, ...args: unknown[]) => {
        const state = globals.__accountSimplify; state.calls.push({ action, args })
        if (state.failNext === action) { state.failNext = null; return { ok: false, message: '此操作需要重新验证登录，请使用恢复凭证或第三方账号重新登录' } }
        if ((action === 'login' || action === 'reauthenticate') && args[0] !== 'fixture-valid-recovery') return { ok: false, message: '恢复凭证无效，请检查后重试。' }
        let value: unknown
        if (action === 'getState') value = state.account
        else if (action === 'register' || action === 'login') { state.account = { ...state.account, status: 'authenticated', user: { ...user, authenticatedAt: new Date().toISOString() }, persistence: 'encrypted', recovery: { available: true, exportedAt: null } }; value = publish() }
        else if (action === 'reauthenticate' || action === 'externalLogin' && args[1] === 'reauth') { state.account = { ...state.account, user: { ...state.account.user!, authenticatedAt: new Date().toISOString() } }; value = publish() }
        else if (action === 'regenerateRecovery') { state.account = { ...state.account, recovery: { available: true, exportedAt: null } }; value = publish() }
        else if (action === 'exportRecovery') { value = !state.saveCanceled; if (value) { state.account = { ...state.account, recovery: { available: true, exportedAt: new Date().toISOString() } }; publish() } }
        else if (action === 'copyRecovery' || action === 'cancelExternalLogin') value = undefined
        else if (action === 'sessions') value = state.sessions
        else if (action === 'revokeSession') { state.sessions = state.sessions.filter(session => session.id !== args[0]); value = undefined }
        else if (action === 'updateProfile') { state.account = { ...state.account, user: { ...state.account.user!, ...args[0] as object } }; value = publish() }
        else if (action === 'unlink') { state.account = { ...state.account, user: { ...state.account.user!, identities: [] } }; value = publish() }
        else if (action === 'logout') { state.account = { ...state.account, status: 'signed-out', user: null, recovery: { available: false, exportedAt: null } }; value = publish() }
        else return { ok: false, message: `Unexpected fixture action ${action}` }
        return { ok: true, value }
      })
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 900)
    }, { channel: IPC.invoke.accountAction, eventChannel: IPC.event.accountChanged, initial: signedOut(), user: accountUser() })
    await page.reload(); await expect(page.locator('.workbench')).toBeVisible()
    await page.locator('.menu-bar').getByRole('button', { name: '登录账号', exact: true }).click()
    await settings().getByRole('tab', { name: '个人账号', exact: true }).click(); await expect(accountPage()).toBeVisible()
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && !page.isClosed()) { const image = info.outputPath('failure.png'); await page.screenshot({ path: image }); await info.attach('账号界面失败', { path: image, contentType: 'image/png' }) }
    expect(errors).toEqual([])
    await closeDialogs()
  })
  test.afterAll(async () => {
    await app?.close()
    if (fixtureDirectory) { const target = resolve(fixtureDirectory); if (dirname(target) !== temporaryRoot || !basename(target).startsWith('profile-')) throw new Error('Unsafe account fixture cleanup'); rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  })
  test('本机入口明确区分登录与创建，错误保留恢复码', async () => {
    await fixture(signedOut())
    await expect(accountPage()).toContainText('无需登录即可使用，工作保存在本机')
    await expect(accountPage()).toContainText('http://127.0.0.1:12543')
    await expect(accountPage().getByRole('button', { name: '一键登录', exact: true })).toHaveCount(0)
    await expect(accountPage().getByLabel('恢复码', { exact: true })).toHaveCount(0)
    await accountPage().getByRole('button', { name: '登录已有账号', exact: true }).click()
    await expect(accountPage().getByRole('button', { name: '选择恢复文件', exact: true })).toBeVisible()
    await accountPage().getByLabel('恢复码', { exact: true }).fill('fixture-bad-recovery')
    await accountPage().getByRole('button', { name: '登录', exact: true }).click()
    await expect(accountPage().getByRole('alert')).toContainText('恢复凭证无效')
    await expect(accountPage().getByLabel('恢复码', { exact: true })).toHaveValue('fixture-bad-recovery')
    expect(await actionCount('register')).toBe(0)
  })
  test('创建需明确确认，首步保存凭证且取消保存不算已备份', async () => {
    await fixture(signedOut(), { saveCanceled: true })
    await accountPage().getByRole('button', { name: '创建新账号', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: '创建新账号', exact: true })
    await expect(confirmation).toContainText('不会自动迁入新账号')
    await confirmation.getByRole('button', { name: '取消', exact: true }).click(); expect(await actionCount('register')).toBe(0)
    await accountPage().getByRole('button', { name: '创建新账号', exact: true }).click()
    await confirmation.getByRole('button', { name: '创建账号', exact: true }).click()
    const onboarding = page.getByRole('dialog', { name: '保存登录凭证', exact: true })
    await expect(onboarding).toBeVisible(); expect(await actionCount('register')).toBe(1)
    await expect(page.getByRole('dialog', { name: '完善个人资料', exact: true })).toHaveCount(0)
    await expectKeyboardFocus(onboarding.getByRole('button', { name: '稍后', exact: true }), onboarding.getByRole('button', { name: '保存恢复文件', exact: true }))
    await onboarding.getByRole('button', { name: '保存恢复文件', exact: true }).click()
    await expect.poll(() => actionCount('exportRecovery')).toBe(1); await expect(onboarding).toBeVisible()
    await app.evaluate(() => { (globalThis as typeof globalThis & { __accountSimplify: Fixture }).__accountSimplify.saveCanceled = false })
    await onboarding.getByRole('button', { name: '保存恢复文件', exact: true }).click()
    await expect(onboarding).toHaveCount(0); await expect(accountPage()).toContainText('最近保存于')
    expect(await actionCount('regenerateRecovery')).toBe(0)
  })
  test('已登录可复制与保存已有凭证，界面不显示恢复码明文', async () => {
    await fixture(signedIn())
    await accountPage().getByRole('button', { name: '复制恢复码', exact: true }).click()
    await expect.poll(() => actionCount('copyRecovery')).toBe(1)
    await expect(accountPage()).toContainText('恢复码已复制')
    await expect(accountPage()).not.toContainText('fixture-valid-recovery')
    await expect(accountPage().getByLabel('姓名', { exact: true })).not.toBeVisible()
    expect(await actionCount('regenerateRecovery')).toBe(0)
  })
  test('过期状态优先重新登录，不显示创建账号入口', async () => {
    await fixture({ ...signedIn(false), status: 'expired' })
    await expect(accountPage().getByRole('button', { name: '重新登录', exact: true })).toBeVisible()
    await expect(accountPage().getByRole('button', { name: '创建新账号', exact: true })).toHaveCount(0)
    await expect(accountPage()).toContainText('测试账号')
  })
  test('展开登录会话自动读取、刷新仅图标，显示创建时间和标识', async () => {
    await fixture(signedIn()); await openSafety()
    await accountPage().locator('.account-sessions > summary').click()
    await expect.poll(() => actionCount('sessions')).toBe(1)
    await expect(accountPage()).toContainText('current-'); await expect(accountPage()).toContainText('another-')
    const refresh = accountPage().getByRole('button', { name: '刷新登录会话', exact: true })
    await expect(refresh).toHaveText(''); await refresh.click(); await expect.poll(() => actionCount('sessions')).toBe(2)
    await accountPage().locator('.account-session').filter({ hasText: 'another-' }).getByRole('button', { name: '撤销登录', exact: true }).click()
    await page.getByRole('dialog', { name: '撤销登录会话', exact: true }).getByRole('button', { name: '撤销登录', exact: true }).click()
    await expect.poll(() => actionCount('revokeSession')).toBe(1)
    await expect(accountPage().locator('.account-session').filter({ hasText: 'another-' })).toHaveCount(0)
  })
  test('原地重验可取消，错误保留输入，成功后继续原操作且不退出', async () => {
    await fixture(signedIn(false)); await beginRegeneration()
    const verification = page.getByRole('dialog', { name: '重新验证身份', exact: true })
    await expect(verification).toBeVisible(); expect(await actionCount('regenerateRecovery')).toBe(0)
    await verification.getByRole('button', { name: '取消', exact: true }).click()
    expect(await actionCount('regenerateRecovery')).toBe(0); expect(await actionCount('logout')).toBe(0)
    await beginRegeneration()
    await verification.getByLabel('恢复码', { exact: true }).fill('wrong-key')
    await verification.getByRole('button', { name: '验证并继续', exact: true }).click()
    await expect(verification.getByRole('alert')).toContainText('恢复凭证无效')
    await expect(verification.getByLabel('恢复码', { exact: true })).toHaveValue('wrong-key')
    await verification.getByLabel('恢复码', { exact: true }).fill('fixture-valid-recovery')
    await expectKeyboardFocus(verification.getByLabel('恢复码', { exact: true }), verification.getByRole('button', { name: '验证并继续', exact: true }))
    await verification.getByRole('button', { name: '验证并继续', exact: true }).click()
    await expect.poll(() => actionCount('regenerateRecovery')).toBe(1)
    await expect(page.getByRole('dialog', { name: '保存登录凭证', exact: true })).toBeVisible()
    expect(await actionCount('logout')).toBe(0)
  })
  test('服务器重验边界触发弹窗，可通过已绑定第三方验证并继续', async () => {
    await fixture(signedIn(), { failNext: 'regenerateRecovery' }); await beginRegeneration()
    const verification = page.getByRole('dialog', { name: '重新验证身份', exact: true })
    await expect(verification).toBeVisible()
    await verification.getByRole('button', { name: '验证', exact: true }).click()
    await expect.poll(() => actionCount('regenerateRecovery')).toBe(2)
    expect((await calls()).find(call => call.action === 'externalLogin')?.args).toEqual([provider.id, 'reauth', undefined])
    expect(await actionCount('logout')).toBe(0)
  })
  test('切换账号取消待验证操作，不把旧操作应用到新账号', async () => {
    await fixture(signedIn(false)); await beginRegeneration()
    await expect(page.getByRole('dialog', { name: '重新验证身份', exact: true })).toBeVisible()
    await fixture({ ...signedIn(), user: accountUser('account-two') })
    await expect(page.getByRole('dialog', { name: '重新验证身份', exact: true })).toHaveCount(0)
    expect(await actionCount('regenerateRecovery')).toBe(0)
  })
  for (const appearance of ['light', 'dark'] as const) test(`${appearance}：标准与小窗口的账号入口布局`, async ({}, info) => {
    await fixture(signedOut())
    await settings().getByRole('tab', { name: '外观', exact: true }).click()
    await settings().getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
    await settings().getByRole('tab', { name: '个人账号', exact: true }).click()
    for (const size of [{ width: 1280, height: 900 }, { width: 800, height: 650 }]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), size)
      await expect(accountPage().getByRole('button', { name: '登录已有账号', exact: true })).toBeVisible()
      const bounds = await accountPage().evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth, right: element.getBoundingClientRect().right, windowWidth: innerWidth }))
      expect(bounds.scroll).toBeLessThanOrEqual(bounds.client + 1); expect(bounds.right).toBeLessThanOrEqual(bounds.windowWidth)
      const screenshot = info.outputPath(`account-${appearance}-${size.width}.png`)
      await page.screenshot({ path: screenshot }); await info.attach(`账号-${appearance}-${size.width}`, { path: screenshot, contentType: 'image/png' })
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 900))
  })
})
