/** Real Electron, no engine: user-selected directory navigation outside the workspace,
 * picker cancellation, child files, refresh/history, independent copies and root boundaries. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { BrowserLocalDirectoryContent, BrowserTabState } from '../src/shared/browser'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), parent = join(root, '.e2e-tmp')
const names = { child: '子 目录', empty: '空 目录', text: '中文 记录.txt', html: '本地 页面.html', junction: '越界 链接' }
const text = '目录中的中文文件\n<script>window.__directoryPreviewExecuted=true</script>'
const errors: string[] = []
let app: ElectronApplication | undefined, health: ElectronHealthMonitor | undefined, page: Page
let fixture = '', directory = '', privateDirectory = '', workspace = '', junctionError = ''

const browser = () => page.getByRole('region', { name: '内置浏览器', exact: true })
const preview = () => browser().getByRole('region', { name: '本地文件预览', exact: true })
const table = () => preview().getByRole('table', { name: '目录内容', exact: true })
const address = () => browser().getByRole('textbox', { name: '网页地址', exact: true })
const tabButton = (id: string) => browser().locator(`[data-browser-tab-id="${id}"] [role="tab"]`)
async function tabs(): Promise<BrowserTabState[]> { return page.evaluate(() => window.aether.browser.list()) }
async function nextTab(before: BrowserTabState[]): Promise<BrowserTabState> {
  let next: BrowserTabState | undefined
  await expect.poll(async () => {
    next = (await tabs()).find(tab => !before.some(old => old.tabId === tab.tabId) && !tab.loading)
    return next?.tabId ?? null
  }).not.toBeNull()
  return next!
}
async function listing(id: string): Promise<BrowserLocalDirectoryContent> {
  const content = await page.evaluate(id => window.aether.browser.readLocalFile(id), id)
  if (content.kind !== 'directory') throw new Error(`Expected directory, received ${content.kind}`)
  return content
}
async function openAddress(value: string): Promise<BrowserTabState> {
  const before = await tabs()
  await address().fill(value); await address().press('Enter')
  const tab = await nextTab(before)
  expect(tab.localFile?.kind).toBe('directory'); expect(tab.context).toBeUndefined()
  await expect(table()).toBeVisible()
  return tab
}
async function expectDirectory(id: string, path: string): Promise<void> {
  await expect.poll(async () => (await tabs()).find(tab => tab.tabId === id)?.localFile?.path).toBe(path)
  await expect(address()).toHaveValue(path)
  await expect(table()).toBeVisible()
  expect((await listing(id)).path).toBe(path)
}
async function pickerResult(path: string | null): Promise<void> {
  await app!.evaluate(({ dialog }, path) => {
    const receipt = globalThis as typeof globalThis & { __directoryPickerCompleted?: boolean }
    receipt.__directoryPickerCompleted = false
    const original = dialog.showOpenDialog
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original; receipt.__directoryPickerCompleted = true
      return { canceled: path === null, filePaths: path === null ? [] : [path] }
    }
  }, path)
  await browser().getByRole('button', { name: '浏览器更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '打开本地目录', exact: true }).click()
  await expect.poll(() => app!.evaluate(() => (globalThis as typeof globalThis & { __directoryPickerCompleted?: boolean }).__directoryPickerCompleted)).toBe(true)
}

test.describe.serial('受控本地目录浏览', () => {
  test.beforeAll(async () => {
    mkdirSync(parent, { recursive: true }); fixture = mkdtempSync(join(parent, 'browser-local-directory-ui-'))
    directory = join(fixture, '外部 中文目录'); privateDirectory = join(fixture, '根外 私密目录'); workspace = join(fixture, 'workspace')
    const profile = join(fixture, 'profile')
    for (const path of [directory, privateDirectory, workspace, profile, join(directory, names.child), join(directory, names.empty), join(directory, 'assets')]) mkdirSync(path)
    writeFileSync(join(workspace, 'workspace.txt'), 'authorized workspace only')
    writeFileSync(join(directory, names.text), text)
    writeFileSync(join(directory, names.child, '子目录.txt'), '子目录文件内容')
    writeFileSync(join(directory, '.可见隐藏项'), 'hidden directory entry')
    writeFileSync(join(privateDirectory, '秘密.txt'), 'outside root private fixture')
    writeFileSync(join(directory, names.html), '<!doctype html><meta charset="utf-8"><title>目录中的 HTML</title><link rel="stylesheet" href="./assets/style.css"><h1>等待模块</h1><script type="module" src="./assets/main.js"></script>')
    writeFileSync(join(directory, 'assets/style.css'), 'h1{color:rgb(17,88,155)}')
    writeFileSync(join(directory, 'assets/main.js'), "document.querySelector('h1').textContent='目录 HTML 相对资源已加载'")
    try { symlinkSync(privateDirectory, join(directory, names.junction), 'junction') }
    catch (error) { junctionError = error instanceof Error ? error.message : String(error) }
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, engineMode: 'embedded', lastFolder: workspace, appearance: 'light' }))
    const env: Record<string, string> = { AETHER_GLOBAL_DIR: join(fixture, 'global') }
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined && name !== 'AETHER_GLOBAL_DIR') env[name] = value
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_MAIN || '.', `--user-data-dir=${profile}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'browser-local-directory')
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.workbench')).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950))
    await page.evaluate(() => localStorage.setItem('aether.app.mode', 'code'))
    await page.reload(); await expect(page.locator('.workbench')).toBeVisible()
    await page.keyboard.press('Control+Alt+b'); await expect(browser()).toBeVisible()
    await expect.poll(tabs).toContainEqual(expect.objectContaining({ url: 'about:blank', loading: false }))
  })
  test.afterEach(async () => {
    expect(errors).toEqual([]); health?.assertHealthy()
    for (const tab of await tabs()) await page.evaluate(id => window.aether.browser.close(id), tab.tabId)
  })
  test.afterAll(async ({}, info) => {
    try {
      if (health) await health.closeAndAssert(info)
      else await app?.close()
    } finally {
      if (!fixture) return
      const target = resolve(fixture)
      if (dirname(target) !== parent || !basename(target).startsWith('browser-local-directory-ui-')) throw new Error('Unsafe directory fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test('带引号和空格的中文目录按目录列表显示，根目录上级按钮禁用', async ({}, info) => {
    const tab = await openAddress(`"${directory}"`), content = await listing(tab.tabId)
    expect(content).toMatchObject({ kind: 'directory', path: directory, root: directory, parent: null, truncated: false })
    expect(content.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: names.child, path: join(directory, names.child), kind: 'directory' }),
      expect.objectContaining({ name: names.empty, path: join(directory, names.empty), kind: 'directory' }),
      expect.objectContaining({ name: names.text, path: join(directory, names.text), kind: 'file', size: statSync(join(directory, names.text)).size }),
      expect.objectContaining({ name: '.可见隐藏项', kind: 'file' })
    ]))
    await expect(table().getByRole('button', { name: names.child, exact: true })).toBeVisible()
    await expect(table().getByRole('button', { name: names.text, exact: true })).toBeVisible()
    await expect(preview().getByRole('button', { name: '返回上级目录', exact: true })).toBeDisabled()
    expect(tab.canGoBack).toBe(false); expect(tab.canGoForward).toBe(false)
    const screenshot = info.outputPath('local-directory-list.png')
    await browser().screenshot({ path: screenshot }); await info.attach('local-directory-list', { path: screenshot, contentType: 'image/png' })
  })

  test('进入子目录和返回上级复用同一标签，后退前进恢复目录历史', async () => {
    const tab = await openAddress(directory), before = (await tabs()).map(item => item.tabId)
    await table().getByRole('button', { name: names.child, exact: true }).click()
    await expectDirectory(tab.tabId, join(directory, names.child))
    expect(await listing(tab.tabId)).toMatchObject({ root: directory, parent: directory })
    await expect(table().getByRole('button', { name: '子目录.txt', exact: true })).toBeVisible()
    await expect(browser().getByRole('button', { name: '后退', exact: true })).toBeEnabled()
    await preview().getByRole('button', { name: '返回上级目录', exact: true }).click()
    await expectDirectory(tab.tabId, directory)
    await expect(preview().getByRole('button', { name: '返回上级目录', exact: true })).toBeDisabled()
    await browser().getByRole('button', { name: '后退', exact: true }).click()
    await expectDirectory(tab.tabId, join(directory, names.child))
    await browser().getByRole('button', { name: '前进', exact: true }).click()
    await expectDirectory(tab.tabId, directory)
    expect((await tabs()).map(item => item.tabId)).toEqual(before)
    expect((await tabs()).find(item => item.tabId === tab.tabId)?.context).toBeUndefined()
  })

  test('空目录是有效列表，刷新后显示磁盘新增文件', async () => {
    const empty = join(directory, names.empty), tab = await openAddress(`'${empty}'`)
    expect(await listing(tab.tabId)).toMatchObject({ path: empty, root: empty, parent: null, entries: [] })
    await expect(table().getByRole('button')).toHaveCount(0)
    await expect(preview().getByRole('status')).toContainText('此目录为空')
    writeFileSync(join(empty, '刚新增.txt'), 'refresh discovers this file')
    await browser().getByRole('button', { name: '刷新网页（Ctrl+R）', exact: true }).click()
    await expect(table().getByRole('button', { name: '刚新增.txt', exact: true })).toBeVisible()
    expect((await listing(tab.tabId)).entries).toContainEqual(expect.objectContaining({ name: '刚新增.txt', kind: 'file' }))
    expect((await tabs()).find(item => item.tabId === tab.tabId)!.navigationId).toBeGreaterThan(tab.navigationId)
  })

  test('点击 TXT 和 HTML 分别新建文件预览，原目录标签与位置保留', async () => {
    const folder = await openAddress(directory), beforeText = await tabs()
    await table().getByRole('button', { name: names.text, exact: true }).click()
    const document = await nextTab(beforeText)
    expect(document.localFile).toMatchObject({ path: join(directory, names.text), kind: 'text' })
    expect(document.context).toBeUndefined()
    await expect(preview().locator('.browser-local-preview__text').getByRole('gridcell')).toHaveText(text.split('\n'))
    await expect(preview().locator('script')).toHaveCount(0)
    expect(await page.evaluate(() => (window as Window & { __directoryPreviewExecuted?: boolean }).__directoryPreviewExecuted ?? false)).toBe(false)
    await tabButton(folder.tabId).click(); await expectDirectory(folder.tabId, directory)
    const beforeHtml = await tabs()
    await table().getByRole('button', { name: names.html, exact: true }).click()
    const html = await nextTab(beforeHtml)
    expect(html.localFile).toMatchObject({ path: join(directory, names.html), kind: 'html' }); expect(html.context).toBeUndefined()
    await expect.poll(() => app!.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find(contents => contents.getURL() === url)
      return guest ? guest.executeJavaScript("({text:document.querySelector('h1')?.textContent,color:document.querySelector('h1')?getComputedStyle(document.querySelector('h1')).color:'',bridge:typeof window.aether,node:typeof require})") : null
    }, html.url)).toEqual({ text: '目录 HTML 相对资源已加载', color: 'rgb(17, 88, 155)', bridge: 'undefined', node: 'undefined' })
    await tabButton(folder.tabId).click(); await expectDirectory(folder.tabId, directory)
    expect((await tabs()).filter(tab => tab.tabId === folder.tabId)).toHaveLength(1)
  })

  test('更多菜单的目录选择器取消不创建标签，选择目录后显示列表', async () => {
    const before = await tabs()
    await pickerResult(null)
    expect((await tabs()).map(tab => tab.tabId)).toEqual(before.map(tab => tab.tabId))
    await pickerResult(directory)
    const tab = await nextTab(before)
    expect(tab.localFile).toMatchObject({ path: directory, kind: 'directory' })
    await expect(table().getByRole('button', { name: names.text, exact: true })).toBeVisible()
    expect((await listing(tab.tabId)).root).toBe(directory)
  })

  test('目录副本历史独立，原标签关闭后副本仍能返回根目录与读取', async () => {
    const original = await openAddress(directory)
    await table().getByRole('button', { name: names.child, exact: true }).click()
    await expectDirectory(original.tabId, join(directory, names.child))
    const before = await tabs()
    await tabButton(original.tabId).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '复制标签页', exact: true }).click()
    const copy = await nextTab(before)
    expect(copy.localFile).toMatchObject({ path: join(directory, names.child), kind: 'directory' })
    expect(copy.canGoBack).toBe(true); expect(copy.context).toBeUndefined()
    await tabButton(original.tabId).click()
    await browser().getByRole('button', { name: '后退', exact: true }).click()
    await expectDirectory(original.tabId, directory)
    expect((await listing(copy.tabId)).path).toBe(join(directory, names.child))
    await browser().locator(`[data-browser-tab-id="${original.tabId}"] .browser-tab__close`).click()
    await expect.poll(async () => (await tabs()).some(tab => tab.tabId === original.tabId)).toBe(false)
    const error = await page.evaluate(async id => { try { await window.aether.browser.readLocalFile(id); return '' } catch (error) { return String(error) } }, original.tabId)
    expect(error).not.toBe('')
    await tabButton(copy.tabId).click()
    await browser().getByRole('button', { name: '后退', exact: true }).click()
    await expectDirectory(copy.tabId, directory)
    await browser().getByRole('button', { name: '刷新网页（Ctrl+R）', exact: true }).click()
    await expect(table().getByRole('button', { name: names.text, exact: true })).toBeVisible()
  })

  test('条目 API 拒绝跳出选定根目录，目录浏览不授予全局读写或 AI context', async () => {
    const tab = await openAddress(directory), before = (await tabs()).map(item => item.tabId)
    for (const path of [dirname(directory), privateDirectory, join(privateDirectory, '秘密.txt')]) {
      const error = await page.evaluate(async ({ id, path }) => { try { await window.aether.browser.openLocalEntry(id, path); return '' } catch (error) { return String(error) } }, { id: tab.tabId, path })
      expect(error, path).not.toBe('')
    }
    expect((await tabs()).map(item => item.tabId)).toEqual(before)
    const access = await page.evaluate(async ({ directory, file }) => {
      const denied = async (operation: () => Promise<unknown>): Promise<string> => { try { await operation(); return '' } catch (error) { return String(error) } }
      return Promise.all([denied(() => window.aether.fs.readDir(directory)), denied(() => window.aether.fs.readFile(file)),
        denied(() => window.aether.fs.writeFile(file, 'should not be written'))])
    }, { directory, file: join(directory, names.text) })
    for (const error of access) expect(error).toContain('工作区之外')
    expect(readFileSync(join(directory, names.text), 'utf8')).toBe(text)
    expect((await tabs()).find(item => item.tabId === tab.tabId)?.context).toBeUndefined()
    const sharing = await page.evaluate(async id => { try { await window.aether.browser.share(id, { sessionId: 'fixture', engineId: 'fixture' }); return '' } catch (error) { return String(error) } }, tab.tabId)
    expect(sharing).not.toBe('')
  })

  test('指向根目录外的 junction 显示不可用且不能通过条目 API 读取', async () => {
    test.skip(Boolean(junctionError), `环境不能创建目录链接：${junctionError}`)
    const tab = await openAddress(directory), content = await listing(tab.tabId)
    expect(content.entries.find(entry => entry.name === names.junction)).toMatchObject({ kind: 'unavailable' })
    await expect(table().getByRole('button', { name: names.junction, exact: true })).toBeDisabled()
    for (const path of [join(directory, names.junction), join(directory, names.junction, '秘密.txt')]) {
      const error = await page.evaluate(async ({ id, path }) => { try { await window.aether.browser.openLocalEntry(id, path); return '' } catch (error) { return String(error) } }, { id: tab.tabId, path })
      expect(error, path).not.toBe('')
    }
    expect((await listing(tab.tabId)).path).toBe(directory)
    expect((await tabs()).filter(item => item.localFile?.path?.startsWith(privateDirectory))).toHaveLength(0)
  })
})
