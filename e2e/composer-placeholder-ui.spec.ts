/** Fresh Electron placeholder regression: real keyboard line breaks, native clipboard
 * paste, draft reload and CDP IME composition in Work. No model send,
 * old E2E suite or export flow; isolated settings and authenticated fixture. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'composer-placeholder-fixture', sessionId = 'work-composer-placeholder', modelId = 'composer-placeholder-model'
const title = '输入提示与正文分离核对', remoteRoot = '/remote/composer-placeholder'
const errors: string[] = [], mutations: string[] = []
let app: ElectronApplication | undefined, page: Page, fixture = ''
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && !['/api/v1/workspace/bind', '/api/v1/chat/admission/receipt'].includes(path)) {
    mutations.push(`${request.method} ${path}`); throw new Error(`Placeholder inspection must not send or mutate ${path}`)
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'f'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'composer-placeholder-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '输入焦点核对模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: [], projection: [], runs: [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: [] }
    : path === '/api/v1/conversation/display' ? { schemaVersion: 1, grouping: 'root', turns: [], messages: [], loadedTurnIds: [],
      revision: 'composer-placeholder-empty', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' }
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'composer-placeholder-tenant', sessionId: id,
      namespace: { id: 'composer-placeholder-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: remoteRoot, entries: [], bindingEpoch: 'one' }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: remoteRoot }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

test.beforeAll(async () => {
  mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'composer-placeholder-profile-'))
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  const origin = `http://127.0.0.1:${address.port}`
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true,
    remoteWorkspaceRoot: remoteRoot, lastSessionId: 'code-placeholder', lastFolder: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900); window.show(); window.focus() })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await page.evaluate(({ key, sessionId, title, modelId, remoteRoot }) => {
    const now = Date.now()
    localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'draft', draft: '', createdAt: now,
      updatedAt: now, workspacePath: remoteRoot, modelId, attachments: [], sources: [] }], activeTaskId: sessionId }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
  }, { key: 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin })), sessionId, title, modelId, remoteRoot })
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await expect(page.locator('.work-view').getByRole('heading', { name: title, exact: true })).toBeVisible()
})
test.afterEach(async ({}, info) => {
  if (page && !page.isClosed()) { await page.screenshot({ path: info.outputPath(`${info.status}.png`), animations: 'allow' }); await info.attach('input-dom', { body: JSON.stringify(await page.locator('.input-composer__input').evaluateAll(elements => elements.map(element => ({ html: element.innerHTML, before: getComputedStyle(element, '::before').content }))), null, 2), contentType: 'application/json' }) }
  await info.attach('app-errors', { body: JSON.stringify({ errors, mutations }, null, 2), contentType: 'application/json' })
  expect(errors).toEqual([]); expect(mutations).toEqual([])
})
test.afterAll(async () => {
  try { await app?.close() } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== fixtureRoot || !basename(target).startsWith('composer-placeholder-profile-')) throw new Error('Unsafe composer fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

async function editorFor(): Promise<Locator> {
  const editor = page.locator('.work-view .input-composer__input')
  await expect(editor).toBeVisible(); return editor
}
async function clear(editor: Locator): Promise<void> {
  await editor.click(); await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace')
  await expect(editor).toHaveText('')
  await expect.poll(() => editor.evaluate(element => element.innerHTML)).toBe('')
  await expect.poll(() => editor.evaluate(element => getComputedStyle(element, '::before').content)).not.toBe('none')
}
async function noPlaceholder(editor: Locator): Promise<void> {
  await expect.poll(() => editor.evaluate(element => getComputedStyle(element, '::before').content)).toBe('none')
  const position = await editor.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) if (node.textContent?.trim()) {
      const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 1)
      const box = element.getBoundingClientRect(), text = range.getBoundingClientRect(), style = getComputedStyle(element)
      return { actual: text.left, expected: box.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth), top: text.top, expectedTop: box.top + parseFloat(style.paddingTop) }
    }
    return null
  })
  expect(position).not.toBeNull()
  expect(Math.abs(position!.actual - position!.expected)).toBeLessThanOrEqual(2)
}

test('Work 办公：text+br 回归及真实键盘、中文组合输入、清空提示', async () => {
    const editor = await editorFor(); await clear(editor)
    await page.keyboard.type('PLACEHOLDER_REGRESSION')
    await noPlaceholder(editor)
    await page.keyboard.press('End'); await page.keyboard.press('Shift+Enter')
    const lineBreak = await editor.evaluate(element => ({ html: element.innerHTML, brs: element.querySelectorAll(':scope > br').length, before: getComputedStyle(element, '::before').content }))
    expect(lineBreak.html.includes('\n') || lineBreak.brs > 0, JSON.stringify(lineBreak)).toBe(true)
    await noPlaceholder(editor)
    await page.keyboard.type('SECOND_LINE')
    await noPlaceholder(editor); await expect(editor).toContainText('SECOND_LINE')
    await clear(editor)
    await page.keyboard.type('TEXT_BEFORE_BROWSER_BR')
    // Some editing/restore paths leave a BR beside text. Construct that exact
    // browser DOM shape explicitly; normal Shift+Enter uses text newlines on
    // this Chromium build and is checked separately above.
    await editor.evaluate(element => element.append(document.createElement('br')))
    await noPlaceholder(editor)
    await clear(editor)
    // Chromium's IME protocol exercises compositionstart/update/end without
    // depending on which OS input method happens to be selected on the host.
    const cdp = await page.context().newCDPSession(page)
    try {
      await cdp.send('Input.imeSetComposition', { text: '中文输入', selectionStart: 4, selectionEnd: 4 })
      await expect(editor).toContainText('中文输入'); await noPlaceholder(editor)
      await cdp.send('Input.insertText', { text: '中文输入' })
      await expect(editor).toContainText('中文输入'); await noPlaceholder(editor)
      await page.keyboard.press('Shift+Enter'); await page.keyboard.type('IME_END')
      await noPlaceholder(editor); await clear(editor)
    } finally { await cdp.detach() }
  })

  test('Work 办公：原生剪贴板多行粘贴及草稿重载不混入提示', async () => {
    if (!app) throw new Error('Missing Electron application')
    const editor = await editorFor(); await clear(editor)
    const original = await app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage().toDataURL() }))
    try {
      for (const text of ['CLIPBOARD_ONE', 'CLIPBOARD_FIRST\nCLIPBOARD_SECOND\n']) {
        await clear(editor)
        await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)
        await page.keyboard.press('Control+V')
        await expect(editor).toContainText(text.trimEnd().split('\n').at(-1)!)
        await noPlaceholder(editor)
      }
      const persisted = 'CLIPBOARD_FIRST\nCLIPBOARD_SECOND'
      await expect.poll(() => page.evaluate(value => Object.keys(localStorage).some(key => /chatDrafts|work.state/.test(key) && (localStorage.getItem(key) ?? '').includes(value)), persisted.replace(/\n/g, '\\n'))).toBe(true)
      await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
      const restored = await editorFor()
      await expect(restored).toContainText('CLIPBOARD_SECOND'); await noPlaceholder(restored)
      await clear(restored)
    } finally {
      await app.evaluate(({ clipboard, nativeImage }, data) => clipboard.write({ text: data.text, html: data.html, rtf: data.rtf, image: nativeImage.createFromDataURL(data.image) }), original)
    }
  })

