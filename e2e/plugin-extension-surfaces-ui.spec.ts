/** Actual renderer mounts and context routing, using an isolated authenticated
 * engine fixture. Build before running; this Electron spec must run serially. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { PluginManifest, PluginRecord } from '../src/renderer/src/core/engine/plugins'
import type { PluginMenuLocation } from '../src/shared/plugin-contributions'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp', 'plugin-extension-surfaces')
const pluginId = 'extension-surfaces', token = 'extension-surfaces-token', model = 'fixture-model', now = Date.now() - 10_000
const first = 'work-surfaces-one', second = 'work-surfaces-two', workspace = (id = first) => `/extension-surfaces/${id}`
const titles: Record<string, string> = { [first]: '扩展入口会话一', [second]: '扩展入口会话二' }
const errors: string[] = [], invokes: Record<string, unknown>[] = [], events: Record<string, unknown>[] = []
const code = 'const alpha = 1\nconst beta = alpha + 2 // TODO\nconsole.log(beta)\n'
let app: ElectronApplication | undefined, page: Page, fixture = '', origin = ''
const locations: PluginMenuLocation[] = ['message.actions', 'session.context', 'file.context', 'editor.context', 'editor.toolbar', 'composer.toolbar', 'service.context']
const manifest: PluginManifest = { apiVersion: 1, id: pluginId, name: '扩展入口验收', version: '1.0.0', description: '真实界面入口验收', runtime: 'node',
  tools: ['inspect', 'start'].map(name => ({ name, description: name, entry: 'main.mjs', inputSchema: { type: 'object' } })),
  contributes: {
    pages: [{ id: 'panel', title: '扩展入口面板', kind: 'webview', entry: 'ui/panel.html', tools: ['inspect'] }],
    commands: locations.map(location => ({ id: location, title: `检查 ${location}`, tool: 'inspect', args: { location }, scope: 'session' })),
    menus: locations.map(location => ({ id: location, title: `检查 ${location}`, location, command: location, scope: 'session' })),
    views: [...(['message.inline', 'composer.panel', 'workspace.panel'] as const).map(location => ({ id: location, title: location, location, page: 'panel', height: 100, scope: 'session' as const })),
      ...Array.from({ length: 5 }, (_, index) => ({ id: `extra-${index}`, title: `额外区域 ${index + 1}`, location: 'composer.panel' as const, page: 'panel', height: 100, scope: 'session' as const }))],
    editorDecorations: [{ id: 'todo', title: '待办提示', text: '检测到待办', pattern: 'TODO', severity: 'warning', scope: 'session' }],
    services: [{ id: 'fixture', title: '入口测试服务', tool: 'start', scope: 'session' }],
    hooks: (['composer.changed', 'editor.selectionChanged', 'session.changed', 'file.changed'] as const).map(event => ({ id: event, title: event, event, tool: 'inspect', scope: 'session' }))
  } }
const hash = `sha256:${'2'.repeat(64)}`
const record: PluginRecord = { id: pluginId, name: manifest.name, description: manifest.description, enabled: true, revision: 1, publishedRevision: 1, manifest,
  revisions: [{ revision: 1, hash, createdAt: now }], createdAt: now, updatedAt: now }
const html = `<pre id="context"></pre><pre id="result"></pre>
<button id="get-composer">读取输入</button><button id="set-composer">设置输入</button><button id="insert-composer">补充输入</button>
<button id="get-editor">读取编辑器</button><button id="reveal-editor">定位编辑器</button><button id="replace-editor">替换选区</button>
<button id="start-service">启动服务</button><script>
const out = value => { document.querySelector('#result').textContent = JSON.stringify(value); };
const run = callback => callback().then(out).catch(error => out({error:error.message}));
aetherPlugin.context().then(value => { document.querySelector('#context').textContent = JSON.stringify(value); });
document.querySelector('#get-composer').onclick = () => run(() => $AE.ui.composer.get());
document.querySelector('#set-composer').onclick = () => run(() => $AE.ui.composer.set('插件生成草稿'));
document.querySelector('#insert-composer').onclick = () => run(() => $AE.ui.composer.insert('，补充要求'));
document.querySelector('#get-editor').onclick = () => run(() => $AE.ui.editor.get());
document.querySelector('#reveal-editor').onclick = () => run(() => $AE.ui.editor.reveal({line:2,column:1}));
document.querySelector('#replace-editor').onclick = () => run(() => $AE.ui.editor.replaceSelection('不应写入'));
document.querySelector('#start-service').onclick = () => run(() => aetherPlugin.services.start('fixture', {}));
</script>`
const history = (id: string) => [{ id: `${id}-user`, role: 'user', content: titles[id], createdAt: now, conversationId: `${id}-turn` },
  { id: `${id}-assistant`, role: 'assistant', content: '已完成入口测试准备。', createdAt: now + 1, conversationId: `${id}-turn` }]
const envelope = (data: unknown) => JSON.stringify({ code: 200, message: 'ok', data })
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', origin || 'http://127.0.0.1'), path = url.pathname
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Missing token: ${path}`)
  let raw = ''; for await (const chunk of request) raw += chunk.toString()
  const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
  const sessionId = url.searchParams.get('sessionId') ?? (typeof body.sessionId === 'string' ? body.sessionId : first)
  if (path === '/api/v1/chat/admission/context') {
    response.end(envelope({ protocolVersion: 1, tenantId: 'surfaces-fixture', sessionId,
      namespace: { id: 'surfaces-db', generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null })); return
  }
  if (path === '/api/v1/chat/admission/receipt' && request.method === 'POST') {
    response.end(envelope({ protocolVersion: 1, status: 'absent', namespace: body.namespace, sessionId: body.sessionId, requestKey: body.requestKey })); return
  }
  if (path === `/api/v1/plugins/runtime/apps/${pluginId}/invoke`) {
    invokes.push(body); response.end(envelope({ result: body.tool === 'start' ? { status: 'running', detail: '测试服务' } : body,
      artifacts: [], stderr: '', durationMs: 1, plugin: { id: pluginId, revision: 1, hash } })); return
  }
  if (path === `/api/v1/plugins/${pluginId}/capabilities/invoke`) {
    if (body.method !== 'host.authorize') throw new Error('Unexpected capability')
    response.end(envelope({ result: { allowed: true } })); return
  }
  if (path === '/api/v1/plugins/runtime/events') { events.push(body); response.end(envelope({ delivered: 1 })); return }
  if (path === `/api/v1/plugins/runtime/apps/${pluginId}`) {
    response.end(envelope({ application: { id: pluginId, name: manifest.name, description: manifest.description, revision: 1, hash, manifest, examples: [], execution: { allowed: true }, uiDocuments: { panel: html } } })); return
  }
  if (path === '/api/v1/conversation/display') {
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: [{ userMessageId: `${sessionId}-user`, conversationId: `${sessionId}-turn`, preview: titles[sessionId], createdAt: now }],
      messages: history(sessionId), loadedTurnIds: [`${sessionId}-user`], revision: 'stable', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (path === '/api/v1/workspace/file/info' || path === '/api/v1/workspace/file/content') {
    const filePath = url.searchParams.get('path') ?? '', name = filePath.split('/').at(-1)
    const content = name === 'demo.ts' ? code : 'second file\n'
    response.end(envelope(path.endsWith('/info') ? { workspacePath: filePath, isDirectory: false, size: Buffer.byteLength(content), mtimeMs: 1 }
      : { content, isBinary: false, totalSize: Buffer.byteLength(content), root: workspace(sessionId), bindingEpoch: sessionId })); return
  }
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/browser/hosts', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) { response.writeHead(404).end(envelope(null)); return }
  if (request.method !== 'GET' && path !== '/api/v1/workspace/bind') throw new Error(`Unexpected write: ${request.method} ${path}`)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: hash, protocolVersion: 1, toolProfiles: ['general'], subagentSchemaVersion: 1, instanceId: token }
    : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', eventId: null, finished: true, history: history(sessionId), projection: [], runs: [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: [] }
    : path === '/api/v1/conversation/history' ? history(sessionId)
    : path === '/api/v1/conversation/sessions' ? [first, second].map(id => ({ sessionId: id, title: titles[id], lastAt: now, messageCount: 2 }))
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'off', effectiveScope: 'off', enabled: false }
    : path === '/api/v1/memory/preferences' ? { enabled: false, globalEnabled: false, sessionDefaultEnabled: false }
    : path === '/api/v1/workspace/directory' ? { root: workspace(sessionId), bindingEpoch: sessionId, entries: ['demo.ts', 'notes.txt'].map(name => ({ name, path: name, isDirectory: false, size: 40, mtimeMs: 1 })) }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: workspace(sessionId) }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] }
    : path === '/api/v1/plugins' ? { plugins: [record] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const slot = (location: string) => page.locator(`[data-extension-slot="${location}"]:visible`).first().frameLocator('iframe')
const tree = () => page.getByRole('region', { name: '工作区文件', exact: true })
const file = (name: string) => tree().locator(`[role="treeitem"][data-path="${workspace()}/${name}"]`)
const preview = () => page.getByRole('region', { name: 'demo.ts 代码预览', exact: true })
async function openSlot(location: string): Promise<void> {
  const toggle = page.locator(`[data-extension-slot="${location}"]:visible`).first().getByRole('button', { name: location, exact: true })
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  await expect(slot(location).locator('#context')).not.toBeEmpty()
}
async function openTask(id: string): Promise<void> {
  await page.locator(`[data-task-id="${id}"]`).getByRole('button').first().click()
  await expect(page.locator('.work-task-heading h1')).toHaveText(titles[id])
}
async function expectInvoke(location: string, hostContext: Record<string, string> = {}, sessionId = first): Promise<void> {
  await expect.poll(() => invokes.at(-1)).toMatchObject({ sessionId, tool: 'inspect', args: { location }, ...(Object.keys(hostContext).length ? { hostContext } : {}) })
}

test.describe.serial('插件实际挂载点与目标路由', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'profile-'))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    origin = `http://127.0.0.1:${address.port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, remoteWorkspaceRoot: workspace(), autoStartEngine: true,
      lastFolder: '', lastModelId: model, appearance: 'light', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_ENGINE_ENTRY'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const key = sessionStorageKey('aether.work.state.v1', engineStorageKey({ mode: 'remote', baseUrl: origin }))
    await page.evaluate(({ key, first, second, titles, now, model }) => {
      localStorage.setItem(key, JSON.stringify({ tasks: [first, second].map(id => ({ id, title: titles[id], status: 'done', draft: '', createdAt: now, updatedAt: now,
        workspacePath: `/extension-surfaces/${id}`, modelId: model, attachments: [], sources: [] })), activeTaskId: first }))
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'workspace', pane: 'conversation', ratio: 50 }))
    }, { key, first, second, titles, now, model })
    await page.reload(); await expect(page.locator('.work-task-heading h1')).toHaveText(titles[first])
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && page && !page.isClosed()) await page.screenshot({ path: info.outputPath('surfaces-failure.png') })
    expect(errors).toEqual([])
  })
  test.afterAll(async () => {
    try { await app?.close() } finally {
      await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('profile-')) throw new Error(`Unsafe fixture cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('插件区域同时展开超过四个时仍保留已打开区域', async () => {
    const surface = page.locator('[data-extension-slot="composer.panel"]')
    for (let index = 1; index <= 5; index++) await surface.getByRole('button', { name: `额外区域 ${index}`, exact: true }).click()
    await expect(surface.locator('iframe')).toHaveCount(5)
    for (let index = 1; index <= 5; index++) await expect(surface.getByRole('button', { name: `额外区域 ${index}`, exact: true })).toHaveAttribute('aria-expanded', 'true')
    for (let index = 1; index <= 5; index++) await surface.getByRole('button', { name: `额外区域 ${index}`, exact: true }).click()
    await expect(surface.locator('iframe')).toHaveCount(0)
  })

  test('消息与会话菜单传递所属消息，会话切换更新插件面板', async () => {
    const user = page.locator(`article[data-message-id="${first}-user"]`)
    await user.getByRole('button', { name: 'message.inline', exact: true }).click()
    await expect(user.locator('[data-extension-slot="message.inline"] iframe')).toBeVisible()
    await expect(user.frameLocator('iframe').locator('#context')).toContainText(`"messageId":"${first}-user"`)
    await user.hover(); await user.getByRole('button', { name: '消息插件操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '检查 message.actions', exact: true }).click()
    await expectInvoke('message.actions', { messageId: `${first}-user`, messageRole: 'user' })
    await page.locator(`[data-task-id="${second}"] .work-sidebar__task`).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '检查 session.context', exact: true }).click()
    await expectInvoke('session.context', {}, second)
    await openTask(second)
    await openSlot('composer.panel')
    await expect(slot('composer.panel').locator('#context')).toContainText(`"sessionId":"${second}"`)
    await expect.poll(() => events.some(event => event.event === 'session.changed' && event.sessionId === second)).toBe(true)
    await openTask(first)
  })

  test('输入框工具栏和页面SDK操作真实草稿并发布变化，服务菜单保留所属上下文', async () => {
    await openSlot('composer.panel')
    await page.getByRole('button', { name: '检查 composer.toolbar', exact: true }).click()
    await expectInvoke('composer.toolbar')
    await slot('composer.panel').locator('#set-composer').click()
    await slot('composer.panel').locator('#insert-composer').click()
    await slot('composer.panel').locator('#get-composer').click()
    await expect(slot('composer.panel').locator('#result')).toContainText('插件生成草稿，补充要求')
    await expect(page.locator('.work-composer [contenteditable="true"]')).toContainText('插件生成草稿，补充要求')
    await expect.poll(() => events.some(event => event.event === 'composer.changed' && event.sessionId === first && JSON.stringify(event.payload).includes('补充要求'))).toBe(true)
    await slot('composer.panel').locator('#start-service').click()
    await expect(slot('composer.panel').locator('#result')).toContainText('running')
    await page.getByRole('button', { name: '服务，1 个运行中', exact: true }).click()
    const row = page.locator('.service-tray__row').filter({ hasText: '入口测试服务' })
    await expect(row).toBeVisible(); await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '检查 service.context', exact: true }).click()
    await expectInvoke('service.context')
    await page.keyboard.press('Escape')
  })

  test('工作区和编辑器挂载实际生效，选择与定位保持文件归属，只读预览不能被写入', async () => {
    const tab = page.getByRole('tab', { name: '工作区', exact: true })
    if (await tab.isVisible()) await tab.click()
    else { await page.locator('.work-task-heading').getByRole('button', { name: '更多工作区', exact: true }).click(); await page.getByRole('menuitem', { name: '工作区', exact: true }).click() }
    await openSlot('workspace.panel')
    await expect(slot('workspace.panel').locator('#context')).toContainText(workspace())
    await file('demo.ts').click({ button: 'right' })
    await page.getByRole('menuitem', { name: '检查 file.context', exact: true }).click()
    await expectInvoke('file.context', { filePath: `${workspace()}/demo.ts` })
    await file('demo.ts').click(); await expect(preview().locator('.monaco-editor')).toBeVisible()
    await expect(preview().getByLabel('编辑器插件提示')).toContainText('检测到待办')
    await expect(preview().locator('.work-code-plugin-mark--warning')).toHaveCount(1)
    await preview().getByRole('button', { name: '检查 editor.toolbar', exact: true }).click()
    await expectInvoke('editor.toolbar', { filePath: `${workspace()}/demo.ts` })
    await preview().locator('.view-line').first().click({ position: { x: 30, y: 8 } })
    await page.keyboard.press('Control+Home'); await page.keyboard.press('Control+A')
    await expect.poll(() => events.some(event => event.event === 'editor.selectionChanged' && (event.payload as Record<string, unknown>)?.selectionText === code)).toBe(true)
    await page.keyboard.press('Shift+F10')
    // Monaco ignores mouseup for 100 ms after opening to avoid treating the
    // opening click as an action. Match the existing native-menu test gesture.
    const editorAction = page.getByRole('menuitem', { name: '检查 editor.context', exact: true })
    await editorAction.click({ delay: 150 })
    await expect(editorAction).toBeHidden()
    await expectInvoke('editor.context', { filePath: `${workspace()}/demo.ts`, selectionText: code })
    await expect.poll(() => events.some(event => event.event === 'editor.selectionChanged' && JSON.stringify(event.payload).includes('const alpha'))).toBe(true)
    await preview().locator('.view-line').first().click({ position: { x: 30, y: 8 } })
    await page.keyboard.press('Control+Home'); await page.keyboard.press('Shift+F10')
    await editorAction.click({ delay: 150 }); await expect(editorAction).toBeHidden()
    await expectInvoke('editor.context', { filePath: `${workspace()}/demo.ts`, selectionText: '' })
    await slot('workspace.panel').locator('#get-editor').click()
    await expect(slot('workspace.panel').locator('#result')).toContainText('"readOnly":true')
    await expect(slot('workspace.panel').locator('#result')).toContainText('const alpha')
    await slot('workspace.panel').locator('#replace-editor').click()
    await expect(slot('workspace.panel').locator('#result')).toContainText('只读文件预览')
    await slot('workspace.panel').locator('#reveal-editor').click()
    await expect(slot('workspace.panel').locator('#result')).toContainText('"lineNumber":2')
    await file('notes.txt').click()
    await expect(page.getByRole('region', { name: 'notes.txt 代码预览', exact: true })).toBeVisible()
    await slot('workspace.panel').locator('#get-editor').click()
    await expect(slot('workspace.panel').locator('#result')).toContainText('notes.txt')
    await expect(slot('workspace.panel').locator('#result')).not.toContainText('const alpha')
    expect(events.filter(event => event.event === 'file.changed')).toEqual([])
  })
})
