/** Real Electron without an engine: save/run HTML, UTF-8/module assets, split geometry, page keyboard and restart persistence. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { BrowserSnapshot } from '../src/shared/browser'

const root = resolve(__dirname, '..')
let fixture = '', workspace = '', profile = '', app: ElectronApplication | undefined, page: Page, tabId = ''
const errors: string[] = []
async function launch(): Promise<void> {
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: root, env: { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
  page = await app.firstWindow()
  page.on('pageerror', error => errors.push(String(error)))
  await expect(page.locator('.status-bar')).toBeVisible()
}
async function snapshot(): Promise<BrowserSnapshot> {
  const result = await page.evaluate(id => window.aether.browser.read(id, 'snapshot'), tabId)
  expect(result.success, result.error).toBe(true)
  return result.output as BrowserSnapshot
}
test.describe.serial('本地 HTML 浏览器运行', () => {
  test.beforeAll(async () => {
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
    fixture = mkdtempSync(join(root, '.e2e-tmp/browser-local-'))
    workspace = join(fixture, 'workspace'); profile = join(fixture, 'profile')
    mkdirSync(workspace); mkdirSync(profile)
    writeFileSync(join(workspace, '演示.html'), '<!doctype html><meta charset="utf-8"><title>本地运行验证</title><link rel="stylesheet" href="/theme.css"><h1>中文模块等待</h1><button id="go">交互</button><script type="module" src="./main.js"></script>')
    writeFileSync(join(workspace, 'main.js'), "document.querySelector('h1').textContent='中文模块加载完成';document.querySelector('#go').onclick=()=>document.querySelector('h1').textContent='本地按钮已点击';")
    writeFileSync(join(workspace, 'theme.css'), 'body{font:20px sans-serif;padding:24px}h1{color:rgb(17, 88, 155)}')
    writeFileSync(join(workspace, '.secret'), 'fixture hidden content')
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, engineMode: 'embedded', lastFolder: workspace }))
    await launch()
  })
  test.afterEach(() => expect(errors).toEqual([]))
  test.afterAll(async () => {
    await app?.close()
    if (dirname(resolve(fixture)) !== join(root, '.e2e-tmp') || !basename(fixture).startsWith('browser-local-')) throw new Error('Unsafe fixture cleanup')
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  test('编辑器运行先保存修改，真实执行中文与相对模块并限制文件范围', async ({}, testInfo) => {
    await page.keyboard.press('Control+p')
    await page.locator('.palette__input').fill('演示.html')
    await expect(page.locator('.palette__item').filter({ hasText: '演示.html' })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: '保存并在浏览器中运行', exact: true })).toBeVisible()
    await page.locator('.doc-view__source .monaco-editor').click({ position: { x: 100, y: 20 } })
    await page.keyboard.press('Control+End'); await page.keyboard.insertText('<!-- 已保存运行 -->')
    await expect(page.locator('.doc-view__dirty')).toContainText('未保存')
    await page.getByRole('button', { name: '保存并在浏览器中运行', exact: true }).click()
    await expect.poll(() => readFileSync(join(workspace, '演示.html'), 'utf8')).toContain('已保存运行')
    await expect.poll(() => page.evaluate(() => window.aether.browser.list())).toContainEqual(expect.objectContaining({ title: '本地运行验证', loading: false }))
    tabId = (await page.evaluate(() => window.aether.browser.list()))[0].tabId
    await expect.poll(async () => (await snapshot()).text).toContain('中文模块加载完成')
    expect(await app!.evaluate(({ webContents }) => webContents.getAllWebContents().find(wc => wc.getTitle() === '本地运行验证')!.executeJavaScript("getComputedStyle(document.querySelector('h1')).color"))).toBe('rgb(17, 88, 155)')
    const state = await snapshot()
    expect(state.tab.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\//)
    const prefix = state.tab.url.slice(0, state.tab.url.lastIndexOf('/') + 1)
    expect((await fetch(`${prefix}.secret`)).status).toBe(403)
    expect((await fetch(new URL('/outside.html', prefix))).status).toBe(404)
    const browserError = await page.evaluate(async ({ root, id }) => { try { await window.aether.browser.openFile(id, root); return '' } catch(error) { return String(error) } }, { root: workspace, id: join(profile, 'settings.json') })
    expect(browserError).not.toBe('')
    const png = await app!.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
    writeFileSync(testInfo.outputPath('browser-local-workbench.png'), Buffer.from(png, 'base64'))
    await testInfo.attach('browser-local-workbench.png', { body: Buffer.from(png, 'base64'), contentType: 'image/png' })
    const nativeWindow = await app!.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
      const host = BrowserWindow.getAllWindows()[0]
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1920, height: 1200 } })
      const own = sources.find(source => source.id === host.getMediaSourceId())
      return own && !own.thumbnail.isEmpty() ? own.thumbnail.toPNG().toString('base64') : null
    })
    if (nativeWindow) writeFileSync(testInfo.outputPath('browser-local-native-window.png'), Buffer.from(nativeWindow, 'base64'))
  })

  test('原生网页焦点支持地址快捷键，分栏缩放后页面边界仍对齐', async () => {
    await app!.evaluate(({ webContents }) => webContents.getAllWebContents().find(wc => wc.getTitle() === '本地运行验证')!.focus())
    await app!.evaluate(({ webContents }) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getTitle() === '本地运行验证')!
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: ['control'] })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'L', modifiers: ['control'] })
    })
    await expect(page.locator('.browser-address')).toBeFocused()
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25))
    await expect.poll(async () => {
      const rect = await page.getByLabel('网页内容区域', { exact: true }).boundingBox()
      const bounds = await app!.evaluate(({ BrowserWindow, WebContentsView }) => {
        const host = BrowserWindow.getAllWindows()[0]
        const view = host.contentView.children.find(view => view instanceof WebContentsView && view.getVisible())
        return { bounds: view?.getBounds(), zoom: host.webContents.getZoomFactor() }
      })
      if (!rect || !bounds.bounds) return false
      return (['x','y','width','height'] as const).every(key => Math.abs(bounds.bounds![key] - rect[key] * bounds.zoom) <= 2)
    }).toBe(true)
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  })

  test('浏览器默认设置在应用重启后保留', async () => {
    const artifacts = join(workspace, '.ae', 'brainstorm')
    mkdirSync(artifacts, { recursive: true })
    const artifact = join(artifacts, '方案.html')
    writeFileSync(artifact, '<!doctype html><meta charset="utf-8"><title>AI 产物</title><h1>产物正常运行</h1>')
    const created = await page.evaluate(({ artifact, workspace }) => window.aether.browser.openFile(artifact, workspace), { artifact, workspace })
    tabId = created.tabId
    expect((await snapshot()).text).toContain('产物正常运行')
    await page.evaluate(() => window.aether.browser.updateSettings({ homeUrl: 'http://localhost:5173/', zoomFactor: 1.25, defaultViewport: { width: 1024, height: 768, mobile: false, deviceScaleFactor: 1 }, persistSession: false, aiEnabled: false }))
    await app!.close(); app = undefined
    await launch()
    expect(await page.evaluate(() => window.aether.browser.getSettings())).toMatchObject({ homeUrl: 'http://localhost:5173/', zoomFactor: 1.25, defaultViewport: { width: 1024, height: 768 }, persistSession: false, aiEnabled: false })
  })
})
