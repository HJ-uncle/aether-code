/** Real Electron + an owned embedded HTTP fixture: a default Work session's
 * private workspace can run HTML with parent assets, without granting Code FS
 * access. Rebinding the session revokes the already-issued preview capability. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AetherIdeApi } from '../src/preload'
import type { BrowserTabState } from '../src/shared/browser'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

declare global { interface Window { aether: AetherIdeApi } }

const root = resolve(__dirname, '..'), fixtureParent = join(root, '.e2e-tmp')
const taskId = 'work-private-html-run', codeSession = 'code-private-html-run', modelId = 'private-html-fixture-model'
const manifest = { version: '2.0.0', buildId: `sha256:${'4'.repeat(64)}`, protocolVersion: 1,
  toolProfiles: ['code', 'general'], subagentSchemaVersion: 1 }
const errors: string[] = []
const reads: Array<{ sessionId: string; path: string; authenticated: boolean }> = []
const bindings: Array<{ sessionId: string; workspaceRoot: unknown }> = []
let app: ElectronApplication | undefined, health: ElectronHealthMonitor | undefined, page: Page
let fixture = '', codeRoot = '', sessionRoot = '', replacementRoot = '', htmlFile = ''
let activeSessionRoot = '', bindingEpoch = 'private-root-one'
let previewTab: BrowserTabState | undefined

function scopedPath(workspace: string, candidate: string): string {
  const result = resolve(workspace, candidate), rel = relative(workspace, result)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Fixture request crossed its session root')
  return result
}

// Only the wire protocol is controlled. Engine ownership, authenticated IPC,
// file-tree clicks, preview permission checks and native rendering remain real.
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    let rawBody = ''
    for await (const chunk of request) rawBody += String(chunk)
    const body: Record<string, unknown> = rawBody ? JSON.parse(rawBody) : {}
    const sessionId = url.searchParams.get('sessionId') || (typeof body.sessionId === 'string' ? body.sessionId : '')
    const workspace = sessionId === taskId ? activeSessionRoot : codeRoot
    const epoch = sessionId === taskId ? bindingEpoch : 'code-root'
    const send = (data: unknown, status = 200): void => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: status, message: status === 200 ? 'ok' : 'Unavailable', data }))
    }
    if (path === '/api/v1/chat') throw new Error('HTML browsing must not invoke a model')
    if (path === '/api/v1/chat/stream' || path === '/api/v1/workspace/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return
    }
    if (path === '/api/v1/conversation/display') {
      send({ schemaVersion: 1, grouping: 'root', turns: [], messages: [], loadedTurnIds: [],
        revision: `${sessionId}:empty`, mutationRevision: `${sessionId}:unchanged`, backend: 'jsonl', completeness: 'complete' }); return
    }
    if (path === '/api/v1/conversation/history' || path === '/api/v1/chat/history') { send([]); return }
    if (path === '/api/v1/chat/admission/context') {
      send({ protocolVersion: 1, tenantId: 'private-html-fixture', sessionId,
        namespace: { id: 'private-html-workspace', generation: 'one' },
        transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'general' ? 'general' : 'code', runLifetime: 'durable', subagentProtocol: 2 },
        root: null, predecessor: null }); return
    }
    if (path === '/api/v1/chat/admission/receipt') {
      send({ protocolVersion: 1, status: 'absent', namespace: body.namespace, sessionId, requestKey: body.requestKey }); return
    }
    if (path === '/api/v1/workbench/clients' || path === '/api/v1/cron/capabilities') { send({}, 404); return }
    if (path === '/api/v1/browser/clients' && request.method === 'POST') {
      send({ clientId: `private-html-${sessionId}`, clientToken: 'private-html-client', sessionId }); return
    }
    if (/\/browser\/clients\/[^/]+\/commands$/.test(path)) { send({ commands: [] }); return }
    if (path === '/api/v1/workspace/bind') {
      bindings.push({ sessionId, workspaceRoot: body.workspaceRoot })
      // A generated Work root is discovered, never persisted as an explicit
      // local directory selection which would accidentally authorize Code FS.
      if (sessionId === taskId) throw new Error('Default Work workspace must not be rebound by viewing it')
      send({ workspaceRoot: workspace, bindingEpoch: epoch }); return
    }
    if (path === '/api/v1/workspace/directory') {
      const candidate = url.searchParams.get('path') ?? '.'
      const directory = scopedPath(workspace, candidate)
      reads.push({ sessionId, path: candidate, authenticated: Boolean(request.headers['x-aether-instance-token']) })
      send({ root: workspace, bindingEpoch: epoch, entries: readdirSync(directory, { withFileTypes: true }).map(entry => {
        const absolute = join(directory, entry.name), info = statSync(absolute)
        return { name: entry.name, path: relative(workspace, absolute).split(sep).join('/'),
          isDirectory: entry.isDirectory(), size: info.size, mtimeMs: info.mtimeMs }
      }) }); return
    }
    if (path === '/api/v1/workspace/file/content') {
      if (url.searchParams.has('expectedRoot') && resolve(url.searchParams.get('expectedRoot')!) !== resolve(workspace) ||
        url.searchParams.has('bindingEpoch') && url.searchParams.get('bindingEpoch') !== epoch) { send({}, 409); return }
      const candidate = url.searchParams.get('path') ?? '', content = readFileSync(scopedPath(workspace, candidate), 'utf8')
      reads.push({ sessionId, path: candidate, authenticated: Boolean(request.headers['x-aether-instance-token']) })
      send({ root: workspace, bindingEpoch: epoch, content, isBinary: false, totalSize: Buffer.byteLength(content), truncated: false }); return
    }
    if (path === '/api/v1/workspace/file/info') {
      const info = statSync(scopedPath(workspace, url.searchParams.get('path') ?? ''))
      send({ isDirectory: info.isDirectory(), size: info.size, mtimeMs: info.mtimeMs }); return
    }
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { ...manifest, instanceId: 'private-html-owned-engine' }
      : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: 'HTML 权限验收', isEnabled: true, capabilities: { toolCalling: true } }]
      : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', eventId: null, finished: true,
        history: [], runs: [], projection: [], todos: [], changes: [], commandJobs: [] }
      : path === '/api/v1/chat/status' ? { running: false, finished: true }
      : path === '/api/v1/chat/runs' ? { runs: [] }
      : path === '/api/v1/command-jobs' ? { jobs: [] }
      : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true,
        eventPagination: true, detailChunks: true, exactWatermarks: true }
      : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'fixture' }
      : path === '/api/v1/git/binding' ? { root: workspace, epoch, contractVersion: 2, mutationRequiresBinding: true }
      : path === '/api/v1/git/status' ? { success: true, isRepo: false, files: [] }
      : path === '/api/v1/security/mode' ? { sessionId, mode: 'standard' }
      : path === '/api/v1/memory/settings' ? { sessionId, memoryScope: 'session', effectiveScope: 'session', enabled: true }
      : []
    send(data)
  })().catch(error => {
    errors.push(String(error))
    if (!response.headersSent) response.writeHead(500)
    response.end('Fixture request failed')
  })
})

const work = () => page.locator('.work-view')
const workspace = () => work().getByRole('region', { name: '任务工作区', exact: true })
const tabs = () => page.evaluate(() => window.aether.browser.list())

async function assertCodeScope(): Promise<void> {
  const state = await page.evaluate(async ({ codeRoot, htmlFile }) => {
    const allowed = await window.aether.fs.readFile(`${codeRoot}/README.md`)
    let privateRead = ''
    try { await window.aether.fs.readFile(htmlFile); privateRead = 'unexpectedly allowed' }
    catch (error) { privateRead = String(error) }
    return { content: allowed.content, privateRead, selected: (await window.aether.settings.get()).lastFolder }
  }, { codeRoot: codeRoot.replace(/\\/g, '/'), htmlFile })
  expect(state.content).toBe('CODE_ROOT_STAYS_SEPARATE')
  expect(state.privateRead).toContain('拒绝访问工作区之外的路径')
  expect(resolve(state.selected)).toBe(resolve(codeRoot))
}

test.describe.serial('Work 默认会话工作区 HTML 运行权限', () => {
  test.beforeAll(async ({}, info) => {
    mkdirSync(fixtureParent, { recursive: true }); fixture = mkdtempSync(join(fixtureParent, 'work-html-session-run-'))
    codeRoot = join(fixture, 'code-root'); sessionRoot = join(fixture, 'session-only-root'); replacementRoot = join(fixture, 'replacement-root')
    activeSessionRoot = sessionRoot
    const profile = join(fixture, 'profile'), entry = join(fixture, 'engine-entry', 'main.mjs')
    for (const directory of [codeRoot, replacementRoot, profile, join(sessionRoot, 'docs'), join(sessionRoot, 'assets'), join(dirname(entry), 'runtime')]) mkdirSync(directory, { recursive: true })
    htmlFile = join(sessionRoot, 'docs', '围棋.html')
    writeFileSync(join(codeRoot, 'README.md'), 'CODE_ROOT_STAYS_SEPARATE')
    writeFileSync(join(replacementRoot, 'replacement.txt'), 'REBOUND_SESSION_ROOT')
    writeFileSync(htmlFile, '<!doctype html><meta charset="utf-8"><title>私有会话围棋</title><link rel="stylesheet" href="../assets/style.css"><h1>等待模块</h1><img src="../assets/board.svg"><script type="module" src="../assets/main.js"></script>')
    writeFileSync(join(sessionRoot, 'assets', 'style.css'), 'h1{color:rgb(17,88,155)}')
    writeFileSync(join(sessionRoot, 'assets', 'main.js'), "document.querySelector('h1').textContent='私有会话模块加载成功'")
    writeFileSync(join(sessionRoot, 'assets', 'board.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="green"/></svg>')
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    // The real host owns this child and supplies its random instance token. The
    // child enforces it before forwarding to mutable test-owned HTTP fixtures.
    writeFileSync(entry, `import { createServer, request } from 'node:http';
const upstream = ${JSON.stringify(`http://127.0.0.1:${address.port}`)};
const server = createServer((req, res) => {
  if (!['/health', '/meta'].includes(req.url) && req.headers['x-aether-instance-token'] !== process.env.AETHER_INSTANCE_TOKEN) {
    res.writeHead(401, {'content-type':'application/json'}).end(JSON.stringify({code:401,message:'Invalid fixture capability',data:null})); return;
  }
  const proxy = request(upstream + req.url, {method:req.method,headers:req.headers}, reply => {
    res.writeHead(reply.statusCode || 500, reply.headers); reply.pipe(res);
  });
  proxy.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(proxy);
});
server.listen(Number(process.env.AETHER_ENGINE_PORT), '127.0.0.1');
`)
    writeFileSync(join(dirname(entry), 'runtime', 'build-manifest.json'), JSON.stringify(manifest))
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'embedded', autoStartEngine: false, preferredPort: 12531,
      lastFolder: codeRoot, lastSessionId: codeSession, lastModelId: modelId, appearance: 'light' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env,
      AETHER_IDE_ENGINE_ENTRY: entry, AETHER_GLOBAL_DIR: join(fixture, 'global') }).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_MAIN || process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${profile}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'work-html-session-run')
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.workbench')).toBeVisible()
    // Subscribe before explicitly starting: an invalid fixture handshake must
    // expose its actual error immediately instead of spending 90 s on UI text.
    const startup = await page.evaluate(async () => {
      const logs: Array<{ level: string; line: string }> = []
      const unsubscribe = window.aether.engine.onLog(entry => { logs.push({ level: entry.level, line: entry.line }) })
      try { return { snapshot: await window.aether.engine.start(), logs } }
      finally { unsubscribe() }
    })
    await info.attach('owned-fixture-engine-startup', { body: JSON.stringify(startup, null, 2), contentType: 'application/json' })
    expect(startup.snapshot, `Owned fixture startup: ${JSON.stringify(startup)}`)
      .toMatchObject({ mode: 'embedded', phase: 'ready', adopted: false, entryPath: entry })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 980))
    await page.evaluate(({ taskId, modelId }) => {
      const now = Date.now()
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.state.v1', JSON.stringify({ activeTaskId: taskId, tasks: [{ id: taskId, title: '默认会话网页运行',
        draft: '', status: 'done', createdAt: now, updatedAt: now, workspacePath: null, modelId, attachments: [], sources: [] }] }))
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', workspace: false }))
    }, { taskId, modelId })
    await page.reload()
    await expect(work().getByRole('heading', { name: '默认会话网页运行', exact: true })).toBeVisible()
  })

  test.afterEach(() => { expect(errors).toEqual([]); health?.assertHealthy() })
  test.afterAll(async ({}, info) => {
    try { if (health) await health.closeAndAssert(info); else await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (!fixture) return
      const owned = resolve(fixture)
      if (dirname(owned) !== fixtureParent || !basename(owned).startsWith('work-html-session-run-')) throw new Error(`Unsafe HTML session fixture cleanup: ${owned}`)
      rmSync(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test('从默认工作区树运行嵌套 HTML，原生页面加载父目录资源且不扩大 Code 文件权限', async ({}, info) => {
    await assertCodeScope()
    await work().getByRole('button', { name: '打开工作区', exact: true }).click()
    await workspace().getByRole('button', { name: '更多工作区', exact: true }).click()
    await page.getByRole('menuitem', { name: '工作区', exact: true }).click()
    const panel = workspace().getByRole('region', { name: '工作区文件', exact: true }), tree = panel.locator('.explorer__tree')
    await expect(panel).toHaveAttribute('data-session-id', taskId)
    await expect(tree).toHaveAttribute('aria-busy', 'false')
    const docs = tree.locator(`[role="treeitem"][data-path=${JSON.stringify(sessionRoot.replace(/\\/g, '/') + '/docs')}]`)
    await expect(docs).toBeVisible()
    if (await docs.getAttribute('aria-expanded') !== 'true') await docs.click()
    await tree.locator(`[role="treeitem"][data-path=${JSON.stringify(htmlFile.replace(/\\/g, '/'))}]`).click()
    const preview = workspace().getByRole('region', { name: '成果预览', exact: true })
    await expect(preview).toHaveAttribute('data-document-session', taskId)
    await expect(preview).toHaveAttribute('data-document-path', htmlFile.replace(/\\/g, '/'))
    await expect(preview.getByRole('grid', { name: '围棋.html 文本预览', exact: true })).toContainText('私有会话围棋')
    const run = preview.getByRole('button', { name: '在浏览器中运行', exact: true })
    await expect(run).toBeEnabled()
    const before = await tabs(), beforeNative = await app!.evaluate(({ webContents }) => webContents.getAllWebContents().map(item => item.id))
    await run.click()
    await expect.poll(async () => {
      previewTab = (await tabs()).find(tab => !before.some(old => old.tabId === tab.tabId) && tab.presentation?.mode === 'work' && !tab.loading && tab.url !== 'about:blank')
      return previewTab?.tabId ?? null
    }).not.toBeNull()
    const tab = previewTab!
    expect(tab.presentation).toMatchObject({ mode: 'work', sessionId: taskId })
    expect(decodeURIComponent(new URL(tab.url).pathname)).toContain('/docs/围棋.html')
    await expect(workspace().getByRole('region', { name: '内置浏览器', exact: true })).toBeVisible()
    let nativeId = -1
    await expect.poll(async () => {
      const ids = await app!.evaluate(({ webContents }, { url, before }) => webContents.getAllWebContents()
        .filter(item => !before.includes(item.id) && item.getURL() === url).map(item => item.id), { url: tab.url, before: beforeNative })
      if (ids.length === 1) nativeId = ids[0]
      return ids.length
    }).toBe(1)
    await expect.poll(() => app!.evaluate(async ({ webContents }, id) => {
      const native = webContents.fromId(id)
      return native ? native.executeJavaScript("({heading:document.querySelector('h1')?.textContent,color:document.querySelector('h1')?getComputedStyle(document.querySelector('h1')).color:'',image:document.querySelector('img')?.naturalWidth,bridge:'aether' in window})") : null
    }, nativeId)).toEqual({ heading: '私有会话模块加载成功', color: 'rgb(17, 88, 155)', image: 32, bridge: false })
    await expect.poll(() => app!.evaluate(({ BrowserWindow, WebContentsView }, id) => {
      const native = BrowserWindow.getAllWindows()[0].contentView.children.find(child => child instanceof WebContentsView && child.webContents.id === id)
      return native instanceof WebContentsView && native.getVisible() && native.getBounds().width > 200 && native.getBounds().height > 200
    }, nativeId)).toBe(true)
    await assertCodeScope()
    expect(bindings.filter(binding => binding.sessionId === taskId)).toEqual([])
    const sessionReads = reads.filter(read => read.sessionId === taskId)
    expect(sessionReads.some(read => read.path.replace(/\\/g, '/') === 'docs/围棋.html')).toBe(true)
    expect(sessionReads.length).toBeGreaterThan(1)
    expect(sessionReads.every(read => read.authenticated)).toBe(true)
    expect((await tabs()).filter(item => item.presentation?.mode === 'code').map(item => item.tabId))
      .toEqual(before.filter(item => item.presentation?.mode === 'code').map(item => item.tabId))
    const screenshot = await app!.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
    const screenshotPath = info.outputPath('work-private-session-html-native-window.png')
    writeFileSync(screenshotPath, Buffer.from(screenshot, 'base64'))
    await info.attach('work-private-session-html-native-window', { path: screenshotPath, contentType: 'image/png' })
    // BrowserWindow capture omits the separate native WebContentsView on
    // Windows; preserve that surface itself as the rendered-page evidence.
    const nativeScreenshot = await app!.evaluate(async ({ webContents }, id) =>
      (await webContents.fromId(id)!.capturePage()).toPNG().toString('base64'), nativeId)
    const nativeScreenshotPath = info.outputPath('work-private-session-html-page.png')
    writeFileSync(nativeScreenshotPath, Buffer.from(nativeScreenshot, 'base64'))
    await info.attach('work-private-session-html-page', { path: nativeScreenshotPath, contentType: 'image/png' })
  })

  test('会话工作区重新绑定后，旧 HTML 与资源 URL 失效且 Code 权限仍隔离', async () => {
    const url = previewTab!.url, asset = new URL('../assets/main.js', url).href
    const first = await fetch(url)
    expect(first.status).toBe(200)
    expect(await first.text()).toContain('私有会话围棋')
    expect((await fetch(asset)).status).toBe(200)
    activeSessionRoot = replacementRoot; bindingEpoch = 'private-root-two'
    for (const address of [url, asset]) {
      const response = await fetch(address)
      expect([403, 404, 410]).toContain(response.status)
      const content = await response.text()
      expect(content).not.toContain('私有会话围棋')
      expect(content).not.toContain('私有会话模块加载成功')
    }
    await assertCodeScope()
  })
})
