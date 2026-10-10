/** Real Electron guest pages: UI entry/settings, authenticated remote tool queue, interactions, viewport, overlays and cleanup. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { BrowserSnapshot, BrowserToolRequest, BrowserUnavailableSnapshot } from '../src/shared/browser'

const root = resolve(__dirname, '..')
const instanceToken = 'browser-ui-test-instance'
const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>浏览器回归页面</title><style>body{font:18px sans-serif;padding:20px}input,button{font:inherit;padding:8px}canvas{display:block;margin-top:16px;background:#eed7a7}#visual-marker{position:fixed;right:14px;top:12px;width:36px;height:28px;background:rgb(220,30,70);z-index:9999;pointer-events:none}</style><div id="visual-marker" aria-hidden="true"></div><h1>可交互中文页面</h1><label>名称<input id="name" value="初始值"></label><button id="go">确认</button><p id="result">等待操作</p><a href="/next">下一页</a><canvas aria-label="回归画布" width="200" height="150"></canvas><script>document.querySelector('#go').onclick=()=>{document.querySelector('#result').textContent='完成：'+document.querySelector('#name').value;console.log('BROWSER_CLICK_OK');fetch('/ping')};const c=document.querySelector('canvas').getContext('2d');c.beginPath();c.arc(80,80,20,0,7);c.fill();console.error('EXPECTED_BROWSER_ERROR');</script></html>`
type Queued = { requestId: string; sessionId: string; action: string; args: object; expiresAt: number }
type Reply = { success: boolean; output: string; error?: string }
type ClickProbe = { tag: string; id: string; href: string | null; x: number; y: number; trusted: boolean; defaultPrevented: boolean }
// Same-origin navigation keeps evidence from the old document available for comparison.
const clickProbeScript = `document.addEventListener('click',event=>{sessionStorage.setItem('clickCount',String(Number(sessionStorage.getItem('clickCount')||0)+1));sessionStorage.setItem('clickProbe',JSON.stringify({tag:event.target.tagName,id:event.target.id,href:event.target.getAttribute('href'),x:event.clientX,y:event.clientY,trusted:event.isTrusted,defaultPrevented:event.defaultPrevented}))});`
let app: ElectronApplication | undefined, page: Page, fixture = '', origin = '', tabId = ''
let client: { clientId: string; clientToken: string; sessionId: string } | null = null
const queue: Queued[] = []
const pending = new Map<string, (result: Reply) => void>()
const errors: string[] = []
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid')
    const send = (data: unknown, status = 200): void => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ code: status, message: 'fixture', data })) }
    if (url.pathname === '/demo') { response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }); response.end(html.replace('</script>', `${clickProbeScript}</script>`)); return }
    if (url.pathname === '/capture-race') { response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }); response.end(html.replace('</style>', 'body{min-height:2000px}</style>').replace('</script>', `${clickProbeScript}</script>`)); return }
    if (url.pathname === '/next') { response.end('<!doctype html><meta charset="utf-8"><title>下一页</title><style>html,body{background:rgb(20,170,80)}</style><h1>第二页</h1>'); return }
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
async function expectActualClick(snapshot: Pick<BrowserSnapshot, 'interaction'>): Promise<ClickProbe> {
  const event: ClickProbe = await app!.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(wc => wc.getURL().startsWith(url))!.executeJavaScript('JSON.parse(sessionStorage.getItem("clickProbe"))'), origin)
  expect(event.trusted).toBe(true)
  expect(Math.abs(event.x - snapshot.interaction!.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(event.y - snapshot.interaction!.y)).toBeLessThanOrEqual(1)
  return event
}
async function expectButtonGeometry(snapshot: BrowserSnapshot): Promise<void> {
  const expected = await app!.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(wc => wc.getURL() === url)!.executeJavaScript('document.querySelector("#go").getBoundingClientRect().toJSON()'), `${origin}/demo`)
  const captured = snapshot.elements.find(element => element.role === 'button' && element.name === '确认')?.bounds
  expect(captured).toBeDefined()
  expect(captured).not.toBeNull()
  for (const dimension of ['x', 'y', 'width', 'height'] as const) expect(captured![dimension]).toBeCloseTo(expected[dimension], 1)
}

/** A known visual marker independently verifies complete viewport capture and
 * CSS-to-pixel alignment; a merely valid but blank or clipped PNG cannot pass. */
