/** Real Electron extension host: published custom HTML, constrained bridge, session/workspace
 * contributions, service lifetime, disable/revision unload and stale results. Isolated HTTP
 * engine fixture/profile only; never a production plugin, model request or data directory.
 * Build first, then run serially with the other Electron specs. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { PluginApplication, PluginManifest, PluginRecord } from '../src/renderer/src/core/engine/plugins'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'extension-host-fixture', pluginId = 'extension-timer', pluginName = '扩展计时器', model = 'extension-model'
const first = 'work-extension-session-one', second = 'work-extension-session-two', now = Date.now() - 5000
const taskTitles: Record<string, string> = { [first]: '插件会话一', [second]: '插件会话二' }, workspace = (id: string) => `/extension-fixture/${id}`
const errors: string[] = [], invokes: Array<{ revision: number; tool: string; args: Record<string, unknown> }> = []
let app: ElectronApplication | undefined, page: Page, fixture = '', origin = '', enabled = true, revision = 1
let releaseSlow: (() => void) | undefined, slowGate: Promise<void> | undefined
const hash = () => `sha256:${String(revision).repeat(64)}`
const manifest = (): PluginManifest => ({ apiVersion: 1, id: pluginId, name: pluginName, version: `${revision}.0.0`,
  description: '外部插件贡献真实验收', runtime: 'node', tools: ['echo', 'start', 'stop', 'private_tool'].map(name => ({ name,
    description: name, entry: 'main.mjs', inputSchema: { type: 'object', properties: {}, additionalProperties: true } })),
  contributes: {
    pages: [{ id: 'timer', title: '计时器页面', kind: 'webview', entry: 'ui/index.html', tools: ['echo'] }],
    navigation: [{ id: 'timer', title: '外部计时器', page: 'timer', icon: 'clock', when: { engineReady: true } }],
    workspaceTabs: [{ id: 'timer-tab', title: '计时器标签', page: 'timer', scope: 'session', when: { workspace: true } }],
    services: [{ id: 'countdown', title: '会话倒计时', tool: 'start', stopTool: 'stop', page: 'timer', scope: 'session', when: { workspace: true, engineReady: true } }],
  } })
const record = (): PluginRecord => ({ id: pluginId, name: pluginName, description: '外部插件贡献真实验收', enabled, revision,
  publishedRevision: revision, manifest: manifest(), revisions: [{ revision, hash: hash(), createdAt: now }], createdAt: now, updatedAt: Date.now() })
const customHTML = () => `<main><h1>自定义计时器 r${revision}</h1><pre id="context"></pre><pre id="output"></pre>
<label>插件草稿<input id="draft" aria-label="插件草稿"></label>
<button id="echo">调用已授权工具</button><button id="forbidden">调用未授权工具</button>
<button id="start">开始倒计时</button><button id="slow">启动延迟服务</button><button id="stop">停止倒计时</button>
<form id="echo-form"><label>表单输入<input id="form-text" aria-label="表单输入" required></label><button type="submit">提交表单</button></form>
<form action="aether-plugin-ui://document/blocked"><button type="submit">禁止表单导航</button></form><pre id="form-policy"></pre>
<pre id="services"></pre></main><script>
const output = document.getElementById('output'), show = value => { output.textContent = JSON.stringify(value); };
window.aetherPlugin.context().then(value => { document.getElementById('context').textContent = JSON.stringify(value); });
document.getElementById('echo').onclick = () => window.aetherPlugin.invoke('echo', {text:'bridge-ok'}).then(show);
document.getElementById('forbidden').onclick = () => window.aetherPlugin.invoke('private_tool', {}).then(show).catch(error => show({error:error.message}));
document.getElementById('start').onclick = () => window.aetherPlugin.services.start('countdown', {delayMs:5000}).then(show);
document.getElementById('slow').onclick = () => window.aetherPlugin.services.start('countdown', {slow:true}).then(show);
document.getElementById('stop').onclick = () => window.aetherPlugin.services.stop('countdown').then(show);
document.getElementById('echo-form').onsubmit = event => { event.preventDefault(); window.aetherPlugin.invoke('echo', {text:document.getElementById('form-text').value}).then(show); };
document.addEventListener('securitypolicyviolation', event => { document.getElementById('form-policy').textContent = event.effectiveDirective; });
const renderServices = value => { document.getElementById('services').textContent = JSON.stringify(value); };
window.aetherPlugin.services.subscribe(renderServices); window.aetherPlugin.services.get().then(renderServices);
</script>`
const application = (): PluginApplication => ({ id: pluginId, name: pluginName, description: '外部插件贡献真实验收', revision,
  hash: hash(), manifest: manifest(), examples: [], execution: { allowed: true }, uiDocuments: { timer: customHTML() } })
const history = (sessionId: string) => [{ id: `${sessionId}-user`, role: 'user', content: taskTitles[sessionId] ?? '插件验收', conversationId: `${sessionId}-turn`, createdAt: now },
  { id: `${sessionId}-assistant`, role: 'assistant', content: '会话已就绪。', conversationId: `${sessionId}-turn`, createdAt: now + 1 }]
const envelope = (data: unknown) => JSON.stringify({ code: 200, message: 'ok', data })
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', origin || 'http://127.0.0.1'), path = url.pathname
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Missing fixture token: ${path}`)
  let raw = ''; for await (const chunk of request) raw += chunk.toString()
  const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
  const sessionId = url.searchParams.get('sessionId') ?? (typeof body.sessionId === 'string' ? body.sessionId : first)
  if (path === `/api/v1/plugins/${pluginId}` && request.method === 'PATCH') {
    if (typeof body.enabled !== 'boolean') throw new Error('Plugin toggle requires boolean')
    enabled = body.enabled; response.end(envelope({ plugin: record() })); return
  }
  if (path === `/api/v1/plugins/runtime/apps/${pluginId}/invoke`) {
    if (request.method !== 'POST' || !enabled || body.revision !== revision || typeof body.tool !== 'string') throw new Error('Invalid pinned plugin invocation')
    const call = { revision, tool: body.tool, args: body.args as Record<string, unknown> }, pinnedHash = hash()
    invokes.push(call)
    if (call.args.slow && slowGate) await slowGate
    const result = call.tool === 'echo' ? { echo: call.args.text, revision: call.revision }
      : call.tool === 'stop' ? { status: 'stopped', detail: '用户已停止' }
        : { status: 'running', detail: `r${call.revision} 倒计时`, completesAt: Date.now() + Number(call.args.delayMs ?? 60_000) }
    response.end(envelope({ result, artifacts: [], stderr: '', durationMs: 1, plugin: { id: pluginId, revision: call.revision, hash: pinnedHash } })); return
  }
  if (path === `/api/v1/plugins/runtime/apps/${pluginId}`) {
    if (!enabled || Number(url.searchParams.get('revision')) !== revision) throw new Error('Invalid plugin app revision')
    response.end(envelope({ application: application() })); return
  }
  if (path === '/api/v1/conversation/display') {
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: [{ userMessageId: `${sessionId}-user`, conversationId: `${sessionId}-turn`, preview: taskTitles[sessionId], createdAt: now }],
      messages: history(sessionId), loadedTurnIds: [`${sessionId}-user`], revision: 'stable', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/browser/hosts', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && path !== '/api/v1/workspace/bind') throw new Error(`Unexpected write: ${request.method} ${path}`)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'8'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: token }
    : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '插件测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', eventId: null, finished: true, history: history(sessionId), projection: [], runs: [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: [] }
    : path === '/api/v1/conversation/history' ? history(sessionId)
    : path === '/api/v1/conversation/sessions' ? [first, second].map(id => ({ sessionId: id, title: taskTitles[id], lastAt: now, messageCount: 2 }))
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'off', effectiveScope: 'off', enabled: false }
    : path === '/api/v1/memory/preferences' ? { enabled: false, globalEnabled: false, sessionDefaultEnabled: false }
    : path === '/api/v1/workspace/directory' ? { root: workspace(sessionId), bindingEpoch: sessionId, entries: [] }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: workspace(sessionId) }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] }
    : path === '/api/v1/plugins' ? { plugins: [record()] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const frame = () => page.frameLocator('iframe[title="计时器页面"]')
const navigation = () => page.locator('.work-navigation').getByRole('button', { name: '外部计时器', exact: true })
const tray = () => page.locator('.service-tray__panel')
const serviceRow = () => tray().locator('.service-tray__row').filter({ hasText: '会话倒计时' })
async function openTask(id = first): Promise<void> {
  await page.locator(`[data-task-id="${id}"]`).getByRole('button').first().click()
  await expect(page.locator('.work-task-heading h1')).toHaveText(taskTitles[id])
}
async function openTray(): Promise<void> {
  if (!(await tray().isVisible())) await page.locator('.service-tray__button').click()
  await expect(tray()).toBeVisible()
  if (await tray().getByRole('button', { name: '返回活动列表', exact: true }).isVisible()) await tray().getByRole('button', { name: '返回活动列表', exact: true }).click()
  await tray().getByRole('tab', { name: '服务', exact: true }).click()
}
async function closeTray(): Promise<void> { if (await tray().isVisible()) await page.keyboard.press('Escape') }
async function togglePlugin(value: boolean): Promise<void> {
  await page.locator('.work-navigation').getByRole('button', { name: '插件', exact: true }).click()
  const control = page.getByRole('switch', { name: `启用插件 ${pluginName}`, exact: true })
  await expect(control).toHaveAttribute('aria-checked', String(!value))
  await control.click()
  await expect(control).toHaveAttribute('aria-checked', String(value))
  await expect.poll(() => enabled).toBe(value)
}
async function setTheme(appearance: 'light' | 'dark', accent: '蓝色' | '紫色'): Promise<void> {
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
  await settings.getByRole('radio', { name: accent, exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await expect(page.locator('html')).toHaveAttribute('data-accent', accent === '紫色' ? 'purple' : 'blue')
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).toHaveCount(0)
}

test.describe.serial('外部插件宿主真实贡献与生命周期', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'extension-host-profile-'))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    origin = `http://127.0.0.1:${address.port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, remoteWorkspaceRoot: workspace(first), autoStartEngine: true,
      lastFolder: '', lastModelId: model, appearance: 'light', accent: 'blue', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_ENGINE_ENTRY'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const stateKey = sessionStorageKey('aether.work.state.v1', engineStorageKey({ mode: 'remote', baseUrl: origin }))
    await page.evaluate(({ stateKey, first, second, taskTitles, now, model }) => {
      localStorage.setItem(stateKey, JSON.stringify({ tasks: [first, second].map(id => ({ id, title: taskTitles[id], status: 'done', draft: '', createdAt: now, updatedAt: now,
        workspacePath: `/extension-fixture/${id}`, modelId: model, attachments: [], sources: [] })), activeTaskId: first }))
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
    }, { stateKey, first, second, taskTitles, now, model })
    await page.reload()
    await expect(page.locator('.work-task-heading h1')).toHaveText(taskTitles[first])
    await expect(navigation()).toBeVisible()
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && page && !page.isClosed()) await page.screenshot({ path: info.outputPath('extension-host-failure.png') })
    expect(errors).toEqual([])
  })
  test.afterAll(async () => {
    releaseSlow?.()
    try { await app?.close() } finally {
      await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('extension-host-profile-')) throw new Error(`Unsafe extension fixture cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('发布插件提供导航与真实自定义HTML，bridge遵守白名单并隔离宿主权限', async () => {
    await navigation().click()
    await expect(frame().getByRole('heading')).toHaveText('自定义计时器 r1')
    await expect(frame().locator('#context')).toContainText(`"sessionId":"${first}"`)
    await expect(frame().locator('#context')).toContainText(`"workspacePath":"${workspace(first)}"`)
    await expect(frame().locator('#context')).toContainText('"engineReady":true')
    const iframe = page.locator('iframe[title="计时器页面"]')
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-forms')
    await expect(iframe).toHaveAttribute('data-ready', 'true')
    await expect(iframe).toHaveAttribute('src', /^aether-plugin-ui:\/\/document\//)
    expect(await frame().locator('body').evaluate(() => ({ preload: 'aether' in window, origin: window.origin }))).toEqual({ preload: false, origin: 'null' })
    await frame().locator('#echo').click()
    await expect(frame().locator('#output')).toContainText('bridge-ok')
    expect(invokes).toEqual([{ revision: 1, tool: 'echo', args: { text: 'bridge-ok' } }])
    await frame().locator('#forbidden').click()
    await expect(frame().locator('#output')).toContainText('此页面未声明该工具权限')
    expect(invokes).toHaveLength(1)
    await frame().getByRole('button', { name: '提交表单', exact: true }).click()
    await expect(frame().locator('#form-text:invalid')).toBeVisible()
    expect(invokes).toHaveLength(1)
    await frame().getByRole('textbox', { name: '表单输入', exact: true }).fill('native-form-ok')
    await frame().getByRole('button', { name: '提交表单', exact: true }).click()
    await expect(frame().locator('#output')).toContainText('native-form-ok')
    expect(invokes.at(-1)).toEqual({ revision: 1, tool: 'echo', args: { text: 'native-form-ok' } })
    const documentUrl = await iframe.getAttribute('src'), windowCount = app!.windows().length
    await frame().getByRole('button', { name: '禁止表单导航', exact: true }).click()
    await expect(frame().locator('#form-policy')).toHaveText('form-action')
    await expect(iframe).toHaveAttribute('src', documentUrl!)
    expect(await frame().locator('body').evaluate(() => location.href)).toBe(documentUrl)
    expect(app!.windows()).toHaveLength(windowCount)
  })

  test('关闭插件页面后宿主倒计时继续完成并产生服务通知', async () => {
    await frame().locator('#start').click()
    await expect(frame().locator('#output')).toContainText('running')
    await openTask()
    await openTray()
    await expect(serviceRow()).toContainText('运行中')
    await expect(serviceRow()).toContainText('已完成', { timeout: 10_000 })
    await tray().getByRole('tab', { name: /^通知/ }).click()
    await expect(serviceRow()).toContainText('已完成')
    await expect(serviceRow()).toHaveAttribute('data-unread', 'true')
    await closeTray()
  })

  test('宿主外观与强调色实时同步到沙箱页面，切换主题不重载或丢失草稿', async () => {
    await navigation().click()
    await expect(frame().locator('html')).toHaveCSS('color-scheme', 'light')
    await frame().getByRole('textbox', { name: '插件草稿', exact: true }).fill('保持输入内容 · 中文😀')
    const documentUrl = await page.locator('iframe[title="计时器页面"]').getAttribute('src')
    for (const [appearance, accent] of [['dark', '紫色'], ['light', '蓝色']] as const) {
      await setTheme(appearance, accent)
      const host = await page.locator('html').evaluate(element => {
        const style = getComputedStyle(element)
        return { background: style.getPropertyValue('--bg-surface').trim(), foreground: style.getPropertyValue('--fg').trim(), accent: style.getPropertyValue('--accent').trim() }
      })
      await expect(frame().locator('html')).toHaveCSS('color-scheme', appearance)
      await expect.poll(() => frame().locator('html').evaluate(element => ({
        background: element.style.getPropertyValue('--bg-surface'), foreground: element.style.getPropertyValue('--fg'), accent: element.style.getPropertyValue('--accent')
      }))).toEqual(host)
      await expect(frame().getByRole('textbox', { name: '插件草稿', exact: true })).toHaveValue('保持输入内容 · 中文😀')
      await expect(page.locator('iframe[title="计时器页面"]')).toHaveAttribute('src', documentUrl!)
    }
    await openTask()
  })

  test('工作区标签使用相同bridge，切换会话后服务状态与上下文互不串用', async () => {
    await page.getByRole('button', { name: '打开工作区', exact: true }).click()
    await page.getByRole('button', { name: '更多工作区', exact: true }).click()
    await page.getByRole('menuitem', { name: '计时器标签', exact: true }).click()
    await expect(page.locator('[id="work-panel-plugin:extension-timer:timer-tab"]')).toBeVisible()
    await expect(frame().locator('#context')).toContainText(`"sessionId":"${first}"`)
    await expect(frame().locator('#services')).toContainText('completed')
    await openTask(second)
    await navigation().click()
    await expect(frame().locator('#context')).toContainText(`"sessionId":"${second}"`)
    await expect(frame().locator('#context')).toContainText(`"workspacePath":"${workspace(second)}"`)
    await frame().locator('#stop').click()
    await expect(frame().locator('#output')).toContainText('stopped')
    await expect(frame().locator('#output')).not.toContainText(first)
    await openTask(first)
    await openTray()
    await expect(serviceRow()).toContainText('已完成')
    await closeTray()
  })

  test('停用卸载导航、页面、工作区标签和服务，修订替换忽略旧异步回执', async () => {
    await navigation().click()
    slowGate = new Promise<void>(done => { releaseSlow = done })
    await frame().locator('#slow').click()
    await expect.poll(() => invokes.some(call => call.args.slow === true)).toBe(true)
    await togglePlugin(false)
    await expect(navigation()).toHaveCount(0)
    await expect(page.locator('[data-extension-id="extension-timer"]')).toHaveCount(0)
    await openTask(first)
    await openTray()
    await expect(serviceRow()).toHaveCount(0)
    await closeTray()
    if (await page.getByRole('button', { name: '打开工作区', exact: true }).isVisible()) await page.getByRole('button', { name: '打开工作区', exact: true }).click()
    await page.getByRole('button', { name: '更多工作区', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: '计时器标签', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    revision = 2
    await togglePlugin(true)
    await expect(navigation()).toBeVisible()
    await navigation().click()
    await expect(frame().getByRole('heading')).toHaveText('自定义计时器 r2')
    releaseSlow?.(); slowGate = undefined
    await expect(frame().locator('#context')).toContainText('"revision":2')
    await frame().locator('#stop').click()
    await expect(frame().locator('#output')).toContainText('stopped')
    await expect(frame().locator('#output')).not.toContainText('r1')
    expect(invokes.filter(call => call.tool === 'start' && call.args.slow === true)).toEqual([{ revision: 1, tool: 'start', args: { slow: true } }])
    expect(invokes.at(-1)).toEqual({ revision: 2, tool: 'stop', args: {} })
  })
})
