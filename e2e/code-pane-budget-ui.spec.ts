/** Real Electron: the browser, sidebar and chat share a measured width budget.
 * Checks three native window sizes, both themes, both pane orders, reduced
 * motion, preserved preferences, and resize from the rendered narrow width.
 * This fixture disables the engine and never calls a model. Build before use. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), parent = join(root, '.e2e-tmp')
let app: ElectronApplication, page: Page, health: ElectronHealthMonitor, fixture = ''
const errors: string[] = []
const sizes = [{ width: 940, height: 640 }, { width: 1100, height: 760 }, { width: 1440, height: 900 }]
const code = () => page.locator('#mode-code')
const saved = () => page.evaluate(() => localStorage.getItem('aether.ide.layout'))

async function contentSize(size: { width: number; height: number }): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), size)
  // Frameless Windows bounds can round across native/non-client pixels; the
  // pane assertions below still use the actual measured Chromium geometry.
  await expect.poll(() => page.evaluate(size =>
    Math.max(Math.abs(innerWidth - size.width), Math.abs(innerHeight - size.height)), size)
  ).toBeLessThanOrEqual(2)
}

async function layout(order: boolean): Promise<void> {
  await page.evaluate(order => {
    localStorage.setItem('aether.ide.layout', JSON.stringify({
      sidebarVisible: true, sidebarWidth: 640, activeView: 'explorer',
      chatPanelVisible: true, chatPanelWidth: 800, chatOnLeft: order,
      panelVisible: false, activeEditorView: 'browser', closedEditorViews: []
    }))
  }, order)
  await page.reload()
  await expect(code().locator('.workbench__chat')).toBeVisible()
  await expect(code().locator('.browser-view')).toBeVisible()
}

test.describe.serial('Code measured pane budget: native window matrix', () => {
  test.beforeAll(async () => {
    mkdirSync(parent, { recursive: true })
    fixture = mkdtempSync(join(parent, 'code-budget-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ autoStartEngine: false, graphicsMode: 'software', lastFolder: '' }))
    const env = { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global') }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.AETHER_ENABLE_GPU
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'code-budget')
    page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.app-mode-switch')).toBeVisible()
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
  })
  test.afterEach(() => { expect(errors).toEqual([]); health.assertHealthy() })
  // eslint-disable-next-line no-empty-pattern
  test.afterAll(async ({}, testInfo) => {
    if (!fixture) return
    const target = resolve(fixture)
    if (dirname(target) !== parent || !basename(target).startsWith('code-budget-')) throw new Error('Unsafe budget fixture cleanup')
    try { await health?.closeAndAssert(testInfo) }
    finally { rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  })

  test('940/1100/1440 viewport keeps the main area usable without rewriting widths', async ({}, testInfo) => {
    for (const order of [false, true]) {
      await layout(order)
      const stored = await saved()
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => { document.documentElement.dataset.appearance = appearance }, appearance)
        for (const size of sizes) {
          await contentSize(size)
          for (const reducedMotion of ['no-preference', 'reduce'] as const) {
            await page.emulateMedia({ reducedMotion })
            const context = `${appearance}/${size.width}/${order ? 'left' : 'right'}/${reducedMotion}`
            await expect.poll(() => code().locator('.workbench__main').evaluate(element => element.getBoundingClientRect().width), { message: context }).toBeGreaterThanOrEqual(319.5)
            const geometry = await code().locator('.workbench__body').evaluate(element => {
              const rect = element.getBoundingClientRect()
              const panes = ['.workbench__sidebar', '.workbench__main', '.workbench__chat'].map(selector => {
                const pane = element.querySelector(selector)
                if (!pane) throw new Error(`Missing pane ${selector}`)
                const box = pane.getBoundingClientRect()
                return { left: box.left, right: box.right, width: box.width }
              })
              return { left: rect.left, right: rect.right, overflow: element.scrollWidth - element.clientWidth, panes }
            })
            expect(geometry.overflow, context).toBeLessThanOrEqual(2)
            for (const pane of geometry.panes) {
              expect(pane.left, context).toBeGreaterThanOrEqual(geometry.left - 1)
              expect(pane.right, context).toBeLessThanOrEqual(geometry.right + 1)
              expect(pane.width, context).toBeGreaterThan(0)
            }
            expect(await saved(), context).toBe(stored)
            await page.screenshot({ path: testInfo.outputPath(`code-budget-${appearance}-${size.width}-${order ? 'left' : 'right'}-${reducedMotion}.png`), animations: 'disabled' })
          }
        }
      }
      await contentSize({ width: 2000, height: 1000 })
      await expect.poll(() => code().locator('.workbench__sidebar').evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(640, 0)
      await expect.poll(() => code().locator('.workbench__chat').evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(800, 0)
      expect(await saved()).toBe(stored)
    }
  })

  test('narrow keyboard and pointer resize begin at the rendered width', async () => {
    await contentSize(sizes[0])
    await layout(false)
    const pane = code().locator('.workbench__chat')
    const divider = code().getByRole('separator', { name: '调整对话面板宽度', exact: true })
    const initial = await pane.evaluate(element => element.getBoundingClientRect().width)
    expect(Number(await divider.getAttribute('aria-valuenow'))).toBeCloseTo(initial, 0)
    await divider.focus()
    await page.keyboard.press('ArrowRight')
    const afterKey = await pane.evaluate(element => element.getBoundingClientRect().width)
    expect(Math.abs(afterKey - initial)).toBeLessThanOrEqual(11)
    const box = await divider.boundingBox()
    if (!box) throw new Error('Missing resize target')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2, { steps: 4 })
    const preview = await pane.evaluate(element => element.getBoundingClientRect().width)
    expect(Math.abs(preview - afterKey)).toBeLessThanOrEqual(11)
    await page.mouse.up()
    const layoutValue = JSON.parse((await saved()) ?? '{}') as { chatPanelWidth: number }
    expect(layoutValue.chatPanelWidth).toBeCloseTo(preview, 0)
    await expect.poll(() => code().locator('.workbench__main').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(319.5)
  })
})
