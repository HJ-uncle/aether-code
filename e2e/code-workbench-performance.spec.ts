/** Real Electron: local resize preview, single final layout save, cancellation,
 * keyboard limits, external resets and Code/Work state preservation. */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'),
  parent = join(root, '.e2e-tmp')
let app: ElectronApplication,
  page: Page,
  health: ElectronHealthMonitor,
  fixture = ''
const errors: string[] = []
const code = (): Locator => page.locator('#mode-code')
const separator = (name: string): Locator => code().getByRole('separator', { name, exact: true })
const sidebar = (): Locator => code().locator('.workbench__sidebar')
const width = (target: Locator): Promise<number> =>
  target.evaluate((element) => element.getBoundingClientRect().width)
const writes = (): Promise<number> =>
  page.evaluate(() => Number(document.documentElement.dataset.resizeWrites ?? 0))
const resetWrites = (): Promise<void> =>
  page.evaluate(() => {
    document.documentElement.dataset.resizeWrites = '0'
  })
const savedSize = (field: string): Promise<number> =>
  page.evaluate(
    (field) =>
      Number(
        (JSON.parse(localStorage.getItem('aether.ide.layout') ?? '{}') as Record<string, unknown>)[
          field
        ]
      ),
    field
  )

async function installProbe(): Promise<void> {
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    document.documentElement.dataset.resizeWrites = '0'
    Storage.prototype.setItem = function (key, value) {
      original.call(this, key, value)
      if (key === 'aether.ide.layout')
        document.documentElement.dataset.resizeWrites = String(
          Number(document.documentElement.dataset.resizeWrites ?? 0) + 1
        )
    }
    document.addEventListener(
      'pointerdown',
      (event) => {
        if ((event.target as Element).closest('.resizer'))
          document.documentElement.dataset.resizePointerId = String(event.pointerId)
      },
      true
    )
  })
}

async function moveDivider(target: Locator, dx: number, dy = 0): Promise<void> {
  const box = await target.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width / 2 + dx, box!.y + box!.height / 2 + dy, { steps: 60 })
}

