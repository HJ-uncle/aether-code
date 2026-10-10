/** Real Electron + authenticated remote queue: same-URL tab identity, trusted input,
 * fresh visible activation, modal waits and cancellation without replaying input. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { BrowserSnapshot, BrowserTabState, BrowserToolRequest } from '../src/shared/browser'

const root = resolve(__dirname, '..')
const instanceToken = 'browser-multitab-fixture-token'
let sessionId = ''
const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>相同地址标签</title>
<style>body{font:18px sans-serif;margin:24px;min-height:2200px}header{position:fixed;top:16px;left:24px;background:white;padding:12px}input{width:160px}input,button{font:inherit;padding:8px}</style>
<header><label>名称<input id="name" value="初始值"></label><button id="go">确认</button><p id="result">等待操作</p></header>
<script>window.__multitab={token:crypto.randomUUID(),clicks:[],inputs:[],keys:[]};
document.querySelector('#go').addEventListener('click',event=>{const probe=window.__multitab;probe.clicks.push({trusted:event.isTrusted,x:event.clientX,y:event.clientY,value:document.querySelector('#name').value});document.querySelector('#result').textContent='已点击 '+probe.clicks.length});
document.querySelector('#name').addEventListener('input',event=>window.__multitab.inputs.push({trusted:event.isTrusted,value:event.target.value}));
document.addEventListener('keydown',event=>{if(event.key==='Enter')window.__multitab.keys.push({trusted:event.isTrusted,key:event.key})});</script></html>`
type Registration = { clientId: string; clientToken: string; sessionId: string }
type Command = { requestId: string; sessionId: string; action: BrowserToolRequest['action']; args: object; expiresAt: number }
type Reply = { success: boolean; output: string; error?: string }
type OwnedTab = { tab: BrowserTabState; webContentsId: number; token: string }
type Probe = {
  token: string
  clicks: Array<{ trusted: boolean; x: number; y: number; value: string }>
  inputs: Array<{ trusted: boolean; value: string }>
  keys: Array<{ trusted: boolean; key: string }>
  value: string
  scrollY: number
}
type Reveals = { multitabReveals?: Array<{ tabId: string; requestId: string }> }
let app: ElectronApplication | undefined, page: Page, fixture = '', origin = ''
let client: Registration | undefined, a: OwnedTab, b: OwnedTab
const registrations = new Map<string, Registration>()
const released = new Set<string>()
const queued: Array<{ clientId: string; command: Command }> = []
const replies = new Map<string, Reply>()
const ownedTabs = new Map<string, OwnedTab>()
const rendererErrors: string[] = []
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid')
    const send = (data: unknown, status = 200): void => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ code: status, message: 'fixture', data }))
    }
    if (url.pathname === '/same') { response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }); response.end(html); return }
    if (url.pathname.startsWith('/api/') && request.headers['x-aether-instance-token'] !== instanceToken) { send({}, 401); return }
    let raw = ''; for await (const chunk of request) raw += String(chunk)
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    if (url.pathname === '/health') { send({ status: 'ok' }); return }
    if (url.pathname === '/meta') { send({ version: '2.0.0', buildId: `sha256:${'b'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'browser-multitab-remote' }); return }
    if (url.pathname === '/api/v1/browser/clients') {
      client = { clientId: String(body.clientId ?? randomUUID()), clientToken: String(body.clientToken ?? randomUUID()), sessionId: String(body.sessionId) }
      registrations.set(client.clientId, client)
      send({ ...client, pollTimeoutMs: 20000, leaseMs: 65000 }); return
    }
    const clientPath = /^\/api\/v1\/browser\/clients\/([^/]+)(?:\/(commands|results))?$/.exec(url.pathname)
    if (clientPath) {
      const id = decodeURIComponent(clientPath[1]), registration = registrations.get(id)
      if (!registration || request.headers['x-aether-browser-token'] !== registration.clientToken) { send({}, 404); return }
      if (request.method === 'DELETE') {
        registrations.delete(id); released.add(id)
        if (client?.clientId === id) client = undefined
        for (let index = queued.length - 1; index >= 0; index--) if (queued[index].clientId === id) queued.splice(index, 1)
        send({ removed: true }); return
      }
      if (clientPath[2] === 'results') { replies.set(String(body.requestId), body as unknown as Reply); send({ accepted: true }); return }
      if (clientPath[2] === 'commands') {
        const finish = (): void => {
          if (response.destroyed) return
          const index = registrations.has(id) ? queued.findIndex(item => item.clientId === id) : -1
          send({ commands: index < 0 ? [] : [queued.splice(index, 1)[0].command] })
        }
        if (queued.some(item => item.clientId === id)) finish()
        else setTimeout(finish, 100)
        return
      }
    }
    if (url.pathname === '/api/v1/chat/snapshot') { send({ schemaVersion: 1, sessionId: url.searchParams.get('sessionId'), source: 'persisted', finished: true, eventId: null, projection: [], runs: [], history: [], todos: [], changes: [], commandJobs: [] }); return }
    if (url.pathname === '/api/v1/workspace/bind') { send({ workspaceRoot: '/remote/project' }); return }
    if (url.pathname === '/api/v1/workspace/directory') { send({ root: '/remote/project', entries: [] }); return }
    send([])
  })().catch(error => { if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})

function enqueue(action: BrowserToolRequest['action'], args: object = {}, options: { expiresAt?: number; sessionId?: string } = {}): string {
  if (!client) throw new Error('Fixture browser client is not registered')
  const requestId = randomUUID()
  queued.push({ clientId: client.clientId, command: { requestId, sessionId: options.sessionId ?? client.sessionId, action, args, expiresAt: options.expiresAt ?? Date.now() + 30000 } })
  return requestId
}
async function replyFor(requestId: string): Promise<Reply> {
  await expect.poll(() => replies.has(requestId), { message: `Waiting for browser result ${requestId}`, timeout: 15000 }).toBe(true)
  return replies.get(requestId)!
}
async function result(action: BrowserToolRequest['action'], args: object): Promise<unknown> {
  const reply = await replyFor(enqueue(action, args))
  expect(reply.success, reply.error ?? reply.output).toBe(true)
  return JSON.parse(reply.output)
}
async function probe(tab: OwnedTab): Promise<Probe> {
  return app!.evaluate(({ webContents }, id) => {
    const guest = webContents.fromId(id)
    if (!guest) throw new Error('Owned fixture tab disappeared')
    return guest.executeJavaScript('({...window.__multitab,value:document.querySelector("#name").value,scrollY})')
  }, tab.webContentsId)
}
async function openSamePage(): Promise<OwnedTab> {
  const before = await app!.evaluate(({ webContents }) => webContents.getAllWebContents().map(wc => wc.id))
  const tab = await result('open', { url: `${origin}/same` }) as BrowserTabState
  const newGuests = (): Promise<number[]> => app!.evaluate(({ webContents }, { before, url }) =>
    webContents.getAllWebContents().filter(wc => !before.includes(wc.id) && wc.getURL() === url).map(wc => wc.id), { before, url: `${origin}/same` })
  await expect.poll(newGuests).toHaveLength(1)
  const webContentsId = (await newGuests())[0]
  const token = await app!.evaluate(({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('window.__multitab.token'), webContentsId) as string
  const owned = { tab, webContentsId, token }
  ownedTabs.set(tab.tabId, owned)
  return owned
}
async function visibleIds(): Promise<number[]> {
  return app!.evaluate(({ BrowserWindow, WebContentsView }, ids) => BrowserWindow.getAllWindows()[0].contentView.children
    .filter(view => view instanceof WebContentsView && ids.includes(view.webContents.id) && view.getVisible())
    .map(view => (view as InstanceType<typeof WebContentsView>).webContents.id), [...ownedTabs.values()].map(tab => tab.webContentsId))
}
async function expectActive(tab: OwnedTab): Promise<void> {
  const tabs = await page.evaluate(() => window.aether.browser.list())
  const index = tabs.findIndex(item => item.tabId === tab.tab.tabId)
  expect(index).toBeGreaterThanOrEqual(0)
  await expect(page.getByRole('tablist', { name: '网页标签', exact: true }).getByRole('tab').nth(index)).toHaveAttribute('aria-selected', 'true')
  await expect.poll(visibleIds).toEqual([tab.webContentsId])
}
async function select(tab: OwnedTab): Promise<void> {
  const tabs = await page.evaluate(() => window.aether.browser.list())
  const index = tabs.findIndex(item => item.tabId === tab.tab.tabId)
  expect(index).toBeGreaterThanOrEqual(0)
  await page.getByRole('tablist', { name: '网页标签', exact: true }).getByRole('tab').nth(index).click()
  await expectActive(tab)
}
async function snapshot(tab: OwnedTab): Promise<BrowserSnapshot> {
  return await result('snapshot', { tabId: tab.tab.tabId }) as BrowserSnapshot
}
const target = (tab: OwnedTab): { tabId: string; navigationId: number } => ({ tabId: tab.tab.tabId, navigationId: tab.tab.navigationId })
async function clickExactly(tab: OwnedTab, other: OwnedTab, locator: object): Promise<BrowserSnapshot> {
  const previous = await probe(tab), untouched = await probe(other)
  const clicked = await result('click', { ...target(tab), ...locator }) as BrowserSnapshot
  await expectActive(tab)
  const actual = await probe(tab)
  expect(actual.token).toBe(tab.token)
  expect(clicked.tab.tabId).toBe(tab.tab.tabId)
  expect(actual.clicks).toHaveLength(previous.clicks.length + 1)
  expect(await probe(other), '相同地址的其他标签不能收到输入或点击').toEqual(untouched)
  const last = actual.clicks[actual.clicks.length - 1]
  expect(last.trusted).toBe(true)
  expect(Math.abs(last.x - clicked.interaction!.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(last.y - clicked.interaction!.y)).toBeLessThanOrEqual(1)
  return clicked
}
async function reveals(): Promise<Array<{ tabId: string; requestId: string }>> {
  return page.evaluate(() => (window as typeof window & Reveals).multitabReveals ?? [])
}
async function blockedClick(tab: OwnedTab): Promise<string> {
  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('.palette')).toBeVisible()
  await expect.poll(visibleIds).toEqual([])
  const before = (await reveals()).length
  const requestId = enqueue('click', { ...target(tab), selector: '#go' })
  await expect.poll(async () => (await reveals()).slice(before).map(event => event.tabId)).toEqual([tab.tab.tabId])
  await expect(page.locator('.palette'), '工具激活不能自行关闭用户的模态界面').toBeVisible()
  expect(await visibleIds()).toEqual([])
  expect(replies.has(requestId), '没有收到真实可见布局回执时不能执行点击').toBe(false)
  return requestId
}
async function reconnect(): Promise<void> {
  await page.evaluate(async sessionId => {
    const expectedEngine = await window.aether.engine.getSnapshot()
    await window.aether.browser.connect({ sessionId, expectedEngine })
  }, sessionId)
  await expect.poll(() => page.evaluate(() => window.aether.browser.getConnection())).toMatchObject({ status: 'connected', sessionId })
}

test.describe.serial('相同地址多标签与浏览器激活保护', () => {
  test.beforeAll(async () => {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address')
    origin = `http://127.0.0.1:${address.port}`
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
    fixture = mkdtempSync(join(root, '.e2e-tmp/browser-multitab-ui-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true, lastSessionId: '' }))
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: instanceToken, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    page = await app.firstWindow()
    page.on('pageerror', error => rendererErrors.push(String(error)))
    await expect.poll(() => page.evaluate(() => window.aether.browser.getConnection())).toMatchObject({ status: 'connected' })
    // An empty remote history creates a new session during bootstrap. Bind the
    // fixture to that actual session rather than a nonexistent saved history ID.
    const connection = await page.evaluate(() => window.aether.browser.getConnection())
    if (!connection.sessionId) throw new Error('Connected browser has no session identity')
    sessionId = connection.sessionId
    await expect.poll(() => client?.sessionId).toBe(sessionId)
    await page.evaluate(() => {
      const owned = window as typeof window & Reveals
      owned.multitabReveals = []
      window.aether.browser.onEvent(event => { if (event.type === 'reveal') owned.multitabReveals!.push({ tabId: event.tabId, requestId: event.requestId }) })
    })
    a = await openSamePage(); b = await openSamePage()
    expect(a.tab.tabId).not.toBe(b.tab.tabId)
    expect(a.webContentsId).not.toBe(b.webContentsId)
    expect(a.token).not.toBe(b.token)
    await expectActive(b)
  })
  test.afterEach(() => expect(rendererErrors).toEqual([]))
  test.afterAll(async () => {
    await app?.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (!fixture) return
    const absolute = resolve(fixture)
    if (dirname(absolute) !== join(root, '.e2e-tmp') || !basename(absolute).startsWith('browser-multitab-ui-')) throw new Error('Unsafe fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  test('同 URL 标签交替 selector、ref、坐标点击准确激活并只触发目标网页一次', async ({}, testInfo) => {
    const listed = (await page.evaluate(() => window.aether.browser.list())).filter(tab => tab.url === `${origin}/same`)
    expect(listed).toHaveLength(2)
    expect(listed.map(tab => tab.title)).toEqual(['相同地址标签', '相同地址标签'])
    const bSnapshot = await snapshot(b)
    const ref = bSnapshot.elements.find(element => element.role === 'button' && element.name === '确认')?.ref
    expect(ref).toBeDefined()
    const clickedA = await clickExactly(a, b, { selector: '#go' })
    await clickExactly(b, a, { ref })
    await clickExactly(a, b, { x: clickedA.interaction!.x, y: clickedA.interaction!.y })
    const events = await reveals()
    expect(events.map(event => event.tabId)).toEqual([a.tab.tabId, b.tab.tabId, a.tab.tabId])
    expect(new Set(events.map(event => event.requestId)).size).toBe(events.length)
    await testInfo.attach('same-url-tab-evidence', { body: JSON.stringify({ a: { ...a, probe: await probe(a) }, b: { ...b, probe: await probe(b) }, reveals: events }), contentType: 'application/json' })
  })

  test('非活动标签的输入、按键和滚动不串页', async () => {
    await select(b)
    const originalB = await probe(b)
    await result('fill', { ...target(a), selector: '#name', text: '甲标签' })
    await expectActive(a)
    expect((await probe(a)).inputs).toEqual([{ value: '甲标签', trusted: true }])
    expect(await probe(b)).toEqual(originalB)
    const filledA = await probe(a)
    await result('fill', { ...target(b), selector: '#name', text: '乙标签' })
    await expectActive(b)
    expect((await probe(b)).inputs).toEqual([{ value: '乙标签', trusted: true }])
    expect(await probe(a)).toEqual(filledA)
    await result('press_key', { ...target(a), key: 'Enter' })
    await expectActive(a)
    expect((await probe(a)).keys).toEqual([{ key: 'Enter', trusted: true }])
    expect((await probe(b)).keys).toEqual([])
    await result('press_key', { ...target(b), key: 'Enter' })
    await expectActive(b)
    expect((await probe(b)).keys).toEqual([{ key: 'Enter', trusted: true }])
    await result('scroll', { ...target(a), deltaY: 180 })
    await expectActive(a)
    expect((await probe(a)).scrollY).toBeGreaterThan(0)
    expect((await probe(b)).scrollY).toBe(0)
    const scrolledA = await probe(a)
    await result('scroll', { ...target(b), deltaY: 300 })
    await expectActive(b)
    expect((await probe(b)).scrollY).toBeGreaterThan(0)
    expect(await probe(a)).toEqual(scrolledA)
  })

  test('过期、跨会话与旧导航请求明确失败，不激活或操作其他标签', async () => {
    const beforeA = await probe(a), beforeB = await probe(b), beforeReveals = await reveals()
    const ids = [
      enqueue('click', { ...target(a), selector: '#go' }, { expiresAt: Date.now() - 1000 }),
      enqueue('click', { ...target(a), selector: '#go' }, { sessionId: 'another-session' }),
      enqueue('click', { ...target(a), navigationId: a.tab.navigationId + 100, selector: '#go' })
    ]
    for (const id of ids) {
      const reply = await replyFor(id)
      expect(reply.success).toBe(false)
      expect(reply.error).toMatch(/过期|会话|页面已经变化/)
    }
    expect(await probe(a)).toEqual(beforeA); expect(await probe(b)).toEqual(beforeB)
    expect(await reveals()).toEqual(beforeReveals)
    await expectActive(b)
  })

  test('模态面板阻挡时等待，关闭面板后才向目标标签派发一次点击', async () => {
    const beforeA = await probe(a), beforeB = await probe(b)
    const requestId = await blockedClick(a)
    expect(await probe(a)).toEqual(beforeA); expect(await probe(b)).toEqual(beforeB)
    await page.keyboard.press('Escape')
    expect(await replyFor(requestId)).toMatchObject({ success: true })
    await expectActive(a)
    expect((await probe(a)).clicks).toHaveLength(beforeA.clicks.length + 1)
    expect((await probe(a)).clicks.at(-1)?.trusted).toBe(true)
    expect(await probe(b)).toEqual(beforeB)
  })

  for (const cancellation of ['关闭标签', '断开连接', '关闭 AI'] as const) {
    test(`激活等待期间${cancellation}后不补发旧点击，后续合法操作仍能恢复`, async () => {
      const victim = await openSamePage()
      await select(b)
      const beforeB = await probe(b), beforeVictim = await probe(victim)
      const oldClientId = client!.clientId
      const requestId = await blockedClick(victim)
      try {
        if (cancellation === '关闭标签') {
          await page.evaluate(id => window.aether.browser.close(id), victim.tab.tabId)
          const failure = await replyFor(requestId)
          expect(failure.success).toBe(false)
          expect(failure.error).toContain('标签已关闭')
        } else {
          if (cancellation === '断开连接') await page.evaluate(() => window.aether.browser.disconnect())
          else await page.evaluate(() => window.aether.browser.updateSettings({ aiEnabled: false }))
          await expect.poll(() => page.evaluate(() => window.aether.browser.getConnection())).toMatchObject({ status: 'disconnected' })
          await expect.poll(() => released.has(oldClientId)).toBe(true)
        }
        await page.keyboard.press('Escape')
        if (cancellation === '关闭标签') {
          expect(await app!.evaluate(({ webContents }, id) => !!webContents.fromId(id), victim.webContentsId)).toBe(false)
          expect(await probe(b)).toEqual(beforeB)
          await clickExactly(b, a, { selector: '#go' })
        } else {
          if (cancellation === '关闭 AI') await page.evaluate(() => window.aether.browser.updateSettings({ aiEnabled: true }))
          await reconnect()
          // The new snapshot runs behind the cancelled action in this tab's queue.
          // Completing it proves the old wait ended, without a fixed sleep.
          await snapshot(victim)
          expect(await probe(victim)).toEqual(beforeVictim)
          expect(await probe(b)).toEqual(beforeB)
          expect(replies.has(requestId), '失效连接不能把迟到结果提交到新连接').toBe(false)
          await clickExactly(victim, b, { selector: '#go' })
        }
      } finally {
        if (await page.locator('.palette').isVisible()) await page.keyboard.press('Escape')
        await page.evaluate(() => window.aether.browser.updateSettings({ aiEnabled: true }))
        await reconnect()
        const tabs = await page.evaluate(() => window.aether.browser.list())
        if (tabs.some(tab => tab.tabId === victim.tab.tabId)) await page.evaluate(id => window.aether.browser.close(id), victim.tab.tabId)
        ownedTabs.delete(victim.tab.tabId)
        await select(b)
      }
    })
  }
})
