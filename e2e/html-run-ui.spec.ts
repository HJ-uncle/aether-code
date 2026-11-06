/** Real UI clicks -> native HTML DOM, saved source, relative CSS/modules, Work reveal and local-tab duplication. No model calls. */
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BrowserTabState } from '../src/shared/browser'

const root = resolve(__dirname, '..'), parent = join(root, '.e2e-tmp')
let app: ElectronApplication | undefined, page: Page, fixture = '', workspace = '', htmlFile = '', localFile = ''
const errors: string[] = [], nativeIds = new Map<string, number>()
const html = (prefix: string) => `<!doctype html><meta charset="utf-8"><title>围棋运行验收</title><link rel="stylesheet" href="${prefix}assets/style.css"><h1>等待脚本</h1><img src="${prefix}assets/board.svg"><script type="module" src="${prefix}assets/main.js"></script>`

async function nativeBefore(): Promise<number[]> {
  return app!.evaluate(({ webContents }) => webContents.getAllWebContents().map(item => item.id))
}
async function resolveNative(tab: BrowserTabState, before: number[]): Promise<void> {
  await expect.poll(async () => {
    const ids = await app!.evaluate(({ webContents }, { url, before }) =>
      webContents.getAllWebContents().filter(item => !before.includes(item.id) && item.getURL() === url).map(item => item.id), { url: tab.url, before })
    if (ids.length === 1) nativeIds.set(tab.tabId, ids[0])
    return ids.length
  }).toBe(1)
}
async function assertPage(tab: BrowserTabState, unsaved = false): Promise<void> {
  const id = nativeIds.get(tab.tabId)!
  await expect.poll(async () => app!.evaluate(async ({ webContents }, id) => {
    const wc = webContents.fromId(id)
    return wc ? wc.executeJavaScript("({heading:document.querySelector('h1')?.textContent,color:document.querySelector('h1')?getComputedStyle(document.querySelector('h1')).color:'',image:!!document.querySelector('img')?.naturalWidth,saved:!!document.querySelector('#saved-source'),bridge:'aether' in window})") : null
  }, id)).toEqual({ heading: '围棋模块加载成功', color: 'rgb(17, 88, 155)', image: true, saved: unsaved, bridge: false })
  await expect.poll(async () => app!.evaluate(({ BrowserWindow, WebContentsView }, id) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find(child => child instanceof WebContentsView && child.webContents.id === id)
    return view instanceof WebContentsView && view.getVisible() && view.getBounds().width > 200 && view.getBounds().height > 200
  }, id)).toBe(true)
}
async function tabs(): Promise<BrowserTabState[]> { return page.evaluate(() => window.aether.browser.list()) }
async function capture(info: TestInfo, mode: 'code' | 'work', tab: BrowserTabState): Promise<void> {
  const fullWindow = await app!.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
  const native = await page.evaluate(id => window.aether.browser.read(id, 'screenshot'), tab.tabId)
  expect(native.success, native.error).toBe(true)
  for (const [name, value] of [[`${mode}-window`, fullWindow], [`${mode}-native-html`, (native.output as { dataUrl: string }).dataUrl.split(',')[1]]]) {
    const path = info.outputPath(`${name}.png`)
    writeFileSync(path, Buffer.from(value, 'base64'))
    await info.attach(name, { path, contentType: 'image/png' })
  }
}
async function newTab(before: BrowserTabState[], mode: 'code' | 'work'): Promise<BrowserTabState> {
  let result: BrowserTabState | undefined
  await expect.poll(async () => {
    result = (await tabs()).find(tab => !before.some(old => old.tabId === tab.tabId) && tab.presentation?.mode === mode && !tab.loading && tab.url !== 'about:blank')
    return Boolean(result)
  }).toBe(true)
  return result!
}

