/** Real Electron guest pages: UI entry/settings, authenticated remote tool queue, interactions, viewport, overlays and cleanup. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { BrowserSnapshot, BrowserToolRequest } from '../src/shared/browser'

const root = resolve(__dirname, '..')
const instanceToken = 'browser-ui-test-instance'
const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>浏览器回归页面</title><style>body{font:18px sans-serif;padding:20px}input,button{font:inherit;padding:8px}canvas{display:block;margin-top:16px;background:#eed7a7}</style><h1>可交互中文页面</h1><label>名称<input id="name" value="初始值"></label><button id="go">确认</button><p id="result">等待操作</p><a href="/next">下一页</a><canvas width="200" height="150"></canvas><script>document.querySelector('#go').onclick=()=>{document.querySelector('#result').textContent='完成：'+document.querySelector('#name').value;console.log('BROWSER_CLICK_OK');fetch('/ping')};const c=document.querySelector('canvas').getContext('2d');c.beginPath();c.arc(80,80,20,0,7);c.fill();console.error('EXPECTED_BROWSER_ERROR');</script></html>`
type Queued = { requestId: string; sessionId: string; action: string; args: object; expiresAt: number }
type Reply = { success: boolean; output: string; error?: string }
let app: ElectronApplication | undefined, page: Page, fixture = '', origin = '', tabId = ''
let client: { clientId: string; clientToken: string; sessionId: string } | null = null
const queue: Queued[] = []
const pending = new Map<string, (result: Reply) => void>()
const errors: string[] = []
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid')
    const send = (data: unknown, status = 200): void => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ code: status, message: 'fixture', data })) }
    if (url.pathname === '/demo') { response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }); response.end(html); return }
    if (url.pathname === '/next') { response.end('<!doctype html><meta charset="utf-8"><title>下一页</title><h1>第二页</h1>'); return }
    if (url.pathname === '/ping') { send({ ok: true }); return }
    if (url.pathname.startsWith('/api/') && request.headers['x-aether-instance-token'] !== instanceToken) { send({}, 401); return }
    let raw = ''; for await (const chunk of request) raw += String(chunk)
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    if (url.pathname === '/health') { send({ status: 'ok' }); return }
    if (url.pathname === '/meta') { send({ version: '2.0.0', buildId: `sha256:${'b'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'browser-ui-remote' }); return }
    if (url.pathname === '/api/v1/browser/clients') {
      client = { clientId: String(body.clientId ?? randomUUID()), clientToken: String(body.clientToken ?? randomUUID()), sessionId: String(body.sessionId) }
      send({ ...client, pollTimeoutMs: 20000, leaseMs: 65000 }); return
    }
    if (url.pathname.startsWith('/api/v1/browser/clients/')) {
      if (!client || !url.pathname.includes(client.clientId) || request.headers['x-aether-browser-token'] !== client.clientToken) { send({}, 404); return }
      if (request.method === 'DELETE') { client = null; send({ removed: true }); return }
      if (url.pathname.endsWith('/results')) {
        const resolveResult = pending.get(String(body.requestId)); pending.delete(String(body.requestId))
        resolveResult?.(body as unknown as Reply); send({ accepted: true }); return
      }
      if (url.pathname.endsWith('/commands')) {
        const finish = (): void => send({ commands: queue.splice(0, 1) })
        if (queue.length) finish(); else setTimeout(() => { if (!response.destroyed) finish() }, 150)
        return
      }
    }
    if (url.pathname === '/api/v1/chat/snapshot') { send({ schemaVersion: 1, sessionId: url.searchParams.get('sessionId'), source: 'persisted', finished: true, eventId: null, projection: [], runs: [], history: [], todos: [], changes: [], commandJobs: [] }); return }
    if (url.pathname === '/api/v1/workspace/bind') { send({ workspaceRoot: '/remote/project' }); return }
    if (url.pathname === '/api/v1/workspace/directory') { send({ root: '/remote/project', entries: [] }); return }
    send([])
  })().catch(error => { if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})

async function tool(action: BrowserToolRequest['action'], args: object = {}, expiresAt = Date.now() + 30000): Promise<Reply> {
  if (!client) throw new Error('Browser client not connected')
  const requestId = randomUUID()
  return new Promise((done, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Tool timed out: ${action}`)) }, 35000)
    pending.set(requestId, value => { clearTimeout(timer); done(value) })
    queue.push({ requestId, sessionId: client!.sessionId, action, args, expiresAt })
  })
}
async function snap(): Promise<BrowserSnapshot> {
  const result = await tool('snapshot', { tabId })
  expect(result.success, result.error).toBe(true)
  return JSON.parse(result.output) as BrowserSnapshot
}
async function assertTool(action: BrowserToolRequest['action'], args: object): Promise<Reply> {
  const result = await tool(action, args)
  expect(result.success, result.error).toBe(true)
  return result
}

test.describe.serial('内置浏览器与远端工具通道', () => {
  test.beforeAll(async () => {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address')
    origin = `http://127.0.0.1:${address.port}`
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true }); fixture = mkdtempSync(join(root, '.e2e-tmp/browser-ui-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true, lastSessionId: '' }))
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: instanceToken, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(String(error)))
    await expect.poll(() => page.evaluate(() => window.aether.browser.getConnection())).toMatchObject({ status: 'connected' })
  })
  test.afterEach(() => expect(errors).toEqual([]))
  test.afterAll(async () => {
    await app?.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    const absolute = resolve(fixture)
    if (dirname(absolute) !== join(root, '.e2e-tmp') || !basename(absolute).startsWith('browser-ui-')) throw new Error('Unsafe fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  test('快捷入口打开分栏浏览器，真实网页加载且与IDE能力隔离', async () => {
    await page.keyboard.press('Control+Alt+b')
    await expect(page.getByRole('region', { name: '内置浏览器', exact: true })).toBeVisible()
    await page.locator('.browser-address').fill(`${origin}/demo`); await page.locator('.browser-address').press('Enter')
    await expect.poll(() => page.evaluate(() => window.aether.browser.list())).toContainEqual(expect.objectContaining({ title: '浏览器回归页面', loading: false }))
    const tabs = await page.evaluate(() => window.aether.browser.list()); tabId = tabs.find(tab => tab.url === `${origin}/demo`)!.tabId
    expect((await snap()).text).toContain('可交互中文页面')
    const isolated = await app!.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(wc => wc.getURL() === url)!.executeJavaScript('({node:typeof require,bridge:typeof window.aether})'), `${origin}/demo`)
    expect(isolated).toEqual({ node: 'undefined', bridge: 'undefined' })
    await expect(page.locator('.editor-group-cell')).toHaveCount(2)
  })

  test('认证工具队列操作可见页面，中文输入点击产生真实DOM与网络副作用', async () => {
    await app!.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(wc => wc.getURL() === url)!.executeJavaScript(`document.body.insertAdjacentHTML('beforeend','<label>密码<input type="password" value="private-test-secret"></label>')`), `${origin}/demo`)
    const snapshot = await snap()
    expect(JSON.stringify(snapshot)).not.toContain('private-test-secret')
    const field = snapshot.elements.find(element => element.role === 'textbox')!
    await assertTool('fill', { tabId, ref: field.ref, text: '五子棋测试', navigationId: snapshot.tab.navigationId })
    expect((await snap()).elements).toContainEqual(expect.objectContaining({ role: 'textbox', value: '五子棋测试' }))
    await assertTool('click', { tabId, selector: '#go', navigationId: snapshot.tab.navigationId })
    expect((await snap()).text).toContain('完成：五子棋测试')
    const logs = JSON.parse((await assertTool('console', { tabId })).output)
    expect(logs.entries).toContainEqual(expect.objectContaining({ message: 'BROWSER_CLICK_OK' }))
    await expect.poll(async () => JSON.parse((await assertTool('network', { tabId })).output).entries).toContainEqual(expect.objectContaining({ url: `${origin}/ping`, status: 200 }))
    const expired = await tool('click', { tabId, selector: '#go' }, Date.now() - 1000)
    expect(expired).toMatchObject({ success: false, error: expect.stringContaining('过期') })
  })

  test('手机视口与截图反映真实网页尺寸，导航后拒绝旧元素引用', async ({}, testInfo) => {
    const before = await snap()
    await assertTool('viewport', { tabId, viewport: { width: 390, height: 600, mobile: true, deviceScaleFactor: 2 } })
    expect((await snap()).viewport.width).toBe(390)
    await assertTool('fill', { tabId, selector: '#name', text: '手机视口输入', navigationId: before.tab.navigationId })
    await assertTool('click', { tabId, selector: '#go', navigationId: before.tab.navigationId })
    expect((await snap()).text).toContain('完成：手机视口输入')
    const screenshot = JSON.parse((await assertTool('screenshot', { tabId })).output)
    expect(screenshot.dataUrl).toMatch(/^data:image\/png;base64,iVBOR/)
    expect(screenshot.viewport.width).toBe(390)
    await testInfo.attach('browser-mobile.png', { body: Buffer.from(screenshot.dataUrl.split(',')[1], 'base64'), contentType: 'image/png' })
    await assertTool('navigate', { tabId, url: `${origin}/next` })
    const stale = await tool('click', { tabId, selector: '#go', navigationId: before.tab.navigationId })
    expect(stale.success).toBe(false); expect(stale.error).toContain('页面已经变化')
    await assertTool('navigate', { tabId, url: `${origin}/demo` })
    await assertTool('viewport', { tabId, viewport: null })
  })

  test('设置入口真实落盘，命令面板不会被原生网页遮挡', async () => {
    await page.keyboard.press('Control+Shift+p')
    await expect(page.locator('[role="dialog"]').first()).toBeVisible()
    const visible = await app!.evaluate(({ BrowserWindow, WebContentsView }) => BrowserWindow.getAllWindows()[0].contentView.children.filter(view => view instanceof WebContentsView).some(view => view.getVisible()))
    expect(visible).toBe(false)
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.aether.browser.updateSettings({ homeUrl: 'https://example.com/', zoomFactor: 1.25, persistSession: false }))
    expect(JSON.parse(readFileSync(join(fixture, 'browser-settings.json'), 'utf8'))).toMatchObject({ homeUrl: 'https://example.com/', zoomFactor: 1.25, persistSession: false })
    await page.keyboard.press('Control+,')
    await page.getByRole('tab', { name: '浏览器', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '浏览器默认地址', exact: true })).toHaveValue('https://example.com/')
    await page.getByRole('textbox', { name: '浏览器默认地址', exact: true }).fill('http://localhost:5173')
    await page.locator('.browser-settings__address').getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => JSON.parse(readFileSync(join(fixture, 'browser-settings.json'), 'utf8')).homeUrl).toBe('http://localhost:5173/')
    await page.getByRole('switch', { name: '允许 AI 使用内置浏览器', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.aether.browser.getConnection())).toMatchObject({ status: 'disconnected' })
    await page.getByRole('switch', { name: '允许 AI 使用内置浏览器', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.aether.browser.getConnection())).toMatchObject({ status: 'connected' })
  })

  test('关闭 AI 时取消等待显示的操作，重新显示网页不会继续旧点击', async () => {
    // Settings can occupy the other editor group. The command palette hides all
    // native pages, so this specifically exercises cancellation during the wait.
    await page.keyboard.press('Control+Shift+p')
    await expect(page.locator('.palette')).toBeVisible()
    await expect.poll(() => app!.evaluate(({ BrowserWindow, WebContentsView }) => BrowserWindow.getAllWindows()[0].contentView.children.filter(view => view instanceof WebContentsView).some(view => view.getVisible()))).toBe(false)
    const before = await page.evaluate(id => window.aether.browser.read(id, 'snapshot'), tabId)
    const navigationId = (before.output as BrowserSnapshot).tab.navigationId
    queue.push({ requestId: randomUUID(), sessionId: client!.sessionId, action: 'click', args: { tabId, selector: '#go', navigationId }, expiresAt: Date.now() + 30000 })
    await expect.poll(() => queue.length).toBe(0)
    await page.evaluate(() => window.aether.browser.updateSettings({ aiEnabled: false }))
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+Alt+b')
    await expect(page.getByRole('region', { name: '内置浏览器', exact: true })).toBeVisible()
    await page.evaluate(() => window.aether.browser.updateSettings({ aiEnabled: true }))
    await expect.poll(() => page.evaluate(() => window.aether.browser.getConnection())).toMatchObject({ status: 'connected' })
    expect((await snap()).text).toContain('等待操作')
  })

  test('关闭网页销毁WebContents，错误协议不创建页面', async () => {
    const count = await page.evaluate(() => window.aether.browser.list().then(tabs => tabs.length))
    const blocked = await page.evaluate(async () => { try { await window.aether.browser.create({ url: 'file:///C:/Windows/win.ini' }); return '' } catch (error) { return String(error) } })
    expect(blocked).toContain('仅支持')
    expect(await page.evaluate(() => window.aether.browser.list().then(tabs => tabs.length))).toBe(count)
    await page.evaluate(tabId => window.aether.browser.close(tabId), tabId)
    expect(await app!.evaluate(({ webContents }, url) => webContents.getAllWebContents().some(wc => wc.getURL() === url), `${origin}/demo`)).toBe(false)
  })
})
