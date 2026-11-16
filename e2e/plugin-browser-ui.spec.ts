/** Authenticated fixture engine + real Electron SDK iframe using the engine's authored
 * session-review HTML. Verifies UI/bridge contracts, not real model inference; separate
 * engine HTTP tests own capability implementation coverage. Never reads production data. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { sessionReviewHtml } from '../../ai-agent-engine/src/plugins/session-review-template'
import type { PluginApplication, PluginManifest } from '../src/renderer/src/core/engine/plugins'
import type { PluginPermissionRecord } from '../src/renderer/src/core/engine/plugin-permissions'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp/plugin-browser-ui-20261112')
const token = 'plugin-browser-fixture-token', pluginId = 'session-review-fixture', pluginName = '会话质量校验'
const sessionId = 'work-session-review-fixture', taskTitle = '图片压缩插件验收', workspace = '/session-review-fixture/workspace'
const modelA = 'review-model-a', modelB = 'review-model-b', hash = 'sha256:' + '7'.repeat(64), now = Date.now() - 5000
const requested = ['session.read', 'models.read', 'ai.run', 'settings.read', 'settings.write']
const catalogue = requested.map(id => ({ id, title: ({ 'session.read': '读取当前会话', 'models.read': '查看可用模型', 'ai.run': '调用平台 AI', 'settings.read': '读取插件设置', 'settings.write': '修改插件设置' })[id],
  description: '隔离验收能力', category: id.split('.')[0], access: id === 'ai.run' ? 'execute' : id.endsWith('.write') ? 'write' : 'read', defaultGranted: false, bridge: [] }))
const manifest: PluginManifest & { permissions: { requested: string[] } } = {
  apiVersion: 1, id: pluginId, name: pluginName, version: '1.0.0', description: '读取当前会话消息并使用平台模型分析', runtime: 'node', permissions: { requested },
  tools: [{ name: 'prepare_review', description: '整理待分析文本', entry: 'main.mjs', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
  contributes: { pages: [{ id: 'review', title: pluginName, kind: 'webview', entry: 'ui/index.html', tools: [] }],
    workspaceTabs: [{ id: 'review', title: '会话校验', page: 'review', icon: 'check-circle-outline', scope: 'session', when: { session: true } }] }
}
const messages = [
  { id: 'review-user', role: 'user', content: '请做图片压缩插件，保留透明通道，并提供压缩前后的大小对比。', conversationId: 'review-turn', createdAt: now, metadata: { attachments: [{ name: '透明图.png', path: '/fixture/透明图.png' }] } },
  { id: 'review-assistant', role: 'assistant', content: '已完成图片压缩，但当前没有提供测试证据。', conversationId: 'review-turn', createdAt: now + 1 },
  { id: 'review-tool', role: 'tool', content: '验证输出：原图 100 KB，压缩后 42 KB；<img src=x onerror="window.invalid=true">', conversationId: 'review-turn', createdAt: now + 2 },
]
type CapabilityCall = { capability: string; method: string; args: Record<string, unknown>; sessionId?: string; expectedRevision: number }
let holdStream = false, streamAborts = 0, releaseStream: (() => void) | undefined
const errors: string[] = [], capabilityCalls: CapabilityCall[] = [], permissionUpdates: string[][] = []
let app: ElectronApplication | undefined, page: Page, fixture = '', origin = '', grants = new Set(requested)
let settings: Record<string, unknown> = {}, aiError = '', modelRuns = 0
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const pluginRecord = (): PluginPermissionRecord => ({ id: pluginId, name: pluginName, description: manifest.description, enabled: true, revision: 1, publishedRevision: 1,
  manifest, permissionGrants: [...grants], permissionRevision: 1, files: { 'ui/index.html': sessionReviewHtml }, revisions: [{ revision: 1, hash, createdAt: now }], createdAt: now, updatedAt: now })
const application = (): PluginApplication => ({ id: pluginId, name: pluginName, description: manifest.description, revision: 1, hash, manifest, examples: [], execution: { allowed: true }, uiDocuments: { review: sessionReviewHtml } })
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', origin || 'http://127.0.0.1'), path = url.pathname
  if (path === '/ordinary') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end('<!doctype html><title>普通网页验收</title><main>此网页不应获得插件 SDK。</main>'); return }
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Missing fixture authentication: ${path}`)
  let raw = ''; for await (const chunk of request) raw += chunk.toString()
  const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
  if (path === '/api/v1/chat/admission/context' && request.method === 'GET') {
    response.end(envelope({ protocolVersion: 1, tenantId: 'plugin-browser-fixture', sessionId: url.searchParams.get('sessionId'),
      namespace: { id: 'plugin-browser-db', generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null })); return
  }
  if (path === '/api/v1/chat/admission/receipt' && request.method === 'POST') {
    response.end(envelope({ protocolVersion: 1, status: 'absent', namespace: body.namespace, sessionId: body.sessionId, requestKey: body.requestKey })); return
  }
  if ([`/api/v1/plugins/${pluginId}/capabilities/invoke`, `/api/v1/plugins/${pluginId}/capabilities/stream`].includes(path)) {
    if (request.method !== 'POST' || body.expectedRevision !== 1 || body.hash !== undefined || body.sessionId !== sessionId || !body.args || typeof body.args !== 'object') throw new Error('Invalid pinned capability request or session binding')
    const call = body as unknown as CapabilityCall; capabilityCalls.push(call)
    if (!grants.has(call.capability)) { response.writeHead(403).end(JSON.stringify({ code: 40300, message: `未授予插件能力：${call.capability}` })); return }
    let result: unknown
    if (call.capability === 'session.read' && call.method === 'messages') {
      const offset = Number(call.args.offset ?? 0), limit = Number(call.args.limit ?? 50)
      result = { messages: messages.slice(offset, offset + limit), total: messages.length, nextOffset: offset + limit < messages.length ? offset + limit : null }
    } else if (call.capability === 'models.read' && call.method === 'list') result = { models: [{ id: modelA, name: '质量分析 A' }, { id: modelB, name: '质量分析 B' }] }
    else if (call.capability === 'settings.read' && call.method === 'get') result = { ...settings }
    else if (call.capability === 'settings.write' && call.method === 'set') {
      if (!call.args.value || typeof call.args.value !== 'object' || Array.isArray(call.args.value)) throw new Error('Invalid settings write')
      settings = { ...call.args.value as Record<string, unknown> }; result = { ...settings }
    } else if (call.capability === 'ai.run' && call.method === 'stream') {
      if (aiError) { response.writeHead(503).end(JSON.stringify({ code: 50300, message: aiError })); return }
      if (![modelA, modelB].includes(String(call.args.modelId)) || typeof call.args.prompt !== 'string' || typeof call.args.systemPrompt !== 'string') throw new Error('Invalid AI request')
      modelRuns++; result = { text: `校验报告 ${modelRuns}：已核对所选消息，仍需补充透明通道的测试证据。`, model: call.args.modelId, usage: { inputTokens: 213, outputTokens: 47 } }
    } else throw new Error(`Unexpected capability ${call.capability}:${call.method}`)
    if (call.method === 'stream') {
      const value = result as { text: string }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.flushHeaders()
      const send = (event: unknown): void => { response.write('data: ' + JSON.stringify(event) + '\n\n') }
      send({ type: 'started' })
      const split = holdStream ? Math.min(6, value.text.length) : value.text.length
      if (split) send({ type: 'text-delta', text: value.text.slice(0, split) })
      const finish = (): void => { if (!response.destroyed) { if (split < value.text.length) send({ type: 'text-delta', text: value.text.slice(split) }); send({ type: 'complete', result }); response.end() } }
      if (holdStream) releaseStream = finish
      else finish()
      response.once('close', () => { if (!response.writableEnded) streamAborts++; if (releaseStream === finish) releaseStream = undefined })
      return
    }
    response.end(envelope({ result })); return
  }
  if (path === `/api/v1/plugins/${pluginId}/permissions` && request.method === 'PUT') {
    const next = body.grants as string[]
    if (body.expectedRevision !== 1 || !Array.isArray(next) || next.some(id => !requested.includes(id))) throw new Error('Invalid permission update')
    grants = new Set(next); permissionUpdates.push(next); response.end(envelope({ plugin: pluginRecord() })); return
  }
  if (path === '/api/v1/plugins/project/capabilities') { response.end(envelope({ catalogue: { capabilities: catalogue } })); return }
  if (path === `/api/v1/plugins/${pluginId}` && request.method === 'GET') { response.end(envelope({ plugin: pluginRecord() })); return }
  if (path === `/api/v1/plugins/runtime/apps/${pluginId}`) { response.end(envelope({ application: application() })); return }
  if (path === '/api/v1/conversation/display') {
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: [{ userMessageId: messages[0].id, conversationId: 'review-turn', preview: taskTitle, createdAt: now }], messages,
      loadedTurnIds: [messages[0].id], revision: 'stable', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/browser/hosts', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) { response.writeHead(404).end(envelope(null)); return }
  if (request.method !== 'GET' && path !== '/api/v1/workspace/bind') throw new Error(`Unexpected write: ${request.method} ${path}`)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'6'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: token }
    : path === '/api/v1/models' ? [{ id: modelA, modelId: modelA, provider: 'openai', displayName: '质量分析 A', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', eventId: null, finished: true, history: messages, projection: [], runs: [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: [] } : path === '/api/v1/conversation/history' ? messages
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title: taskTitle, lastAt: now, messageCount: messages.length }]
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'off', effectiveScope: 'off', enabled: false }
    : path === '/api/v1/memory/preferences' ? { enabled: false, globalEnabled: false, sessionDefaultEnabled: false }
    : path === '/api/v1/workspace/directory' ? { root: workspace, bindingEpoch: sessionId, entries: [] }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: workspace }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] } : path === '/api/v1/plugins' ? { plugins: [pluginRecord()] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })
const frame = (): ReturnType<Page['frameLocator']> => page.frameLocator(`iframe[title="${pluginName}"]`)
const selections = () => frame().locator('#messages input')
const analyses = (): CapabilityCall[] => capabilityCalls.filter(call => call.capability === 'ai.run')
async function openReview(): Promise<void> {
  await page.locator(`[data-task-id="${sessionId}"]`).getByRole('button').first().click()
  await expect(page.locator('.work-task-heading h1')).toHaveText(taskTitle)
  await page.locator('.work-task-heading').getByRole('button', { name: '更多工作区', exact: true }).click()
  await page.getByRole('menuitem', { name: '会话校验', exact: true }).click()
  await expect(frame().getByRole('heading', { name: pluginName, exact: true })).toBeVisible()
  await expect(selections()).toHaveCount(messages.length)
  await expect(frame().getByRole('combobox', { name: '分析模型', exact: true })).toHaveValue(modelA)
  await expect(frame().locator('#rubric')).toHaveValue(String(settings.rubric))
  await expect(page.locator('.work-next-turn__error')).toHaveCount(0)
}

test.describe.serial('受信插件浏览器真实 SDK iframe', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'profile-'))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    origin = `http://127.0.0.1:${address.port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, remoteWorkspaceRoot: workspace, autoStartEngine: true,
      lastFolder: '', lastModelId: modelA, appearance: 'light', accent: 'blue', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_ENGINE_ENTRY'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const stateKey = sessionStorageKey('aether.work.state.v1', engineStorageKey({ mode: 'remote', baseUrl: origin }))
    await page.evaluate(({ stateKey, sessionId, taskTitle, workspace, now, modelA }) => {
      localStorage.setItem(stateKey, JSON.stringify({ tasks: [{ id: sessionId, title: taskTitle, status: 'done', draft: '', createdAt: now, updatedAt: now, workspacePath: workspace, modelId: modelA, attachments: [], sources: [] }], activeTaskId: sessionId }))
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
    }, { stateKey, sessionId, taskTitle, workspace, now, modelA })
  })
  test.beforeEach(async () => {
    holdStream = false; releaseStream = undefined; streamAborts = 0
    grants = new Set(requested); settings = { rubric: '检查需求覆盖、附件和测试证据；引用消息 ID。' }; aiError = ''; modelRuns = 0; capabilityCalls.length = 0; permissionUpdates.length = 0
    await page.reload(); await openReview()
  })
  test.afterEach(async ({}, info) => {
    if (page && !page.isClosed()) {
      await expect(page.locator('.work-next-turn__error')).toHaveCount(0)
      await page.screenshot({ path: info.outputPath('plugin-browser.png') })
    }
    expect(errors).toEqual([])
  })
  test.afterAll(async () => {
    try { await app?.close() } finally {
      server.closeAllConnections(); if (server.listening) await new Promise<void>(done => server.close(() => done()))
      if (fixture) { const target = resolve(fixture); if (dirname(target) !== fixtureRoot || !basename(target).startsWith('profile-')) throw new Error('Unsafe session review cleanup'); rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    }
  })


  test('插件浏览器复用真实 SDK、刷新重挂载、撤权立即拒绝，普通网页不继承能力', async () => {
    await page.getByRole('button', { name: '在浏览器中打开插件', exact: true }).click()
    await page.locator('.work-navigation').getByRole('button', { name: '浏览器', exact: true }).click()
    const browser = page.getByRole('region', { name: '内置浏览器', exact: true })
    const surface = browser.locator('[data-plugin-browser-tab]')
    await expect(surface).toHaveCount(1)
    const tabId = await surface.getAttribute('data-plugin-browser-tab')
    const pluginAddress = await browser.getByRole('textbox', { name: '网页地址', exact: true }).inputValue()
    expect(pluginAddress).toBe('aether-plugin:' + pluginId + '/review')
    const pluginFrame = browser.frameLocator('iframe[title="会话质量校验"]')
    const iframe = browser.locator('iframe[title="会话质量校验"]')
    await expect(iframe).toHaveAttribute('data-ready', 'true')
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-forms')
    await expect(pluginFrame.locator('#messages input')).toHaveCount(3)
    await expect(pluginFrame.locator('#rubric')).toHaveValue(String(settings.rubric))
    expect(await pluginFrame.locator('body').evaluate(() => ({ sdk: typeof (window as unknown as { $AE?: unknown }).$AE, preload: 'aether' in window, origin: window.origin }))).toEqual({ sdk: 'object', preload: false, origin: 'null' })
    await pluginFrame.locator('#messages input').first().check()
    holdStream = true
    await pluginFrame.getByRole('button', { name: '分析', exact: true }).click()
    await expect(pluginFrame.locator('#report')).toHaveText('校验报告 1')
    await expect(pluginFrame.getByRole('button', { name: '停止', exact: true })).toBeEnabled()
    await expect(pluginFrame.getByRole('button', { name: '导出报告', exact: true })).toBeDisabled()
    releaseStream!(); holdStream = false
    await expect(pluginFrame.locator('#report')).toContainText('校验报告 1')
    await expect(pluginFrame.getByRole('status')).toContainText('分析完成')
    expect(analyses()[0]).toMatchObject({ sessionId, expectedRevision: 1, args: { modelId: modelA } })
    await expect(page.locator('.work-next-turn__error')).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('plugin-browser-active.png'), animations: 'disabled' })
    const firstURL = await iframe.getAttribute('src')
    await browser.getByRole('button', { name: '刷新网页（Ctrl+R）', exact: true }).click()
    await expect(iframe).not.toHaveAttribute('src', firstURL!)
    await expect(pluginFrame.locator('#messages input')).toHaveCount(3)
    await expect(pluginFrame.locator('#report')).toBeEmpty()
    await expect(pluginFrame.locator('#messages input:checked')).toHaveCount(0)
    await expect(surface).toHaveAttribute('data-plugin-browser-tab', tabId!)

    // Revoke through the authenticated API while the exact iframe stays mounted.
    const mountedURL = await iframe.getAttribute('src')
    const response = await fetch(origin + '/api/v1/plugins/' + pluginId + '/permissions', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-aether-instance-token': token }, body: JSON.stringify({ expectedRevision: 1, grants: requested.filter(id => id !== 'ai.run') }) })
    expect((await response.json()).data.plugin.permissionGrants).not.toContain('ai.run')
    await pluginFrame.locator('#messages input').first().check()
    await pluginFrame.getByRole('button', { name: '分析', exact: true }).click()
    await expect(pluginFrame.getByRole('status')).toHaveText('未授予插件能力：ai.run')
    await expect(iframe).toHaveAttribute('src', mountedURL!)
    expect(modelRuns).toBe(1)

    const ordinaryURL = origin + '/ordinary'
    await browser.getByRole('textbox', { name: '网页地址', exact: true }).fill(ordinaryURL)
    await browser.getByRole('button', { name: '打开地址', exact: true }).click()
    await expect(browser.getByRole('textbox', { name: '网页地址', exact: true })).toHaveValue(ordinaryURL)
    await expect.poll(() => app!.evaluate(({ webContents }, target) => webContents.getAllWebContents().some(contents => contents.getURL() === target), ordinaryURL)).toBe(true)
    const external = await app!.evaluate(async ({ webContents }, target) => {
      const contents = webContents.getAllWebContents().find(item => item.getURL() === target)
      if (!contents) throw new Error('Ordinary website WebContentsView missing')
      return contents.executeJavaScript('({ sdk: typeof window.$AE, pluginBridge: typeof window.aetherPlugin, title: document.title })')
    }, ordinaryURL)
    expect(external).toEqual({ sdk: 'undefined', pluginBridge: 'undefined', title: '普通网页验收' })
    await expect(browser.locator('[data-plugin-browser-tab]')).toHaveCount(0)
    await browser.getByRole('tab', { name: pluginName, exact: true }).click()
    await expect(surface).toHaveAttribute('data-plugin-browser-tab', tabId!)
    await expect(pluginFrame.getByRole('heading', { name: pluginName, exact: true })).toBeVisible()
    await browser.getByRole('button', { name: '关闭网页 ' + pluginName, exact: true }).click()
    await expect(browser.getByRole('tab', { name: pluginName, exact: true })).toHaveCount(0)
    await expect(browser.locator('[data-plugin-browser-tab]')).toHaveCount(0)
    const rejection = await page.evaluate(async url => {
      try { await window.aether.browser.create({ url }); return 'unexpected success' }
      catch (error) { return error instanceof Error ? error.message : String(error) }
    }, pluginAddress)
    expect(rejection).toContain('仅支持 HTTP、HTTPS 和 about:blank')
    await expect(browser.getByRole('tab', { name: pluginName, exact: true })).toHaveCount(0)
    await expect(browser.locator('[data-plugin-browser-tab]')).toHaveCount(0)
  })

  test('浏览器关闭插件标签会取消正在生成的流，不留下后台连接', async () => {
    await page.getByRole('button', { name: '在浏览器中打开插件', exact: true }).click()
    await page.locator('.work-navigation').getByRole('button', { name: '浏览器', exact: true }).click()
    const browser = page.getByRole('region', { name: '内置浏览器', exact: true })
    const pluginFrame = browser.frameLocator('iframe[title="会话质量校验"]')
    await expect(pluginFrame.locator('#messages input')).toHaveCount(3)
    await pluginFrame.locator('#messages input').first().check(); holdStream = true
    await pluginFrame.getByRole('button', { name: '分析', exact: true }).click()
    await expect(pluginFrame.locator('#report')).toHaveText('校验报告 1')
    await browser.getByRole('button', { name: '关闭网页 ' + pluginName, exact: true }).click()
    await expect(browser.locator('[data-plugin-browser-tab]')).toHaveCount(0)
    await expect.poll(() => streamAborts).toBe(1)
  })
})