test.describe.serial('Code 工作台局部布局性能与数据安全', () => {
  test.beforeAll(async () => {
    mkdirSync(parent, { recursive: true })
    fixture = mkdtempSync(join(parent, 'code-layout-'))
    writeFileSync(
      join(fixture, 'settings.json'),
      JSON.stringify({ autoStartEngine: false, graphicsMode: 'software', lastFolder: '' })
    )
    const env = { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global') }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.AETHER_ENABLE_GPU
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'code-layout')
    page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setSize(1800, 1200)
      window.show()
      window.focus()
    })
    await expect(page.locator('.app-mode-switch')).toBeVisible()
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    await expect(sidebar()).toBeVisible()
    await installProbe()
  })
  test.afterEach(() => {
    expect(errors).toEqual([])
    health.assertHealthy()
  })
  // Playwright requires fixture destructuring even when teardown uses none.
  // eslint-disable-next-line no-empty-pattern
  test.afterAll(async ({}, testInfo) => {
    if (!fixture) return
    const target = resolve(fixture)
    if (dirname(target) !== parent || !basename(target).startsWith('code-layout-'))
      throw new Error('Unsafe Code fixture cleanup')
    try {
      await health?.closeAndAssert(testInfo)
    } finally {
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test('连续60步拖动只预览局部尺寸，松手一次保存，重载恢复', async () => {
    const initial = await width(sidebar())
    await resetWrites()
    await moveDivider(separator('调整侧边栏宽度'), 120)
    await expect.poll(() => width(sidebar())).toBeCloseTo(initial + 120, 0)
    expect(await writes()).toBe(0)
    await page.mouse.up()
    await expect.poll(() => savedSize('sidebarWidth')).toBeCloseTo(initial + 120, 0)
    expect(await writes()).toBe(1)
    await page.reload()
    await expect(sidebar()).toBeVisible()
    await expect.poll(() => width(sidebar())).toBeCloseTo(initial + 120, 0)
    await installProbe()
  })

  test('左右对话面板和底部面板沿正确方向预览，分别一次保存', async () => {
    const chat = code().locator('.workbench__chat')
    for (const dx of [-60, 60]) {
      const initial = await width(chat)
      await resetWrites()
      await moveDivider(separator('调整对话面板宽度'), dx)
      await expect.poll(() => width(chat)).toBeCloseTo(initial + 60, 0)
      expect(await writes()).toBe(0)
      await page.mouse.up()
      await expect.poll(() => savedSize('chatPanelWidth')).toBeCloseTo(initial + 60, 0)
      expect(await writes()).toBe(1)
      if (dx < 0)
        await page.getByRole('button', { name: '对话面板与主区换位', exact: true }).click()
    }
    await page.keyboard.press('Control+`')
    const pane = code().locator('.workbench__panel')
    await expect(separator('调整面板高度')).toBeVisible()
    const initial = await pane.evaluate((element) => element.getBoundingClientRect().height)
    await resetWrites()
    await moveDivider(separator('调整面板高度'), 0, -60)
    await expect
      .poll(() => pane.evaluate((element) => element.getBoundingClientRect().height))
      .toBeCloseTo(initial + 60, 0)
    expect(await writes()).toBe(0)
    await page.mouse.up()
    await expect.poll(() => savedSize('panelHeight')).toBeCloseTo(initial + 60, 0)
    expect(await writes()).toBe(1)
  })

  test('Escape、失去捕获、窗口失焦和切Work均取消预览，不写入旧布局', async () => {
    for (const reason of ['escape', 'capture', 'blur', 'mode']) {
      const divider = separator('调整侧边栏宽度')
      const initial = await width(sidebar())
      await resetWrites()
      await moveDivider(divider, 60)
      await expect.poll(() => width(sidebar())).toBeCloseTo(initial + 60, 0)
      if (reason === 'escape') await page.keyboard.press('Escape')
      else if (reason === 'capture') {
        await divider.evaluate((element) =>
          element.releasePointerCapture(Number(document.documentElement.dataset.resizePointerId))
        )
        await page.mouse.move(30, 100)
      } else if (reason === 'blur')
        await page.evaluate(() => window.dispatchEvent(new Event('blur')))
      else await page.getByRole('tab', { name: 'Work 办公', exact: true }).press('Enter')
      await page.mouse.up()
      if (reason === 'mode') await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
      await expect.poll(() => width(sidebar())).toBeCloseTo(initial, 0)
      expect(await writes(), reason).toBe(0)
      expect(await savedSize('sidebarWidth')).toBeCloseTo(initial, 0)
    }
  })

  test('键盘调整遵守边界，拖动中恢复默认采用最新提交值', async () => {
    const divider = separator('调整侧边栏宽度')
    await divider.focus()
    await page.keyboard.press('End')
    await expect.poll(() => savedSize('sidebarWidth')).toBe(640)
    await page.keyboard.press('Home')
    await expect.poll(() => savedSize('sidebarWidth')).toBe(200)
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => savedSize('sidebarWidth')).toBe(210)
    await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
    await code()
      .locator('.app-settings__nav')
      .getByRole('tab', { name: '工作台', exact: true })
      .click()
    const reset = code().getByRole('button', { name: '恢复默认（280px 侧边栏）', exact: true })
    await resetWrites()
    await moveDivider(divider, 50)
    await expect.poll(() => width(sidebar())).toBeCloseTo(260, 0)
    await reset.press('Enter')
    await page.mouse.up()
    await expect.poll(() => savedSize('sidebarWidth')).toBe(280)
    await expect.poll(() => width(sidebar())).toBeCloseTo(280, 0)
    await expect(divider).toHaveAttribute('aria-valuenow', '280')
    expect(await writes()).toBe(1)
    await divider.focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => width(sidebar())).toBeCloseTo(290, 0)
    expect(await savedSize('sidebarWidth')).toBe(290)
  })
})
