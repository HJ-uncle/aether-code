/** Fresh regression: with an existing Work task selected, local files opened
 * from the standalone browser must keep that surface and the task draft.
 * Real Electron, disk reads and native browser tabs; only picker results are
 * substituted at the OS dialog boundary. No engine, legacy suites or exports. */
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { BrowserTabState } from '../src/shared/browser'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), parent = join(root, '.e2e-tmp')
const taskId = 'work-browser-navigation-task', taskTitle = '文件预览不改变这条会话', draft = '未发送的工作指令，必须保留'
const markdown = '# README\nStandaloneBrowserFileMarker\n只读本地文件内容'
const errors: string[] = []
let app: ElectronApplication | undefined, health: ElectronHealthMonitor | undefined, page: Page
let fixture = '', directory = '', workspace = '', origin = ''
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><meta charset="utf-8"><title>导航回归网页</title><h1>BrowserNavigationWebMarker</h1>')
})
const work = () => page.locator('.work-view')
const standalone = () => work().getByRole('region', { name: 'Work 浏览器', exact: true })
const browser = () => work().getByRole('region', { name: '内置浏览器', exact: true })
const preview = () => browser().getByRole('region', { name: '本地文件预览', exact: true })
const address = () => browser().getByRole('textbox', { name: '网页地址', exact: true })
const taskButton = () => work().locator('.work-sidebar__task').filter({ hasText: taskTitle })
async function tabs(): Promise<BrowserTabState[]> { return page.evaluate(() => window.aether.browser.list()) }
async function opened(before: BrowserTabState[]): Promise<BrowserTabState> {
  let tab: BrowserTabState | undefined
  await expect.poll(async () => {
    tab = (await tabs()).find(value => !value.loading && !before.some(old => old.tabId === value.tabId))
    return tab?.tabId
  }).toBeDefined()
  return tab!
}
async function openAddress(value: string): Promise<BrowserTabState> {
  const before = await tabs()
  await address().fill(value)
  await address().press('Enter')
  return opened(before)
}
async function assertTaskPreserved(): Promise<void> {
  expect(await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('aether.work.state.v1') ?? '{}')
    return { activeTaskId: state.activeTaskId, tasks: state.tasks?.map((task: { id: string; draft: string }) => ({ id: task.id, draft: task.draft })) }
  })).toEqual({ activeTaskId: taskId, tasks: [{ id: taskId, draft }] })
}
async function assertStandalone(): Promise<void> {
  await expect(standalone()).toBeVisible()
  await expect(work().locator('.work-navigation').getByRole('button', { name: '浏览器', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(work().locator('.work-task-body')).toHaveCount(0)
  await assertTaskPreserved()
}
async function assertText(text: string): Promise<void> {
  await expect(preview().locator('.browser-local-preview__text').getByRole('gridcell')).toHaveText(text.split('\n'))
  await expect(preview().getByRole('alert')).toHaveCount(0)
}
async function selectTab(id: string): Promise<void> {
  await browser().locator(`[data-browser-tab-id="${id}"] [role="tab"]`).click()
}
async function armPicker(path: string | null): Promise<void> {
  await app!.evaluate(({ dialog }, path) => {
    const receipt = globalThis as typeof globalThis & { __navigationPickerCompleted?: boolean }
    receipt.__navigationPickerCompleted = false
    const original = dialog.showOpenDialog
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original
      receipt.__navigationPickerCompleted = true
      return { canceled: path === null, filePaths: path === null ? [] : [path] }
    }
  }, path)
}
async function pickerCompleted(): Promise<void> {
  await expect.poll(() => app!.evaluate(() => (globalThis as typeof globalThis & { __navigationPickerCompleted?: boolean }).__navigationPickerCompleted)).toBe(true)
}
async function capture(info: TestInfo, name: string): Promise<void> {
  const output = info.outputPath(name + '.png')
  await page.screenshot({ path: output })
  await info.attach(name, { path: output, contentType: 'image/png' })
}

test.describe.serial('Work 浏览器打开文件保持当前页面（新专项）', () => {
  test.beforeAll(async () => {
    mkdirSync(parent, { recursive: true }); fixture = mkdtempSync(join(parent, 'work-browser-navigation-'))
    workspace = join(fixture, 'workspace'); directory = join(fixture, '本地 资料')
    const profile = join(fixture, 'profile')
    for (const path of [workspace, directory, profile]) mkdirSync(path)
    writeFileSync(join(directory, 'README.md'), markdown)
    writeFileSync(join(directory, '说明.txt'), 'DirectoryEntryMarker\n打开目录内文件仍停留浏览器')
    writeFileSync(join(workspace, 'workspace.txt'), 'workspace fixture')
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, engineMode: 'embedded', lastFolder: workspace, appearance: 'dark' }))
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const location = server.address(); if (!location || typeof location === 'string') throw new Error('Missing fixture HTTP port')
    origin = `http://127.0.0.1:${location.port}`
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    env.AETHER_GLOBAL_DIR = join(fixture, 'global'); delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${profile}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'work-browser-file-navigation')
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1460, 950))
    await expect(page.locator('.workbench')).toBeVisible()
  })
  test.beforeEach(async () => {
    for (const tab of await tabs()) await page.evaluate(id => window.aether.browser.close(id), tab.tabId)
    await page.evaluate(({ taskId, taskTitle, draft, workspace }) => {
      const now = Date.now()
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.state.v1', JSON.stringify({ activeTaskId: taskId, tasks: [{ id: taskId,
        title: taskTitle, draft, status: 'draft', createdAt: now, updatedAt: now,
        workspacePath: workspace, modelId: '', attachments: [], sources: [] }] }))
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', workspace: false }))
    }, { taskId, taskTitle, draft, workspace })
    await page.reload()
    await expect(work().getByRole('heading', { name: taskTitle, exact: true })).toBeVisible()
    await work().locator('.work-navigation').getByRole('button', { name: '浏览器', exact: true }).click()
    await assertStandalone()
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus) await capture(info, 'navigation-failure')
    expect(errors).toEqual([]); health?.assertHealthy()
  })
  test.afterAll(async ({}, info) => {
    try { if (health) await health.closeAndAssert(info); else await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const owned = resolve(fixture)
        if (dirname(owned) !== parent || !basename(owned).startsWith('work-browser-navigation-')) throw new Error(`Unsafe cleanup: ${owned}`)
        rmSync(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('地址栏打开 README 保留独立浏览器及原会话草稿', async ({}, info) => {
    const file = await openAddress(join(directory, 'README.md'))
    expect(file.localFile).toMatchObject({ path: join(directory, 'README.md'), kind: 'text' })
    await assertText(readFileSync(join(directory, 'README.md'), 'utf8'))
    await assertStandalone()
    await capture(info, 'standalone-readme')
  })

  test('目录进入文件后仍在独立浏览器，返回目录标签保留列表', async () => {
    const folder = await openAddress(directory)
    expect(folder.localFile).toMatchObject({ path: directory, kind: 'directory' })
    await assertStandalone()
    const table = preview().getByRole('table', { name: '目录内容', exact: true })
    const before = await tabs()
    await table.getByRole('button', { name: '说明.txt', exact: true }).click()
    const file = await opened(before)
    expect(file.localFile).toMatchObject({ path: join(directory, '说明.txt'), kind: 'text' })
    await assertText(readFileSync(join(directory, '说明.txt'), 'utf8'))
    await assertStandalone()
    await selectTab(folder.tabId)
    await expect(table.getByRole('button', { name: '说明.txt', exact: true })).toBeVisible()
    await expect(address()).toHaveValue(directory)
    await assertStandalone()
  })

  test('网页与本地文件切换及关闭标签都不会跳到会话', async () => {
    const web = await openAddress(origin)
    expect(web.localFile).toBeUndefined()
    await assertStandalone()
    const file = await openAddress(join(directory, 'README.md'))
    await assertText(markdown)
    await assertStandalone()
    await selectTab(web.tabId)
    await expect(address()).toHaveValue(origin + '/')
    await expect.poll(() => app!.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find(contents => contents.getURL() === url)
      return guest ? guest.executeJavaScript('document.body.textContent') : null
    }, web.url)).toContain('BrowserNavigationWebMarker')
    await assertStandalone()
    await selectTab(file.tabId)
    await assertText(markdown)
    await browser().locator(`[data-browser-tab-id="${file.tabId}"] .browser-tab__close`).click()
    await expect.poll(async () => (await tabs()).some(tab => tab.tabId === file.tabId)).toBe(false)
    await expect(address()).toHaveValue(origin + '/')
    await assertStandalone()
  })

  test('本地文件选择器取消不跳转，确认文件后仍留在独立浏览器', async () => {
    const before = await tabs()
    await armPicker(null)
    await browser().getByRole('button', { name: '打开本地文件', exact: true }).click()
    await pickerCompleted()
    expect((await tabs()).map(tab => tab.tabId)).toEqual(before.map(tab => tab.tabId))
    await assertStandalone()
    await armPicker(join(directory, 'README.md'))
    await browser().getByRole('button', { name: '打开本地文件', exact: true }).click()
    await pickerCompleted()
    const file = await opened(before)
    expect(file.localFile?.path).toBe(join(directory, 'README.md'))
    await assertText(markdown)
    await assertStandalone()
  })

  test('从会话工作区的浏览器打开文件保留会话工作区', async ({}, info) => {
    const file = await openAddress(join(directory, 'README.md'))
    await assertStandalone()
    await taskButton().click()
    await expect(work().getByRole('heading', { name: taskTitle, exact: true })).toBeVisible()
    const workspacePane = work().getByRole('region', { name: '任务工作区', exact: true })
    if (!await workspacePane.isVisible()) await work().getByRole('button', { name: '打开工作区', exact: true }).click()
    await expect(workspacePane).toBeVisible()
    await workspacePane.getByRole('tab', { name: 'README.md', exact: true }).click()
    await assertText(markdown)
    const next = await openAddress(join(directory, '说明.txt'))
    expect(next.tabId).not.toBe(file.tabId)
    await assertText(readFileSync(join(directory, '说明.txt'), 'utf8'))
    await expect(standalone()).toHaveCount(0)
    await expect(work().locator('.work-task-body')).toBeVisible()
    await expect(taskButton()).toHaveAttribute('aria-current', 'true')
    await expect(workspacePane.getByRole('tab', { name: '说明.txt', exact: true })).toHaveAttribute('aria-selected', 'true')
    await assertTaskPreserved()
    await capture(info, 'conversation-browser-file')
  })
})
