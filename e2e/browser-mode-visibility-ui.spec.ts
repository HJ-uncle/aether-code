/** Reproduces native WebContentsView covering Work's PDF after Code is hidden.
 * Assert actual Electron native visibility/identity, not just DOM screenshots.
 * No engine or model calls; isolated generated PDF and local web fixture. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'

const root = resolve(__dirname, '..'), parent = join(root, '.e2e-tmp')
let app: ElectronApplication | undefined, page: Page, fixture = '', origin = '', file = '', tabId = '', nativeId = 0
const errors: string[] = []
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html;charset=utf-8')
  response.end('<!doctype html><title>原生模式切换验证</title><style>body{background:rgb(22,139,112);font:24px sans-serif}</style><h1>Native page retained</h1><input value="keep this state"><script>window.loadMarker=crypto.randomUUID()</script>')
})
async function nativeState() {
  return app!.evaluate(({ BrowserWindow, WebContentsView }, origin) => {
    const host = BrowserWindow.getAllWindows()[0]
    return host.contentView.children.filter(view => view instanceof WebContentsView && view.webContents.getURL().startsWith(origin))
      .map(view => ({ id: (view as InstanceType<typeof WebContentsView>).webContents.id, visible: view.getVisible(), bounds: view.getBounds() }))
  }, origin)
}

test.describe.serial('Code 与 Work 原生浏览器显示归属', () => {
  test.beforeAll(async () => {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture port')
    origin = `http://127.0.0.1:${address.port}`
    mkdirSync(parent, { recursive: true }); fixture = mkdtempSync(join(parent, 'browser-mode-'))
    const workspace = join(fixture, 'workspace'), profile = join(fixture, 'profile'); mkdirSync(workspace); mkdirSync(profile)
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage([612, 792]).drawText('Work document must stay unobscured', { x: 48, y: 720, size: 20, font })
    file = join(workspace, '模式切换.pdf'); writeFileSync(file, await pdf.save())
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: workspace, appearance: 'light' }))
    const env = { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global') }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_MAIN || '.', `--user-data-dir=${profile}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.workbench')).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950))
    await page.evaluate(workspace => {
      localStorage.setItem('aether.app.mode', 'code')
      localStorage.setItem('aether.work.state.v1', JSON.stringify({ tasks: [{ id: 'work-native-mode-test', title: '原生视图切换', draft: '', status: 'draft', createdAt: Date.now(), updatedAt: Date.now(), workspacePath: workspace, modelId: '', attachments: [], sources: [] }], activeTaskId: 'work-native-mode-test', homeDraft: '', homeWorkspacePath: null, homeAttachments: [], homeModelId: '', homeSessionId: null, homeAgentId: '', homeMentions: [], homeResources: { skills: [], mcpServers: [], knowledgeBases: [] } }))
    }, workspace)
    await page.reload(); await expect(page.locator('.workbench')).toBeVisible()
    await page.keyboard.press('Control+Alt+b')
    const addressInput = page.getByLabel('网页地址', { exact: true })
    await addressInput.fill(origin); await addressInput.press('Enter')
    await expect.poll(() => page.evaluate(() => window.aether.browser.list())).toContainEqual(expect.objectContaining({ title: '原生模式切换验证', loading: false }))
    tabId = (await page.evaluate(() => window.aether.browser.list())).find(tab => tab.title === '原生模式切换验证')!.tabId
    await expect.poll(async () => (await nativeState())[0]?.visible).toBe(true)
    nativeId = (await nativeState())[0].id
  })
  test.afterEach(() => expect(errors).toEqual([]))
  test.afterAll(async () => {
    await app?.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (!fixture) return
    const absolute = resolve(fixture)
    if (dirname(absolute) !== parent || !basename(absolute).startsWith('browser-mode-')) throw new Error('Unsafe native mode fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  test('切到 Work PDF 时旧 Code 原生视图立即隐藏，后台页面读取仍可用', async ({}, testInfo) => {
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await page.getByRole('button', { name: '打开工作区', exact: true }).click()
    await page.locator('input.work-resource-tabs__file-input').setInputFiles(file)
    await expect(page.locator('.work-view [data-document-preview="pdf"]:visible canvas').first()).toHaveAttribute('data-rendered-page', '1')
    await expect(page.locator('#mode-code')).toBeHidden()
    await expect.poll(async () => (await nativeState())[0]?.visible).toBe(false)
    const read = await page.evaluate(tabId => window.aether.browser.read(tabId, 'snapshot'), tabId)
    expect(read.success, read.error).toBe(true)
    expect(JSON.stringify(read.output)).toContain('Native page retained')
    expect((await nativeState())[0]).toMatchObject({ id: nativeId, visible: false })
    await testInfo.attach('actual-native-view-state.json', { body: JSON.stringify(await nativeState()), contentType: 'application/json' })
  })

  test('旧 mode 的延迟 show 不覆盖 PDF，往返恢复同一原生页面且旧 hide 无效', async () => {
    const stale = { tabId, surface: { mode: 'code' as const, generation: 0 }, bounds: { x: 100, y: 100, width: 700, height: 500 }, visible: true }
    await page.evaluate(input => window.aether.browser.setBounds(input), stale)
    expect((await nativeState())[0]).toMatchObject({ id: nativeId, visible: false })
    const marker = await app!.evaluate(({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('window.loadMarker'), nativeId)
    for (let turn = 0; turn < 3; turn++) {
      await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
      await expect.poll(async () => (await nativeState())[0]?.visible).toBe(true)
      await page.evaluate(input => window.aether.browser.setBounds({ ...input, visible: false }), stale)
      expect((await nativeState())[0]).toMatchObject({ id: nativeId, visible: true })
      await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
      await expect.poll(async () => (await nativeState())[0]?.visible).toBe(false)
      await expect(page.locator('.work-view [data-document-preview="pdf"]:visible')).toBeVisible()
    }
    expect(await app!.evaluate(({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('window.loadMarker'), nativeId)).toBe(marker)
  })
})
