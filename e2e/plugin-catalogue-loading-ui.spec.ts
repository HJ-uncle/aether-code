/** Isolated Electron loading regression: independent plugin registration, @ catalogue
 * reuse, late publish receipts and recoverable application loads. No model, production profile or plugin code
 * is executed. Build first; run serially with the other Electron specs. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { PluginApplication, PluginManifest, PluginRecord } from '../src/renderer/src/core/engine/plugins'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), taskRoot = join(root, '.e2e-tmp/plugin-loading-20261112')
const token = 'plugin-loading-disposable-token', model = 'plugin-loading-model', sessionId = 'work-plugin-loading'
const title = '插件加载性能验证', workspace = '/plugin-loading-fixture', now = Date.now() - 5000
const names = { fast: '快速插件', slow: '独立慢插件', tools: '纯工具插件', late: '延迟发布插件', recover: '短暂失败插件', recycle: '重新启用插件', background: '后台发布插件' }
type PluginId = keyof typeof names
const enabled: Record<PluginId, boolean> = { fast: true, slow: true, tools: true, late: false, recover: false, recycle: false, background: false }
const published: Record<PluginId, boolean> = { fast: true, slow: true, tools: true, late: false, recover: true, recycle: true, background: false }
const appReads: Record<PluginId, number> = { fast: 0, slow: 0, tools: 0, late: 0, recover: 0, recycle: 0, background: 0 }
const counts = { agents: 0, toolkits: 0, lists: 0, successfulLists: 0, failedLists: 0, publishes: 0, failedApplications: 0, catalogueStreams: 0 }, errors: string[] = []
const catalogueStreams = new Set<ServerResponse>()
const catalogueEvent = (action: 'update' | 'refresh', id: string): string => `data: ${JSON.stringify({ pluginCatalogueChange: { kind: 'plugin', action, id } })}\n\n`
function backgroundChange(id: PluginId, value: boolean, action = 'set_enabled'): void {
  enabled[id] = value
  if (action === 'publish') published[id] = true
  for (const response of catalogueStreams) response.write(catalogueEvent('update', id))
}
const pendingReleases = new Set<() => void>()
function deferredResponse(): { promise: Promise<void>; release: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  const release = (): void => { pendingReleases.delete(release); resolve() }
  pendingReleases.add(release)
  return { promise, release }
}
let publishGate: ReturnType<typeof deferredResponse> | undefined
let listFailuresRemaining = 0, listSuccessGate: ReturnType<typeof deferredResponse> | undefined
const applicationResponses = new Map<PluginId, { gate?: ReturnType<typeof deferredResponse>; failures: number }>()
let app: ElectronApplication | undefined, page: Page, fixture = '', origin = ''
let releaseApp: (() => void) | undefined, releaseAgents: (() => void) | undefined
const appGate = new Promise<void>(done => { releaseApp = done })
const agentGate = new Promise<void>(done => { releaseAgents = done })
const hash = (id: PluginId): string => `sha256:${id === 'fast' ? 'a'.repeat(64) : id === 'slow' ? 'b'.repeat(64) : 'c'.repeat(64)}`
const manifest = (id: PluginId): PluginManifest => ({ apiVersion: 1, id, name: names[id], version: '1.0.0', description: `${names[id]}的隔离加载测试`, runtime: 'node',
  tools: [{ name: 'echo', description: '仅供菜单展示', entry: 'main.mjs', inputSchema: { type: 'object', properties: {} } }],
  ...(id === 'tools' ? {} : { contributes: { pages: [{ id: 'page', title: names[id], kind: 'webview', entry: 'ui/index.html', tools: ['echo'] }],
    navigation: [{ id: 'navigation', title: names[id], page: 'page', icon: 'puzzle', when: { engineReady: true } }],
    ...(id === 'late' || id === 'background' ? {
      workspaceTabs: [{ id: 'workspace', title: `${names[id]}标签`, page: 'page', scope: 'session', when: { workspace: true } }],
      services: [{ id: 'service', title: `${names[id]}服务`, tool: 'echo', page: 'page', scope: 'session', when: { workspace: true, engineReady: true } }]
    } : {}) } }) })
const plugin = (id: PluginId): PluginRecord => ({ id, name: names[id], description: `${names[id]}的隔离加载测试`, enabled: enabled[id], revision: 1,
  ...(published[id] ? { publishedRevision: 1 } : {}), manifest: manifest(id), files: { 'main.mjs': '// Isolated editor fixture; never executed.' }, revisions: [{ revision: 1, hash: hash(id), createdAt: now }], createdAt: now, updatedAt: now })
const application = (id: PluginId): PluginApplication => ({ id, name: names[id], description: plugin(id).description, revision: 1, hash: hash(id), manifest: manifest(id),
  examples: [], execution: { allowed: true }, uiDocuments: { page: `<main><h1>${names[id]}</h1></main>` } })
const history = () => [{ id: 'loading-user', role: 'user', content: title, conversationId: 'loading-turn', createdAt: now },
  { id: 'loading-answer', role: 'assistant', content: '会话已就绪。', conversationId: 'loading-turn', createdAt: now + 1 }]
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const ids = Object.keys(names) as PluginId[]
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', origin || 'http://127.0.0.1'), path = url.pathname
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated fixture request: ${path}`)
  let raw = ''; for await (const chunk of request) raw += chunk.toString()
  const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
  if (request.method === 'GET' && path === '/api/v1/plugins/runtime/changes') {
    counts.catalogueStreams++
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    catalogueStreams.add(response)
    response.on('close', () => catalogueStreams.delete(response))
    response.write(catalogueEvent('refresh', '*'))
    return
  }
  const mutation = /^\/api\/v1\/plugins\/(fast|slow|tools|late|recover|recycle|background)$/.exec(path)
  if (request.method === 'GET' && mutation) { response.end(envelope({ plugin: plugin(mutation[1] as PluginId) })); return }
  if (request.method === 'PATCH' && mutation) {
    if (typeof body.enabled !== 'boolean') throw new Error('Invalid toggle')
    const id = mutation[1] as PluginId; enabled[id] = body.enabled
    response.end(envelope({ plugin: plugin(id) })); return
  }
  if (request.method === 'POST' && path === '/api/v1/plugins/late/publish') {
    if (body.expectedRevision !== 1) throw new Error('Publish must pin draft revision 1')
    counts.publishes++
    await publishGate?.promise
    enabled.late = true; published.late = true
    response.end(envelope({ plugin: plugin('late') })); return
  }
  const runtime = /^\/api\/v1\/plugins\/runtime\/apps\/(fast|slow|tools|late|recover|recycle|background)$/.exec(path)
  if (runtime) {
    const id = runtime[1] as PluginId; appReads[id]++
    const configured = applicationResponses.get(id), gate = configured?.gate
    const fail = Boolean(configured && configured.failures > 0)
    if (configured) { configured.gate = undefined; if (fail) configured.failures-- }
    await gate?.promise
    if (fail) {
      counts.failedApplications++
      response.writeHead(503).end(JSON.stringify({ code: 50300, message: '插件应用临时不可用，请稍后重试。' })); return
    }
    if (id === 'slow') await appGate
    response.end(envelope({ application: application(id) })); return
  }
  if (path === '/api/v1/agents') {
    counts.agents++; await agentGate
    response.end(envelope([{ id: 'loading-custom-agent', name: '自定义审阅', description: '延迟响应的独立目录' }])); return
  }
  if (path === '/api/v1/toolkits') {
    counts.toolkits++
    response.end(envelope({ toolkits: [{ id: 'plugin-management', name: '插件管理', description: '管理插件', toolNames: ['plugin_create'], available: true },
      ...ids.filter(id => enabled[id] && published[id]).map(id => ({ id: `plugin-${id}--r1`, name: names[id], description: plugin(id).description, toolNames: [`plugin_${id}_echo`], available: true }))] })); return
  }
  if (path === '/api/v1/plugins') {
    counts.lists++
    if (listFailuresRemaining > 0) {
      listFailuresRemaining--; counts.failedLists++
      response.writeHead(503).end(JSON.stringify({ code: 50300, message: '插件目录临时不可用。' })); return
    }
    const gate = listSuccessGate; listSuccessGate = undefined
    await gate?.promise
    counts.successfulLists++
    response.end(envelope({ plugins: ids.map(plugin) })); return
  }
  if (path === '/api/v1/conversation/display') {
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: [{ userMessageId: 'loading-user', conversationId: 'loading-turn', preview: title, createdAt: now }],
      messages: history(), loadedTurnIds: ['loading-user'], revision: 'stable', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/browser/hosts', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && path !== '/api/v1/workspace/bind') throw new Error(`Unexpected mutation: ${request.method} ${path}`)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'8'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general'], subagentSchemaVersion: 1, instanceId: token }
    : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '隔离模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', eventId: null, finished: true, history: history(), projection: [], runs: [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, lastEventId: null }
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'plugin-loading', sessionId: url.searchParams.get('sessionId') ?? sessionId,
      namespace: { id: 'plugin-loading-db', generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/chat/runs' ? { runs: [] }
    : path === '/api/v1/conversation/history' ? history()
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: now, messageCount: 2 }]
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : /\/sessions\/[^/]+\/toolkits$/.test(path) ? { toolkits: [] }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'off', effectiveScope: 'off', enabled: false }
    : path === '/api/v1/memory/preferences' ? { enabled: false, globalEnabled: false, sessionDefaultEnabled: false }
    : path === '/api/v1/workspace/directory' ? { root: workspace, bindingEpoch: sessionId, entries: [] }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: workspace }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const navigation = (id: PluginId) => page.locator('.work-navigation').getByRole('button', { name: names[id], exact: true })
const manager = () => page.getByRole('region', { name: '插件管理', exact: true })
const picker = () => page.locator('.mention-ref-picker:visible')
const input = () => page.getByRole('textbox', { name: '继续对话', exact: true })
async function openPicker(): Promise<void> {
  await input().fill(''); await input().focus(); await page.keyboard.insertText('@')
  await expect(picker()).toBeVisible()
}
async function closePicker(): Promise<void> { await page.keyboard.press('Escape'); await expect(picker()).toHaveCount(0) }
async function animationFrames(): Promise<void> { await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))) }
async function openTask(): Promise<void> {
  await page.locator(`[data-task-id="${sessionId}"]`).getByRole('button').first().click()
  await expect(page.locator('.work-task-heading h1')).toHaveText(title)
}
async function openManager(): Promise<void> {
  await page.locator('.work-navigation').getByRole('button', { name: '插件', exact: true }).click()
  await expect(manager()).toBeVisible()
}
async function togglePlugin(id: PluginId, value: boolean): Promise<void> {
  const control = manager().getByRole('switch', { name: `启用插件 ${names[id]}`, exact: true })
  await expect(control).toHaveAttribute('aria-checked', String(!value))
  await control.click()
  await expect(control).toHaveAttribute('aria-checked', String(value))
  await expect.poll(() => enabled[id]).toBe(value)
}
async function workspaceEntry(id: PluginId, visible: boolean, open = false): Promise<void> {
  await page.locator('.work-task-heading').getByRole('button', { name: '更多工作区', exact: true }).click()
  const entry = page.getByRole('menuitem', { name: `${names[id]}标签`, exact: true })
  if (visible) await expect(entry).toBeVisible()
  else await expect(entry).toHaveCount(0)
  if (visible && open) {
    await entry.click()
    await expect(page.frameLocator(`iframe[title="${names[id]}"]`).getByRole('heading')).toHaveText(names[id])
  } else await page.keyboard.press('Escape')
}
async function serviceEntry(id: PluginId, visible: boolean): Promise<void> {
  await page.locator('.service-tray__button').click()
  const panel = page.locator('.service-tray__panel')
  await panel.getByRole('tab', { name: '服务', exact: true }).click()
  const entry = panel.locator('.service-tray__row').filter({ hasText: `${names[id]}服务` })
  if (visible) await expect(entry).toBeVisible()
  else await expect(entry).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
}

test.describe.serial('插件与引用目录加载', () => {
  test.beforeAll(async () => {
    mkdirSync(taskRoot, { recursive: true }); fixture = mkdtempSync(join(taskRoot, 'profile-'))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture port missing')
    origin = `http://127.0.0.1:${address.port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, remoteWorkspaceRoot: workspace, autoStartEngine: true,
      lastFolder: '', lastModelId: model, appearance: 'dark', accent: 'purple', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_ENGINE_ENTRY'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const stateKey = sessionStorageKey('aether.work.state.v1', engineStorageKey({ mode: 'remote', baseUrl: origin }))
    await page.evaluate(({ stateKey, sessionId, title, now, model, workspace }) => {
      localStorage.setItem(stateKey, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'done', draft: '', createdAt: now, updatedAt: now,
        workspacePath: workspace, modelId: model, attachments: [], sources: [] }], activeTaskId: sessionId }))
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
    }, { stateKey, sessionId, title, now, model, workspace })
    await page.reload(); await expect(page.locator('.work-task-heading h1')).toHaveText(title)
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && page && !page.isClosed()) await page.screenshot({ path: info.outputPath('loading-failure.png') })
    expect(errors).toEqual([])
  })
  test.afterAll(async () => {
    releaseApp?.(); releaseAgents?.()
    for (const release of pendingReleases) release()
    try { await app?.close() } finally {
      for (const response of catalogueStreams) response.end()
      await new Promise<void>(done => server.close(() => done()))
      writeFileSync(join(fixture, 'request-counts.json'), JSON.stringify({ counts, appReads, errors }, null, 2))
    }
  })

  test('独立慢插件不阻塞快速导航，纯工具插件不读取应用页面', async () => {
    await expect.poll(() => appReads.slow).toBeGreaterThan(0)
    await expect(navigation('fast')).toBeVisible()
    await expect(navigation('slow')).toHaveCount(0)
    expect(appReads.tools).toBe(0)
    releaseApp?.()
    await expect(navigation('slow')).toBeVisible()
    expect(appReads.tools).toBe(0)
  })

  test('自定义Agent延迟不挡插件菜单，同scope重开复用目录且不闪加载', async () => {
    await openPicker()
    await expect(picker().getByRole('option').filter({ hasText: names.fast })).toBeVisible()
    await expect(picker().getByRole('group', { name: '协作 Agent', exact: true })).toHaveAttribute('aria-busy', 'true')
    await expect.poll(() => counts.agents).toBeGreaterThan(0)
    releaseAgents?.()
    await expect(picker().getByRole('option').filter({ hasText: '自定义审阅' })).toBeVisible()
    await expect(picker().getByRole('listbox')).toHaveAttribute('aria-busy', 'false')
    await closePicker()
    const before = { agents: counts.agents, toolkits: counts.toolkits }
    await page.evaluate(() => {
      document.body.dataset.catalogueLoadingObserved = 'false'
      const observer = new MutationObserver(records => {
        if (records.some(record => [...record.addedNodes].some(node => node.textContent?.includes('正在加载自定义 Agent')))) document.body.dataset.catalogueLoadingObserved = 'true'
      })
      observer.observe(document.body, { childList: true, subtree: true })
      ;(window as Window & { catalogueLoadingObserver?: MutationObserver }).catalogueLoadingObserver = observer
    })
    for (let attempt = 0; attempt < 3; attempt++) {
      await openPicker(); await expect(picker().getByRole('option').filter({ hasText: '自定义审阅' })).toBeVisible()
      await animationFrames(); await expect(picker().getByRole('listbox')).toHaveAttribute('aria-busy', 'false'); await closePicker()
    }
    expect({ agents: counts.agents, toolkits: counts.toolkits }).toEqual(before)
    await expect(page.locator('body')).toHaveAttribute('data-catalogue-loading-observed', 'false')
    await page.evaluate(() => { (window as Window & { catalogueLoadingObserver?: MutationObserver }).catalogueLoadingObserver?.disconnect() })
  })

  test('真实停用使菜单失效，同时保留未变化插件的已加载应用', async () => {
    const beforeApps = { ...appReads }, beforeToolkits = counts.toolkits
    await page.locator('.work-navigation').getByRole('button', { name: '插件', exact: true }).click()
    const toggle = page.getByRole('switch', { name: `启用插件 ${names.slow}`, exact: true })
    await expect(toggle).toHaveAttribute('aria-checked', 'true'); await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(navigation('slow')).toHaveCount(0); await expect(navigation('fast')).toBeVisible()
    await page.locator(`[data-task-id="${sessionId}"]`).getByRole('button').first().click()
    await expect(page.locator('.work-task-heading h1')).toHaveText(title)
    await openPicker()
    await expect(picker().getByRole('option').filter({ hasText: names.fast })).toBeVisible()
    await expect(picker().getByRole('listbox')).toHaveAttribute('aria-busy', 'false')
    await expect(picker().getByRole('option').filter({ hasText: names.slow })).toHaveCount(0)
    expect(counts.toolkits).toBeGreaterThan(beforeToolkits)
    expect(appReads).toEqual(beforeApps)
    await closePicker()
  })

  test('发布回执迟于页面卸载时无需重启即挂载导航、工作区、服务与已缓存的@目录', async ({}, info) => {
    await openPicker()
    await expect(picker().getByRole('listbox')).toHaveAttribute('aria-busy', 'false')
    await expect(picker().locator('[data-toolkit-id="plugin-late--r1"]')).toHaveCount(0)
    await closePicker()
    const beforeApps = { ...appReads }, beforeToolkits = counts.toolkits, beforePublishes = counts.publishes
    await page.evaluate(() => { document.body.dataset.pluginLifecycleDocument = 'same-document' })
    publishGate = deferredResponse()
    try {
      await openManager()
      await manager().getByRole('button', { name: `编辑插件 ${names.late}`, exact: true }).click()
      await expect(manager().getByLabel('名称', { exact: true })).toHaveValue(names.late)
      await manager().getByRole('button', { name: '发布并启用', exact: true }).click()
      await expect.poll(() => counts.publishes).toBe(beforePublishes + 1)
      await openTask()
      await expect(manager()).toHaveCount(0)
      await expect(navigation('late')).toHaveCount(0)
      expect(enabled.late).toBe(false)
      publishGate.release()
      await expect(navigation('late')).toBeVisible()
      await expect.poll(() => published.late && enabled.late).toBe(true)
      await expect(page.locator('body')).toHaveAttribute('data-plugin-lifecycle-document', 'same-document')
      await openPicker()
      await expect(picker().locator('[data-toolkit-id="plugin-late--r1"]')).toBeVisible()
      expect(counts.toolkits).toBeGreaterThan(beforeToolkits)
      await closePicker()
      await workspaceEntry('late', true, true)
      await serviceEntry('late', true)
      expect(appReads.fast).toBe(beforeApps.fast)
      expect(appReads.slow).toBe(beforeApps.slow)
      expect(appReads.tools).toBe(0)
      expect(appReads.late).toBe(beforeApps.late + 1)
      await page.screenshot({ path: info.outputPath('late-publish-mounted.png'), animations: 'disabled' })
    } finally { publishGate?.release(); publishGate = undefined }
  })

  test('应用首次读取短暂失败会自动恢复且不重载已有插件', async () => {
    const beforeApps = { ...appReads }, beforeFailures = counts.failedApplications
    applicationResponses.set('recover', { failures: 1 })
    await openManager()
    await togglePlugin('recover', true)
    await expect.poll(() => counts.failedApplications).toBe(beforeFailures + 1)
    // No manual refresh, navigation, toggle or renderer reload may trigger recovery.
    await expect(navigation('recover')).toBeVisible({ timeout: 15_000 })
    expect(appReads.recover).toBeGreaterThanOrEqual(beforeApps.recover + 2)
    expect(appReads.fast).toBe(beforeApps.fast)
    expect(appReads.late).toBe(beforeApps.late)
    await navigation('recover').click()
    await expect(page.frameLocator(`iframe[title="${names.recover}"]`).getByRole('heading')).toHaveText(names.recover)
    await expect(page.locator('body')).toHaveAttribute('data-plugin-lifecycle-document', 'same-document')
  })

  test('同一修订停用再启用会新建应用请求，迟到失败不能卸载新注册', async () => {
    const beforeApps = { ...appReads }, beforeFailures = counts.failedApplications, oldResponse = deferredResponse()
    applicationResponses.set('recycle', { gate: oldResponse, failures: 1 })
    try {
      await openManager()
      await togglePlugin('recycle', true)
      await expect.poll(() => appReads.recycle).toBe(beforeApps.recycle + 1)
      await expect(navigation('recycle')).toHaveCount(0)
      await togglePlugin('recycle', false)
      await togglePlugin('recycle', true)
      // The first response is deliberately still pending: reusing it makes this fail.
      await expect.poll(() => appReads.recycle).toBeGreaterThanOrEqual(beforeApps.recycle + 2)
      await expect(navigation('recycle')).toBeVisible()
      oldResponse.release()
      await expect.poll(() => counts.failedApplications).toBe(beforeFailures + 1)
      await navigation('recycle').click()
      await expect(page.frameLocator(`iframe[title="${names.recycle}"]`).getByRole('heading')).toHaveText(names.recycle)
      await expect(navigation('recycle')).toBeVisible()
      expect(plugin('recycle').publishedRevision).toBe(1)
      expect(appReads.fast).toBe(beforeApps.fast)
      expect(appReads.late).toBe(beforeApps.late)
      expect(appReads.recover).toBe(beforeApps.recover)
    } finally { oldResponse.release() }
  })

  test('后台发布和停用通过目录流同步各入口，断线重连补齐漏掉的启用事件', async ({}, info) => {
    await openTask()
    await openPicker()
    await expect(picker().getByRole('listbox')).toHaveAttribute('aria-busy', 'false')
    await expect(picker().locator('[data-toolkit-id="plugin-background--r1"]')).toHaveCount(0)
    await closePicker()
    await expect.poll(() => catalogueStreams.size).toBe(1)
    const beforeApps = { ...appReads }, beforeToolkits = counts.toolkits
    // These mutations never visit PluginManager or emit a renderer-side custom event.
    backgroundChange('background', true, 'publish')
    await expect(navigation('background')).toBeVisible()
    await openPicker()
    await expect(picker().locator('[data-toolkit-id="plugin-background--r1"]')).toBeVisible()
    await closePicker()
    await workspaceEntry('background', true, true)
    await serviceEntry('background', true)
    backgroundChange('background', false)
    await expect(navigation('background')).toHaveCount(0)
    await expect(page.locator(`iframe[title="${names.background}"]`)).toHaveCount(0)
    await openTask()
    await workspaceEntry('background', false)
    await serviceEntry('background', false)
    await openPicker()
    await expect(picker().getByRole('listbox')).toHaveAttribute('aria-busy', 'false')
    await expect(picker().locator('[data-toolkit-id="plugin-background--r1"]')).toHaveCount(0)
    await closePicker()
    const beforeConnections = counts.catalogueStreams
    for (const response of catalogueStreams) response.end()
    // No event is sent for this committed change; reconnect's initial refresh must find it.
    enabled.background = true
    await expect.poll(() => counts.catalogueStreams, { timeout: 15_000 }).toBeGreaterThan(beforeConnections)
    await expect(navigation('background')).toBeVisible()
    await workspaceEntry('background', true, true)
    await serviceEntry('background', true)
    await openPicker()
    await expect(picker().locator('[data-toolkit-id="plugin-background--r1"]')).toBeVisible()
    await closePicker()
    expect(counts.toolkits).toBeGreaterThan(beforeToolkits)
    expect(appReads.background).toBe(beforeApps.background + 2)
    expect(appReads.fast).toBe(beforeApps.fast)
    expect(appReads.late).toBe(beforeApps.late)
    expect(appReads.recover).toBe(beforeApps.recover)
    expect(appReads.recycle).toBe(beforeApps.recycle)
    await expect(page.locator('body')).toHaveAttribute('data-plugin-lifecycle-document', 'same-document')
    await page.screenshot({ path: info.outputPath('background-reconnected-mounted.png'), animations: 'disabled' })
  })

  test('目录短暂503期间保留已挂载插件，自动重试恢复且不重读应用', async () => {
    await openTask()
    await expect(manager()).toHaveCount(0)
    await expect(navigation('fast')).toBeVisible()
    await expect(navigation('background')).toBeVisible()
    const beforeApps = { ...appReads }, beforeLists = counts.lists, beforeFailures = counts.failedLists, beforeSuccesses = counts.successfulLists
    const recovery = deferredResponse()
    listFailuresRemaining = 1; listSuccessGate = recovery
    try {
      for (const response of catalogueStreams) response.write(catalogueEvent('refresh', '*'))
      await expect.poll(() => counts.failedLists).toBe(beforeFailures + 1)
      await expect.poll(() => counts.lists, { timeout: 15_000 }).toBe(beforeLists + 2)
      // The recovery response is still withheld; retaining navigation here cannot
      // be explained by an unload followed by a fast successful application read.
      expect(counts.successfulLists).toBe(beforeSuccesses)
      await expect(navigation('fast')).toBeVisible()
      await expect(navigation('late')).toBeVisible()
      await expect(navigation('background')).toBeVisible()
      expect(appReads).toEqual(beforeApps)
      recovery.release()
      await expect.poll(() => counts.successfulLists).toBe(beforeSuccesses + 1)
      await animationFrames()
      await expect(navigation('fast')).toBeVisible()
      await expect(navigation('background')).toBeVisible()
      expect(counts.lists).toBe(beforeLists + 2)
      expect(appReads).toEqual(beforeApps)
      await expect(page.locator('body')).toHaveAttribute('data-plugin-lifecycle-document', 'same-document')
    } finally { recovery.release(); listSuccessGate = undefined; listFailuresRemaining = 0 }
  })

  test('手动刷新同时补齐扩展宿主和@缓存中未收到通知的后台变更', async () => {
    await openTask()
    await openPicker()
    await expect(picker().getByRole('listbox')).toHaveAttribute('aria-busy', 'false')
    await expect(picker().locator('[data-toolkit-id="plugin-slow--r1"]')).toHaveCount(0)
    await closePicker()
    const beforeApps = { ...appReads }, beforeToolkits = counts.toolkits, beforeConnections = counts.catalogueStreams
    expect(enabled.slow).toBe(false)
    enabled.slow = true // Commit only: intentionally neither SSE nor a management receipt.
    await openManager()
    await expect(manager().getByRole('switch', { name: `启用插件 ${names.slow}`, exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect(navigation('slow')).toHaveCount(0)
    await manager().getByRole('button', { name: '刷新插件', exact: true }).click()
    await expect(navigation('slow')).toBeVisible()
    await openTask()
    await openPicker()
    await expect(picker().locator('[data-toolkit-id="plugin-slow--r1"]')).toBeVisible()
    expect(counts.toolkits).toBeGreaterThan(beforeToolkits)
    await closePicker()
    expect(counts.catalogueStreams).toBe(beforeConnections)
    expect(appReads).toEqual({ ...beforeApps, slow: beforeApps.slow + 1 })
    await expect(page.locator('body')).toHaveAttribute('data-plugin-lifecycle-document', 'same-document')
  })
})
