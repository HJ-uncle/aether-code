/** Real Electron + authenticated remote browser queue: manually opened pages,
 * current-session discovery, explicit chat attachment, and target-safe tab menus. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AetherIdeApi } from '../src/preload'
import type { BrowserSnapshot, BrowserTabState, BrowserToolRequest } from '../src/shared/browser'
import type { RootRun } from '../src/shared/root-run'
import { parseMentionContent } from '../src/renderer/src/contrib/chat/mention-context'
import { monitorElectronHealth } from './helpers/electron-health'

declare global { interface Window { aether: AetherIdeApi } }

const root = resolve(__dirname, '..')
const instanceToken = 'browser-session-fixture-token'
const initialSessionId = 'browser-session-code-initial'
type Registration = { clientId: string; clientToken: string; sessionId: string }
type Command = { requestId: string; sessionId: string; action: BrowserToolRequest['action']; args: object; expiresAt: number }
type Reply = { success: boolean; output: string; error?: string; metadata?: { code: string; operationPerformed: boolean | 'unknown' } }
type Guest = { tab: BrowserTabState; webContentsId: number; token: string }
let fixture = '', origin = '', sessionId = ''
let app: ElectronApplication | undefined, page: Page
let health: Awaited<ReturnType<typeof monitorElectronHealth>> | undefined
let client: Registration | undefined, original: Guest
const registrations = new Map<string, Registration>()
const queue: Array<{ clientId: string; command: Command }> = []
const replies = new Map<string, Reply>()
const chatRequests: Record<string, unknown>[] = []
const chatTurns = new Map<string, { run: RootRun; prompt: string }>()
const admissionReceipts = new Map<string, { admission: Record<string, unknown>; run: RootRun }>()
const chatAnswer = '已收到浏览器引用。'
const chatHistory = (sessionId: string) => {
  const turn = chatTurns.get(sessionId)
  return turn ? [
    { id: turn.run.userMessageId, role: 'user', content: turn.prompt, conversationId: turn.run.turnId, createdAt: turn.run.createdAt, metadata: { rootRunId: turn.run.runId } },
    { id: turn.run.assistantMessageId, role: 'assistant', content: chatAnswer, conversationId: turn.run.turnId, createdAt: turn.run.updatedAt, metadata: { rootRunId: turn.run.runId } }
  ] : []
}
const fileReads: string[] = []
const pageErrors: string[] = []
const html = (name: string): string => `<!doctype html><html lang="zh"><meta charset="utf-8"><title>会话网页 ${name}</title>
<style>body{font:18px sans-serif;padding:24px}input,button{font:inherit;padding:8px}</style><h1>会话网页 ${name}</h1><label>名称<input id="name" value="未修改"></label><button id="confirm">确认</button><p id="result">尚未操作</p>
<script>window.__browserSession={token:crypto.randomUUID(),clicks:0,trusted:false};document.querySelector('#confirm').addEventListener('click',event=>{window.__browserSession.clicks++;window.__browserSession.trusted=event.isTrusted;document.querySelector('#result').textContent='已处理：'+document.querySelector('#name').value});</script></html>`
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid')
    const send = (data: unknown, status = 200): void => {
      response.writeHead(status, { 'content-type': 'application/json;charset=utf-8' })
      response.end(JSON.stringify({ code: status, message: 'fixture', data }))
    }
    if (url.pathname.startsWith('/page/')) {
      response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }).end(html(decodeURIComponent(url.pathname.slice('/page/'.length))))
      return
    }
    if (url.pathname.startsWith('/api/') && request.headers['x-aether-instance-token'] !== instanceToken) { send({}, 401); return }
    let raw = ''; for await (const chunk of request) raw += String(chunk)
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    const requestedSession = String(body.sessionId ?? url.searchParams.get('sessionId') ?? '')
    if (url.pathname === '/health') { send({ status: 'ok' }); return }
    if (url.pathname === '/meta') { send({ version: '2.0.0', buildId: `sha256:${'c'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code', 'general'], subagentSchemaVersion: 1, instanceId: 'browser-session-remote' }); return }
    if (url.pathname === '/api/v1/browser/clients') {
      client = { clientId: String(body.clientId ?? randomUUID()), clientToken: String(body.clientToken ?? randomUUID()), sessionId: String(body.sessionId) }
      registrations.set(client.clientId, client)
      send({ ...client, pollTimeoutMs: 20000, leaseMs: 65000, capabilities: { resultMetadata: 1 } }); return
    }
    const clientPath = /^\/api\/v1\/browser\/clients\/([^/]+)(?:\/(commands|results))?$/.exec(url.pathname)
    if (clientPath) {
      const id = decodeURIComponent(clientPath[1]), registration = registrations.get(id)
      if (!registration || request.headers['x-aether-browser-token'] !== registration.clientToken) { send({}, 404); return }
      if (request.method === 'DELETE') {
        registrations.delete(id)
        if (client?.clientId === id) client = undefined
        for (let index = queue.length - 1; index >= 0; index--) if (queue[index].clientId === id) queue.splice(index, 1)
        send({ removed: true }); return
      }
      if (clientPath[2] === 'results') { replies.set(String(body.requestId), body as unknown as Reply); send({ accepted: true }); return }
      if (clientPath[2] === 'commands') {
        const finish = (): void => {
          if (response.destroyed) return
          const index = registrations.has(id) ? queue.findIndex(item => item.clientId === id) : -1
          send({ commands: index < 0 ? [] : [queue.splice(index, 1)[0].command] })
        }
        if (queue.some(item => item.clientId === id)) finish()
        else setTimeout(finish, 100)
        return
      }
    }
    if (url.pathname === '/api/v1/chat' && request.method === 'POST') {
      chatRequests.push(body)
      const now = Date.now(), id = randomUUID()
      const running: RootRun = { schemaVersion: 1, runId: `browser-run-${id}`, sessionId: requestedSession,
        turnId: `browser-turn-${id}`, userMessageId: `browser-user-${id}`, assistantMessageId: `browser-answer-${id}`,
        status: 'running', seq: 1, version: 1, modelId: 'browser-session-model', pending: [],
        workspacePaths: ['/remote/browser-session'], createdAt: now, updatedAt: now }
      const run: RootRun = { ...running, status: 'succeeded', seq: 4, version: 2, updatedAt: now + 1, finishedAt: now + 1 }
      chatTurns.set(requestedSession, { run, prompt: String(body.message) })
      if (body.admission && typeof body.admission === 'object' && !Array.isArray(body.admission)) {
        const admission = body.admission as Record<string, unknown>
        if (admission.protocolVersion !== 1 || admission.owner !== 'code' || typeof admission.requestKey !== 'string') throw new Error('Invalid Code browser fixture admission')
        admissionReceipts.set(admission.requestKey, { admission, run })
      }
      // A content frame is not proof of admission. The production composer
      // releases its authored draft only for a new validated root on this SSE.
      const frames = [{ run: running }, { userMessage: chatHistory(requestedSession)[0] }, { content: chatAnswer }, { run }]
      response.writeHead(200, { 'content-type': 'text/event-stream;charset=utf-8' }).end(
        frames.map((payload, index) => `id: ${run.runId}:${index + 1}\ndata: ${JSON.stringify(payload)}\n\n`).join('') + 'data: [DONE]\n\n')
      return
    }
    if (url.pathname === '/api/v1/chat/snapshot') {
      const turn = chatTurns.get(requestedSession)
      send({ schemaVersion: 1, sessionId: requestedSession, source: 'persisted', finished: true,
        eventId: turn ? `${turn.run.runId}:4` : null, projection: [], runs: turn ? [turn.run] : [],
        ...(turn ? { run: turn.run } : {}), history: chatHistory(requestedSession), todos: [], changes: [], commandJobs: [] }); return
    }
    if (url.pathname === '/api/v1/conversation/history') { send(chatHistory(requestedSession)); return }
    // The current client resolves the subagent protocol before accepting a
    // history snapshot. An HTTP 200 [] here means malformed protocol, not an
    // empty session; keep this fixture on the real negotiated contract.
    if (url.pathname === '/api/v1/subagent/capabilities') { send({ schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }); return }
    if (url.pathname === '/api/v1/subagent/runs') { send({ schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'fixture' }); return }
    if (url.pathname === '/api/v1/chat/status') { send({ running: false, finished: true, run: chatTurns.get(requestedSession)?.run }); return }
    if (url.pathname === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
    if (url.pathname === '/api/v1/chat/admission/context') {
      const run = chatTurns.get(requestedSession)?.run, root = run ? { ...run, attemptId: `attempt-${run.runId}` } : null
      send({ protocolVersion: 1, tenantId: 'fixture', sessionId: requestedSession,
        namespace: { id: 'browser-session', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'general' ? 'general' : 'code', runLifetime: 'durable', subagentProtocol: 2 },
        root, predecessor: root ? { runId: root.runId, attemptId: root.attemptId, version: root.version } : null }); return
    }
    if (url.pathname === '/api/v1/chat/admission/receipt') {
      const accepted = admissionReceipts.get(String(body.requestKey)), run = accepted?.run.sessionId === requestedSession ? accepted.run : undefined
      send(accepted && run ? { protocolVersion: 1, status: 'accepted', receipt: { ...accepted.admission, sessionId: requestedSession,
        rootRunId: run.runId, turnId: run.turnId, userMessageId: run.userMessageId, assistantMessageId: run.assistantMessageId },
        run, projection: { rootVersion: run.version, rootAttemptId: `attempt-${run.runId}`,
          user: { messageId: run.userMessageId, state: 'projected' }, assistant: { anchorMessageId: run.assistantMessageId, state: 'persisted', messageId: run.assistantMessageId } } }
        : { protocolVersion: 1, status: 'absent', namespace: body.namespace, sessionId: requestedSession, requestKey: body.requestKey }); return
    }
    if (url.pathname === '/api/v1/security/mode') { send({ sessionId: requestedSession, mode: 'standard' }); return }
    if (url.pathname === '/api/v1/workbench/clients' || url.pathname === '/api/v1/cron/capabilities') { send({}, 404); return }
    if (url.pathname === '/api/v1/chat/runs') { const turn = chatTurns.get(requestedSession); send({ runs: turn ? [turn.run] : [] }); return }
    if (url.pathname === '/api/v1/workspace/file' && request.method === 'GET') { fileReads.push(url.searchParams.get('path') ?? ''); send({ content: 'UNEXPECTED_FILE_REFERENCE', encoding: 'utf8' }); return }
    if (url.pathname === '/api/v1/models') { send([{ id: 'browser-session-model', modelId: 'browser-session-model', displayName: '浏览器会话测试', provider: 'openai', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 128000 } }]); return }
    if (url.pathname === '/api/v1/workspace/bind') { send({ workspaceRoot: '/remote/browser-session' }); return }
    if (url.pathname === '/api/v1/workspace/directory') { send({ root: '/remote/browser-session', entries: [] }); return }
    send([])
  })().catch(error => { if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})

async function tabs(): Promise<BrowserTabState[]> { return page.evaluate(() => window.aether.browser.list()) }
async function tabButton(tabId: string): Promise<Locator> {
  const index = (await tabs()).findIndex(tab => tab.tabId === tabId)
  expect(index, '目标浏览器标签必须仍然存在').toBeGreaterThanOrEqual(0)
  return page.locator(`.browser-view:visible .browser-tab[data-browser-tab-id="${tabId}"]`).getByRole('tab')
}
async function menuOn(tabId: string, keyboard = false): Promise<void> {
  const button = await tabButton(tabId)
  if (keyboard) { await button.focus(); await button.press('Shift+F10') }
  else await button.click({ button: 'right' })
  await expect(page.getByRole('menu')).toBeVisible()
}
async function choose(label: string): Promise<void> {
  await page.getByRole('menuitem', { name: new RegExp(`^${label}(?:\\s|$)`) }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
}
async function command(action: BrowserToolRequest['action'], args: object = {}): Promise<Reply> {
  if (!client) throw new Error('Fixture browser client is not registered')
  const requestId = randomUUID()
  queue.push({ clientId: client.clientId, command: { requestId, sessionId: client.sessionId, action, args, expiresAt: Date.now() + 30000 } })
  await expect.poll(() => replies.has(requestId), { timeout: 15000 }).toBe(true)
  return replies.get(requestId)!
}
async function result<T>(action: BrowserToolRequest['action'], args: object = {}): Promise<T> {
  const reply = await command(action, args)
  expect(reply.success, reply.error ?? reply.output).toBe(true)
  return JSON.parse(reply.output) as T
}
async function guest(tab: BrowserTabState): Promise<Guest> {
  const guests = await app!.evaluate(({ webContents }, url) => webContents.getAllWebContents().filter(wc => wc.getURL() === url).map(wc => wc.id), tab.url)
  expect(guests, `应只有一张 ${tab.url} 页面`).toHaveLength(1)
  const webContentsId = guests[0]
  const token = await app!.evaluate(({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('window.__browserSession.token'), webContentsId) as string
  return { tab, webContentsId, token }
}
async function probe(target: Guest): Promise<{ token: string; clicks: number; trusted: boolean; value: string }> {
  return app!.evaluate(({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('({...window.__browserSession,value:document.querySelector("#name").value})'), target.webContentsId)
}
async function openPage(name: string): Promise<Guest> {
  const browser = page.locator('.browser-view:visible')
  await browser.getByRole('button', { name: '新建网页标签（Ctrl+T）', exact: true }).click()
  await browser.getByLabel('网页地址', { exact: true }).fill(`${origin}/page/${name}`)
  await browser.getByLabel('网页地址', { exact: true }).press('Enter')
  await expect.poll(tabs).toContainEqual(expect.objectContaining({ url: `${origin}/page/${name}`, title: `会话网页 ${name}`, loading: false }))
  return guest((await tabs()).find(tab => tab.url === `${origin}/page/${name}`)!)
}
async function expectDestroyed(target: Guest): Promise<void> {
  await expect.poll(tabs).not.toContainEqual(expect.objectContaining({ tabId: target.tab.tabId }))
  await expect.poll(() => app!.evaluate(({ webContents }, id) => !webContents.fromId(id), target.webContentsId)).toBe(true)
}

test.describe.serial('手动浏览器标签的会话可见性与右键菜单', () => {
  test.beforeAll(async () => {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address')
    origin = `http://127.0.0.1:${address.port}`
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
    fixture = mkdtempSync(join(root, '.e2e-tmp/browser-session-ui-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: false, lastSessionId: initialSessionId, lastFolder: '' }))
    const env: NodeJS.ProcessEnv = { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: instanceToken, AETHER_GLOBAL_DIR: join(fixture, 'global') }
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root, env })
    await app.evaluate(({ clipboard }) => {
      // Keep the user's clipboard in the main process; no clipboard contents
      // belong in Playwright results, traces, or failed assertion messages.
      const owned = globalThis as typeof globalThis & { browserSessionClipboard?: Electron.Data }
      const image = clipboard.readImage(), bookmark = clipboard.readBookmark()
      owned.browserSessionClipboard = {
        text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(),
        ...(!image.isEmpty() ? { image } : {}), ...(bookmark.title ? { bookmark: bookmark.title } : {})
      }
    })
    health = await monitorElectronHealth(app, 'browser-session', [instanceToken])
    page = await app.firstWindow()
    page.on('pageerror', error => pageErrors.push(String(error)))
    await expect(page.locator('.status-bar')).toBeVisible()
    // A pending page belongs to the selected conversation even before engine
    // startup. The endpoint-local selection must restore that same identity;
    // inventing a new session would correctly leave the old page isolated.
    await page.evaluate(({ origin, id }) => {
      localStorage.setItem(`aether:lastSessionId:${encodeURIComponent(`remote:${origin}`)}`, id)
    }, { origin, id: initialSessionId })
    await page.keyboard.press('Control+Alt+b')
    await page.getByLabel('网页地址', { exact: true }).fill(`${origin}/page/original`)
    await page.getByLabel('网页地址', { exact: true }).press('Enter')
    await expect.poll(tabs).toContainEqual(expect.objectContaining({ title: '会话网页 original', loading: false }))
    original = await guest((await tabs()).find(tab => tab.url === `${origin}/page/original`)!)

    // Opening the page before engine startup reproduces the missing-tab bug:
    // a later connection must adopt this same page without a second navigation.
    expect(original.tab.context).toBeUndefined()
    expect(original.tab.presentation).toMatchObject({ mode: 'code', sessionId: initialSessionId })
    await expect.poll(() => page.evaluate(() => window.aether.browser.getConnection())).toMatchObject({ status: 'disconnected' })
    const started = await page.evaluate(() => window.aether.engine.start())
    expect(started.phase, started.error ?? '').toBe('ready')
    await expect.poll(() => page.evaluate(() => window.aether.browser.getConnection())).toMatchObject({ status: 'connected' })
    const connected = await page.evaluate(() => window.aether.browser.getConnection())
    sessionId = connected.sessionId ?? ''
    expect(sessionId).toBe(initialSessionId)
    await expect.poll(() => client?.sessionId).toBe(sessionId)
    await expect(page.getByTitle('新建会话（开一条全新对话）', { exact: true })).toBeEnabled()
  })
  test.afterEach(() => { expect(pageErrors).toEqual([]); health?.assertHealthy() })
  test.afterAll(async ({}, testInfo) => {
    try {
      try {
        await app?.evaluate(({ clipboard }) => {
          const owned = globalThis as typeof globalThis & { browserSessionClipboard?: Electron.Data }
          if (owned.browserSessionClipboard) clipboard.write(owned.browserSessionClipboard)
          delete owned.browserSessionClipboard
        })
      } finally {
        if (health) await health.closeAndAssert(testInfo)
        else await app?.close()
      }
    } finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        if (dirname(resolve(fixture)) !== join(root, '.e2e-tmp') || !basename(fixture).startsWith('browser-session-ui-')) throw new Error('Unsafe browser session fixture cleanup')
        rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('用户先打开再连接引擎，同一标签自动出现在 AI 列表且保留页面状态', async () => {
    const before = await probe(original)
    const visible = await result<BrowserTabState[]>('tabs')
    expect(visible.map(tab => tab.tabId)).toEqual([original.tab.tabId])
    expect(visible[0].context?.sessionId).toBe(sessionId)
    const snapshot = await result<BrowserSnapshot>('snapshot', { tabId: original.tab.tabId })
    expect(snapshot.tab.tabId).toBe(original.tab.tabId)
    expect(snapshot.text).toContain(original.tab.title)
    const observation = await command('tabs')
    expect(observation.metadata).toEqual({ code: 'BROWSER_OBSERVATION_COMPLETE', operationPerformed: false })
    expect(snapshot.tab.availability).toMatchObject({ window: 'visible', initialization: 'ready' })
    expect(await probe(original)).toEqual(before)
  })

  test('会话切换不会偷偷迁移标签，过期添加请求不能污染新会话', async () => {
    const oldContext = (await tabs()).find(tab => tab.tabId === original.tab.tabId)!.context!
    const before = await probe(original)
    const oldSession = sessionId
    await page.getByTitle('新建会话（开一条全新对话）', { exact: true }).click()
    await expect.poll(async () => {
      const state = await page.evaluate(() => window.aether.browser.getConnection())
      return state.status === 'connected' && Boolean(state.sessionId) && state.sessionId !== oldSession
    }).toBe(true)
    const nextSession = (await page.evaluate(() => window.aether.browser.getConnection())).sessionId!
    expect(nextSession).not.toBe(oldSession)
    await expect.poll(() => client?.sessionId).toBe(nextSession)
    const isolated = await result<BrowserTabState[]>('tabs')
    expect(isolated.some(tab => tab.tabId === original.tab.tabId)).toBe(false)
    const rejected = await command('snapshot', { tabId: original.tab.tabId, navigationId: original.tab.navigationId })
    expect(rejected.success).toBe(false)
    expect(rejected.metadata).toEqual({ code: 'BROWSER_OPERATION_NOT_PERFORMED', operationPerformed: false })
    expect(JSON.parse(rejected.output)).toBeNull()
    expect(rejected.error).toMatch(/尚未添加到当前会话|其他会话|会话/)
    const stale = await page.evaluate(async ({ tabId, oldContext }) => {
      try { await window.aether.browser.share(tabId, oldContext); return '' }
      catch (error) { return String(error) }
    }, { tabId: original.tab.tabId, oldContext })
    expect(stale).toMatch(/会话|变化/)
    expect((await tabs()).find(tab => tab.tabId === original.tab.tabId)?.context).toEqual(oldContext)
    expect((await result<BrowserTabState[]>('tabs')).map(tab => tab.tabId)).not.toContain(original.tab.tabId)
    await expect(page.locator(`.browser-view:visible .browser-tab[data-browser-tab-id="${original.tab.tabId}"]`)).toHaveCount(0)
    expect(await probe(original)).toEqual(before)
    sessionId = nextSession
    // The remaining menu tests operate on a page owned by the new session.
    // Retire the old native fixture only after proving its context and DOM
    // survived the switch; the UI must never expose a foreign session's tab.
    await page.evaluate(id => window.aether.browser.close(id), original.tab.tabId)
    await expectDestroyed(original)
    original = await openPage('original-current')
    expect(original.tab.context?.sessionId).toBe(sessionId)
  })

  test('右键添加把原网页和准确标签引用交给当前会话，不重开网页也不自动发送', async ({}, testInfo) => {
    const before = await probe(original), beforeChatRequests = chatRequests.length
    const hideChat = page.getByRole('button', { name: '关闭对话面板', exact: true })
    if (await hideChat.isVisible()) await hideChat.click()
    await menuOn(original.tab.tabId, true)
    await expect(page.getByRole('menuitem', { name: '新建标签页', exact: true })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('menuitem', { name: '复制标签页', exact: true })).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(page.getByRole('menuitem', { name: '新建标签页', exact: true })).toBeFocused()
    await page.keyboard.press('End')
    await expect(page.getByRole('menuitem', { name: '关闭全部标签页', exact: true })).toBeFocused()
    await page.keyboard.press('Home')
    await expect(page.getByRole('menuitem', { name: '新建标签页', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(await tabButton(original.tab.tabId)).toBeFocused()
    await menuOn(original.tab.tabId)
    const screenshot = testInfo.outputPath('browser-tab-context-menu.png')
    await page.screenshot({ path: screenshot })
    await testInfo.attach('browser-tab-context-menu', { path: screenshot, contentType: 'image/png' })
    await expect(page.getByRole('menuitem', { name: /^添加到当前会话/ })).toBeVisible()
    await choose('添加到当前会话')
    await expect(page.locator('.mention-input')).toBeVisible()
    await expect(page.locator('.mention-input .mention-chip--browser')).toContainText(original.tab.title)
    const visible = await result<BrowserTabState[]>('tabs')
    expect(visible.map(tab => tab.tabId)).toEqual([original.tab.tabId])
    expect(visible[0].context?.sessionId).toBe(sessionId)
    const snapshot = await result<BrowserSnapshot>('snapshot', { tabId: original.tab.tabId })
    expect(snapshot.tab.tabId).toBe(original.tab.tabId)
    expect(snapshot.text).toContain(original.tab.title)
    expect(await probe(original)).toEqual(before)
    expect(chatRequests).toHaveLength(beforeChatRequests)

    await result('fill', { tabId: original.tab.tabId, navigationId: snapshot.tab.navigationId, selector: '#name', text: '已授权会话' })
    await result('click', { tabId: original.tab.tabId, navigationId: snapshot.tab.navigationId, selector: '#confirm' })
    expect(await probe(original)).toEqual({ ...before, value: '已授权会话', clicks: before.clicks + 1, trusted: true })
  })

  test('发送浏览器引用包含准确标签和会话身份，不当成文件读取', async () => {
    const readCount = fileReads.length, chatCount = chatRequests.length
    const input = page.locator('.mention-input')
    await input.click()
    await input.press('End')
    await page.keyboard.insertText(' 请读取这个标签的任务列表。')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => chatRequests.length).toBe(chatCount + 1)
    const sent = chatRequests.at(-1)!
    expect(sent.sessionId).toBe(sessionId)
    const message = String(sent.message)
    expect(message).toContain('<reference type="browser"')
    const reference = /<reference type="browser"[^>]*>\n`{3,}(?:json)?\n([\s\S]*?)\n`{3,}\n<\/reference>/.exec(message)
    expect(reference).not.toBeNull()
    const context = (await tabs()).find(tab => tab.tabId === original.tab.tabId)!.context!
    expect(JSON.parse(reference![1])).toMatchObject({ tabId: original.tab.tabId, url: original.tab.url, title: original.tab.title, ...context })
    expect(parseMentionContent(message).refs).toContainEqual(expect.objectContaining({ t: 'browser' }))
    expect(fileReads.slice(readCount)).toEqual([])
    await expect(input.locator('.mention-chip--browser')).toHaveCount(0)
  })

  test('标签右键菜单可关闭目标标签，且不影响另一张页面', async () => {
    const other = await openPage('other')
    await (await tabButton(original.tab.tabId)).click()
    const before = await probe(original)
    await menuOn(other.tab.tabId)
    await expect(page.getByRole('menuitem', { name: /^关闭标签页/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /^复制网页地址/ })).toBeVisible()
    await expect(await tabButton(other.tab.tabId)).toHaveAttribute('aria-selected', 'true')
    await choose('关闭标签页')
    await expectDestroyed(other)
    expect(await probe(original)).toEqual(before)
    await expect(await tabButton(original.tab.tabId)).toHaveAttribute('aria-selected', 'true')
  })

  test('菜单复制与刷新作用于右击目标；复制页面创建独立实例并沿用会话', async () => {
    const target = await openPage('menu-target')
    await (await tabButton(original.tab.tabId)).click()
    const beforeOriginal = await probe(original)
    await menuOn(target.tab.tabId)
    const reopening = await page.evaluate(async tabId => {
      const selector = '.browser-tab-menu-host .context-menu'
      const old = document.querySelector<HTMLElement>(selector)
      const button = document.querySelector<HTMLElement>(`.browser-view .browser-tab[data-browser-tab-id="${tabId}"] [role="tab"]`)
      if (!old || !button) throw new Error('Missing menu or target for rapid reopen')
      const bounds = button.getBoundingClientRect(), started = performance.now()
      return await new Promise<{ closingInert: boolean; reopened: boolean; survived: boolean }>(resolve => {
        let closingInert = false, reopened = false
        const observer = new MutationObserver(() => {
          if (reopened || old.dataset.motionState !== 'closing') return
          closingInert = old.inert && old.getAttribute('aria-hidden') === 'true'
          reopened = true
          // Reinvoke at the identical pointer coordinates during the first
          // closing frame, without waiting for the 120 ms exit to finish.
          button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2,
            clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2 }))
        })
        observer.observe(old, { attributes: true, attributeFilter: ['data-motion-state', 'inert', 'aria-hidden'] })
        const tick = (): void => {
          const current = document.querySelector<HTMLElement>(selector)
          if (performance.now() - started >= 260) {
            observer.disconnect()
            resolve({ closingInert, reopened, survived: Boolean(current && current !== old && current.dataset.motionState === 'open' && !current.inert) })
          } else requestAnimationFrame(tick)
        }
        old.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        requestAnimationFrame(tick)
      })
    }, target.tab.tabId)
    expect(reopening).toEqual({ closingInert: true, reopened: true, survived: true })
    await expect(page.getByRole('menuitem', { name: '新建标签页', exact: true })).toBeFocused()
    await choose('复制网页地址')
    await expect(page.getByText('网页地址已复制', { exact: true })).toBeVisible()
    await expect.poll(() => app!.evaluate(({ clipboard }, expected) => clipboard.readText() === expected, target.tab.url), { message: '复制网页地址应在写入完成后更新系统剪贴板' }).toBe(true)
    await expect(await tabButton(target.tab.tabId)).toHaveAttribute('aria-selected', 'true')

    await menuOn(target.tab.tabId)
    await choose('重新加载')
    await expect.poll(() => app!.evaluate(({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('window.__browserSession?.token ?? null'), target.webContentsId)).toEqual(expect.any(String))
    await expect.poll(() => probe(target).then(value => value.token).catch(() => target.token)).not.toBe(target.token)
    expect(await probe(original)).toEqual(beforeOriginal)
    await expect(await tabButton(target.tab.tabId)).toHaveAttribute('aria-selected', 'true')
    const beforeIds = (await tabs()).map(tab => tab.tabId)
    await menuOn(target.tab.tabId)
    await choose('复制标签页')
    await expect.poll(() => tabs().then(values => values.filter(tab => !beforeIds.includes(tab.tabId) && tab.url === target.tab.url && !tab.loading))).toHaveLength(1)
    const duplicate = (await tabs()).find(tab => !beforeIds.includes(tab.tabId))!
    expect(duplicate.tabId).not.toBe(target.tab.tabId)
    expect(duplicate.context).toEqual(target.tab.context)
    await expect(await tabButton(duplicate.tabId)).toHaveAttribute('aria-selected', 'true')
    const matchingGuests = await app!.evaluate(({ webContents }, url) => webContents.getAllWebContents().filter(wc => wc.getURL() === url).map(wc => wc.id), target.tab.url)
    expect(matchingGuests).toHaveLength(2)
    expect(matchingGuests).toContain(target.webContentsId)
    expect(await probe(original)).toEqual(beforeOriginal)
    await page.evaluate(ids => Promise.all(ids.map(id => window.aether.browser.close(id))), [target.tab.tabId, duplicate.tabId])
    await expectDestroyed(target)
    await expect.poll(() => tabs().then(values => values.map(tab => tab.tabId))).toEqual([original.tab.tabId])
  })

  test('Work 浏览器添加到自己的主页草稿，保留输入且不混入 Code 会话', async () => {
    const chatCount = chatRequests.length
    const codeInput = page.locator('.mode-surface[data-mode="code"] .mention-input')
    await codeInput.fill('Code 草稿保持原样')
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    const work = page.locator('.mode-surface[data-mode="work"]')
    const navigateWork = async (name: '工作台' | '浏览器'): Promise<void> => {
      const button = work.locator('.work-navigation').getByRole('button', { name, exact: true })
      if (!await button.isVisible()) await work.getByRole('button', { name: '展开 Work 导航', exact: true }).click()
      await button.click()
    }
    // Switching from an open Code browser may preserve the browser surface in
    // Work. Enter the actual home page before testing its editable draft.
    await navigateWork('工作台')
    await work.getByRole('textbox', { name: '任务目标', exact: true }).fill('Work 草稿已有要求')
    await navigateWork('浏览器')
    await expect.poll(async () => {
      const connection = await page.evaluate(() => window.aether.browser.getConnection())
      return connection.status === 'connected' && Boolean(connection.sessionId?.startsWith('work-'))
    }).toBe(true)
    const workSessionId = (await page.evaluate(() => window.aether.browser.getConnection())).sessionId!
    expect(workSessionId).not.toBe(sessionId)
    await expect.poll(() => client?.sessionId).toBe(workSessionId)
    expect((await result<BrowserTabState[]>('tabs')).map(tab => tab.tabId)).not.toContain(original.tab.tabId)
    await expect(work.locator(`.browser-tab[data-browser-tab-id="${original.tab.tabId}"]`)).toHaveCount(0)
    const codeBefore = await probe(original)
    const rejected = await command('snapshot', { tabId: original.tab.tabId })
    expect(rejected.success).toBe(false)
    expect(rejected.metadata).toEqual({ code: 'BROWSER_OPERATION_NOT_PERFORMED', operationPerformed: false })
    const workPage = await openPage('work-own')
    expect(workPage.tab.presentation).toMatchObject({ mode: 'work', sessionId: workSessionId })
    const workBefore = await probe(workPage)
    await menuOn(workPage.tab.tabId)
    await choose('添加到当前会话')
    await expect.poll(tabs).toContainEqual(expect.objectContaining({ tabId: workPage.tab.tabId, context: expect.objectContaining({ sessionId: workSessionId }) }))
    await navigateWork('工作台')
    const workInput = work.getByRole('textbox', { name: '任务目标', exact: true })
    await expect(workInput).toContainText('Work 草稿已有要求')
    await expect(workInput.locator('.mention-chip--browser')).toContainText('会话网页 work-own')
    expect(chatRequests).toHaveLength(chatCount)
    expect(await probe(workPage)).toEqual(workBefore)
    expect(await probe(original)).toEqual(codeBefore)

    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    await expect(codeInput).toContainText('Code 草稿保持原样')
    await expect(codeInput.locator('.mention-chip--browser')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.aether.browser.getConnection())).toMatchObject({ status: 'connected', sessionId })
    await expect.poll(() => client?.sessionId).toBe(sessionId)
    expect((await result<BrowserTabState[]>('tabs')).map(tab => tab.tabId)).toEqual([original.tab.tabId])
    await expect(page.locator(`.mode-surface[data-mode="code"] .browser-tab[data-browser-tab-id="${workPage.tab.tabId}"]`)).toHaveCount(0)
    expect((await tabs()).find(tab => tab.tabId === original.tab.tabId)?.context?.sessionId).toBe(sessionId)
    await page.evaluate(id => window.aether.browser.close(id), workPage.tab.tabId)
    await expectDestroyed(workPage)
  })

  test('关闭右侧、其他与全部标签精确保留目标并销毁对应原生页面', async () => {
    const middle = await openPage('middle'), right = await openPage('right')
    await menuOn(middle.tab.tabId)
    await choose('关闭右侧标签页')
    await expectDestroyed(right)
    expect((await tabs()).map(tab => tab.tabId)).toEqual([original.tab.tabId, middle.tab.tabId])
    await expect(await tabButton(middle.tab.tabId)).toHaveAttribute('aria-selected', 'true')
    await menuOn(middle.tab.tabId)
    await expect(page.getByRole('menuitem', { name: /^关闭右侧标签页/ })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)

    await menuOn(original.tab.tabId)
    await choose('关闭其他标签页')
    await expectDestroyed(middle)
    expect((await tabs()).map(tab => tab.tabId)).toEqual([original.tab.tabId])
    await expect(await tabButton(original.tab.tabId)).toHaveAttribute('aria-selected', 'true')
    await menuOn(original.tab.tabId)
    await expect(page.getByRole('menuitem', { name: /^关闭其他标签页/ })).toBeDisabled()
    await choose('关闭全部标签页')
    await expectDestroyed(original)
    expect(await result<BrowserTabState[]>('tabs')).toEqual([])
    await expect(page.getByRole('tablist', { name: '网页标签', exact: true }).getByRole('tab')).toHaveCount(0)
  })
})