async function expectViewportPixels(captured: {
  viewport: { width: number; height: number }
  screenshot?: { dataUrl: string; width: number; height: number }
}, expected = [220, 30, 70], sample?: { x: number; y: number }): Promise<void> {
  const image = captured.screenshot
  expect(image, '稳定页面的快照应包含真实页面截图').toBeDefined()
  if (!image) throw new Error('Missing saved viewport screenshot')
  expect(image.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  const point = sample ?? { x: captured.viewport.width - 32, y: 26 }
  expect(point.x).toBeGreaterThanOrEqual(0)
  expect(point.y).toBeGreaterThanOrEqual(0)
  expect(point.x).toBeLessThan(captured.viewport.width)
  expect(point.y).toBeLessThan(captured.viewport.height)
  const pixels = await page.evaluate(async ({ image, viewport, point }) => {
    const img = new Image()
    await new Promise<void>((done, reject) => { img.onload = () => done(); img.onerror = () => reject(new Error('Saved viewport PNG did not decode')); img.src = image.dataUrl })
    const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
    const context = canvas.getContext('2d'); if (!context) throw new Error('Missing canvas decoder')
    context.drawImage(img, 0, 0)
    const x = Math.floor(point.x * img.naturalWidth / viewport.width)
    const y = Math.floor(point.y * img.naturalHeight / viewport.height)
    return { width: img.naturalWidth, height: img.naturalHeight, color: [...context.getImageData(x, y, 1, 1).data] }
  }, { image, viewport: captured.viewport, point })
  expect(pixels.width).toBe(image.width)
  expect(pixels.height).toBe(image.height)
  expect(pixels.width).toBeGreaterThan(100)
  expect(pixels.height).toBeGreaterThan(100)
  expect(Math.abs(pixels.width / pixels.height - captured.viewport.width / captured.viewport.height)).toBeLessThan(0.01)
  expect(pixels.color).toEqual([...expected, 255])
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
    const initial = await snap()
    expect(initial.text).toContain('可交互中文页面')
    await expectViewportPixels(initial)
    const isolated = await app!.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(wc => wc.getURL() === url)!.executeJavaScript('({node:typeof require,bridge:typeof window.aether})'), `${origin}/demo`)
    expect(isolated).toEqual({ node: 'undefined', bridge: 'undefined' })
    await expect(page.locator('.editor-group-cell')).toHaveCount(2)
  })

  test('非点击快照记录按钮、文字与画布位置，滚动后仍与真实视口一致', async () => {
    await app!.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(wc => wc.getURL() === url)!.executeJavaScript(`document.body.insertAdjacentHTML('beforeend','<section id="geometry-fixture" style="margin-top:900px;padding-bottom:300px"><p id="geometry-text">滚动定位文本</p><button id="geometry-target" style="background:rgb(36,118,220);border:0;border-radius:0">离屏定位按钮</button></section>')`), `${origin}/demo`)
    const before = await snap()
    const beforeBounds = before.elements.find(element => element.role === 'button' && element.name === '离屏定位按钮')?.bounds
    expect(beforeBounds).toBeDefined()
    expect(beforeBounds!.y).toBeGreaterThan(before.viewport.height)
    const after = JSON.parse((await assertTool('scroll', { tabId, deltaY: beforeBounds!.y - Math.min(160, before.viewport.height / 2) })).output) as BrowserSnapshot
    expect(after.viewport.scrollY).toBeGreaterThan(0)
    await expectViewportPixels(after)
    const actual = await app!.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(wc => wc.getURL() === url)!.executeJavaScript(`(()=>{
      const bounds=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
      const range=document.createRange();range.selectNodeContents(document.querySelector('#geometry-text'));const r=range.getBoundingClientRect();
      return {button:bounds('#geometry-target'),canvas:bounds('canvas'),text:{x:r.x,y:r.y,width:r.width,height:r.height},scrollY};
    })()`), `${origin}/demo`)
    expect(after.viewport.scrollY).toBeCloseTo(actual.scrollY, 3)
    await expectViewportPixels(after, [36, 118, 220], { x: actual.button.x + 4, y: actual.button.y + 4 })
    const candidates = [
      [after.elements.find(element => element.role === 'button' && element.name === '离屏定位按钮')?.bounds, actual.button],
      [after.elements.find(element => element.role.toLowerCase() === 'statictext' && element.name === '滚动定位文本')?.bounds, actual.text],
      [after.elements.find(element => element.role.toLowerCase() === 'canvas')?.bounds, actual.canvas]
    ] as const
    for (const [captured, expected] of candidates) {
      expect(captured, JSON.stringify(after.elements.map(element => ({ role: element.role, name: element.name })))).toBeDefined()
      expect(captured).not.toBeNull()
      for (const dimension of ['x', 'y', 'width', 'height'] as const) expect(captured![dimension]).toBeCloseTo(expected[dimension], 1)
    }
    await app!.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(wc => wc.getURL() === url)!.executeJavaScript(`document.querySelector('#geometry-fixture').remove();window.scrollTo(0,0)`), `${origin}/demo`)
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

  test('引用和坐标点击记录真实位置，密码目标不暴露输入值', async () => {
    await assertTool('fill', { tabId, selector: '#name', text: '引用点击' })
    const before = await snap()
    const button = before.elements.find(element => element.role === 'button' && element.name === '确认')!
    expect(button.ref).toBeTruthy()
    const byRef = JSON.parse((await assertTool('click', { tabId, ref: button.ref, navigationId: before.tab.navigationId })).output) as BrowserSnapshot
    expect(byRef.text).toContain('完成：引用点击')
    expect(byRef.interaction).toMatchObject({ type: 'click', pageUrl: `${origin}/demo`, navigationId: before.tab.navigationId,
      target: { ref: button.ref, name: '确认' } })
    expect(await expectActualClick(byRef)).toMatchObject({ id: 'go' })
    await expectViewportPixels(byRef)
    await expectViewportPixels(byRef.interaction!)
    const point = byRef.interaction!
    expect(point.x).toBeGreaterThanOrEqual(0)
    expect(point.x).toBeLessThan(point.viewport.width)
    expect(point.y).toBeLessThan(point.viewport.height)
    await assertTool('fill', { tabId, selector: '#name', text: '坐标点击' })
    const byPoint = JSON.parse((await assertTool('click', { tabId, x: point.x, y: point.y, navigationId: before.tab.navigationId })).output) as BrowserSnapshot
    expect(byPoint.text).toContain('完成：坐标点击')
    expect(byPoint.interaction).toMatchObject({ type: 'click', x: point.x, y: point.y, target: { name: '确认' } })
    expect(byPoint.interaction?.target?.ref).toBeUndefined()
    expect(await expectActualClick(byPoint)).toMatchObject({ id: 'go' })
    const edge = JSON.parse((await assertTool('click', { tabId, x: 0, y: 0, navigationId: before.tab.navigationId })).output) as BrowserSnapshot
    expect(edge.interaction).toMatchObject({ x: 0, y: 0 })
    await expectActualClick(edge)
    const password = JSON.parse((await assertTool('click', { tabId, selector: 'input[type=password]', navigationId: before.tab.navigationId })).output) as BrowserSnapshot
    expect(password.interaction?.target?.selector).toBe('input[type=password]')
    expect(JSON.stringify(password)).not.toContain('private-test-secret')
    for (const zoomFactor of [0.8, 1.25]) {
      await page.evaluate(({ tabId, zoomFactor }) => window.aether.browser.action({ tabId, action: 'zoom', zoomFactor }), { tabId, zoomFactor })
      const zoomed = JSON.parse((await assertTool('click', { tabId, selector: '#go' })).output) as BrowserSnapshot
      expect(await expectActualClick(zoomed)).toMatchObject({ id: 'go' })
      await expectButtonGeometry(zoomed)
      await expectViewportPixels(zoomed)
      await expectViewportPixels(zoomed.interaction!)
    }
    await page.evaluate(tabId => window.aether.browser.action({ tabId, action: 'zoom', zoomFactor: 1 }), tabId)
  })

  test('截图等待期间滚动或目标移动拒绝旧坐标，单独截图失败仍可正常点击', async () => {
    const raceUrl = `${origin}/capture-race`
    await assertTool('navigate', { tabId, url: raceUrl })
    const count = (): Promise<number> => app!.evaluate(({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find(wc => wc.getURL() === url)
      if (!guest) throw new Error('Missing owned capture-race fixture')
      return guest.executeJavaScript('Number(sessionStorage.getItem("clickCount")||0)')
    }, raceUrl)
    const inject = (fault: 'scroll' | 'move' | 'capture-error'): Promise<void> => app!.evaluate(({ webContents }, { url, fault }) => {
      const guest = webContents.getAllWebContents().find(wc => wc.getURL() === url)
      if (!guest) throw new Error('Missing owned capture-race fixture')
      const owned = guest as typeof guest & { fixtureOriginalCapture?: typeof guest.capturePage }
      if (owned.fixtureOriginalCapture) throw new Error('Previous fixture capture wrapper was not consumed')
      const original = guest.capturePage
      owned.fixtureOriginalCapture = original
      guest.capturePage = async (...args) => {
        guest.capturePage = original
        delete owned.fixtureOriginalCapture
        if (fault === 'capture-error') throw new Error('Fixture screenshot decoder unavailable')
        const image = await original.apply(guest, args)
        await guest.executeJavaScript(fault === 'scroll'
          ? 'window.scrollBy(0,80)'
          : 'document.querySelector("#go").style.transform="translateX(90px)"')
        return image
      }
    }, { url: raceUrl, fault })
    try {
      for (const fault of ['scroll', 'move'] as const) {
        const before = await count()
        await inject(fault)
        const result = await tool('click', { tabId, selector: '#go' })
        expect(result.success, `${fault} changed the frame while capturePage was pending`).toBe(false)
        expect(result.error).toMatch(/变化/)
        expect(await count(), '旧坐标不能触发真实网页点击事件').toBe(before)
        await app!.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(wc => wc.getURL() === url)!
          .executeJavaScript('document.querySelector("#go").style.transform="";window.scrollTo(0,0)'), raceUrl)
      }
      const before = await count()
      await inject('capture-error')
      const result = JSON.parse((await assertTool('click', { tabId, selector: '#go' })).output) as BrowserSnapshot
      expect(await count()).toBe(before + 1)
      expect(await expectActualClick(result)).toMatchObject({ id: 'go', trusted: true })
      expect(result.interaction?.screenshot).toBeUndefined()
    } finally {
      await app!.evaluate(({ webContents }, url) => {
        const guest = webContents.getAllWebContents().find(wc => wc.getURL() === url)
        if (!guest) return
        const owned = guest as typeof guest & { fixtureOriginalCapture?: typeof guest.capturePage }
        if (owned.fixtureOriginalCapture) { guest.capturePage = owned.fixtureOriginalCapture; delete owned.fixtureOriginalCapture }
      }, raceUrl)
      await assertTool('navigate', { tabId, url: `${origin}/demo` })
    }
  })

  test('点击后的快照截图期间发生导航时只重取快照，不重复点击并保留点击前图', async ({}, testInfo) => {
    const before = await snap()
    const owned = await app!.evaluate(async ({ webContents }, { url, nextUrl }) => {
      const guest = webContents.getAllWebContents().find(wc => wc.getURL() === url)
      if (!guest) throw new Error('Missing owned navigation capture fixture')
      const target = guest as typeof guest & {
        fixtureOriginalCapture?: typeof guest.capturePage
        fixtureNavigationCaptureCalls?: number
      }
      const clicks = await guest.executeJavaScript('Number(sessionStorage.getItem("clickCount")||0)') as number
      const original = guest.capturePage
      target.fixtureOriginalCapture = original
      target.fixtureNavigationCaptureCalls = 0
      guest.capturePage = async (...args) => {
        const image = await original.apply(guest, args)
        target.fixtureNavigationCaptureCalls = (target.fixtureNavigationCaptureCalls ?? 0) + 1
        // Capture 1 belongs to the evidence collected before mousePressed.
        // Navigate only while capture 2 is producing the post-click snapshot.
        if (target.fixtureNavigationCaptureCalls === 2) {
          guest.capturePage = original
          delete target.fixtureOriginalCapture
          await guest.loadURL(nextUrl)
        }
        return image
      }
      return { id: guest.id, clicks }
    }, { url: `${origin}/demo`, nextUrl: `${origin}/next` })
    try {
      const result = JSON.parse((await assertTool('click', { tabId, selector: '#go', navigationId: before.tab.navigationId })).output) as BrowserSnapshot
      expect(result.tab.url).toBe(`${origin}/next`)
      expect(result.text).toContain('第二页')
      expect(result.interaction).toMatchObject({ pageUrl: `${origin}/demo`, navigationId: before.tab.navigationId, target: { selector: '#go' } })
      const observed = await app!.evaluate(async ({ webContents }, id) => {
        const guest = webContents.fromId(id)
        if (!guest) throw new Error('Owned navigation fixture disappeared')
        const target = guest as typeof guest & { fixtureNavigationCaptureCalls?: number }
        return { captures: target.fixtureNavigationCaptureCalls, clicks: await guest.executeJavaScript('Number(sessionStorage.getItem("clickCount")||0)') as number }
      }, owned.id)
      expect(observed.captures, '故障必须发生在操作后快照截图，不能误改点击前截图').toBe(2)
      expect(observed.clicks, '读取新页面快照不能重新派发点击').toBe(owned.clicks + 1)
      expect(await expectActualClick(result)).toMatchObject({ id: 'go', trusted: true })
      await expectViewportPixels(result.interaction!)
      await expectViewportPixels(result, [20, 170, 80])
      await testInfo.attach('navigation-race-before.png', { body: Buffer.from(result.interaction!.screenshot!.dataUrl.split(',')[1], 'base64'), contentType: 'image/png' })
      await testInfo.attach('navigation-race-after.png', { body: Buffer.from(result.screenshot!.dataUrl.split(',')[1], 'base64'), contentType: 'image/png' })
    } finally {
      await app!.evaluate(({ webContents }, id) => {
        const guest = webContents.fromId(id)
        if (!guest) return
        const target = guest as typeof guest & { fixtureOriginalCapture?: typeof guest.capturePage; fixtureNavigationCaptureCalls?: number }
        if (target.fixtureOriginalCapture) { guest.capturePage = target.fixtureOriginalCapture; delete target.fixtureOriginalCapture }
        delete target.fixtureNavigationCaptureCalls
      }, owned.id)
      await assertTool('navigate', { tabId, url: `${origin}/demo` })
    }
  })

  test('点击后读取快照失败仍返回操作成功，保留点击前图且不重复点击', async () => {
    const before = await snap()
    const owned = await app!.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find(wc => wc.getURL() === url)
      if (!guest) throw new Error('Missing owned post-click AX fixture')
      const target = guest as typeof guest & {
        fixtureOriginalAXCommand?: typeof guest.debugger.sendCommand
        fixtureAXFailures?: number
      }
      const clicks = await guest.executeJavaScript('Number(sessionStorage.getItem("clickCount")||0)') as number
      const original = guest.debugger.sendCommand
      target.fixtureOriginalAXCommand = original
      target.fixtureAXFailures = 0
      guest.debugger.sendCommand = async (...args) => {
        // Clicking uses DOM/Runtime commands; the next AX read belongs to the
        // post-action snapshot, after the trusted mouse event was dispatched.
        if (args[0] === 'Accessibility.getFullAXTree') {
          guest.debugger.sendCommand = original
          delete target.fixtureOriginalAXCommand
          target.fixtureAXFailures = (target.fixtureAXFailures ?? 0) + 1
          throw new Error('Fixture post-action AX unavailable')
        }
        return original.apply(guest.debugger, args)
      }
      return { id: guest.id, clicks }
    }, `${origin}/demo`)
    try {
      const result = JSON.parse((await assertTool('click', { tabId, selector: '#go', navigationId: before.tab.navigationId })).output) as BrowserUnavailableSnapshot
      expect(result.snapshotUnavailable).toContain('Fixture post-action AX unavailable')
      expect(result).toMatchObject({ tab: { url: `${origin}/demo` }, text: '', elements: [], truncated: false })
      expect(result, '读取失败不能把点击前视口伪装成点击后快照').not.toHaveProperty('viewport')
      expect(result).not.toHaveProperty('screenshot')
      expect(result.interaction).toMatchObject({ type: 'click', pageUrl: `${origin}/demo`, navigationId: before.tab.navigationId, target: { selector: '#go' } })
      const observed = await app!.evaluate(async ({ webContents }, id) => {
        const guest = webContents.fromId(id)
        if (!guest) throw new Error('Owned post-click AX fixture disappeared')
        const target = guest as typeof guest & { fixtureAXFailures?: number }
        return {
          failures: target.fixtureAXFailures,
          clicks: await guest.executeJavaScript('Number(sessionStorage.getItem("clickCount")||0)') as number,
          result: await guest.executeJavaScript('document.querySelector("#result").textContent') as string
        }
      }, owned.id)
      expect(observed.failures, '故障注入必须真正触发一次').toBe(1)
      expect(observed.clicks, '快照读取失败不能重新派发已成功的点击').toBe(owned.clicks + 1)
      expect(observed.result).toBe('完成：初始值')
      expect(await expectActualClick(result)).toMatchObject({ id: 'go', trusted: true })
      await expectViewportPixels(result.interaction!)
    } finally {
      await app!.evaluate(({ webContents }, id) => {
        const guest = webContents.fromId(id)
        if (!guest) return
        const target = guest as typeof guest & {
          fixtureOriginalAXCommand?: typeof guest.debugger.sendCommand
          fixtureAXFailures?: number
        }
        if (target.fixtureOriginalAXCommand) { guest.debugger.sendCommand = target.fixtureOriginalAXCommand; delete target.fixtureOriginalAXCommand }
        delete target.fixtureAXFailures
      }, owned.id)
    }
  })

  test('缩放视口点击坐标与网页事件一致，手机截图与链接导航保留真实证据', async ({}, testInfo) => {
    const before = await snap()
    await assertTool('viewport', { tabId, viewport: { width: 1000, height: 900, mobile: false, deviceScaleFactor: 1 } })
    const desktopClick = JSON.parse((await assertTool('click', { tabId, selector: '#go', navigationId: before.tab.navigationId })).output) as BrowserSnapshot
    expect(desktopClick.interaction?.viewport).toMatchObject({ width: 1000, height: 900 })
    expect(await expectActualClick(desktopClick)).toMatchObject({ id: 'go' })
    await expectButtonGeometry(desktopClick)
    await expectViewportPixels(desktopClick)
    await expectViewportPixels(desktopClick.interaction!)
    await assertTool('viewport', { tabId, viewport: { width: 390, height: 600, mobile: true, deviceScaleFactor: 2 } })
    expect((await snap()).viewport.width).toBe(390)
    await assertTool('fill', { tabId, selector: '#name', text: '手机视口输入', navigationId: before.tab.navigationId })
    const mobileClick = JSON.parse((await assertTool('click', { tabId, selector: '#go', navigationId: before.tab.navigationId })).output) as BrowserSnapshot
    expect(mobileClick.interaction?.viewport).toMatchObject({ width: 390, height: 600 })
    expect(mobileClick.interaction!.viewport.deviceScaleFactor).toBeCloseTo(2, 5)
    expect(mobileClick.interaction!.x).toBeLessThan(390)
    expect(await expectActualClick(mobileClick)).toMatchObject({ id: 'go' })
    await expectButtonGeometry(mobileClick)
    await expectViewportPixels(mobileClick)
    await expectViewportPixels(mobileClick.interaction!)
    const mobilePoint = JSON.parse((await assertTool('click', { tabId, x: mobileClick.interaction!.x, y: mobileClick.interaction!.y })).output) as BrowserSnapshot
    expect(await expectActualClick(mobilePoint)).toMatchObject({ id: 'go' })
    expect((await snap()).text).toContain('完成：手机视口输入')
    const screenshot = JSON.parse((await assertTool('screenshot', { tabId })).output)
    expect(screenshot.dataUrl).toMatch(/^data:image\/png;base64,iVBOR/)
    expect(screenshot.viewport.width).toBe(390)
    await testInfo.attach('browser-mobile.png', { body: Buffer.from(screenshot.dataUrl.split(',')[1], 'base64'), contentType: 'image/png' })
    const navigatingClick = JSON.parse((await assertTool('click', { tabId, selector: 'a[href="/next"]', navigationId: before.tab.navigationId })).output) as BrowserSnapshot
    expect(navigatingClick.interaction).toMatchObject({ pageUrl: `${origin}/demo`, navigationId: before.tab.navigationId })
    await expectViewportPixels(navigatingClick.interaction!)
    await expect.poll(async () => (await snap()).tab.url).toBe(`${origin}/next`)
    const nextPage = await snap()
    await expectViewportPixels(nextPage, [20, 170, 80])
    expect(nextPage.screenshot?.dataUrl === navigatingClick.interaction?.screenshot?.dataUrl).toBe(false)
    const clickProbe = await expectActualClick(navigatingClick)
    expect(clickProbe).toMatchObject({ tag: 'A', href: '/next', defaultPrevented: false })
    await testInfo.attach('navigation-click-evidence', { body: JSON.stringify({ captured: navigatingClick.interaction, event: clickProbe }), contentType: 'application/json' })
    const stale = await tool('click', { tabId, selector: '#go', navigationId: before.tab.navigationId })
    expect(stale.success).toBe(false); expect(stale.error).toContain('页面已经变化')
    await assertTool('navigate', { tabId, url: `${origin}/demo` })
    await assertTool('viewport', { tabId, viewport: null })
  })

  test('设置入口真实落盘，命令面板不会被原生网页遮挡', async () => {
    await page.keyboard.press('Control+Shift+p')
    await expect(page.locator('[role="dialog"]').first()).toBeVisible()
    // Overlay visibility reaches the native view on the next animation frame + IPC.
    await expect.poll(() => app!.evaluate(({ BrowserWindow, WebContentsView }) => BrowserWindow.getAllWindows()[0].contentView.children.filter(view => view instanceof WebContentsView).some(view => view.getVisible()))).toBe(false)
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
