/** Isolated Electron + authenticated engine fixture. Plugin mutations and source text never execute locally.
 * Includes full plugin-name visibility, search filtering, keyboard selection, and
 * revision-pinned batch deletion with partial failures and a single confirmation. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'
import type { PluginRecord, PluginImport, PluginTemplate } from '../src/renderer/src/core/engine/plugins'
import { newPlugin, pluginSource, pluginArchive } from './fixtures/plugin'
import { selectOption, expectSelectedOption } from './fixtures/select'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp/plugin-batch-delete-20261113'), token = 'plugin-ui-disposable-token'
const modelId = 'plugin-ui-model', fixturePort = Number(process.env.AETHER_PLUGIN_UI_PORT ?? 12541), origin = `http://127.0.0.1:${fixturePort}`
const source = engineStorageKey({ mode: 'remote', baseUrl: origin }), stateKey = sessionStorageKey('aether.work.state.v1', source)
const plugins = new Map<string, PluginRecord>(), imports = new Map<string, PluginImport>(), mutations: Array<{ path: string; body: Record<string, unknown> }> = []
const errors: string[] = []
const deleteRequests: Array<{ id: string; expectedRevision: unknown }> = [], deleteFailuresRemaining = new Map<string, number>()
let deleteGate: Promise<void> | undefined, activeDeletes = 0, maxActiveDeletes = 0
let failTemplate = false
const installFailuresRemaining = new Map<string, number>()
const lostInstallResponses = new Set<string>(), receiptFailuresRemaining = new Map<string, number>()
let activeInstalls = 0, maxActiveInstalls = 0
let previewGate: Promise<void> | undefined, previewStarted = 0, nextImportId = 0
const runtimeCalls: Array<Record<string, unknown>> = []
let runtimeError = '', runtimeAllowed = true, runtimeGate: Promise<void> | undefined, completedRuntimeCalls = 0
let developmentRevision = 1, developmentClosed = 0, developmentError = ''
let app: ElectronApplication | undefined, page: Page, fixture = ''
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const envelope = (data: unknown) => JSON.stringify({ code: 200, message: 'ok', data })
function fixtureTemplate(id: string): PluginTemplate {
  const base = newPlugin(), manifest = { ...base.manifest, id: id === 'json-tool' ? 'my-json-tool' : 'my-report', name: id === 'json-tool' ? '文本整理工具' : '报告生成工具', tools: base.manifest.tools.map(tool => ({ ...tool, entry: 'main.mjs' })) }
  return { id, name: id === 'json-tool' ? '基础 JSON 工具' : 'Markdown 报告', description: '来自引擎的完整模板工程。', manifest,
    files: { 'aether-plugin.json': JSON.stringify(manifest, null, 2), 'main.mjs': base.files['tools/greet.mjs'], 'README.md': '# 官方模板说明', 'examples/cases.json': '{"cases":[]}' },
    protocol: { apiVersion: 1, runtime: 'node', ui: '当前不支持插件交互 UI。', background: '每次调用完成即退出，不支持后台定时器。' } }
}
function seedRuntimePlugin(): void {
  const value = newPlugin(), manifest = { ...value.manifest, id: 'native-app', name: '原生换算工具', tools: [{ name: 'convert', description: '输入金额并选择币种。', entry: 'main.mjs', inputSchema: { type: 'object', title: '单笔换算', properties: { amount: { title: '金额', type: 'number', minimum: 0 }, from: { title: '源币种', type: 'string', enum: ['USD', 'CNY'] }, to: { title: '目标币种', type: 'string', enum: ['CNY', 'USD'] }, rate: { title: '汇率', type: 'number', minimum: 0 } }, required: ['amount', 'from', 'to'] } }] }
  plugins.set(manifest.id, { ...value, manifest, id: manifest.id, name: manifest.name, description: '发布工具可直接操作', enabled: true, revision: 2, publishedRevision: 1, revisions: [{ revision: 1, hash: 'sha256:runtime', createdAt: 1 }], createdAt: 1, updatedAt: 1 })
}
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', origin), path = url.pathname
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error('Missing fixture authentication')
  let raw = ''; for await (const chunk of request) raw += chunk.toString()
  const value: unknown = raw ? JSON.parse(raw) : {}, body = record(value) ? value : {}
  if (request.method !== 'GET') mutations.push({ path, body })
  if (path === '/api/v1/conversation/sessions') { response.end(envelope([{ sessionId: 'existing-review-session', title: '已有会话调试' }])); return }
  if (path === '/api/v1/plugins/dev/open' || path === '/api/v1/plugins/dev/source-fixture/refresh') {
    const manifest: PluginRecord['manifest'] = { ...newPlugin().manifest, id: 'source-plugin', name: '源码开发插件', contributes: { pages: [{ id: 'main', title: '开发预览', kind: 'webview', entry: 'ui/main.html', tools: ['greet'] }] } }
    const hash = `sha256:source-${developmentRevision}`
    const html = `<main><h1>源码页面 r${developmentRevision}</h1><button id="run">运行问候</button><button id="skills">读取 Skills</button><button id="denied">拒绝权限</button><output id="result"></output><script>
      document.querySelector('#run').onclick = async () => { try { const value = await $AE.invoke('greet', {name:'预览'}); document.querySelector('#result').textContent = value.result.text } catch(error) { document.querySelector('#result').textContent=error.message } };
      document.querySelector('#skills').onclick = async () => { try { const value = await $AE.skills.list(); document.querySelector('#result').textContent=JSON.stringify(value) } catch(error) { document.querySelector('#result').textContent=error.message } };
      document.querySelector('#denied').onclick = async () => { try { await $AE.workspace.write({path:'secret.txt',content:'test'}); document.querySelector('#result').textContent='unexpected' } catch(error) { document.querySelector('#result').textContent=error.message } };
    </script></main>`
    response.end(envelope({ session: { devSessionId: 'source-fixture', path: 'D:\\plugins\\source-plugin', manifest, revision: developmentRevision, hash }, examples: [{ name: '示例', tool: 'greet', args: { name: '开发者' } }], application: { id: manifest.id, name: manifest.name, description: manifest.description, manifest, revision: developmentRevision, hash, examples: [], execution: { allowed: true }, uiDocuments: { main: html } } })); return
  }
  if (path === '/api/v1/plugins/dev/source-fixture/invoke') {
    if (developmentError || body.revision !== developmentRevision || body.hash !== `sha256:source-${developmentRevision}`) { response.writeHead(409).end(JSON.stringify({ code: 40900, message: developmentError || '源码已经变化，请刷新工程。' })); return }
    response.end(envelope({ result: { text: `r${developmentRevision} 你好 ${(body.args as Record<string,unknown>).name}` }, artifacts: [], stderr: '', durationMs: 2, plugin: { id: 'source-plugin', revision: developmentRevision, hash: `sha256:source-${developmentRevision}` } })); return
  }
  if (path === '/api/v1/plugins/dev/source-fixture/capabilities/invoke') {
    if (body.capability === 'skills.read' && body.method === 'list') { response.end(envelope({ result: [{ id: 'fixture-skill', name: '本地技能' }] })); return }
    response.writeHead(403).end(JSON.stringify({ code: 40300, message: '尚未授权 workspace.write' })); return
  }
  if (path === '/api/v1/plugins/dev/source-fixture/close') { developmentClosed++; response.end(envelope({ closed: true })); return }
  const runtimeMatch = /^\/api\/v1\/plugins\/runtime\/apps\/([^/]+)(\/invoke)?$/.exec(path)
  if (runtimeMatch) {
    const plugin = plugins.get(runtimeMatch[1])!
    if (!runtimeMatch[2]) { response.end(envelope({ application: { id: plugin.id, name: plugin.name, description: plugin.description, revision: plugin.publishedRevision, hash: 'sha256:runtime', manifest: plugin.manifest, examples: [{ name: '示例', tool: 'convert', args: { amount: 100, from: 'USD', to: 'CNY' } }], execution: { allowed: runtimeAllowed, ...(!runtimeAllowed ? { reason: '安全模式无法运行此插件。' } : {}) } } })); return }
    runtimeCalls.push(body)
    if (runtimeGate) await runtimeGate
    completedRuntimeCalls++
    if (runtimeError) { response.writeHead(400).end(JSON.stringify({ code: 40000, message: runtimeError })); return }
    const args = body.args as Record<string, unknown>, converted = Number(args.amount) * Number(args.rate ?? 7.1)
    response.end(envelope({ result: { formatted: `${converted.toFixed(2)} CNY`, converted, note: '测试汇率，非实时行情' }, artifacts: [], stderr: '', durationMs: 12, plugin: { id: plugin.id, revision: body.revision, hash: 'sha256:runtime' } })); return
  }
  if (path === '/api/v1/plugins/project/templates') { response.end(envelope({ templates: ['json-tool','markdown-report'].map(id => { const { name,description } = fixtureTemplate(id); return { id,name,description } }) })); return }
  const templateMatch = /^\/api\/v1\/plugins\/project\/templates\/([^/]+)$/.exec(path)
  if (templateMatch) {
    if (failTemplate) { response.writeHead(503).end(JSON.stringify({ code: 503, message: '模板服务暂不可用' })); return }
    response.end(envelope({ template: fixtureTemplate(templateMatch[1]) })); return
  }
  const exportMatch = /^\/api\/v1\/plugins\/project\/exports\/([^/]+)$/.exec(path)
  if (exportMatch) {
    const plugin = plugins.get(exportMatch[1])!, zip = new JSZip()
    for (const [name,content] of Object.entries(plugin.files!)) zip.file(name,content)
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })
    response.end(envelope({ archive: { fileName: `${plugin.id}-r${plugin.revision}.zip`, base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), revision: plugin.revision } })); return
  }
  if (path === '/api/v1/plugins/imports/preview-batch') {
    expect(body).toMatchObject({ type: 'zip', format: 'native' })
    expect(typeof body.base64).toBe('string')
    expect(Number(body.maxPlugins)).toBeGreaterThan(0)
    previewStarted++
    if (previewGate) await previewGate
    let item: PluginImport
    try {
      const archive = await JSZip.loadAsync(Buffer.from(String(body.base64),'base64'))
      const manifestFile = archive.file('aether-plugin.json')
      if (!manifestFile) throw new Error('缺少 aether-plugin.json')
      const manifest = JSON.parse(await manifestFile.async('string')) as PluginRecord['manifest']
      item = { jobId: `job-${++nextImportId}`, status: 'prepared', manifest, source: { type: 'archive' } }
      imports.set(item.jobId,item)
      response.end(envelope({ imports: [{ fileName: `${manifest.id}.zip`, import: item }] }))
    } catch {
      response.end(envelope({ imports: [{ fileName: 'broken.zip', error: 'ZIP 文件损坏，无法读取插件清单。' }] }))
    }
    return
  }
  if (path === '/api/v1/plugins/imports/preview') {
    if (body.url === 'https://github.com/example/missing') {
      const item: PluginImport = { jobId: 'failed-job', status: 'failed', error: '缺少 aether-plugin.json', failureStage: 'prepare' }
      imports.set(item.jobId,item); response.writeHead(400).end(JSON.stringify({ code: 40000, message: item.error, data: { import: item } })); return
    }
    const id = `imported-${body.source}`, template = newPlugin(), manifest = { ...template.manifest, id, name: `导入 ${body.source}` }
    const item: PluginImport = { jobId: `job-${++nextImportId}`, status: 'prepared', manifest, source: { type: body.source, ...(body.source === 'github' ? { commit: 'a'.repeat(40) } : {}) } }
    imports.set(item.jobId, item); response.end(envelope({ import: item })); return
  }
  const importJob = /^\/api\/v1\/plugins\/imports\/([^/]+)$/.exec(path)
  if (importJob && request.method === 'GET') {
    const remaining = receiptFailuresRemaining.get(importJob[1]) ?? 0
    if (remaining) { receiptFailuresRemaining.set(importJob[1],remaining - 1); response.writeHead(503).end(JSON.stringify({ code: 50300, message: '回执暂时无法读取' })); return }
    response.end(envelope({ import: imports.get(importJob[1]) })); return
  }
  if (importJob && request.method === 'DELETE') {
    const item = imports.get(importJob[1])
    if (item?.status === 'installed') { response.writeHead(409).end(JSON.stringify({ code: 40900, message: '已安装任务不能取消' })); return }
    if (item && item.status !== 'installed') imports.set(item.jobId,{ ...item, status: 'cancelled' })
    response.end(envelope({ cancelled: true })); return
  }
  const install = /^\/api\/v1\/plugins\/imports\/([^/]+)\/install$/.exec(path)
  if (install) {
    const item = imports.get(install[1])!
    activeInstalls++; maxActiveInstalls = Math.max(maxActiveInstalls,activeInstalls)
    await new Promise<void>(done => setTimeout(done,30))
    activeInstalls--
    const failures = installFailuresRemaining.get(item.manifest!.id) ?? 0
    if (failures) {
      installFailuresRemaining.set(item.manifest!.id,failures - 1)
      const failed: PluginImport = { ...item, status: 'failed', failureStage: 'install', error: '测试安装暂时失败，可重试。' }
      imports.set(item.jobId,failed)
      response.writeHead(500).end(JSON.stringify({ code: 50000, message: failed.error, data: { import: failed } })); return
    }
    const plugin: PluginRecord = { ...newPlugin(), manifest: item.manifest!, id: item.manifest!.id, name: item.manifest!.name,
      description: item.manifest!.description, revision: 1, enabled: false, source: item.source, revisions: [{ revision: 1, hash: 'sha256:import', createdAt: Date.now() }], createdAt: Date.now(), updatedAt: Date.now() }
    imports.set(item.jobId,{ ...item, status: 'installed', error: undefined, failureStage: undefined })
    plugins.set(plugin.id, plugin)
    if (lostInstallResponses.delete(plugin.id)) {
      receiptFailuresRemaining.set(item.jobId,1)
      response.writeHead(502).end(JSON.stringify({ code: 50200, message: '安装响应连接中断' })); return
    }
    response.end(envelope({ plugin })); return
  }
  const match = /^\/api\/v1\/plugins(?:\/([^/]+))?(?:\/(publish|test))?$/.exec(path)
  if (match) {
    const id = match[1] && decodeURIComponent(match[1]), action = match[2]
    if (request.method === 'GET') { response.end(envelope(id ? { plugin: plugins.get(id) } : { plugins: [...plugins.values()].map(({ files: _, ...item }) => item) })); return }
    if (action === 'test') { response.end(envelope({ result: { text: `TEST_RESULT_${String((body.args as Record<string, unknown>)?.name)}` }, artifacts: [] })); return }
    if (action === 'publish') { const plugin = { ...plugins.get(id!)!, publishedRevision: plugins.get(id!)!.revision, enabled: true }; plugins.set(id!, plugin); response.end(envelope({ plugin })); return }
    if (request.method === 'DELETE') {
      deleteRequests.push({ id: id!, expectedRevision: body.expectedRevision })
      activeDeletes++; maxActiveDeletes = Math.max(maxActiveDeletes, activeDeletes)
      try {
        if (deleteGate) await deleteGate
        const plugin = plugins.get(id!)
        if (id?.startsWith('batch-delete-') && (!plugin || body.expectedRevision !== plugin.revision)) {
          response.writeHead(409).end(JSON.stringify({ code: 40900, message: '插件版本已变化，请刷新列表后重试。' })); return
        }
        const remaining = deleteFailuresRemaining.get(id!) ?? 0
        if (remaining > 0) {
          deleteFailuresRemaining.set(id!, remaining - 1)
          response.writeHead(503).end(JSON.stringify({ code: 50300, message: '测试删除暂时失败，请重试。' })); return
        }
        plugins.delete(id!); response.end(envelope({ deleted: true })); return
      } finally { activeDeletes-- }
    }
    if (request.method === 'PATCH') { const plugin = { ...plugins.get(id!)!, enabled: Boolean(body.enabled) }; plugins.set(id!, plugin); response.end(envelope({ plugin })); return }
    if (request.method === 'POST' || request.method === 'PUT') {
      if (!record(body.manifest) || !record(body.files)) throw new Error('Plugin payload must include manifest and authored files')
      const previous = id ? plugins.get(id) : undefined, revision = (previous?.revision ?? 0) + 1
      if (previous && body.expectedRevision !== previous.revision) throw new Error('Missing optimistic revision')
      const plugin: PluginRecord = { id: String(body.manifest.id), name: String(body.manifest.name), description: String(body.manifest.description), enabled: previous?.enabled ?? false,
        manifest: body.manifest as unknown as PluginRecord['manifest'], files: { ...body.files as Record<string, string>, 'aether-plugin.json': JSON.stringify(body.manifest, null, 2) }, revision,
        publishedRevision: previous?.publishedRevision, revisions: [...(previous?.revisions ?? []), { revision, hash: `sha256:${revision}`, createdAt: Date.now() }], createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now() }
      plugins.set(plugin.id, plugin); response.end(envelope({ plugin })); return
    }
    throw new Error(`Unexpected plugin action ${request.method} ${path}`)
  }
  if (path === '/api/v1/workspace/bind') { response.end(envelope({ workspaceRoot: String(body.workspaceRoot), bindingEpoch: 'plugins' })); return }
  if (['/api/v1/workbench/clients','/api/v1/browser/clients','/api/v1/terminal/create','/api/v1/lsp/request','/api/v1/cron/capabilities'].includes(path)) { response.writeHead(404).end(envelope(null)); return }
  if (request.method !== 'GET') throw new Error(`Unexpected mutation ${request.method} ${path}`)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'e'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general','code'], subagentSchemaVersion: 1, instanceId: 'plugins-ui' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '插件测试模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
    : path === '/api/v1/toolkits' ? { toolkits: [{ id: 'plugin-management', name: '插件管理', description: '创建和管理插件', toolNames: ['plugin_create'], available: true }, ...[...plugins.values()].filter(p => p.enabled && p.publishedRevision).map(p => ({ id: `plugin-${p.id}--r${p.publishedRevision}`, name: p.name, description: p.description, toolNames: [`plugin_${p.id}_greet`], available: true }))] }
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: url.searchParams.get('sessionId'), source: 'persisted', eventId: null, finished: true, history: [], projection: [], run: null, runs: [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: null, lastEventId: null }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1,2], views: ['legacy','summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'off', effectiveScope: 'off', enabled: false }
    : path === '/api/v1/memory/preferences' ? { enabled: false, globalEnabled: false, sessionDefaultEnabled: false }
    : path === '/api/v1/security/mode' ? { mode: 'standard' }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] }
    : path === '/api/v1/workspace/directory' ? { root: '/plugins-ui', entries: [], bindingEpoch: 'plugins' }
    : path === '/api/v1/skills' ? { list: [] } : path === '/api/v1/chat/runs' ? { runs: [] }
    : path === '/api/v1/settings' ? {} : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })
const manager = () => page.getByRole('region', { name: '插件管理', exact: true })
async function seed(): Promise<void> {
  await page.evaluate(key => {
    localStorage.setItem(key, JSON.stringify({ tasks: [], activeTaskId: null, homeDraft: '', homeResources: { skills: [], mcpServers: [], knowledgeBases: [], toolkits: [] } }))
    localStorage.setItem('aether.app.mode', 'work'); localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'plugins', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 56 }))
  }, stateKey)
  await page.reload(); await expect(manager().getByRole('heading', { name: '插件', exact: true })).toBeVisible()
}
test.describe.serial('插件管理与会话选择', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'profile-'))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(fixturePort, '127.0.0.1', done) })
    writeFileSync(join(fixture,'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true, remoteWorkspaceRoot: '/plugins-ui', lastFolder: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
    const env: Record<string,string> = Object.fromEntries(Object.entries(process.env).flatMap(([key,value]) => value === undefined ? [] : [[key,value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','AETHER_IDE_REMOTE_API_KEY','AETHER_IDE_REMOTE_BEARER_TOKEN','AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture,'global')
    app = await electron.launch({ args: [join(root,'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow },directory) => BrowserWindow.getAllWindows()[0].webContents.session.on('will-download',(_event,item) => item.setSavePath(`${directory}/${item.getFilename()}`)),fixture)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320,900))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  })
  test.beforeEach(async () => { plugins.clear(); imports.clear(); mutations.length = 0; deleteRequests.length = 0; deleteFailuresRemaining.clear(); deleteGate = undefined; activeDeletes = 0; maxActiveDeletes = 0; installFailuresRemaining.clear(); lostInstallResponses.clear(); receiptFailuresRemaining.clear(); previewGate = undefined; previewStarted = 0; activeInstalls = 0; maxActiveInstalls = 0; failTemplate = false; runtimeCalls.length = 0; runtimeError = ''; runtimeAllowed = true; runtimeGate = undefined; completedRuntimeCalls = 0; await seed() })
  test.afterEach(async ({}, info) => { if (!page.isClosed()) await page.screenshot({ path: info.outputPath('plugins.png') }); expect(errors).toEqual([]) })
  test.afterAll(async () => { try { await app?.close() } finally { server.closeAllConnections(); if (server.listening) await new Promise<void>(done => server.close(() => done())); if (fixture) { if (dirname(resolve(fixture)) !== fixtureRoot) throw new Error('Unsafe plugin profile cleanup'); rmSync(fixture,{ recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } } })

  test('开发模式直接预览源码、调用平台能力并刷新版本，无安装发布副作用', async ({}, info) => {
    developmentRevision = 1; developmentClosed = 0; developmentError = ''
    await manager().getByRole('button', { name: '开发模式', exact: true }).click()
    const development = page.getByRole('region', { name: '插件开发模式', exact: true })
    await development.getByRole('textbox', { name: '本地插件工程目录' }).fill('D:\\plugins\\source-plugin')
    await development.getByRole('button', { name: '打开开发工程' }).click()
    const frame = page.frameLocator('iframe[title="开发预览"]')
    await expect(frame.getByRole('heading')).toHaveText('源码页面 r1')
    await frame.getByRole('button', { name: '运行问候' }).click()
    await expect(frame.locator('#result')).toHaveText('r1 你好 预览')
    await frame.getByRole('button', { name: '读取 Skills' }).click()
    await expect(frame.locator('#result')).toContainText('本地技能')
    const call = mutations.find(item => item.path.endsWith('/capabilities/invoke'))!
    expect(call.body).toMatchObject({ capability: 'skills.read', method: 'list', expectedRevision: 1, args: {} })
    expect(call.body).not.toHaveProperty('sessionId')
    await frame.getByRole('button', { name: '拒绝权限' }).click()
    await expect(frame.locator('#result')).toHaveText('尚未授权 workspace.write')
    await selectOption(development.getByRole('button', { name: '开发模式绑定会话', exact: true }), 'existing-review-session', '已有会话调试')
    await frame.getByRole('button', { name: '读取 Skills' }).click()
    await expect(frame.locator('#result')).toContainText('本地技能')
    expect(mutations.filter(item => item.path.endsWith('/capabilities/invoke')).at(-1)?.body.sessionId).toBe('existing-review-session')
    await page.screenshot({ path: info.outputPath('development-preview-light.png'), animations: 'disabled' })
    developmentRevision = 2
    await frame.getByRole('button', { name: '运行问候' }).click()
    await expect(frame.locator('#result')).toHaveText('源码已经变化，请刷新工程。')
    await development.getByRole('button', { name: '重新读取本地插件' }).click()
    await expect(frame.getByRole('heading')).toHaveText('源码页面 r2')
    await frame.getByRole('button', { name: '运行问候' }).click()
    await expect(frame.locator('#result')).toHaveText('r2 你好 预览')
    expect(mutations.filter(item => item.path.endsWith('/invoke') && !item.path.includes('/capabilities/')).at(-1)?.body.sessionId).toBe('existing-review-session')
    await development.getByRole('tab', { name: '工具测试' }).click()
    await expect(development.getByRole('textbox', { name: '开发模式参数 JSON' })).toHaveValue('{\n  "name": "开发者"\n}')
    await development.getByRole('button', { name: '运行本地代码' }).click()
    await expect(development.getByLabel('开发模式运行结果')).toContainText('r2 你好 开发者')
    developmentError = '源码入口语法错误'
    await development.getByRole('button', { name: '运行本地代码' }).click()
    await expect(development.getByRole('alert')).toHaveText(developmentError)
    await expect(development.getByLabel('开发模式运行结果')).toHaveCount(0)
    await development.getByRole('button', { name: '切换工程' }).click()
    await expect(development.getByRole('textbox', { name: '本地插件工程目录' })).toBeEditable()
    expect(developmentClosed).toBe(1)
    expect(plugins.size).toBe(0)
    expect(mutations.filter(item => item.path.startsWith('/api/v1/plugins') && !item.path.startsWith('/api/v1/plugins/dev/'))).toEqual([])
    await development.getByRole('button', { name: '返回插件列表' }).click()
    await expect(manager().getByRole('heading', { name: '插件', exact: true })).toBeVisible()
  })

  test('手动创建、源码编辑、测试、发布、启停和删除使用真实持久回执', async () => {
    await manager().getByRole('button', { name: '新建插件', exact: true }).click()
    for (const label of ['名称', '版本']) {
      const padding = await manager().getByLabel(label, { exact: true }).evaluate(node => {
        const style = getComputedStyle(node)
        return { left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight) }
      })
      expect(padding.left, `${label}左侧文字留白`).toBeGreaterThanOrEqual(10)
      expect(padding.right, `${label}右侧文字留白`).toBeGreaterThanOrEqual(10)
    }
    await manager().getByLabel('名称', { exact: true }).fill('问候助手')
    await manager().getByLabel('标识', { exact: true }).fill('greeting')
    await manager().getByRole('tab', { name: '源文件', exact: true }).click()
    await manager().getByRole('textbox', { name: '源文件 main.mjs', exact: true }).fill(pluginSource('`Hello ${args.name}`'))
    await manager().getByRole('button', { name: '保存草稿', exact: true }).click()
    await expect.poll(() => plugins.get('greeting')?.files?.['main.mjs']).toContain('Hello')
    await manager().getByRole('tab', { name: '测试', exact: true }).click()
    await manager().getByRole('textbox', { name: '测试参数 JSON' }).fill('{"name":"Aether"}')
    await manager().getByRole('button', { name: '运行测试', exact: true }).click()
    await expect(manager().getByLabel('插件测试结果')).toContainText('TEST_RESULT_Aether')
    await manager().getByRole('button', { name: '发布并启用', exact: true }).click()
    await expect.poll(() => plugins.get('greeting')?.publishedRevision).toBe(1)
    await manager().getByRole('button', { name: '返回插件列表', exact: true }).click()
    await expect(manager().getByRole('button', { name: '打开插件 问候助手', exact: true })).toBeVisible()
    await manager().getByRole('switch', { name: '启用插件 问候助手', exact: true }).click()
    await expect.poll(() => plugins.get('greeting')?.enabled).toBe(false)
    await manager().getByRole('button', { name: '打开插件 问候助手', exact: true }).click()
    await manager().getByRole('textbox', { name: '用途', exact: true }).fill('修改后的用途')
    await manager().getByRole('button', { name: '保存草稿', exact: true }).click()
    await expect.poll(() => plugins.get('greeting')?.revision).toBe(2)
    await expect.poll(() => plugins.get('greeting')?.publishedRevision).toBe(1)
    await manager().getByRole('button', { name: '返回插件列表', exact: true }).click()
    await manager().getByRole('button', { name: '删除插件 问候助手', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
    await expect.poll(() => plugins.size).toBe(0)
    expect(mutations.some(item => item.path.endsWith('/greeting/test') && item.body.revision === 1)).toBe(true)
  })

  test('已发布插件使用原生字段操作，校验参数、显示真实回执与错误，并保持编辑入口独立', async () => {
    seedRuntimePlugin()
    await manager().getByRole('button', { name: '刷新插件', exact: true }).click()
    await manager().getByRole('button', { name: '打开插件 原生换算工具', exact: true }).click()
    const application = page.getByRole('region', { name: '插件操作页', exact: true })
    await expectSelectedOption(application.getByLabel('插件功能'), 'convert', '单笔换算')
    await expect(application.getByLabel('金额', { exact: true })).toHaveValue('100')
    await application.getByLabel('金额', { exact: true }).fill('-1')
    await application.getByRole('button', { name: '运行', exact: true }).click()
    await expect(application.getByRole('alert')).toContainText('不能小于 0')
    expect(runtimeCalls).toHaveLength(0)
    await application.getByLabel('金额', { exact: true }).fill('100')
    await application.getByLabel('汇率', { exact: true }).fill('7.28')
    await application.getByLabel('汇率', { exact: true }).press('Enter')
    await expect(application.getByLabel('插件运行结果')).toContainText('728.00 CNY')
    expect(runtimeCalls[0]).toEqual({ revision: 1, tool: 'convert', args: { amount: 100, from: 'USD', to: 'CNY', rate: 7.28 } })
    await expect(application.locator('.work-plugin-app__raw')).not.toHaveAttribute('open')
    runtimeError = '已停用，无法继续运行'
    await application.getByRole('button', { name: '运行', exact: true }).click()
    await expect(application.getByRole('alert')).toHaveText(runtimeError)
    await expect(application.getByLabel('插件运行结果')).toHaveCount(0)
    await application.getByRole('button', { name: '编辑插件', exact: true }).click()
    await expect(manager().getByRole('heading', { name: '编辑插件', exact: true })).toBeVisible()
    await expect(manager().getByRole('tab', { name: '源文件', exact: true })).toBeVisible()
  })

  test('离开操作页丢弃旧请求结果，安全模式允许查看表单并禁止执行', async () => {
    seedRuntimePlugin()
    await manager().getByRole('button', { name: '刷新插件', exact: true }).click()
    await manager().getByRole('button', { name: '打开插件 原生换算工具', exact: true }).click()
    const application = page.getByRole('region', { name: '插件操作页', exact: true })
    let release: () => void = () => {}
    runtimeGate = new Promise<void>(resolve => { release = resolve })
    await application.getByRole('button', { name: '运行', exact: true }).click()
    await expect.poll(() => runtimeCalls.length).toBe(1)
    await expect(application.getByLabel('插件功能')).toBeDisabled()
    await application.getByRole('button', { name: '返回插件列表', exact: true }).click()
    runtimeAllowed = false
    await manager().getByRole('button', { name: '打开插件 原生换算工具', exact: true }).click()
    await expect(application.getByRole('alert')).toHaveText('安全模式无法运行此插件。')
    await expect(application.getByRole('button', { name: '运行', exact: true })).toBeDisabled()
    release()
    await expect.poll(() => completedRuntimeCalls).toBe(1)
    await expect(application.getByLabel('插件运行结果')).toHaveCount(0)
    expect(runtimeCalls).toHaveLength(1)
  })

  test('引擎模板可切换，加载失败保留草稿，清单只读且导出对应已保存ZIP', async () => {
    await manager().getByRole('button',{ name: '新建插件', exact: true }).click()
    await expectSelectedOption(manager().getByLabel('官方模板',{ exact: true }), 'json-tool', '基础 JSON 工具')
    await selectOption(manager().getByLabel('官方模板',{ exact: true }), 'markdown-report', 'Markdown 报告')
    await expect(manager().getByLabel('名称',{ exact: true })).toHaveValue('报告生成工具')
    failTemplate = true
    await selectOption(manager().getByLabel('官方模板',{ exact: true }), 'json-tool', '基础 JSON 工具')
    await expect(manager().getByRole('alert')).toContainText('模板服务暂不可用')
    await expectSelectedOption(manager().getByLabel('官方模板',{ exact: true }), 'markdown-report', 'Markdown 报告')
    await expect(manager().getByLabel('名称',{ exact: true })).toHaveValue('报告生成工具')
    failTemplate = false
    await manager().getByLabel('标识',{ exact: true }).fill('export-probe')
    await manager().getByLabel('名称',{ exact: true }).fill('可导出工程')
    const exportButton = manager().getByRole('button',{ name: '导出插件 ZIP', exact: true })
    await expect(exportButton).toBeDisabled()
    await manager().getByRole('tab',{ name: '源文件', exact: true }).click()
    await selectOption(manager().getByLabel('选择源文件',{ exact: true }), 'aether-plugin.json')
    const rootManifest = manager().getByRole('textbox',{ name: '源文件 aether-plugin.json', exact: true })
    await expect(rootManifest).toHaveAttribute('readonly','')
    expect(await rootManifest.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(379)
    await expect(rootManifest).toHaveValue(/可导出工程/)
    await expect(manager().getByRole('button',{ name: '移除文件', exact: true })).toBeDisabled()
    await manager().getByRole('button',{ name: '保存草稿', exact: true }).click()
    await expect(exportButton).toBeEnabled()
    await exportButton.click()
    const archivePath = join(fixture,'export-probe-r1.zip')
    await expect.poll(() => { try { return readFileSync(archivePath).length } catch { return 0 } }).toBeGreaterThan(100)
    const archive = await JSZip.loadAsync(readFileSync(archivePath))
    expect(Object.keys(archive.files)).toEqual(expect.arrayContaining(['aether-plugin.json','main.mjs','README.md','examples/cases.json']))
    expect(JSON.parse(await archive.file('aether-plugin.json')!.async('string')).name).toBe('可导出工程')
    expect(await archive.file('main.mjs')!.async('string')).toBe(plugins.get('export-probe')!.files!['main.mjs'])
    await expect(manager().getByRole('status')).toContainText('已导出 r1')
  })

  test('GitHub、引擎本地目录和ZIP均先预览再安装，保留来源信息', async () => {
    for (const kind of ['github','directory','archive'] as const) {
      await manager().getByRole('button', { name: '导入', exact: true }).click()
      await manager().getByRole('tab', { name: { github: 'GitHub', directory: '本地目录', archive: 'ZIP 文件' }[kind], exact: true }).click()
      if (kind === 'archive') await manager().locator('input[type=file]').setInputFiles({ name: 'fixture.zip', mimeType: 'application/zip', buffer: await pluginArchive('imported-archive','导入 archive') })
      else await manager().getByLabel(kind === 'github' ? '仓库地址' : '引擎所在电脑的目录', { exact: true }).fill(kind === 'github' ? 'https://github.com/example/plugin' : 'D:\\fixtures\\plugin')
      await manager().getByRole('button', { name: '预览插件', exact: true }).click()
      if (kind === 'archive') await expect(manager().getByRole('list',{ name: '待导入插件', exact: true })).toContainText('导入 archive')
      else await expect(manager().getByRole('heading', { name: `导入 ${kind}`, exact: true })).toBeVisible()
      expect(plugins.size).toBe(['github','directory','archive'].indexOf(kind))
      await manager().getByRole('button', { name: '安装插件', exact: true }).click()
      await expect(manager().getByRole('button', { name: `打开插件 导入 ${kind}`, exact: true })).toBeVisible()
      expect(plugins.get(`imported-${kind}`)?.source).toMatchObject({ type: kind })
    }
  })

  test('ZIP 多选逐项显示失败，取消勾选与重复保护生效，重试不重复安装成功项', async ({},info) => {
    const template = newPlugin(), manifest = { ...template.manifest, id: 'batch-existing', name: '已存在插件' }
    plugins.set(manifest.id,{ ...template, manifest, id: manifest.id, name: manifest.name, description: manifest.description,
      enabled: false, revision: 1, revisions: [{ revision: 1, hash: 'sha256:existing', createdAt: 1 }], createdAt: 1, updatedAt: 1 })
    installFailuresRemaining.set('batch-retry',1)
    await manager().getByRole('button',{ name: '刷新插件', exact: true }).click()
    await expect(manager().getByRole('button',{ name: '打开插件 已存在插件', exact: true })).toBeVisible()
    await manager().getByRole('button',{ name: '导入', exact: true }).click()
    await manager().getByRole('tab',{ name: 'ZIP 文件', exact: true }).click()
    const input = manager().locator('input[type=file]')
    await expect(input).toHaveAttribute('multiple','')
    await input.setInputFiles([
      { name: 'good.zip', mimeType: 'application/zip', buffer: await pluginArchive('batch-good','批量成功') },
      { name: 'retry.zip', mimeType: 'application/zip', buffer: await pluginArchive('batch-retry','稍后重试') },
      { name: 'skip.zip', mimeType: 'application/zip', buffer: await pluginArchive('batch-skip','取消选择') },
      { name: 'duplicate.zip', mimeType: 'application/zip', buffer: await pluginArchive('batch-good','重复标识') },
      { name: 'existing.zip', mimeType: 'application/zip', buffer: await pluginArchive('batch-existing','已存在插件') },
      { name: 'broken.zip', mimeType: 'application/zip', buffer: Buffer.from('not a ZIP') }
    ])
    await manager().getByRole('button',{ name: '预览插件', exact: true }).click()
    const list = manager().getByRole('list',{ name: '待导入插件', exact: true })
    await expect(list.getByRole('listitem')).toHaveCount(6)
    await expect(list).toContainText('ZIP 文件损坏')
    await expect(list.getByRole('checkbox',{ name: '选择 重复标识', exact: true })).toBeDisabled()
    await expect(list.getByRole('checkbox',{ name: '选择 已存在插件', exact: true })).toBeDisabled()
    await page.screenshot({ path: info.outputPath('batch-preview-light.png'), animations: 'disabled' })
    const all = manager().getByRole('checkbox',{ name: '全选可导入插件', exact: true })
    await all.uncheck()
    await expect(list.getByRole('checkbox',{ name: '选择 批量成功', exact: true })).not.toBeChecked()
    await all.check()
    await list.getByRole('checkbox',{ name: '选择 取消选择', exact: true }).uncheck()
    await manager().getByRole('button',{ name: '导入所选（2）', exact: true }).click()
    await expect(list.locator('li[data-plugin-id="batch-good"]').first()).toContainText('已导入')
    await expect(list.locator('li[data-plugin-id="batch-retry"]')).toContainText('测试安装暂时失败')
    await page.evaluate(() => document.documentElement.dataset.appearance = 'dark')
    await page.screenshot({ path: info.outputPath('batch-partial-failure-dark.png'), animations: 'disabled' })
    writeFileSync(info.outputPath('batch-dark-button-colors.json'), JSON.stringify(await list.locator('button').evaluateAll(buttons => buttons.map(button => ({ label: button.getAttribute('aria-label'), disabled: (button as HTMLButtonElement).disabled, color: getComputedStyle(button).color, opacity: getComputedStyle(button).opacity, svgColor: getComputedStyle(button.querySelector('svg') ?? button).color }))), null, 2))
    expect([...plugins.keys()].sort()).toEqual(['batch-existing','batch-good'])
    const attempts = (id: string) => mutations.filter(entry => /\/imports\/[^/]+\/install$/.test(entry.path) && imports.get(entry.path.split('/').at(-2)!)?.manifest?.id === id).length
    expect(attempts('batch-good')).toBe(1); expect(attempts('batch-retry')).toBe(1); expect(attempts('batch-skip')).toBe(0)
    await manager().getByRole('button',{ name: '重试导入（1）', exact: true }).click()
    await expect(list.locator('li[data-plugin-id="batch-retry"]')).toContainText('已导入')
    expect(attempts('batch-good')).toBe(1); expect(attempts('batch-retry')).toBe(2); expect(attempts('batch-existing')).toBe(0)
    expect(maxActiveInstalls).toBe(1)
    expect([...plugins.keys()].sort()).toEqual(['batch-existing','batch-good','batch-retry'])
    expect(plugins.get('batch-existing')?.revision).toBe(1)
    await manager().getByRole('button',{ name: '完成', exact: true }).click()
    await expect(manager().getByRole('button',{ name: '打开插件 批量成功', exact: true })).toBeVisible()
    await expect(manager().getByRole('button',{ name: '打开插件 稍后重试', exact: true })).toBeVisible()
    await expect(manager().getByRole('button',{ name: '打开插件 取消选择', exact: true })).toHaveCount(0)
    await page.evaluate(() => document.documentElement.dataset.appearance = 'light')
  })

  test('批量预览未返回时离开页面会取消迟到任务并停止后续文件请求', async () => {
    let release!: () => void
    previewGate = new Promise<void>(done => { release = done })
    try {
      await manager().getByRole('button',{ name: '导入', exact: true }).click()
      await manager().getByRole('tab',{ name: 'ZIP 文件', exact: true }).click()
      await manager().locator('input[type=file]').setInputFiles([
        { name: 'delayed.zip', mimeType: 'application/zip', buffer: await pluginArchive('late-preview','延迟预览') },
        { name: 'never-requested.zip', mimeType: 'application/zip', buffer: await pluginArchive('never-preview','不应继续预览') }
      ])
      await manager().getByRole('button',{ name: '预览插件', exact: true }).click()
      await expect.poll(() => previewStarted).toBe(1)
      await page.getByRole('navigation').getByRole('button',{ name: '工作台', exact: true }).click()
      await expect(manager()).toHaveCount(0)
      release()
      await expect.poll(() => [...imports.values()].map(item => item.status)).toEqual(['cancelled'])
      expect(previewStarted).toBe(1)
      expect(plugins.size).toBe(0)
      await page.getByRole('navigation').getByRole('button',{ name: '插件', exact: true }).click()
      await expect(manager().getByRole('list',{ name: '待导入插件', exact: true })).toHaveCount(0)
    } finally { release(); previewGate = undefined }
  })

  test('安装响应丢失且回执未知时改选文件会保留已安装插件并清理其他旧预览', async () => {
    lostInstallResponses.add('committed-unknown')
    await manager().getByRole('button',{ name: '导入', exact: true }).click()
    await manager().getByRole('tab',{ name: 'ZIP 文件', exact: true }).click()
    await manager().locator('input[type=file]').setInputFiles([
      { name: 'unknown.zip', mimeType: 'application/zip', buffer: await pluginArchive('committed-unknown','已提交但回执未知') },
      { name: 'unused.zip', mimeType: 'application/zip', buffer: await pluginArchive('unused-preview','待清理预览') }
    ])
    await manager().getByRole('button',{ name: '预览插件', exact: true }).click()
    const list = manager().getByRole('list',{ name: '待导入插件', exact: true })
    await expect(list.getByRole('listitem')).toHaveCount(2)
    await list.getByRole('checkbox',{ name: '选择 待清理预览', exact: true }).uncheck()
    await manager().getByRole('button',{ name: '导入所选（1）', exact: true }).click()
    await expect(list.locator('[data-plugin-id="committed-unknown"]')).toContainText('导入结果待确认')
    expect(plugins.get('committed-unknown')?.revision).toBe(1)
    const installedJob = [...imports.values()].find(item => item.manifest?.id === 'committed-unknown')!.jobId
    const unusedJob = [...imports.values()].find(item => item.manifest?.id === 'unused-preview')!.jobId
    await manager().locator('input[type=file]').setInputFiles({ name: 'replacement.zip', mimeType: 'application/zip', buffer: await pluginArchive('replacement-preview','替换后的预览') })
    await expect.poll(() => imports.get(unusedJob)?.status).toBe('cancelled')
    expect(imports.get(installedJob)?.status).toBe('installed')
    expect(plugins.get('committed-unknown')?.revision).toBe(1)
    expect(mutations.filter(item => item.path === `/api/v1/plugins/imports/${installedJob}/install`)).toHaveLength(1)
    await manager().getByRole('button',{ name: '预览插件', exact: true }).click()
    await expect(list.getByRole('listitem')).toHaveCount(1)
    await expect(list).toContainText('替换后的预览')
    expect(mutations.some(item => item.path === `/api/v1/plugins/imports/${unusedJob}`)).toBe(true)
    expect(plugins.has('unused-preview')).toBe(false)
  })

  test('AI创建进入真实草稿，动态插件可被@选中且固定发布版本', async () => {
    const template = newPlugin(), plugin: PluginRecord = { ...template, id: 'greeting', name: '问候助手', description: '生成问候', manifest: { ...template.manifest, id: 'greeting', name: '问候助手' },
      enabled: true, revision: 2, publishedRevision: 1, revisions: [{ revision: 1, hash: 'sha256:1', createdAt: 1 }], createdAt: 1, updatedAt: 2 }
    plugins.set(plugin.id, plugin)
    await manager().getByRole('button', { name: 'AI 创建', exact: true }).click()
    const input = page.locator('.work-view [contenteditable=true][role=textbox]:visible')
    await expect(input.locator('.mention-chip--toolkit')).toHaveText('插件管理')
    await expect(input).toContainText('请帮我创建一个自定义插件')
    await input.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' @问候')
    const picker = page.locator('.mention-ref-picker:visible')
    await expect(picker.locator('[data-toolkit-id="plugin-greeting--r1"]')).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(input.locator('.mention-chip--toolkit')).toHaveCount(2)
    await expect(input.locator('.mention-chip--toolkit').last()).toHaveText('问候助手')
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    const state = await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}'), stateKey)
    expect(state.homeResources.toolkits).toEqual(['plugin-management','plugin-greeting--r1'])
    expect(state.homeMentions.some((mention: { path: string; displayText: string }) => mention.path === 'plugin-greeting--r1' && mention.displayText === '问候助手')).toBe(true)
    expect(mutations.some(item => item.path === '/api/v1/chat')).toBe(false)
  })

  test('导入预览失败保留任务回执并支持手动刷新，禁止安装失败的准备任务', async () => {
    await manager().getByRole('button',{ name: '导入', exact: true }).click()
    await manager().getByRole('tab',{ name: 'GitHub', exact: true }).click()
    await manager().getByLabel('仓库地址',{ exact: true }).fill('https://github.com/example/missing')
    await manager().getByRole('button',{ name: '预览插件', exact: true }).click()
    await expect(manager().getByRole('heading',{ name: '导入信息', exact: true })).toBeVisible()
    await expect(manager().getByRole('button',{ name: '安装插件', exact: true })).toBeDisabled()
    imports.set('failed-job',{ jobId: 'failed-job', status: 'failed', error: '重新读取后的失败原因', failureStage: 'prepare' })
    await manager().getByRole('button',{ name: '刷新导入状态', exact: true }).click()
    await expect(manager().getByRole('alert')).toHaveText('重新读取后的失败原因')
    expect(plugins.size).toBe(0)
  })

  test('批量删除只选择搜索结果，取消零请求且一次确认后按修订串行删除', async ({}, info) => {
    const template = newPlugin(), entries = [
      { id: 'batch-delete-document-one', name: '清理文档一', revision: 3 },
      { id: 'batch-delete-document-two', name: '清理文档二', revision: 7 },
      { id: 'batch-delete-retained', name: '保留图片工具', revision: 2 }
    ]
    for (const entry of entries) plugins.set(entry.id, { ...template, ...entry, manifest: { ...template.manifest, id: entry.id, name: entry.name },
      enabled: false, publishedRevision: undefined, revisions: [{ revision: entry.revision, hash: `sha256:${entry.id}`, createdAt: 1 }], createdAt: 1, updatedAt: 1 })
    await manager().getByRole('button', { name: '刷新插件', exact: true }).click()
    const search = manager().getByLabel('搜索插件', { exact: true }), list = manager().getByRole('list', { name: '已安装插件', exact: true })
    await expect(list.getByRole('listitem')).toHaveCount(3)
    await manager().getByRole('button', { name: '多选', exact: true }).click()
    const all = manager().getByRole('checkbox', { name: '全选当前结果', exact: true })
    await list.getByRole('checkbox', { name: '选择插件 保留图片工具', exact: true }).check()
    await expect(all).toHaveJSProperty('indeterminate', true)
    await search.fill('清理文档')
    await expect(list.getByRole('listitem')).toHaveCount(2)
    await expect(list.getByRole('checkbox', { checked: true })).toHaveCount(0)
    const remove = manager().getByRole('button', { name: '删除所选插件', exact: true })
    await expect(remove).toBeDisabled()
    await all.check()
    await expect(list.getByRole('checkbox', { checked: true })).toHaveCount(2)
    try {
      for (const [appearance, width, height] of [['light', 1320, 900], ['dark', 1320, 900], ['dark', 860, 760]] as const) {
        await app!.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height] as [number, number])
        await page.evaluate(async value => {
          document.documentElement.dataset.appearance = value
          for (let pass = 0; pass < 5; pass++) {
            await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
            const animations = document.getAnimations().filter(animation => (animation.pending || animation.playState === 'running') && Number.isFinite(animation.effect?.getComputedTiming().endTime))
            if (!animations.length) return
            await Promise.allSettled(animations.map(animation => animation.finished))
          }
        }, appearance)
        await expect(list.getByRole('checkbox', { checked: true })).toHaveCount(2)
        expect(await manager().evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
        expect(await list.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
        await page.screenshot({ path: info.outputPath(`batch-delete-selection-${appearance}-${width}.png`), animations: 'disabled' })
      }
    } finally {
      await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 900))
      await page.evaluate(() => document.documentElement.dataset.appearance = 'light')
    }
    await remove.click()
    const confirmation = page.getByRole('dialog', { name: '删除 2 个插件？', exact: true })
    await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    expect(deleteRequests).toEqual([])
    expect(plugins.size).toBe(3)
    await expect(list.getByRole('checkbox', { checked: true })).toHaveCount(2)
    let release!: () => void
    deleteGate = new Promise<void>(done => { release = done })
    try {
      await remove.click()
      await expect(confirmation).toBeVisible()
      await confirmation.getByRole('button', { name: '删除', exact: true }).click()
      await expect.poll(() => deleteRequests.length).toBe(1)
      expect(activeDeletes).toBe(1)
      await expect(remove).toBeDisabled()
      release()
      await expect.poll(() => [...plugins.keys()]).toEqual(['batch-delete-retained'])
      await expect(manager().getByRole('button', { name: '多选', exact: true })).toBeVisible()
      await expect(list.getByRole('checkbox')).toHaveCount(0)
      expect(deleteRequests).toEqual(entries.slice(0, 2).map(entry => ({ id: entry.id, expectedRevision: entry.revision })))
      expect(maxActiveDeletes).toBe(1)
      await expect(page.getByRole('dialog', { name: /删除.*个插件/ })).toHaveCount(0)
      await search.fill('')
      await expect(list.getByRole('listitem')).toHaveCount(1)
      await expect(list.getByRole('button', { name: '打开插件 保留图片工具', exact: true })).toBeVisible()
      await page.screenshot({ path: info.outputPath('batch-delete-filtered.png'), animations: 'disabled' })
    } finally { release(); deleteGate = undefined }
  })

  test('批量删除确认期间收到外部更新，取消后刷新列表且不发删除请求', async () => {
    const template = newPlugin(), id = 'batch-delete-event', name = '事件竞态插件'
    plugins.set(id, { ...template, id, name, manifest: { ...template.manifest, id, name }, enabled: false, revision: 1, publishedRevision: 1,
      revisions: [{ revision: 1, hash: 'sha256:runtime', createdAt: 1 }], createdAt: 1, updatedAt: 1 })
    await manager().getByRole('button', { name: '刷新插件', exact: true }).click()
    await page.evaluate(() => {
      window.addEventListener('aether:resource-catalogue-changed', event => {
        const detail = (event as CustomEvent).detail
        if (detail?.kind === 'plugin' && typeof detail.source === 'number') document.body.dataset.catalogueEventSource = String(detail.source)
      })
    })
    const toggle = manager().getByRole('switch', { name: `启用插件 ${name}`, exact: true })
    await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => page.locator('body').getAttribute('data-catalogue-event-source')).toMatch(/^\d+$/)
    await manager().getByRole('button', { name: '多选', exact: true }).click()
    await manager().getByRole('checkbox', { name: `选择插件 ${name}`, exact: true }).check()
    await manager().getByRole('button', { name: '删除所选插件', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: '删除 1 个插件？', exact: true })
    await expect(confirmation).toBeVisible()
    const previous = plugins.get(id)!, nextName = '外部更新后的插件'
    plugins.set(id, { ...previous, name: nextName, revision: 2, manifest: { ...previous.manifest, name: nextName }, updatedAt: 2 })
    await page.evaluate(id => {
      window.dispatchEvent(new CustomEvent('aether:resource-catalogue-changed', { detail: { kind: 'plugin', action: 'update', id,
        source: Number(document.body.dataset.catalogueEventSource) } }))
    }, id)
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    await expect(manager().getByRole('checkbox', { name: `选择插件 ${nextName}`, exact: true })).toBeVisible()
    await expect(manager().getByRole('checkbox', { name: `选择插件 ${name}`, exact: true })).toHaveCount(0)
    expect(deleteRequests).toEqual([])
    expect(plugins.get(id)?.revision).toBe(2)
  })

  test('批量删除部分失败保留失败选择，重试只发失败请求并准确反馈', async ({}, info) => {
    const template = newPlugin(), entries = [
      { id: 'batch-delete-success', name: '批删成功项', revision: 4 },
      { id: 'batch-delete-retry', name: '批删待重试项', revision: 9 },
      { id: 'batch-delete-last', name: '批删末项', revision: 6 }
    ]
    for (const entry of entries) plugins.set(entry.id, { ...template, ...entry, manifest: { ...template.manifest, id: entry.id, name: entry.name },
      enabled: false, publishedRevision: undefined, revisions: [{ revision: entry.revision, hash: `sha256:${entry.id}`, createdAt: 1 }], createdAt: 1, updatedAt: 1 })
    deleteFailuresRemaining.set('batch-delete-retry', 1)
    await manager().getByRole('button', { name: '刷新插件', exact: true }).click()
    const list = manager().getByRole('list', { name: '已安装插件', exact: true })
    await expect(list.getByRole('listitem')).toHaveCount(3)
    await manager().getByRole('button', { name: '多选', exact: true }).click()
    await manager().getByRole('button', { name: '完成', exact: true }).click()
    await expect(manager().getByRole('checkbox')).toHaveCount(0)
    await manager().getByRole('button', { name: '多选', exact: true }).click()
    await manager().getByRole('checkbox', { name: '全选当前结果', exact: true }).check()
    const remove = manager().getByRole('button', { name: '删除所选插件', exact: true })
    await remove.click()
    await page.getByRole('dialog', { name: '删除 3 个插件？', exact: true }).getByRole('button', { name: '删除', exact: true }).click()
    await expect.poll(() => [...plugins.keys()]).toEqual(['batch-delete-retry'])
    await expect(list.getByRole('listitem')).toHaveCount(1)
    await expect(list.getByRole('checkbox', { name: '选择插件 批删待重试项', exact: true })).toBeChecked()
    await expect(remove).toBeEnabled()
    const feedback = manager().getByRole('alert')
    await expect(feedback).toContainText('已删除 2 个插件，1 个删除失败。')
    await expect(feedback).toContainText('批删待重试项：测试删除暂时失败')
    expect(deleteRequests).toEqual(entries.map(entry => ({ id: entry.id, expectedRevision: entry.revision })))
    await page.screenshot({ path: info.outputPath('batch-delete-partial-failure.png'), animations: 'disabled' })
    await remove.click()
    await page.getByRole('dialog', { name: '删除 1 个插件？', exact: true }).getByRole('button', { name: '删除', exact: true }).click()
    await expect.poll(() => plugins.size).toBe(0)
    await expect(manager().getByRole('button', { name: '多选', exact: true })).toBeVisible()
    await expect(manager().getByRole('checkbox')).toHaveCount(0)
    expect(deleteRequests).toEqual([...entries.map(entry => ({ id: entry.id, expectedRevision: entry.revision })), { id: 'batch-delete-retry', expectedRevision: 9 }])
    await expect(feedback).toHaveCount(0)
    await expect(manager().getByRole('status')).toHaveText('已删除 1 个插件')
  })

  test('长中英文插件名称完整显示且搜索有效，格式选择支持键盘切换与取消', async ({},info) => {
    const names = ['交付验收工作台与项目发布前需求覆盖率及测试证据汇总助手', 'ReleaseReadinessAndTraceabilityWorkbenchEnterprise']
    const template = newPlugin()
    for (const [index, name] of names.entries()) {
      const id = `visual-plugin-${index}`, description = '整理输入资料并对照验收标准，汇总结构化结果、测试证据和发布说明；较长的描述不应挤掉插件名称。'
      const plugin: PluginRecord = { ...template, id, name, description, manifest: { ...template.manifest, id, name, description },
        enabled: true, revision: 1, publishedRevision: 1, revisions: [{ revision: 1, hash: 'sha256:1', createdAt: 1 }], createdAt: 1, updatedAt: 1 }
      plugins.set(id, plugin)
    }
    await manager().getByRole('button',{ name: '刷新插件', exact: true }).click()
    const list = manager().getByRole('list', { name: '已安装插件', exact: true })
    await expect(list.getByRole('listitem')).toHaveCount(2)
    try {
      for (const [appearance,width,height] of [['light',1320,900],['dark',1320,900],['dark',860,760]] as const) {
        await app!.evaluate(({ BrowserWindow },size) => BrowserWindow.getAllWindows()[0].setContentSize(...size),[width,height] as [number,number])
        await page.evaluate(async value => {
          document.documentElement.dataset.appearance = value
          for (let pass = 0; pass < 5; pass++) {
            await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
            const animations = document.getAnimations().filter(animation => (animation.pending || animation.playState === 'running') && Number.isFinite(animation.effect?.getComputedTiming().endTime))
            if (!animations.length) return
            await Promise.allSettled(animations.map(animation => animation.finished))
          }
        },appearance)
        for (const name of names) {
          const row = manager().getByRole('button', { name: `打开插件 ${name}`, exact: true })
          const title = row.locator('strong')
          await expect(title).toHaveText(name)
          await expect(title).toBeVisible()
          expect(await title.evaluate(node => ({ horizontal: node.scrollWidth <= node.clientWidth + 1, vertical: node.scrollHeight <= node.clientHeight + 1 })))
            .toEqual({ horizontal: true, vertical: true })
          const titleBounds = await title.boundingBox(), rowBounds = await row.boundingBox()
          expect(titleBounds).not.toBeNull(); expect(rowBounds).not.toBeNull()
          expect(titleBounds!.x + titleBounds!.width).toBeLessThanOrEqual(rowBounds!.x + rowBounds!.width + 1)
        }
        expect(await manager().evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
        await page.screenshot({ path: info.outputPath(`plugins-${appearance}-${width}.png`), animations: 'disabled' })
      }
      const search = manager().getByLabel('搜索插件', { exact: true })
      await search.focus()
      const searchFrame = await search.evaluate(node => {
        const inner = getComputedStyle(node), shell = getComputedStyle(node.parentElement!)
        return { innerBorders: [inner.borderTopWidth, inner.borderRightWidth, inner.borderBottomWidth, inner.borderLeftWidth].map(parseFloat),
          innerShadow: inner.boxShadow, shellBorder: parseFloat(shell.borderLeftWidth) }
      })
      expect(searchFrame.innerBorders).toEqual([0, 0, 0, 0])
      expect(searchFrame.innerShadow).toBe('none')
      expect(searchFrame.shellBorder).toBeGreaterThan(0)
      await search.fill('Traceability')
      await expect(list.getByRole('listitem')).toHaveCount(1)
      await expect(list.getByRole('button', { name: `打开插件 ${names[1]}`, exact: true })).toBeVisible()
      await search.fill('需求覆盖率')
      await expect(list.getByRole('listitem')).toHaveCount(1)
      await expect(list.getByRole('button', { name: `打开插件 ${names[0]}`, exact: true })).toBeVisible()
      await search.fill('')
      await expect(list.getByRole('listitem')).toHaveCount(2)
      await manager().getByRole('button', { name: '导入', exact: true }).click()
      const format = manager().getByRole('button', { name: '插件格式', exact: true })
      await expect(format).toHaveText('Aether 原生插件')
      await format.press('ArrowDown')
      const menu = page.getByRole('menu', { name: '插件格式', exact: true })
      await expect(menu).toBeVisible()
      await page.keyboard.press('End')
      await expect(menu.getByRole('menuitem', { name: 'remark · Markdown 处理插件', exact: true })).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(format).toHaveText('remark · Markdown 处理插件')
      await expect(format).toHaveAttribute('aria-expanded', 'false')
      await format.press('ArrowDown')
      await expect(menu).toBeVisible()
      await page.keyboard.press('Home')
      await expect(menu.getByRole('menuitem', { name: 'Aether 原生插件', exact: true })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(format).toBeFocused()
      await expect(format).toHaveAttribute('aria-expanded', 'false')
      await expect(format).toHaveText('remark · Markdown 处理插件')
      await manager().getByLabel('仓库地址', { exact: true }).fill('https://github.com/example/keyboard-format')
      await manager().getByRole('button', { name: '预览插件', exact: true }).click()
      await expect(manager().getByRole('heading', { name: '导入 github', exact: true })).toBeVisible()
      expect(mutations.filter(item => item.path === '/api/v1/plugins/imports/preview').map(item => item.body.format)).toEqual(['remark'])
      await page.screenshot({ path: info.outputPath('plugins-format-keyboard.png'), animations: 'disabled' })
    } finally {
      await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320,900))
      await page.evaluate(() => document.documentElement.dataset.appearance = 'light')
    }
  })
})
