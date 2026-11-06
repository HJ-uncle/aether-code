/** Real isolated Electron acceptance: Work local-page dimensions, retained native
 * pages across workspace surface tabs, and Code/Work/session tab isolation. No engine/model calls. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BrowserTabState } from '../src/shared/browser'

const root = resolve(__dirname, '..'), parent = join(root, '.e2e-tmp')
let app: ElectronApplication | undefined, page: Page, fixture = '', url = ''
let code: BrowserTabState, workA: BrowserTabState, workB: BrowserTabState
const errors: string[] = []
const nativeIds = new Map<string, number>()

async function createLocal(scope: string): Promise<BrowserTabState> {
  const target = new URL(url)
  target.hash = scope
  const tab = await page.evaluate(url => window.aether.browser.create({ url }), target.href)
  // Local-file opens issue a distinct capability origin per tab. Resolve that
  // unique URL once, then retain the tab ID -> native ID relation across switches.
  const matches = await app!.evaluate(({ BrowserWindow, WebContentsView }, target) =>
    BrowserWindow.getAllWindows()[0].contentView.children.flatMap(child =>
      child instanceof WebContentsView && child.webContents.getURL() === target ? [child.webContents.id] : []), tab.url)
  expect(matches, `exactly one native page for ${scope}`).toHaveLength(1)
  expect([...nativeIds.values()]).not.toContain(matches[0])
  nativeIds.set(tab.tabId, matches[0])
  return tab
}
async function native(tab: BrowserTabState) {
  const id = nativeIds.get(tab.tabId)
  if (id === undefined) throw new Error(`Unresolved native tab: ${tab.tabId}`)
  return app!.evaluate(({ BrowserWindow, WebContentsView }, target) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find(child => child instanceof WebContentsView && child.webContents.id === target)
    if (!(view instanceof WebContentsView)) return null
    return { id: view.webContents.id, visible: view.getVisible(), bounds: view.getBounds() }
  }, id)
}
async function visible(tab: BrowserTabState): Promise<void> {
  await expect.poll(async () => (await native(tab))?.visible).toBe(true)
  await expect.poll(async () => (await native(tab))?.bounds.height ?? 0).toBeGreaterThan(200)
  await expect.poll(async () => (await native(tab))?.bounds.width ?? 0).toBeGreaterThan(200)
  await expect.poll(async () => {
    const snapshot = await page.evaluate(id => window.aether.browser.read(id, 'snapshot'), tab.tabId)
    return snapshot.success ? (snapshot.output as { text: string }).text : ''
  }).toContain('原生页面内容可见')
}

test.describe.serial('Work 浏览器原生范围与可见性', () => {
  test.beforeAll(async () => {
    mkdirSync(parent, { recursive: true }); fixture = mkdtempSync(join(parent, 'browser-work-scope-'))
    const workspace = join(fixture, 'workspace'), profile = join(fixture, 'profile')
    mkdirSync(workspace); mkdirSync(profile)
    const html = join(workspace, '范围预览.html')
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><title>范围预览</title><style>body{background:rgb(21,126,106);color:white;font:24px sans-serif}button{padding:16px}</style><h1>原生页面内容可见</h1><button id="test" onclick="this.textContent=\'已点击\'">点击验证</button><input id="keep" value="保留输入"><script>window.marker=crypto.randomUUID()</script>')
    url = pathToFileURL(html).href
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: workspace, lastSessionId: 'code-scope', appearance: 'light' }))
    const env = { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global') }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || process.env.AETHER_E2E_MAIN || '.', `--user-data-dir=${profile}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.workbench')).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950))
    await page.evaluate(workspace => {
      const task = (id: string, title: string) => ({ id, title, draft: '', status: 'draft', createdAt: Date.now(), updatedAt: Date.now(), workspacePath: workspace, modelId: '', attachments: [], sources: [] })
      localStorage.setItem('aether.app.mode', 'code')
      localStorage.setItem('aether.work.state.v1', JSON.stringify({ tasks: [task('work-scope-a', '测试会话 A'), task('work-scope-b', '测试会话 B')], activeTaskId: 'work-scope-a', homeDraft: '', homeWorkspacePath: null, homeAttachments: [], homeModelId: '', homeSessionId: null, homeAgentId: '', homeMentions: [], homeResources: { skills: [], mcpServers: [], knowledgeBases: [] } }))
    }, workspace)
    await page.reload(); await expect(page.locator('.workbench')).toBeVisible()
  })
  test.afterEach(() => expect(errors).toEqual([]))
  test.afterAll(async () => {
    await app?.close()
    if (!fixture) return
    if (dirname(resolve(fixture)) !== parent || !basename(fixture).startsWith('browser-work-scope-')) throw new Error('Unsafe browser fixture cleanup')
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  test('同一本地 HTML 在 Code 与 Work 各有独立原生页面，Work 内容区域获得真实尺寸', async ({}, testInfo) => {
    code = await createLocal('code-scope'); expect(code.presentation?.mode).toBe('code')
    await visible(code)
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await page.getByRole('button', { name: '打开工作区', exact: true }).click()
    workA = await createLocal('work-scope-a')
    expect(workA.presentation).toMatchObject({ mode: 'work', sessionId: 'work-scope-a' })
    await page.locator('.work-view').getByRole('tab', { name: '范围预览', exact: true }).click()
    await visible(workA)
    expect((await native(code))?.visible).toBe(false)
    await expect(page.locator('.work-resource-browser .browser-surface')).toBeVisible()
    const bounds = await page.locator('.work-resource-browser .browser-surface').boundingBox()
    expect(bounds?.height).toBeGreaterThan(200)
    const shot = await page.evaluate(id => window.aether.browser.read(id, 'screenshot'), workA.tabId)
    expect(shot.success, shot.error).toBe(true)
    const png = (shot.output as { dataUrl: string }).dataUrl
    await testInfo.attach('work-native-preview.png', { body: Buffer.from(png.split(',')[1], 'base64'), contentType: 'image/png' })

    const original = (await native(workA))!
    const contentState = async (): Promise<{ marker: string; input: string }> => app!.evaluate(({ webContents }, id) => {
      const contents = webContents.fromId(id)
      if (!contents || contents.isDestroyed()) throw new Error('Retained Work page was destroyed')
      return contents.executeJavaScript('({ marker: window.marker, input: document.getElementById("keep").value })')
    }, original.id)
    const beforeSwitch = await contentState()
    expect(beforeSwitch.marker).toMatch(/^[0-9a-f-]{36}$/i)
    const workspace = page.locator('.work-view').getByRole('region', { name: '任务工作区', exact: true })
    for (const name of ['成果', '工作区'] as const) {
      const tab = workspace.getByRole('tab', { name, exact: true })
      if (await tab.isVisible()) await tab.click()
      else {
        await workspace.getByRole('button', { name: '更多工作区', exact: true }).click()
        await page.getByRole('menuitem', { name, exact: true }).click()
      }
      await expect(workspace.getByRole('tabpanel', { name, exact: true })).toBeVisible()
      await expect.poll(async () => (await native(workA))?.visible).toBe(false)
      expect((await native(workA))?.id).toBe(original.id)
      expect(await contentState()).toEqual(beforeSwitch)
      await expect(workspace.locator('.browser-surface')).toHaveCount(0)
    }
    await workspace.getByRole('tab', { name: '范围预览', exact: true }).click()
    await visible(workA)
    expect((await native(workA))?.id).toBe(original.id)
    expect(await contentState()).toEqual(beforeSwitch)
    await expect.poll(async () => {
      const current = await native(workA)
      const surface = await workspace.locator('.browser-surface').boundingBox()
      if (!current || !surface) return Infinity
      const zoom = await page.evaluate(() => window.aether.browser.getHostZoomFactor())
      return Math.max(...(['x', 'y', 'width', 'height'] as const)
        .map(field => Math.abs(current.bounds[field] - Math.round(surface[field] * zoom))))
    }, { message: '恢复网页后原生页面应对齐固定面板槽中的真实宿主，不能停在切换前的偏移位置' }).toBeLessThanOrEqual(2)
    expect((await native(code))?.visible).toBe(false)
  })

  test('同模式切换会话不共享 tabs，返回时保留原生 WebContents 和选择', async () => {
    const originalA = (await native(workA))!.id
    await page.locator('.work-sidebar__task').filter({ hasText: '测试会话 B' }).click()
    await expect(page.locator('.work-view').getByRole('tab', { name: '范围预览', exact: true })).toHaveCount(0)
    expect((await native(workA))?.visible).toBe(false)
    workB = await createLocal('work-scope-b')
    expect(workB.presentation).toMatchObject({ mode: 'work', sessionId: 'work-scope-b' })
    await page.locator('.work-view').getByRole('tab', { name: '范围预览', exact: true }).click()
    await visible(workB)
    await expect(page.locator('.work-view').getByRole('tab', { name: '范围预览', exact: true })).toHaveCount(1)
    await page.locator('.work-sidebar__task').filter({ hasText: '测试会话 A' }).click()
    await page.locator('.work-view').getByRole('tab', { name: '范围预览', exact: true }).click()
    await visible(workA)
    expect((await native(workA))?.id).toBe(originalA)
    expect((await native(workB))?.visible).toBe(false)
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    await visible(code)
    expect((await native(workA))?.visible).toBe(false)
    await expect(page.locator('#mode-code .browser-tabs [role="tab"]')).toHaveCount(1)
    expect((await page.evaluate(() => window.aether.browser.list())).map(tab => tab.tabId).sort()).toEqual([code.tabId, workA.tabId, workB.tabId].sort())
    expect(new Set([code.url, workA.url, workB.url]).size).toBe(3)
    expect(new Set(nativeIds.values()).size).toBe(3)
  })
})
