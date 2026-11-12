/** Real Electron: MCP settings follow the visible Work workspace, keep Code's
 * default scope, and never apply an old workspace's late response to a new one.
 * Requests hit an isolated fixture; no MCP executable or user configuration is used. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import type { RootRun } from '../src/shared/root-run'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'mcp-settings-scope-token', model = 'mcp-scope-model'
const defaultRoot = '/remote/code-default', workA = '/remote/work-alpha', workB = '/remote/work-beta'
const taskA = 'work-mcp-scope-alpha', taskB = 'work-mcp-scope-beta'
const taskInfo = [
  { id: taskA, title: 'MCP 范围任务甲', workspacePath: null, bindingRoot: workA },
  { id: taskB, title: 'MCP 范围任务乙', workspacePath: '/remote/stale-beta-hint', bindingRoot: workB }
]
interface ServerConfig {
  id: string; name: string; scope: 'project' | 'global'; transportType: 'stdio'; command: string
  args: string[]; enabled: boolean; disabledTools?: string[]
}
interface Receipt { method: string; endpoint: string; project: string | null; scope: string | null; body: Record<string, unknown> }
const servers = new Map<string, ServerConfig[]>(), receipts: Receipt[] = [], errors: string[] = []
const runs = new Map<string, RootRun>(), histories = new Map<string, EngineHistoryRow[]>()
let app: ElectronApplication | undefined, page: Page, fixture = '', storageKey = ''
let holdNext: { endpoint: string; project: string } | undefined
let held: { response: ServerResponse; data: unknown } | undefined
let failNextWorkspace = false
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
function answer(response: ServerResponse, data: unknown): void { if (!response.writableEnded && !response.destroyed) response.end(envelope(data)) }
function resetFixture(): void {
  servers.clear(); receipts.length = 0; runs.clear(); histories.clear(); holdNext = undefined; failNextWorkspace = false
  for (const [project, id, name] of [[workA, 'alpha-mcp', '甲项目 MCP'], [workB, 'beta-mcp', '乙项目 MCP'], [defaultRoot, 'code-mcp', 'Code 默认 MCP']])
    servers.set(project, [{ id, name, scope: 'project', transportType: 'stdio', command: 'node', args: ['fixture-only.mjs'], enabled: true }])
  servers.set('global', [{ id: 'global-mcp', name: '全局 MCP', scope: 'global', transportType: 'stdio', command: 'node', args: ['global-fixture.mjs'], enabled: true }])
  for (const task of taskInfo) {
    const now = Date.now() - 5000
    const run: RootRun = { schemaVersion: 1, runId: `run-${task.id}`, sessionId: task.id, turnId: `turn-${task.id}`,
      userMessageId: `user-${task.id}`, assistantMessageId: `assistant-${task.id}`, seq: 1, version: 2, status: 'succeeded',
      modelId: model, pending: [], workspacePaths: [task.bindingRoot], createdAt: now, updatedAt: now, startedAt: now, finishedAt: now }
    runs.set(task.id, run)
    histories.set(task.id, [
      { id: run.userMessageId, role: 'user', content: task.title, createdAt: now, conversationId: run.turnId, metadata: { rootRunId: run.runId } },
      { id: run.assistantMessageId, role: 'assistant', content: 'MCP_SCOPE_READY', createdAt: now + 1, conversationId: run.turnId, metadata: { rootRunId: run.runId } }
    ])
  }
}
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), endpoint = url.pathname
  const sessionId = url.searchParams.get('sessionId') ?? '', project = url.searchParams.get('path')
  response.setHeader('content-type', 'application/json')
  if (endpoint.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${endpoint}`)
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {}
  if (endpoint.startsWith('/api/v1/mcp/')) {
    const method = request.method ?? 'GET'
    receipts.push({ method, endpoint, project, scope: url.searchParams.get('scope'), body })
    const storeKey = project ?? (url.searchParams.get('scope') === 'global' ? 'global' : '')
    const current = servers.get(storeKey) ?? []
    let result: unknown
    if (endpoint === '/api/v1/mcp/servers' && method === 'GET') result = structuredClone(current)
    else if (endpoint === '/api/v1/mcp/config/export' && method === 'GET') result = { mcpServers: Object.fromEntries(current.map(item => [item.id, item])) }
    else if (endpoint === '/api/v1/mcp/config/import' && method === 'POST') {
      const config = body.config as { mcpServers: Record<string, ServerConfig> }
      servers.set(storeKey, Object.entries(config.mcpServers).map(([id, item]) => ({ ...item, id, scope: body.scope === 'global' ? 'global' : 'project' })))
      result = { count: Object.keys(config.mcpServers).length }
    } else {
      const match = /^\/api\/v1\/mcp\/servers\/([^/]+)(?:\/(test|enable|disable))?$/.exec(endpoint)
      const item = current.find(candidate => candidate.id === decodeURIComponent(match?.[1] ?? ''))
      if (!match || !item) throw new Error(`Wrong MCP target: ${method} ${endpoint} at ${project}`)
      if (match[2] === 'test') result = { toolCount: 1, tools: [{ name: 'echo', description: '范围测试工具' }] }
      else if (match[2] === 'enable' || match[2] === 'disable') { item.enabled = match[2] === 'enable'; result = item }
      else if (method === 'PATCH') { Object.assign(item, body); result = item }
      else throw new Error(`Unexpected MCP mutation: ${method} ${endpoint}`)
    }
    if (holdNext?.endpoint === endpoint && holdNext.project === project) { holdNext = undefined; held = { response, data: result }; return }
    answer(response, result); return
  }
  const run = runs.get(sessionId), rows = histories.get(sessionId) ?? []
  if (endpoint === '/api/v1/workspace/directory' && sessionId === taskA && failNextWorkspace) {
    failNextWorkspace = false
    response.writeHead(503).end(JSON.stringify({ code: 503, message: '测试：会话工作目录暂不可读' })); return
  }
  if (endpoint === '/api/v1/workspace/bind') { answer(response, { workspaceRoot: body.workspaceRoot }); return }
  if (endpoint === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  if (['/api/v1/cron/capabilities', '/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request'].includes(endpoint)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET') throw new Error(`Unexpected mutation: ${request.method} ${endpoint}`)
  const data = endpoint === '/health' ? { status: 'ok' }
    : endpoint === '/meta' ? { version: '2.0.0', buildId: `sha256:${'d'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'mcp-settings-scope' }
    : endpoint === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: 'MCP 范围测试模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
    : endpoint === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', eventId: null, finished: true, history: rows, projection: [], run, runs: run ? [run] : [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : endpoint === '/api/v1/chat/status' ? { running: false, finished: true, run, lastEventId: null }
    : endpoint === '/api/v1/chat/runs' ? { runs: run ? [run] : [] }
    : endpoint === '/api/v1/conversation/history' ? rows
    : endpoint === '/api/v1/conversation/display' ? { schemaVersion: 1, grouping: 'root', turns: rows.filter(row => row.role === 'user').map(row => ({ userMessageId: row.id, conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows, loadedTurnIds: rows.filter(row => row.role === 'user').map(row => row.id), revision: sessionId, mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' }
    : endpoint === '/api/v1/conversation/sessions' ? taskInfo.map(task => ({ sessionId: task.id, title: task.title, lastAt: Date.now(), messageCount: 2 }))
    : endpoint === '/api/v1/workspace/directory' ? { root: taskInfo.find(task => task.id === sessionId)?.bindingRoot ?? defaultRoot, entries: [], bindingEpoch: 'scope-binding' }
    : endpoint === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : endpoint === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : endpoint === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(endpoint) ? { started: true, agentId: null, metadata: null, agent: null }
    : /\/sessions\/[^/]+\/toolkits$/.test(endpoint) ? { toolkits: [] }
    : endpoint === '/api/v1/toolkits' ? { toolkits: [] }
    : endpoint === '/api/v1/skills' ? { list: [] }
    : endpoint === '/api/v1/security/mode' ? { mode: 'standard', sessionId }
    : endpoint === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId }
    : endpoint === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : endpoint === '/api/v1/command-jobs' ? { jobs: [] } : []
  answer(response, data)
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); if (!response.writableEnded) response.end(String(error)) }) })

const settings = (): Locator => page.locator('.app-settings:visible')
const mcp = (): Locator => settings().locator('.settings-view--mcp')
const row = (name: string): Locator => mcp().getByRole('article', { name, exact: true })
async function openSettings(): Promise<void> {
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  await settings().getByRole('tab', { name: 'MCP', exact: true }).click()
  await expect(mcp()).toBeVisible()
}
async function closeSettings(): Promise<void> {
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings()).toHaveCount(0)
}
async function openJson(): Promise<void> {
  const disclosure = mcp().getByRole('button', { name: 'JSON 配置', exact: true })
  if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click()
  await expect(mcp().getByRole('textbox', { name: 'MCP JSON 配置', exact: true })).toBeVisible()
}
async function readJson(): Promise<void> {
  await openJson()
  await mcp().getByRole('button', { name: '读取当前配置', exact: true }).click()
}
async function selectTask(title: string): Promise<void> {
  await page.locator('.work-sidebar__recent').getByText(title, { exact: true }).click()
  await expect(page.locator('.work-task-heading h1')).toHaveText(title)
  await expect(page.locator('.work-view')).toContainText('MCP_SCOPE_READY')
}
async function seed(): Promise<void> {
  resetFixture()
  await page.evaluate(({ key, taskInfo, model }) => {
    window.dispatchEvent(new Event('blur'))
    localStorage.setItem(key, JSON.stringify({ tasks: taskInfo.map(task => ({ ...task, status: 'done', draft: '', mentions: [],
      createdAt: Date.now(), updatedAt: Date.now(), modelId: model, attachments: [], sources: [] })), activeTaskId: taskInfo[0].id, homeDraft: '' }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 60 }))
  }, { key: storageKey, taskInfo, model })
  await page.reload()
  await expect(page.locator('.work-task-heading h1')).toHaveText(taskInfo[0].title)
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await expect(page.locator('.work-view')).toContainText('MCP_SCOPE_READY')
}

test.describe.serial('MCP 设置项目范围', () => {
  test.beforeAll(async () => {
    resetFixture(); mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'mcp-settings-scope-profile-'))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    storageKey = `aether.work.state.v1:${encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin }))}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, remoteWorkspaceRoot: defaultRoot,
      autoStartEngine: true, lastSessionId: 'mcp-scope-work-a', lastFolder: '', lastModelId: model, appearance: 'light', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1440, 1000); win.show(); win.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  })
  test.beforeEach(seed)
  test.afterEach(async ({}, info) => {
    if (held) { answer(held.response, held.data); held = undefined }
    holdNext = undefined
    if (page && !page.isClosed()) {
      const path = info.outputPath('mcp-settings-scope.png'); await page.screenshot({ path, animations: 'disabled' })
      await info.attach('MCP 设置项目范围', { path, contentType: 'image/png' })
    }
    await info.attach('MCP request scopes', { body: JSON.stringify({ receipts, errors }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([])
  })
  test.afterAll(async () => {
    try { await app?.close() } finally {
      server.closeAllConnections(); if (server.listening) await new Promise<void>(done => server.close(() => done()))
      if (fixture) { const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('mcp-settings-scope-profile-')) throw new Error(`Unsafe fixture cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('Work 会话读取自己的 MCP 列表和 JSON，切换项目不沿用 Code 默认目录', async ({}, info) => {
    await openSettings(); await expect(row('甲项目 MCP')).toBeVisible(); await expect(mcp()).not.toContainText('Code 默认 MCP')
    await expect(mcp().locator('.mcp-context__path')).toHaveText(workA)
    await settings().screenshot({ path: info.outputPath('mcp-current-work-project.png'), animations: 'disabled' })
    await readJson()
    await expect(mcp().getByRole('textbox', { name: 'MCP JSON 配置', exact: true })).toHaveValue(/alpha-mcp/)
    expect(receipts.filter(item => item.endpoint.endsWith('/config/export')).at(-1)).toMatchObject({ project: workA, scope: 'project' })
    servers.get(workA)![0].name = '甲项目 MCP 已刷新'
    await mcp().getByRole('button', { name: '刷新 MCP 服务器', exact: true }).click(); await expect(row('甲项目 MCP 已刷新')).toBeVisible()
    await closeSettings(); await selectTask(taskInfo[1].title); await openSettings()
    await expect(row('乙项目 MCP')).toBeVisible(); await expect(mcp()).not.toContainText('甲项目 MCP')
    await readJson()
    await expect(mcp().getByRole('textbox', { name: 'MCP JSON 配置', exact: true })).toHaveValue(/beta-mcp/)
    expect(receipts.filter(item => item.endpoint.endsWith('/config/export')).at(-1)?.project).toBe(workB)
    await closeSettings()
  })

  test('MCP 测试、开关、编辑和 JSON 应用都使用当前 Work 项目', async () => {
    await openSettings(); await expect(row('甲项目 MCP')).toBeVisible()
    await row('甲项目 MCP').getByRole('button', { name: '测试', exact: true }).click()
    await expect(mcp()).toContainText('连接成功，发现 1 个工具')
    await row('甲项目 MCP').getByRole('switch', { name: '甲项目 MCP 启用', exact: true }).click()
    await expect.poll(() => servers.get(workA)![0].enabled).toBe(false)
    await row('甲项目 MCP').getByRole('button', { name: '甲项目 MCP 的更多操作', exact: true }).click()
    await page.locator('.mcp-server-menu:visible').getByRole('button', { name: '编辑', exact: true }).click()
    const editDialog = page.getByRole('dialog', { name: '编辑 MCP 服务器', exact: true })
    await editDialog.getByRole('textbox', { name: 'MCP 名称', exact: true }).fill('甲项目 MCP 已编辑')
    await editDialog.getByRole('button', { name: '保存', exact: true }).click(); await expect(editDialog).toHaveCount(0)
    await expect(row('甲项目 MCP 已编辑')).toBeVisible()
    const imported = { ...servers.get(workA)![0], id: 'alpha-imported', name: '甲项目 JSON MCP' }
    await openJson()
    await mcp().getByRole('textbox', { name: 'MCP JSON 配置', exact: true }).fill(JSON.stringify({ mcpServers: { [imported.id]: imported } }))
    await mcp().getByRole('button', { name: '应用 JSON', exact: true }).click(); await expect(row(imported.name)).toBeVisible()
    const mutations = receipts.filter(item => item.method !== 'GET')
    expect(mutations.map(item => [item.method, item.endpoint])).toEqual([
      ['POST', '/api/v1/mcp/servers/alpha-mcp/test'], ['POST', '/api/v1/mcp/servers/alpha-mcp/disable'],
      ['PATCH', '/api/v1/mcp/servers/alpha-mcp'], ['POST', '/api/v1/mcp/config/import']
    ])
    expect(mutations.map(item => item.project)).toEqual([workA, workA, workA, workA])
    expect(servers.get(workB)![0]).toMatchObject({ id: 'beta-mcp', name: '乙项目 MCP', enabled: true })
    expect(servers.get(defaultRoot)![0]).toMatchObject({ id: 'code-mcp', name: 'Code 默认 MCP', enabled: true })
    await closeSettings()
  })

  for (const endpoint of ['/api/v1/mcp/servers', '/api/v1/mcp/config/export']) test(`切换会话后忽略旧项目延迟返回：${endpoint}`, async () => {
    await openSettings(); await expect(row('甲项目 MCP')).toBeVisible()
    holdNext = { endpoint, project: workA }
    if (endpoint.endsWith('/servers')) await mcp().getByRole('button', { name: '刷新 MCP 服务器', exact: true }).click()
    else await readJson()
    await expect.poll(() => Boolean(held)).toBe(true)
    await closeSettings(); await selectTask(taskInfo[1].title); await openSettings(); await expect(row('乙项目 MCP')).toBeVisible()
    await readJson()
    const editor = mcp().getByRole('textbox', { name: 'MCP JSON 配置', exact: true })
    await expect(editor).toHaveValue(/beta-mcp/)
    const pending = held!
    const response = pending.response.destroyed ? Promise.resolve() : new Promise<void>(done => {
      pending.response.once('finish', done); pending.response.once('close', done)
    })
    answer(pending.response, pending.data); held = undefined
    await response
    // HTTP is carried by the main-process bridge, not the renderer's network events.
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
    await expect(row('乙项目 MCP')).toBeVisible(); await expect(mcp()).not.toContainText('甲项目 MCP')
    await expect(editor).toHaveValue(/beta-mcp/)
    await closeSettings()
  })

  test('会话目录解析失败明确报错，可重试且不读取 Code 默认 MCP', async () => {
    receipts.length = 0; failNextWorkspace = true
    await openSettings()
    await expect(mcp().getByRole('alert')).toContainText('无法确认当前会话的项目目录')
    await expect(mcp()).not.toContainText('暂无 MCP 服务器')
    expect(receipts).toEqual([])
    await mcp().getByRole('button', { name: '重试读取项目目录', exact: true }).click()
    await expect(row('甲项目 MCP')).toBeVisible()
    expect(receipts.filter(item => item.endpoint.endsWith('/servers')).map(item => item.project)).toEqual([workA])
    await closeSettings()
  })

  test('Work 首页未选择目录时仅管理全局 MCP，不能保存到隐含项目', async () => {
    await page.evaluate(key => {
      window.dispatchEvent(new Event('blur'))
      const state = JSON.parse(localStorage.getItem(key)!)
      state.activeTaskId = null; state.homeWorkspacePath = null; state.homeSessionId = null
      localStorage.setItem(key, JSON.stringify(state))
    }, storageKey)
    await page.reload(); await expect(page.locator('.work-home')).toBeVisible()
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
    receipts.length = 0
    await openSettings(); await expect(row('全局 MCP')).toBeVisible()
    await openJson()
    const jsonScope = mcp().getByRole('button', { name: 'MCP JSON 保存层级', exact: true })
    await expect(jsonScope).toBeDisabled(); await expect(jsonScope).toContainText('全局')
    await readJson()
    await expect(mcp().getByRole('textbox', { name: 'MCP JSON 配置', exact: true })).toHaveValue(/global-mcp/)
    await mcp().getByRole('button', { name: '新增服务器', exact: true }).click()
    const addDialog = page.getByRole('dialog', { name: '新增 MCP 服务器', exact: true })
    const formScope = addDialog.getByRole('button', { name: 'MCP 服务器保存层级', exact: true })
    await expect(formScope).toBeDisabled(); await expect(formScope).toContainText('全局')
    await addDialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(addDialog).toHaveCount(0)
    await mcp().getByRole('button', { name: '应用 JSON', exact: true }).click()
    await expect(mcp()).toContainText('MCP JSON 已校验并原子保存')
    expect(receipts.length).toBeGreaterThanOrEqual(3)
    expect(receipts.every(item => item.project === null && item.scope === 'global')).toBe(true)
    expect(receipts.find(item => item.endpoint.endsWith('/config/import'))?.body.scope).toBe('global')
    expect(servers.get(defaultRoot)![0].id).toBe('code-mcp')
    await closeSettings()
  })
})
