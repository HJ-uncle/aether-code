/** Isolated Electron + authenticated engine fixture. Plugin mutations and source text never execute locally. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'
import type { PluginRecord, PluginImport, PluginTemplate } from '../src/renderer/src/core/engine/plugins'
import { newPlugin, pluginSource } from './fixtures/plugin'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp/plugins'), token = 'plugin-ui-disposable-token'
const modelId = 'plugin-ui-model', fixturePort = Number(process.env.AETHER_PLUGIN_UI_PORT ?? 12541), origin = `http://127.0.0.1:${fixturePort}`
const source = engineStorageKey({ mode: 'remote', baseUrl: origin }), stateKey = sessionStorageKey('aether.work.state.v1', source)
const plugins = new Map<string, PluginRecord>(), imports = new Map<string, PluginImport>(), mutations: Array<{ path: string; body: Record<string, unknown> }> = []
const errors: string[] = []
let failTemplate = false
const runtimeCalls: Array<Record<string, unknown>> = []
let runtimeError = '', runtimeAllowed = true, runtimeGate: Promise<void> | undefined, completedRuntimeCalls = 0
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
  if (path === '/api/v1/plugins/imports/preview') {
    if (body.url === 'https://github.com/example/missing') {
      const item: PluginImport = { jobId: 'failed-job', status: 'failed', error: '缺少 aether-plugin.json', failureStage: 'prepare' }
      imports.set(item.jobId,item); response.writeHead(400).end(JSON.stringify({ code: 40000, message: item.error, data: { import: item } })); return
    }
    const id = `imported-${body.source}`, template = newPlugin(), manifest = { ...template.manifest, id, name: `导入 ${body.source}` }
    const item: PluginImport = { jobId: `job-${imports.size + 1}`, status: 'prepared', manifest, source: { type: body.source, ...(body.source === 'github' ? { commit: 'a'.repeat(40) } : {}) } }
    imports.set(item.jobId, item); response.end(envelope({ import: item })); return
  }
  const importJob = /^\/api\/v1\/plugins\/imports\/([^/]+)$/.exec(path)
  if (importJob && request.method === 'GET') { response.end(envelope({ import: imports.get(importJob[1]) })); return }
  const install = /^\/api\/v1\/plugins\/imports\/([^/]+)\/install$/.exec(path)
  if (install) {
    const item = imports.get(install[1])!; const plugin: PluginRecord = { ...newPlugin(), manifest: item.manifest!, id: item.manifest!.id, name: item.manifest!.name,
      description: item.manifest!.description, revision: 1, enabled: false, source: item.source, revisions: [{ revision: 1, hash: 'sha256:import', createdAt: Date.now() }], createdAt: Date.now(), updatedAt: Date.now() }
    plugins.set(plugin.id, plugin); response.end(envelope({ plugin })); return
  }
  const match = /^\/api\/v1\/plugins(?:\/([^/]+))?(?:\/(publish|test))?$/.exec(path)
  if (match) {
    const id = match[1] && decodeURIComponent(match[1]), action = match[2]
    if (request.method === 'GET') { response.end(envelope(id ? { plugin: plugins.get(id) } : { plugins: [...plugins.values()].map(({ files: _, ...item }) => item) })); return }
    if (action === 'test') { response.end(envelope({ result: { text: `TEST_RESULT_${String((body.args as Record<string, unknown>)?.name)}` }, artifacts: [] })); return }
    if (action === 'publish') { const plugin = { ...plugins.get(id!)!, publishedRevision: plugins.get(id!)!.revision, enabled: true }; plugins.set(id!, plugin); response.end(envelope({ plugin })); return }
    if (request.method === 'DELETE') { plugins.delete(id!); response.end(envelope({ deleted: true })); return }
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
  test.beforeEach(async () => { plugins.clear(); imports.clear(); mutations.length = 0; failTemplate = false; runtimeCalls.length = 0; runtimeError = ''; runtimeAllowed = true; runtimeGate = undefined; completedRuntimeCalls = 0; await seed() })
  test.afterEach(async ({}, info) => { if (!page.isClosed()) await page.screenshot({ path: info.outputPath('plugins.png') }); expect(errors).toEqual([]) })
  test.afterAll(async () => { try { await app?.close() } finally { server.closeAllConnections(); if (server.listening) await new Promise<void>(done => server.close(() => done())); if (fixture) { if (dirname(resolve(fixture)) !== fixtureRoot) throw new Error('Unsafe plugin profile cleanup'); rmSync(fixture,{ recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } } })

  test('手动创建、源码编辑、测试、发布、启停和删除使用真实持久回执', async () => {
    await manager().getByRole('button', { name: '新建插件', exact: true }).click()
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
    await expect(application.getByLabel('插件功能')).toHaveValue('convert')
    await expect(application.getByLabel('插件功能').getByRole('option', { selected: true })).toHaveText('单笔换算')
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
    await expect(manager().getByLabel('官方模板',{ exact: true })).toHaveValue('json-tool')
    await manager().getByLabel('官方模板',{ exact: true }).selectOption('markdown-report')
    await expect(manager().getByLabel('名称',{ exact: true })).toHaveValue('报告生成工具')
    failTemplate = true
    await manager().getByLabel('官方模板',{ exact: true }).selectOption('json-tool')
    await expect(manager().getByRole('alert')).toContainText('模板服务暂不可用')
    await expect(manager().getByLabel('官方模板',{ exact: true })).toHaveValue('markdown-report')
    await expect(manager().getByLabel('名称',{ exact: true })).toHaveValue('报告生成工具')
    failTemplate = false
    await manager().getByLabel('标识',{ exact: true }).fill('export-probe')
    await manager().getByLabel('名称',{ exact: true }).fill('可导出工程')
    const exportButton = manager().getByRole('button',{ name: '导出插件 ZIP', exact: true })
    await expect(exportButton).toBeDisabled()
    await manager().getByRole('tab',{ name: '源文件', exact: true }).click()
    await manager().getByRole('combobox',{ name: '选择源文件', exact: true }).selectOption('aether-plugin.json')
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
      if (kind === 'archive') await manager().locator('input[type=file]').setInputFiles({ name: 'fixture.zip', mimeType: 'application/zip', buffer: Buffer.from('fixture archive') })
      else await manager().getByLabel(kind === 'github' ? '仓库地址' : '引擎所在电脑的目录', { exact: true }).fill(kind === 'github' ? 'https://github.com/example/plugin' : 'D:\\fixtures\\plugin')
      await manager().getByRole('button', { name: '预览插件', exact: true }).click()
      await expect(manager().getByRole('heading', { name: `导入 ${kind}`, exact: true })).toBeVisible()
      expect(plugins.size).toBe(['github','directory','archive'].indexOf(kind))
      await manager().getByRole('button', { name: '安装插件', exact: true }).click()
      await expect(manager().getByRole('button', { name: `打开插件 导入 ${kind}`, exact: true })).toBeVisible()
      expect(plugins.get(`imported-${kind}`)?.source).toMatchObject({ type: kind })
    }
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

  test('插件列表保持单行信息并适配浅色、深色与窄窗', async ({},info) => {
    const template = newPlugin(), plugin: PluginRecord = { ...template, id: 'visual-plugin', name: '资料整理', description: '整理输入资料，生成简洁的结构化结果。', manifest: { ...template.manifest, id: 'visual-plugin', name: '资料整理' },
      enabled: true, revision: 1, publishedRevision: 1, revisions: [{ revision: 1, hash: 'sha256:1', createdAt: 1 }], createdAt: 1, updatedAt: 1 }
    plugins.set(plugin.id,plugin)
    await manager().getByRole('button',{ name: '刷新插件', exact: true }).click()
    await expect(manager().getByRole('button',{ name: '打开插件 资料整理', exact: true })).toBeVisible()
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
      expect(await manager().evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      await page.screenshot({ path: info.outputPath(`plugins-${appearance}-${width}.png`) })
    }
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320,900))
    await page.evaluate(() => document.documentElement.dataset.appearance = 'light')
  })
})