test.describe.serial('HTML 运行与本地标签菜单', () => {
  test.beforeAll(async () => {
    mkdirSync(parent, { recursive: true }); fixture = mkdtempSync(join(parent, 'html-run-ui-'))
    workspace = join(fixture, 'workspace')
    const profile = join(fixture, 'profile')
    mkdirSync(join(workspace, 'docs'), { recursive: true }); mkdirSync(join(workspace, 'assets')); mkdirSync(profile)
    htmlFile = join(workspace, 'docs', '围棋.html'); localFile = join(workspace, 'standalone.html')
    writeFileSync(htmlFile, html('../')); writeFileSync(localFile, html('./'))
    writeFileSync(join(workspace, 'assets', 'style.css'), 'h1{color:rgb(17,88,155)}')
    writeFileSync(join(workspace, 'assets', 'main.js'), "document.querySelector('h1').textContent='围棋模块加载成功'")
    writeFileSync(join(workspace, 'assets', 'board.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="green"/></svg>')
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: workspace, lastSessionId: 'code-html-run', appearance: 'light' }))
    const env = { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global') }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_MAIN || '.', `--user-data-dir=${profile}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.workbench')).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950))
    await page.evaluate(({ workspace, htmlFile }) => {
      localStorage.setItem('aether.app.mode', 'code')
      const task = { id: 'work-html-run', title: 'HTML 运行验收', draft: '', status: 'draft', createdAt: Date.now(), updatedAt: Date.now(), workspacePath: workspace, modelId: '', attachments: [],
        sources: [{ path: htmlFile, name: '围棋.html', type: 'text/html', size: 256 }] }
      localStorage.setItem('aether.work.state.v1', JSON.stringify({ tasks: [task], activeTaskId: task.id, homeDraft: '', homeWorkspacePath: null, homeAttachments: [], homeModelId: '', homeSessionId: null, homeAgentId: '', homeMentions: [], homeResources: { skills: [], mcpServers: [], knowledgeBases: [] } }))
    }, { workspace, htmlFile })
    await page.reload(); await expect(page.locator('.workbench')).toBeVisible()
  })
  test.afterEach(() => expect(errors).toEqual([]))
  test.afterAll(async () => {
    await app?.close()
    if (!fixture) return
    if (dirname(resolve(fixture)) !== parent || !basename(fixture).startsWith('html-run-ui-')) throw new Error('Unsafe HTML fixture cleanup')
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  test('Code 点击运行保存当前 HTML，展示真正的页面及相对 CSS/模块/图片', async ({}, info) => {
    await page.keyboard.press('Control+p')
    const picker = page.locator('.palette[aria-label="快速打开文件"]')
    await picker.locator('.palette__input').fill('围棋.html')
    await expect(picker.locator('.palette__item').first()).toContainText('围棋.html', { timeout: 30_000 })
    await page.keyboard.press('Enter')
    await expect(page.locator('.doc-view__source .monaco-editor').first()).toBeVisible()
    await expect(page.locator('.editor-preview-modes')).toHaveCount(0)
    await page.locator('.doc-view__source .monaco-editor').first().click({ position: { x: 100, y: 20 } })
    await page.keyboard.press('Control+Home'); await page.keyboard.insertText('<h2 id="saved-source">编辑后运行</h2>')
    await expect(page.locator('.doc-view__dirty')).toBeVisible()
    const before = await tabs(), native = await nativeBefore()
    await page.getByRole('button', { name: '保存并在浏览器中运行', exact: true }).click()
    const tab = await newTab(before, 'code')
    expect(decodeURIComponent(new URL(tab.url).pathname)).toContain('/docs/围棋.html')
    expect(readFileSync(htmlFile, 'utf8')).toContain('id="saved-source"')
    await resolveNative(tab, native); await assertPage(tab, true)
    await expect(page.locator(`#mode-code [data-browser-tab-id="${tab.tabId}"] [role="tab"]`)).toHaveAttribute('aria-selected', 'true')
    await capture(info, 'code', tab)
  })

  test('本地网页的右键复制菜单生成独立可用页面，关闭原页不影响副本', async () => {
    const native = await nativeBefore()
    const original = await page.evaluate(url => window.aether.browser.create({ url }), pathToFileURL(localFile).href)
    await resolveNative(original, native); await assertPage(original)
    const before = await tabs(), beforeCopy = await nativeBefore()
    await page.locator(`#mode-code [data-browser-tab-id="${original.tabId}"] [role="tab"]`).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '复制标签页', exact: true }).click()
    const copy = await newTab(before, 'code')
    expect(copy.url).toMatch(/^aether-local:/); expect(new URL(copy.url).host).not.toBe(new URL(original.url).host)
    expect(copy.presentation).toEqual(original.presentation)
    await resolveNative(copy, beforeCopy); await assertPage(copy)
    await page.locator(`#mode-code [data-browser-tab-id="${original.tabId}"] .browser-tab__close`).click()
    await expect.poll(async () => (await tabs()).some(tab => tab.tabId === original.tabId)).toBe(false)
    await page.evaluate(tabId => window.aether.browser.action({ tabId, action: 'reload' }), copy.tabId)
    await assertPage(copy)
  })

  test('Work 资料打开后点击运行，自动显示当前任务网页且加载父目录资源', async ({}, info) => {
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await page.getByRole('button', { name: '打开工作区', exact: true }).click()
    const work = page.locator('.work-view')
    await work.getByRole('button', { name: '更多工作区', exact: true }).click()
    await page.getByRole('menuitem', { name: '资料', exact: true }).click()
    await expect(work.getByRole('tab', { name: '资料', exact: true })).toHaveAttribute('aria-selected', 'true')
    await work.getByRole('option', { name: /围棋.html/ }).click()
    let opened = 'waiting'
    await expect.poll(async () => {
      const errors = await page.locator('.toast-host__item--error').allTextContents()
      opened = errors.length ? `error: ${errors.join('; ')}` : await work.getByRole('tab', { name: '围棋.html', exact: true }).count() ? 'opened' : 'waiting'
      return opened
    }).not.toBe('waiting')
    await info.attach('work-file-open.json', { body: JSON.stringify({ outcome: opened,
      engine: await page.evaluate(() => window.aether.engine.getSnapshot()),
      resourceTabs: await work.getByRole('tab').allTextContents() }, null, 2), contentType: 'application/json' })
    expect(opened, 'Opening a locally readable Work source must not require a ready AI engine').toBe('opened')
    // Source selection keeps its source preview visible and adds the file to
    // the unified strip. Open that actual file resource before running it.
    await work.getByRole('tab', { name: '围棋.html', exact: true }).click()
    const run = work.getByRole('button', { name: '在浏览器中运行', exact: true })
    await expect(run).toBeEnabled({ timeout: 30_000 })
    const before = await tabs(), native = await nativeBefore()
    await run.click()
    const tab = await newTab(before, 'work')
    expect(tab.presentation).toMatchObject({ mode: 'work', sessionId: 'work-html-run' })
    await expect(work.locator('.work-resource-browser .browser-surface')).toBeVisible()
    await resolveNative(tab, native); await assertPage(tab, true)
    await capture(info, 'work', tab)
    expect((await tabs()).filter(item => item.presentation?.mode === 'code').map(item => item.tabId)).toEqual(before.filter(item => item.presentation?.mode === 'code').map(item => item.tabId))
  })
})
