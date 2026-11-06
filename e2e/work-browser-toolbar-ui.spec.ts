/** Work browser toolbar: one-row light/dark and narrow layouts, real navigation,
 * anchored viewport/zoom controls, inspectors and local file/directory access. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { basename, dirname, join, resolve } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { BrowserTabState } from '../src/shared/browser'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), parent = join(root, '.e2e-tmp')
let app: ElectronApplication | undefined, health: ElectronHealthMonitor | undefined, page: Page
let fixture = '', origin = '', tabId = '', documentLoads = 0
const errors: string[] = []
const server = createServer((request, response) => {
  if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return }
  if (request.url === '/ping') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}'); return }
  documentLoads++
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(`<!doctype html><meta charset="utf-8"><title>Toolbar ${request.url}</title><h1>Work browser toolbar</h1><script>console.info('ToolbarConsoleMarker');fetch('/ping')</script>`)
})
const browser = () => page.locator('.work-view').getByRole('region', { name: '内置浏览器', exact: true })
const display = () => page.getByRole('dialog', { name: '网页显示与检查', exact: true })
const trigger = () => browser().getByRole('button', { name: '网页显示与检查', exact: true })
async function current(): Promise<BrowserTabState | undefined> { return page.evaluate(id => window.aether.browser.list().then(tabs => tabs.find(tab => tab.tabId === id)), tabId) }
async function openDisplay(): Promise<void> { if (await trigger().getAttribute('aria-expanded') !== 'true') await trigger().click(); await expect(display()).toBeVisible() }
async function choose(label: string, option: string | RegExp): Promise<void> {
  await display().getByRole('button', { name: label, exact: true }).click()
  await page.getByRole('menu', { name: label, exact: true }).getByRole('menuitem', { name: option }).click()
}

test.describe.serial('Work 浏览器紧凑工具栏', () => {
  test.beforeAll(async () => {
    mkdirSync(parent, { recursive: true }); fixture = mkdtempSync(join(parent, 'work-browser-toolbar-'))
    const profile = join(fixture, 'profile'), workspace = join(fixture, 'workspace')
    mkdirSync(profile); mkdirSync(workspace)
    writeFileSync(join(workspace, 'hello.txt'), 'ToolbarLocalFileMarker')
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, engineMode: 'embedded', lastFolder: workspace, appearance: 'dark' }))
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing server address')
    origin = `http://127.0.0.1:${address.port}`
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    env.AETHER_GLOBAL_DIR = join(fixture, 'global'); delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${profile}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'work-browser-toolbar')
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1380, 920))
    await expect(page.locator('.workbench')).toBeVisible()
    await page.evaluate(workspace => {
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.state.v1', JSON.stringify({ activeTaskId: 'toolbar-task', tasks: [{ id: 'toolbar-task', title: '工具栏验收', draft: '', status: 'draft',
        createdAt: Date.now(), updatedAt: Date.now(), workspacePath: workspace, modelId: '', attachments: [], sources: [] }] }))
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', workspace: false }))
    }, workspace)
    await page.reload()
    await page.locator('.work-navigation').getByRole('button', { name: '浏览器', exact: true }).click()
    await browser().getByRole('textbox', { name: '网页地址', exact: true }).fill(`${origin}/one`)
    await browser().getByRole('button', { name: '打开地址', exact: true }).click()
    await expect.poll(async () => {
      const tabs = await page.evaluate(() => window.aether.browser.list())
      const tab = tabs.find(item => item.url === `${origin}/one` && !item.loading)
      tabId = tab?.tabId ?? ''; return tabId
    }).not.toBe('')
  })
  test.afterEach(async () => { expect(errors).toEqual([]); health?.assertHealthy() })
  test.afterAll(async ({}, info) => {
    try { if (health) await health.closeAndAssert(info); else await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const absolute = resolve(fixture)
        if (dirname(absolute) !== parent || !basename(absolute).startsWith('work-browser-toolbar-')) throw new Error('Unsafe test cleanup')
        rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('明暗与窄栏只有一行导航，所有按钮保持可见且弹层不被原生网页覆盖', async ({}, info) => {
    await expect(browser().locator('.browser-options')).toHaveCount(0)
    for (const appearance of ['dark', 'light']) {
      await page.evaluate(value => { document.documentElement.dataset.appearance = value }, appearance)
      for (const width of [900, 340]) {
        await browser().evaluate((element, value) => { element.style.width = `${value}px` }, width)
        const nav = browser().locator('.browser-navigation')
        const geometry = await nav.evaluate(element => {
          const rect = element.getBoundingClientRect()
          return { height: rect.height, width: rect.width, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
            children: [...element.querySelectorAll('button,input')].map(child => { const box = child.getBoundingClientRect(); return { left: box.left - rect.left, right: box.right - rect.left, height: box.height } }) }
        })
        expect(geometry.height).toBeLessThanOrEqual(42)
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1)
        for (const child of geometry.children) { expect(child.left).toBeGreaterThanOrEqual(0); expect(child.right).toBeLessThanOrEqual(geometry.width + 1); expect(child.height).toBeGreaterThanOrEqual(24) }
        await browser().screenshot({ path: info.outputPath(`work-browser-navigation-${appearance}-${width}.png`) })
        await openDisplay()
        await expect(display().getByRole('button', { name: '网页视口', exact: true })).toBeVisible()
        await expect(display().getByRole('button', { name: '网页缩放', exact: true })).toBeVisible()
        await expect(display().getByRole('button', { name: '控制台', exact: true })).toBeVisible()
        await expect(display().getByRole('button', { name: '网络', exact: true })).toBeVisible()
        await page.screenshot({ path: info.outputPath(`work-browser-toolbar-${appearance}-${width}.png`) })
        await display().getByRole('button', { name: '关闭显示选项', exact: true }).press('Escape')
        await expect(trigger()).toBeFocused()
      }
    }
    await browser().evaluate(element => { element.style.width = '' })
  })

  test('视口预设、自定义尺寸、缩放和检查器在弹层执行真实动作', async () => {
    await openDisplay(); await choose('网页视口', /^手机/)
    await expect.poll(async () => (await current())?.viewport).toEqual({ width: 390, height: 844, mobile: true, deviceScaleFactor: 2 })
    await choose('网页视口', /^自定义/)
    await display().getByRole('spinbutton', { name: '视口宽度', exact: true }).fill('960')
    await display().getByRole('spinbutton', { name: '视口高度', exact: true }).fill('640')
    const previousLoads = documentLoads
    await display().getByRole('button', { name: '应用', exact: true }).click()
    await expect.poll(async () => (await current())?.viewport).toEqual({ width: 960, height: 640, mobile: false, deviceScaleFactor: 1 })
    expect(documentLoads).toBe(previousLoads)
    await choose('网页缩放', '125%')
    await expect.poll(async () => (await current())?.zoomFactor).toBe(1.25)
    await choose('网页视口', '适应区域'); await choose('网页缩放', '100%')
    await display().getByRole('button', { name: '控制台', exact: true }).click()
    const consolePanel = browser().getByRole('region', { name: '浏览器控制台', exact: true })
    await expect(consolePanel).toContainText('ToolbarConsoleMarker')
    await openDisplay(); await display().getByRole('button', { name: '网络', exact: true }).click()
    await expect(browser().getByRole('region', { name: '浏览器网络请求', exact: true })).toBeVisible()
    await expect(consolePanel).toHaveCount(0)
    await openDisplay(); await display().getByRole('button', { name: '网络', exact: true }).click()
    await expect(browser().getByRole('region', { name: '浏览器网络请求', exact: true })).toHaveCount(0)
  })

  test('导航、刷新以及文件和目录入口保留', async () => {
    const address = browser().getByRole('textbox', { name: '网页地址', exact: true })
    await address.fill(`${origin}/two`); await address.press('Enter')
    await expect.poll(async () => (await current())?.url).toBe(`${origin}/two`)
    await browser().getByRole('button', { name: '后退', exact: true }).click()
    await expect.poll(async () => (await current())?.url).toBe(`${origin}/one`)
    await browser().getByRole('button', { name: '前进', exact: true }).click()
    await expect.poll(async () => (await current())?.url).toBe(`${origin}/two`)
    await expect.poll(async () => (await current())?.loading).toBe(false)
    const previousLoads = documentLoads
    await browser().getByRole('button', { name: '刷新网页（Ctrl+R）', exact: true }).click()
    await expect.poll(() => documentLoads).toBeGreaterThan(previousLoads)
    await browser().getByRole('button', { name: '浏览器更多操作', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: '打开本地目录', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: '浏览器设置', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: '开发者工具', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    const file = join(fixture, 'workspace', 'hello.txt')
    await app!.evaluate(({ dialog }, path) => {
      const original = dialog.showOpenDialog
      dialog.showOpenDialog = async () => { dialog.showOpenDialog = original; return { canceled: false, filePaths: [path] } }
    }, file)
    await browser().getByRole('button', { name: '打开本地文件', exact: true }).click()
    await expect(browser().getByRole('region', { name: '本地文件预览', exact: true })).toContainText('ToolbarLocalFileMarker')
    await expect(trigger()).toHaveCount(0)
    await app!.evaluate(({ dialog }, path) => {
      const original = dialog.showOpenDialog
      dialog.showOpenDialog = async () => { dialog.showOpenDialog = original; return { canceled: false, filePaths: [path] } }
    }, join(fixture, 'workspace'))
    await browser().getByRole('button', { name: '浏览器更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '打开本地目录', exact: true }).click()
    await expect(browser().getByRole('table', { name: '目录内容', exact: true }).getByRole('button', { name: 'hello.txt', exact: true })).toBeVisible()
  })
})
