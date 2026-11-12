/** Real Electron engine status: one compact status, private connection metadata,
 * settings navigation by keyboard/click, and management controls -> preload ->
 * IPC dispatch. Lifecycle handlers are intercepted inside this disposable main
 * process, so tests never start/stop the user's engine. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { IPC, type EngineSnapshot } from '../src/shared/ipc'
import { ResourceSettingsFixture, resourceModel, resourceToken, resourceWorkspace } from './fixtures/resource-settings'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp/engine-status-bar')
const fixture = new ResourceSettingsFixture(), errors: string[] = []
let app: ElectronApplication | undefined, page: Page, profile = '', original: EngineSnapshot
type MainFixture = typeof globalThis & { __engineStatusFixture: { snapshot: EngineSnapshot; calls: string[] } }
const bar = () => page.locator('.status-bar')
const engine = () => bar().locator('.status-bar__engine')
const settingsDialog = () => page.getByRole('dialog', { name: '设置', exact: true })
const controls = () => settingsDialog().locator('.engine-status__actions')

async function snapshot(patch: Partial<EngineSnapshot> = {}): Promise<void> {
  const value = { ...original, ...patch, updatedAt: Date.now() }
  await app!.evaluate(({ BrowserWindow }, { value, channel }) => {
    (globalThis as MainFixture).__engineStatusFixture.snapshot = value
    BrowserWindow.getAllWindows()[0].webContents.send(channel, value)
  }, { value, channel: IPC.event.engineSnapshot })
}
async function windowSize(width: number): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, width) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(520, 600); win.setContentSize(width, 850) }, width)
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
}

test.beforeAll(async () => {
  mkdirSync(fixtureRoot, { recursive: true }); profile = mkdtempSync(join(fixtureRoot, 'profile-')); await fixture.start()
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: fixture.origin,
    remoteWorkspaceRoot: resourceWorkspace, autoStartEngine: true, lastFolder: '', lastSessionId: '',
    lastModelId: resourceModel, appearance: 'light', thinkingMode: 'off' }))
  const env = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY',
    'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_REMOTE_INSTANCE_TOKEN'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = resourceToken; env.AETHER_GLOBAL_DIR = join(profile, 'global')
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${profile}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.show(); win.focus() })
  await expect(bar()).toContainText('引擎：就绪', { timeout: 90_000 })
  original = await page.evaluate(() => window.aether.engine.getSnapshot())
  await app.evaluate(({ ipcMain }, { channels, snapshot }) => {
    const state = (globalThis as MainFixture).__engineStatusFixture = { snapshot, calls: [] }
    for (const channel of channels) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => { state.calls.push(channel); return state.snapshot })
    }
    ipcMain.removeHandler('engine:get-snapshot')
    ipcMain.handle('engine:get-snapshot', () => state.snapshot)
  }, { channels: [IPC.invoke.engineStart, IPC.invoke.engineStop, IPC.invoke.engineRestart], snapshot: original })
})

test.beforeEach(async () => {
  await snapshot()
  await app!.evaluate(() => { (globalThis as MainFixture).__engineStatusFixture.calls.length = 0 })
  await page.reload(); await expect(bar()).toContainText('引擎：就绪')
  await windowSize(1320)
})

test.afterEach(async ({}, info) => {
  await info.attach('app-errors', { body: JSON.stringify({ errors, fixtureErrors: fixture.errors }, null, 2), contentType: 'application/json' })
  if (info.status !== info.expectedStatus && page && !page.isClosed()) await page.screenshot({ path: info.outputPath('failure.png') })
  expect(errors).toEqual([]); expect(fixture.errors).toEqual([])
})

test.afterAll(async () => {
  try { await app?.close() } finally {
    await fixture.close()
    if (profile) {
      const target = resolve(profile)
      if (dirname(target) !== fixtureRoot || !basename(target).startsWith('profile-')) throw new Error('Unsafe status fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

test('底栏只显示状态，点击或 Enter 直接打开引擎管理', async () => {
  await expect(page.locator('.work-sidebar')).not.toContainText('引擎已连接')
  await expect(page.locator('.work-sidebar')).not.toContainText('引擎未就绪')
  const status = engine().getByRole('button', { name: '引擎：就绪', exact: true })
  await expect(status).toBeVisible()
  await expect(engine().getByRole('button')).toHaveCount(1)
  await expect(bar().locator('.status-bar__engine-toggle, .status-bar__engine-actions')).toHaveCount(0)
  await expect(bar().getByRole('button', { name: /启动引擎|停止引擎|重启引擎|重新连接远端引擎|展开引擎操作|收起引擎操作/ })).toHaveCount(0)
  await status.focus(); await page.keyboard.press('Enter')
  await expect(settingsDialog().getByRole('heading', { name: '引擎管理', exact: true })).toBeVisible()
  await expect(controls().getByRole('button', { name: '断开连接', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(settingsDialog()).toBeHidden(); await expect(status).toBeFocused()
  await status.click()
  await expect(settingsDialog().getByRole('heading', { name: '引擎管理', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
})

test('状态与悬停不暴露地址、端口、进程号及原始错误', async ({}, info) => {
  const privateValues = [fixture.origin, new URL(fixture.origin).port, '918273', 'private-runtime-path', 'private-data-path', 'secret-status-error']
  for (const phase of ['ready', 'error', 'starting'] as const) {
    await snapshot({ phase, pid: 918273, adopted: true, entryPath: 'C:/private-runtime-path/index.js', dataDir: 'C:/private-data-path',
      error: phase === 'ready' ? null : `secret-status-error ${fixture.origin} credentials=private-token` })
    await expect(engine()).toContainText(phase === 'ready' ? '引擎：就绪' : phase === 'error' ? '引擎：异常' : '引擎：连接中')
    for (const value of privateValues) expect(await engine().evaluate(element => element.outerHTML)).not.toContain(value)
    await expect(engine().getByRole('button', { name: /^引擎：/ })).toHaveAttribute('title', '打开引擎设置')
  }
  await snapshot()
  await engine().getByRole('button', { name: '引擎：就绪', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(settings).toBeVisible()
  await expect(settings.getByRole('tablist', { name: '设置范围', exact: true })).toHaveCount(0)
  await expect(settings.locator('.app-settings__scope')).toHaveCount(0)
  const search = settings.getByRole('textbox', { name: '搜索设置', exact: true })
  await search.fill('排除')
  const results = settings.getByRole('listbox', { name: '设置搜索结果', exact: true })
  await expect(results.getByRole('option', { name: /资源管理器排除规则/ })).toBeVisible()
  await expect(results.getByRole('option', { name: /搜索排除规则/ })).toBeVisible()
  const path = info.outputPath('settings-without-global-scope.png')
  await page.mouse.move(4, 4); await page.screenshot({ path, animations: 'disabled' })
  await info.attach('settings-without-global-scope', { path, contentType: 'image/png' })
  await search.fill('')
  await expect(results).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('引擎管理中的连接断开重连经 preload 调用对应 IPC', async () => {
  await snapshot({ phase: 'idle' }); await expect(engine()).toContainText('引擎：未启动')
  await engine().getByRole('button', { name: '引擎：未启动', exact: true }).click()
  await expect(settingsDialog().getByRole('heading', { name: '引擎管理', exact: true })).toBeVisible()
  await expect(controls().getByRole('button', { name: '断开连接', exact: true })).toHaveCount(0)
  await controls().getByRole('button', { name: '连接', exact: true }).click()
  await snapshot({ phase: 'ready' }); await expect(engine()).toContainText('引擎：就绪')
  await controls().getByRole('button', { name: '断开连接', exact: true }).click()
  await controls().getByRole('button', { name: '重启', exact: true }).click()
  await expect.poll(() => app!.evaluate(() => (globalThis as MainFixture).__engineStatusFixture.calls)).toEqual([
    IPC.invoke.engineStart, IPC.invoke.engineStop, IPC.invoke.engineRestart
  ])
  await snapshot({ phase: 'starting', error: null }); await expect(engine()).toContainText('引擎：连接中')
  await expect(controls().getByRole('button', { name: '断开连接', exact: true })).toBeDisabled()
  await snapshot({ phase: 'starting', error: '连接失败，正在重新连接' }); await expect(engine()).toContainText('引擎：重新连接中')
  await controls().getByRole('button', { name: '断开连接', exact: true }).click()
  await expect.poll(() => app!.evaluate(() => (globalThis as MainFixture).__engineStatusFixture.calls)).toEqual([
    IPC.invoke.engineStart, IPC.invoke.engineStop, IPC.invoke.engineRestart, IPC.invoke.engineStop
  ])
  await page.keyboard.press('Escape')
})

test('深浅色和窄窗下底栏状态悬停无背景且不溢出', async ({}, info) => {
  for (const appearance of ['light', 'dark']) for (const width of [1320, 620]) {
    await page.evaluate(appearance => { document.documentElement.dataset.appearance = appearance }, appearance)
    await windowSize(width)
    const bounds = await bar().boundingBox(), engineBounds = await engine().boundingBox()
    expect(bounds).not.toBeNull(); expect(engineBounds).not.toBeNull()
    expect(engineBounds!.x - bounds!.x).toBeLessThan(20)
    expect(engineBounds!.width).toBeLessThan(160)
    await expect(engine().getByRole('button')).toHaveCount(1)
    expect(await bar().evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    const status = engine().getByRole('button', { name: '引擎：就绪', exact: true })
    await expect(status).toBeInViewport({ ratio: 1 })
    await status.hover()
    await expect(status).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    const path = info.outputPath(`engine-status-${appearance}-${width}.png`)
    await page.screenshot({ path, animations: 'disabled' })
    await info.attach(`engine-status-${appearance}-${width}`, { path, contentType: 'image/png' })
  }
})
