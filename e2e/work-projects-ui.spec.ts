/** Real Electron + owned engine fixture: master-detail project identity,
 * cross-project search, source-scoped pins/selection/sort, virtual navigation,
 * paginated task opening, complete details, responsive light/dark layout,
 * project/task context menus, independent sessions and source isolation, confirmed deletion and failure recovery, local aliases/archive,
 * and draft-preserving creation. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { WorkState, WorkTask } from '../src/renderer/src/contrib/work/work-state'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'disposable-projects-ui-token', now = Date.now() - 60_000
const alphaPath = 'D:\\clients\\alpha\\web-2048', betaPath = 'D:\\clients\\beta\\web-go'
const sameNamePath = 'D:\\archive\\客户资料与项目成果\\跨部门协作项目\\需要保留完整路径以便区分同名项目\\web-2048'
const longTitle = '为当前 Web 项目整理面向技术客户的介绍材料，包含 Word 项目说明、Excel 功能清单与演示文稿，并核对最终交付文件'
const task = (id: string, title: string, workspacePath: string | null, updatedAt: number, status: WorkTask['status'] = 'done'): WorkTask => ({
  id, title, workspacePath, updatedAt, status, createdAt: updatedAt - 60_000, draft: '', modelId: '', attachments: [], sources: [],
})
const alphaTasks = Array.from({ length: 52 }, (_, index) => task(`work-project-alpha-${index}`,
  index === 0 ? longTitle : index === 51 ? '核对特殊验收关键词的历史任务' : `项目交付核对 ${String(index + 1).padStart(2, '0')}`,
  alphaPath, now - index * 60_000, index === 2 ? 'stopped' : index === 3 ? 'error' : 'done'))
const tasks: WorkTask[] = [
  task('work-project-same-2', '归档目录中的独立成果', sameNamePath, now - 200_000),
  task('work-project-beta-2', '生成客户演示资料', betaPath, now - 150_000),
  ...alphaTasks.slice().reverse(),
  task('work-project-beta-1', '整理围棋项目的功能清单', betaPath, now - 100_000),
  task('work-project-same-1', '同名项目中的独立任务', sameNamePath, now - 190_000),
  task('work-project-beta-3', '复核项目说明文档', betaPath, now - 170_000),
  { ...task('work-project-archived', '归档任务不应出现', 'D:\\archived-only', now + 1_000), archived: true },
  task('work-project-unbound', '无工作目录的独立会话', null, now + 2_000),
]
const independentTasks: WorkTask[] = [
  task('work-independent-done', '独立会话：整理灵感记录', null, now + 8_000),
  { ...task('work-independent-running', '独立会话：正在整理资料', null, now + 3_000, 'running'),
    activity: { runId: 'root-work-independent-running', seq: 1, version: 2, status: 'running', updatedAt: now + 3_000, pendingAsk: 0, pendingPermission: 0 } },
  { ...task('work-independent-permission', '独立会话：等待工具授权', null, now + 2_000, 'waiting'),
    activity: { runId: 'root-work-independent-permission', seq: 1, version: 2, status: 'waiting', updatedAt: now + 2_000, pendingAsk: 0, pendingPermission: 1 } },
  { ...task('work-independent-ask', '独立会话：等待补充要求', null, now + 1_000, 'waiting'),
    activity: { runId: 'root-work-independent-ask', seq: 1, version: 2, status: 'waiting', updatedAt: now + 1_000, pendingAsk: 1, pendingPermission: 0 } },
  { ...task('work-independent-both', '独立会话：等待授权和补充', null, now, 'waiting'),
    activity: { runId: 'root-work-independent-both', seq: 1, version: 2, status: 'waiting', updatedAt: now, pendingAsk: 1, pendingPermission: 1 } },
  { ...task('work-independent-archived', '已归档的独立会话', null, now + 9_000), archived: true },
]
const portfolioTasks = Array.from({ length: 160 }, (_, index) => task(`work-project-portfolio-${index}`,
  `规模项目任务 ${String(index).padStart(3, '0')}`, `D:\\portfolio\\Project-${String(index).padStart(3, '0')}`, now - 20_000_000 - index * 60_000))
let seededTasks = tasks
const errors: string[] = [], forbidden: string[] = [], opened: string[] = []
const deletedSessions: string[] = []
const deletionRequests: Array<{ sessionId: string; keepWorkspace: string | null }> = []
const failNextDeletion = new Set<string>()
const deletionFailureMessage = '删除服务暂时不可用，请重试'
const workspaceBindings = new Map<string, string>()
let app: ElectronApplication | undefined, page: Page, fixture = '', storageKey = '', preferencesKey = ''
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const findTask = (id: string): WorkTask | undefined => seededTasks.find(item => item.id === id)
const run = (id: string): RootRun | undefined => {
  const item = findTask(id)
  if (!item) return undefined
  const active = item.status === 'running' || item.status === 'waiting'
  const pending: RootRun['pending'] = item.status !== 'waiting' ? [] : [
    ...(item.activity?.pendingPermission ? [{ kind: 'permission' as const, requestId: `permission-${id}`, toolCallId: `tool-${id}`,
      toolName: 'read_file', args: { path: 'permission-fixture.txt' }, description: '隔离夹具等待授权，不执行实际操作。', status: 'pending' as const }] : []),
    ...(item.activity?.pendingAsk ? [{ kind: 'ask' as const, requestId: `ask-${id}`, toolCallId: `ask-tool-${id}`,
      toolName: 'ask_user', args: {}, question: '请补充本次任务要求。', status: 'pending' as const }] : []),
  ]
  return { schemaVersion: 1, runId: `root-${id}`, sessionId: id, turnId: `turn-${id}`,
    userMessageId: `user-${id}`, assistantMessageId: `assistant-${id}`, seq: 1, version: 2,
    status: item.status === 'running' ? 'running' : item.status === 'waiting' ? 'waiting'
      : item.status === 'error' ? 'failed' : item.status === 'stopped' ? 'cancelled' : 'succeeded', modelId: '',
    pending, workspacePaths: item.workspacePath ? [item.workspacePath] : [], createdAt: item.createdAt,
    updatedAt: item.updatedAt, startedAt: item.createdAt, ...(!active ? { finishedAt: item.updatedAt } : {}) }
}
const history = (id: string) => findTask(id) ? [
  { id: `user-${id}`, role: 'user', content: findTask(id)!.title, createdAt: findTask(id)!.createdAt,
    conversationId: `turn-${id}`, metadata: { rootRunId: `root-${id}` } },
  { id: `assistant-${id}`, role: 'assistant', content: `已打开正确任务：${id}`, createdAt: findTask(id)!.updatedAt,
    conversationId: `turn-${id}`, metadata: { rootRunId: `root-${id}` } },
] : []
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  let raw = ''; for await (const chunk of request) raw += chunk.toString()
  const body: unknown = raw ? JSON.parse(raw) : null
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated fixture request: ${path}`)
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (path === '/api/v1/workspace/bind') {
    if (body && typeof body === 'object' && 'sessionId' in body && 'workspaceRoot' in body &&
      typeof body.sessionId === 'string' && typeof body.workspaceRoot === 'string') workspaceBindings.set(body.sessionId, body.workspaceRoot)
    response.end(envelope({ workspaceRoot: body && typeof body === 'object' && 'workspaceRoot' in body && typeof body.workspaceRoot === 'string'
      ? body.workspaceRoot : findTask(id)?.workspacePath ?? alphaPath })); return
  }
  const deletion = /^\/api\/v1\/sessions\/([^/]+)$/.exec(path)
  if (request.method === 'DELETE' && deletion) {
    const target = decodeURIComponent(deletion[1]), keepWorkspace = url.searchParams.get('keepWorkspace')
    if (!findTask(target) || keepWorkspace !== 'true' || body !== null)
      throw new Error(`Unexpected session deletion: ${target}, keepWorkspace=${keepWorkspace}`)
    deletionRequests.push({ sessionId: target, keepWorkspace })
    if (failNextDeletion.delete(target)) {
      response.writeHead(500).end(JSON.stringify({ code: 500, message: deletionFailureMessage, data: null })); return
    }
    seededTasks = seededTasks.filter(task => task.id !== target)
    deletedSessions.push(target)
    response.end(envelope({ success: true, sessionId: target })); return
  }
  if (request.method !== 'GET') { forbidden.push(`${request.method} ${path}`); throw new Error(`Project browsing must not mutate the engine: ${path}`) }
  const rows = history(id), current = run(id)
  if (path === '/api/v1/conversation/display') {
    opened.push(id)
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows,
      loadedTurnIds: users.map(row => row.id), revision: `${id}-stable`, mutationRevision: `${id}-stable`, backend: 'jsonl', completeness: 'complete' })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'a'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'projects-ui-fixture' }
    : path === '/api/v1/models' ? []
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: current?.status !== 'running',
      history: rows, projection: [], run: current, runs: current ? [current] : [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: current?.status === 'running', finished: current?.status !== 'running', run: current, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: current ? [current] : [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? []
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'projects-fixture', sessionId: id,
      namespace: { id: 'projects-db', generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: Boolean(current), agentId: null, metadata: null, agent: null }
    : path === '/api/v1/memory/settings' ? { sessionId: id, memoryScope: 'off', effectiveScope: 'off', enabled: false }
    : path === '/api/v1/memory/preferences' ? { enabled: false, globalEnabled: false, sessionDefaultEnabled: false }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: workspaceBindings.get(id) ?? findTask(id)?.workspacePath ?? alphaPath, bindingEpoch: 'one', entries: [] }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] }
    : path === '/api/v1/settings' ? {} : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end('Projects fixture failed') }) })

const projects = (): Locator => page.locator('.work-projects')
const navigation = (): Locator => projects().getByRole('listbox', { name: '项目列表', exact: true })
const options = (): Locator => navigation().locator('.work-project-nav-item')
const option = (path: string): Locator => navigation().locator(`.work-project-nav-item[data-project-path=${JSON.stringify(path)}]`)
const detail = (): Locator => projects().locator('.work-project-detail')
const independentNavigation = (): Locator => projects().getByRole('button', { name: '独立会话', exact: true })
const independentDetail = (): Locator => projects().getByRole('region', { name: '独立会话', exact: true })
const independentScope = (): Locator => independentDetail().getByRole('button', { name: '独立会话范围', exact: true })
const search = (): Locator => projects().getByRole('searchbox', { name: '搜索项目或任务', exact: true })
const projectMenu = (): Locator => page.locator('.context-menu').filter({ has: page.getByRole('menuitem', { name: /^查看项目/ }) })
const menuAction = (name: string): Locator => projectMenu().getByRole('menuitem', { name: new RegExp(`^${name}`) })
const taskButton = (id: string): Locator => detail().locator(`.work-project-task[data-task-id="${id}"]`)
const sidebarTask = (id: string): Locator => page.locator(`.work-sidebar__task-row[data-task-id="${id}"]`)
const taskMenu = (): Locator => page.locator('.context-menu').filter({ has: page.getByRole('menuitem', { name: '删除任务', exact: true }) })
const taskAction = (name: string): Locator => taskMenu().getByRole('menuitem', { name, exact: true })
const deleteConfirmation = (): Locator => page.getByRole('dialog', { name: '删除任务', exact: true })
const state = (): Promise<WorkState> => page.evaluate(key => {
  return JSON.parse(localStorage.getItem(key) ?? '{}') as WorkState
}, storageKey)
async function seed(seedTasks = tasks, home: Partial<Pick<WorkState, 'homeDraft' | 'homeWorkspacePath' | 'homeAttachments' | 'homeSources' | 'homeSessionId'>> = {}): Promise<void> {
  seededTasks = seedTasks
  failNextDeletion.clear()
  await page.evaluate(({ storageKey, preferencesKey, tasks, home }) => {
    localStorage.setItem(storageKey, JSON.stringify({ tasks, activeTaskId: null, homeDraft: '', ...home }))
    localStorage.removeItem(preferencesKey)
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'projects', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
  }, { storageKey, preferencesKey, tasks: seedTasks, home })
  await page.reload()
  await expect(projects()).toBeVisible()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
}
async function setWindow(width: number, height: number): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setMinimumSize(520, 600); win.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height })
}
async function setAppearance(appearance: 'light' | 'dark'): Promise<void> {
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).toHaveCount(0)
}

test.describe.serial('Work 项目页', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'work-projects-profile-'))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    const source = engineStorageKey({ mode: 'remote', baseUrl: origin })
    storageKey = sessionStorageKey('aether.work.state.v1', source)
    preferencesKey = sessionStorageKey('aether.work.projects.v1', source)
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin,
      remoteWorkspaceRoot: alphaPath, autoStartEngine: true, lastFolder: '', lastModelId: '', appearance: 'light', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await page.addInitScript(({ storageKey }) => {
      const events: unknown[] = []
      ;(window as typeof window & { projectInputTrace: unknown[] }).projectInputTrace = events
      for (const type of ['mousedown', 'mouseup', 'click', 'contextmenu']) document.addEventListener(type, event => {
        if (!(event instanceof MouseEvent)) return
        const target = event.target instanceof Element ? event.target.closest('[data-project-path], button, [role="menuitem"]') : null
        events.push({ type, at: performance.now(), button: event.button, x: event.clientX, y: event.clientY, trusted: event.isTrusted,
          target: target?.outerHTML.slice(0, 900), selectedTask: JSON.parse(localStorage.getItem(storageKey) ?? '{}').activeTaskId })
        if (events.length > 120) events.shift()
      }, true)
    }, { storageKey })
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1440, 1000); win.show(); win.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  })
  test.beforeEach(async () => { await setWindow(1440, 1000); await seed() })
  test.afterEach(async ({}, info) => {
    if (page && !page.isClosed()) {
      const path = info.outputPath('projects.png'); await page.screenshot({ path }); await info.attach('projects', { path, contentType: 'image/png' })
    }
    await info.attach('project-fixture-requests', { body: JSON.stringify({ errors, forbidden, opened, deletionRequests, deletedSessions }, null, 2), contentType: 'application/json' })
    if (page && !page.isClosed()) await info.attach('project-input-events', {
      body: JSON.stringify(await page.evaluate(() => (window as typeof window & { projectInputTrace?: unknown[] }).projectInputTrace ?? []), null, 2),
      contentType: 'application/json',
    })
    expect(errors).toEqual([]); expect(forbidden).toEqual([])
  })
  test.afterAll(async () => {
    try { await app?.close() } finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('work-projects-profile-')) throw new Error('Unsafe projects fixture cleanup')
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('项目独立选择、全量搜索、置顶和排序保持明确且持久', async () => {
    await expect(projects().locator('.work-projects__summary')).toHaveText(/3 个项目\s*·\s*57 项任务/)
    await expect(options()).toHaveCount(3)
    await expect(detail()).toHaveCount(1)
    await expect(detail()).toHaveAttribute('data-project-path', alphaPath)
    await expect(detail().locator('.work-project-task')).toHaveCount(40)
    await expect(option(alphaPath)).toHaveAttribute('aria-selected', 'true')
    await expect(projects().getByText('归档任务不应出现', { exact: true })).toHaveCount(0)
    await expect(independentNavigation()).toBeVisible()
    await expect(independentNavigation()).toHaveAttribute('aria-pressed', 'false')
    await expect(detail()).not.toContainText('无工作目录的独立会话')
    await option(sameNamePath).click()
    await expect(detail()).toHaveAttribute('data-project-path', sameNamePath)
    await expect(detail().locator('.work-project-task')).toHaveCount(2)
    await expect(detail()).not.toContainText('项目交付核对')
    await search().fill('特殊验收关键词')
    await expect(options()).toHaveCount(1)
    await expect(detail()).toHaveAttribute('data-project-path', alphaPath)
    await expect(detail().locator('.work-project-task')).toHaveCount(1)
    await expect(detail().locator('.work-project-task')).toHaveAttribute('data-task-id', 'work-project-alpha-51')
    await projects().locator('.work-projects__clear').click()
    await expect(search()).toHaveValue(''); await expect(search()).toBeFocused()
    await expect(options()).toHaveCount(3)
    await expect(detail()).toHaveAttribute('data-project-path', sameNamePath)
    await search().fill('客户资料与项目成果'); await expect(options()).toHaveCount(1)
    await expect(detail()).toHaveAttribute('data-project-path', sameNamePath)
    await search().fill('不存在的任务关键词'); await expect(options()).toHaveCount(0)
    await search().press('Escape'); await expect(search()).toHaveValue(''); await expect(search()).toBeFocused()
    await expect(options()).toHaveCount(3)
    await projects().getByRole('button', { name: '项目排序', exact: true }).click()
    await page.getByRole('menuitem', { name: '名称排序', exact: true }).click()
    await expect(options().last()).toHaveAttribute('data-project-path', betaPath)
    await detail().getByRole('button', { name: '置顶项目', exact: true }).click()
    await expect(detail().getByRole('button', { name: '取消置顶项目', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await projects().getByRole('button', { name: '仅看置顶', exact: true }).click()
    await expect(options()).toHaveCount(1); await expect(options()).toHaveAttribute('data-project-path', sameNamePath)
    await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}'), preferencesKey))
      .toMatchObject({ pinnedPaths: [sameNamePath], selectedPath: sameNamePath, sort: 'name' })
    await page.reload(); await expect(projects()).toBeVisible()
    await expect(detail()).toHaveAttribute('data-project-path', sameNamePath)
    await expect(detail().getByRole('button', { name: '取消置顶项目', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(projects().getByRole('button', { name: '项目排序', exact: true })).toContainText('名称排序')
    await seed(tasks.filter(item => item.archived || !item.workspacePath))
    await expect(options()).toHaveCount(0); await expect(independentDetail()).toBeVisible()
    await expect(independentNavigation()).toHaveAttribute('aria-pressed', 'true')
    await expect(independentDetail().locator('.work-project-task')).toHaveCount(1)
    await expect(taskButton('work-project-unbound')).toContainText('无工作目录的独立会话')
    await expect(search()).toBeVisible()
    await search().fill('无工作目录'); await expect(taskButton('work-project-unbound')).toBeVisible()
    await seed(tasks.filter(item => item.archived))
    await expect(options()).toHaveCount(0); await expect(detail()).toHaveCount(0)
    await expect(search()).toHaveCount(0)
    await expect(projects()).toContainText('工作目录'); await expect(projects()).not.toContainText('后续版本')
  })

  test('独立会话保留真实待处理状态，搜索和点击不混入目录项目', async ({}, info) => {
    await seed([...tasks.filter(item => item.workspacePath), ...independentTasks])
    await expect(options()).toHaveCount(3)
    await independentNavigation().click()
    await expect(independentNavigation()).toHaveAttribute('aria-pressed', 'true')
    await expect(independentNavigation()).not.toHaveAttribute('data-project-path')
    await expect(independentDetail()).toHaveAttribute('data-independent-sessions', 'true')
    await expect(independentDetail()).not.toHaveAttribute('data-project-path')
    await expect(independentDetail().getByRole('heading', { level: 2 })).toHaveText('独立会话')
    await expect(independentDetail().locator('.work-project-task')).toHaveCount(5)
    await expect(taskButton('work-independent-archived')).toHaveCount(0)
    await expect(taskButton('work-project-alpha-0')).toHaveCount(0)
    await expect(taskButton('work-independent-running').locator('.work-status')).toHaveText('进行中')
    await expect(taskButton('work-independent-permission').locator('.work-status')).toHaveText('待授权')
    await expect(taskButton('work-independent-ask').locator('.work-status')).toHaveText('等你补充')
    await expect(taskButton('work-independent-both').locator('.work-status')).toHaveText('待授权与补充')
    await expect(taskButton('work-independent-done').locator('.work-status')).toHaveText('已完成')
    const ids = await independentDetail().locator('.work-project-task').evaluateAll(rows => rows.map(row => row.getAttribute('data-task-id')))
    for (const id of ['work-independent-running', 'work-independent-permission', 'work-independent-ask', 'work-independent-both'])
      expect(ids.indexOf(id)).toBeLessThan(ids.indexOf('work-independent-done'))
    await expect(options()).toHaveCount(3)
    await page.evaluate(async () => {
      await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
      await Promise.allSettled(document.getAnimations()
        .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map(animation => animation.finished))
    })
    const listCapture = info.outputPath('independent-session-statuses.png')
    await page.screenshot({ path: listCapture })
    await info.attach('independent-session-statuses', { path: listCapture, contentType: 'image/png' })
    await option(betaPath).click(); await expect(detail()).toHaveAttribute('data-project-path', betaPath)
    await search().fill('等待工具授权')
    await expect(options()).toHaveCount(0)
    await expect(independentDetail()).toBeVisible()
    await expect(independentDetail().locator('.work-project-task')).toHaveCount(1)
    await expect(taskButton('work-independent-permission')).toBeVisible()
    await search().fill('不存在的独立会话关键词')
    await expect(projects().locator('.work-project-task')).toHaveCount(0)
    await search().press('Escape'); await independentNavigation().click()
    const beforeOpened = opened.length
    await taskButton('work-independent-done').click()
    await expect(projects()).toHaveCount(0)
    await expect.poll(async () => (await state()).activeTaskId).toBe('work-independent-done')
    await expect(page.locator('.work-conversation')).toContainText('已打开正确任务：work-independent-done')
    await expect.poll(() => opened.slice(beforeOpened)).toContain('work-independent-done')
    expect(opened.slice(beforeOpened).every(id => id === 'work-independent-done')).toBe(true)
  })

  test('独立会话菜单不会打开会话，归档与恢复只作用于当前目标', async () => {
    await seed([...tasks.filter(item => item.workspacePath), ...independentTasks])
    await independentNavigation().click()
    const target = independentTasks[0], beforeOpened = opened.length, beforeDeleted = deletedSessions.length
    const button = taskButton(target.id), more = button.locator('xpath=ancestor::li[1]')
      .getByRole('button', { name: `${target.title}的会话菜单`, exact: true })
    await button.click({ button: 'right' }); await expect(taskMenu()).toBeVisible()
    for (const name of ['重命名任务', '置顶', '颜色标记', '添加到对话', '导出任务', '归档任务', '删除任务'])
      await expect(taskAction(name)).toBeVisible()
    await page.keyboard.press('Escape'); await expect(taskMenu()).toHaveCount(0); await expect(button).toBeFocused()
    for (const key of ['Shift+F10', 'ContextMenu']) {
      await button.press(key); await expect(taskMenu()).toBeVisible()
      await page.keyboard.press('Escape'); await expect(taskMenu()).toHaveCount(0); await expect(button).toBeFocused()
    }
    await button.hover(); await more.click(); await expect(taskMenu()).toBeVisible()
    expect((await state()).activeTaskId).toBeNull(); expect(opened.slice(beforeOpened)).toEqual([])
    await taskAction('归档任务').click()
    await expect.poll(async () => (await state()).tasks.find(item => item.id === target.id)?.archived).toBe(true)
    await expect(taskButton(target.id)).toHaveCount(0)
    await expect(taskButton('work-independent-permission')).toBeVisible()
    await independentScope().click(); await page.getByRole('menuitem', { name: '已归档会话', exact: true }).click()
    await expect(independentDetail().locator('.work-project-task')).toHaveCount(2)
    await expect(taskButton(target.id)).toBeVisible(); await expect(taskButton('work-independent-archived')).toBeVisible()
    await expect(taskButton('work-project-archived')).toHaveCount(0)
    await taskButton(target.id).click({ button: 'right' }); await taskAction('恢复任务').click()
    await expect.poll(async () => (await state()).tasks.find(item => item.id === target.id)?.archived === true).toBe(false)
    await expect(taskButton(target.id)).toHaveCount(0)
    await independentScope().click(); await page.getByRole('menuitem', { name: '当前会话', exact: true }).click()
    await expect(taskButton(target.id)).toBeVisible()
    expect((await state()).tasks.find(item => item.id === 'work-independent-archived')?.archived).toBe(true)
    expect((await state()).tasks.find(item => item.id === 'work-project-archived')?.archived).toBe(true)
    expect((await state()).activeTaskId).toBeNull(); expect(opened.slice(beforeOpened)).toEqual([])
    expect(deletedSessions).toHaveLength(beforeDeleted)
  })

  test('独立会话读取和菜单写入不串到其他引擎来源的同名标识', async () => {
    const target = independentTasks[0]
    const otherSource = engineStorageKey({ mode: 'remote', baseUrl: 'http://other-projects-fixture.invalid' })
    const otherKey = sessionStorageKey('aether.work.state.v1', otherSource)
    const otherPreferences = sessionStorageKey('aether.work.projects.v1', otherSource)
    const otherState = { tasks: [{ ...target, title: '其他引擎的私有独立会话', pinned: false }], activeTaskId: null, homeDraft: '其他引擎未发送的草稿' }
    const otherSettings = { selectedPath: 'D:\\other-engine-only', pinnedPaths: ['D:\\other-engine-only'] }
    await page.evaluate(({ key, preferences, state, settings }) => {
      localStorage.setItem(key, JSON.stringify(state)); localStorage.setItem(preferences, JSON.stringify(settings))
    }, { key: otherKey, preferences: otherPreferences, state: otherState, settings: otherSettings })
    try {
      await seed([target])
      await expect(independentDetail()).toBeVisible()
      await expect(taskButton(target.id)).toContainText(target.title)
      await expect(projects()).not.toContainText('其他引擎的私有独立会话')
      await search().fill('其他引擎'); await expect(projects().locator('.work-project-task')).toHaveCount(0)
      await search().press('Escape')
      await taskButton(target.id).click({ button: 'right' }); await taskAction('置顶').click()
      await expect.poll(async () => (await state()).tasks.find(item => item.id === target.id)?.pinned).toBe(true)
      expect((await state()).tasks.find(item => item.id === target.id)?.title).toBe(target.title)
      expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), otherKey)).toEqual(otherState)
      expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), otherPreferences)).toEqual(otherSettings)
      await page.reload(); await expect(independentDetail()).toBeVisible()
      await expect(taskButton(target.id)).toContainText(target.title)
      expect((await state()).tasks.find(item => item.id === target.id)?.pinned).toBe(true)
    } finally {
      await page.evaluate(({ key, preferences }) => { localStorage.removeItem(key); localStorage.removeItem(preferences) }, { key: otherKey, preferences: otherPreferences })
    }
  })

  test('仅有独立会话时窄窗可进入和返回列表，搜索及菜单仍在可见区域', async () => {
    await setWindow(760, 900); await seed(independentTasks)
    await expect(options()).toHaveCount(0)
    await expect(search()).toBeVisible()
    await expect(independentDetail()).toBeVisible()
    await expect(independentScope()).toBeInViewport({ ratio: 1 })
    await expect(taskButton('work-independent-permission')).toBeVisible()
    await independentDetail().getByRole('button', { name: '返回项目', exact: true }).click()
    await expect(independentNavigation()).toBeVisible()
    await expect(independentNavigation()).toBeFocused()
    await expect(independentDetail()).not.toBeVisible()
    await search().fill('整理灵感记录'); await independentNavigation().click()
    await expect(independentDetail().locator('.work-project-task')).toHaveCount(1)
    await expect(taskButton('work-independent-done')).toBeVisible()
    expect(await projects().evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  })

  test('大量项目使用有界列表，键盘跨虚拟区域导航且两侧独立滚动', async ({}, info) => {
    await seed([...tasks, ...portfolioTasks])
    await expect(projects().locator('.work-projects__summary')).toHaveText(/163 个项目\s*·\s*217 项任务/)
    const mounted = await options().count()
    expect(mounted).toBeGreaterThan(1); expect(mounted).toBeLessThan(60)
    await expect(detail().locator('.work-project-task')).toHaveCount(40)
    const taskScroll = projects().locator('.work-projects__task-scroll')
    // The Work mode surface can already be "open" while its entry transition
    // is still moving. Measure fixed controls only after ancestor motion ends.
    await search().evaluate(async element => {
      const animations: Animation[] = []
      for (let node: Element | null = element; node; node = node.parentElement)
        animations.push(...node.getAnimations().filter(animation => (animation.pending || animation.playState === 'running') &&
          animation.effect?.getTiming().iterations !== Infinity))
      await Promise.allSettled(animations.map(animation => animation.finished))
    })
    const searchBefore = await search().boundingBox()
    await taskScroll.evaluate(element => { element.scrollTop = 900 })
    await expect.poll(() => taskScroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    expect(await navigation().evaluate(element => element.scrollTop)).toBe(0)
    const taskTop = await taskScroll.evaluate(element => element.scrollTop)
    await navigation().evaluate(element => { element.scrollTop = 3200 })
    await expect.poll(() => navigation().evaluate(element => element.scrollTop)).toBeGreaterThan(3000)
    expect(await taskScroll.evaluate(element => element.scrollTop)).toBe(taskTop)
    const searchAfter = await search().boundingBox()
    expect(searchBefore).not.toBeNull(); expect(searchAfter).not.toBeNull()
    expect(Math.abs(searchAfter!.y - searchBefore!.y)).toBeLessThanOrEqual(1)
    await options().first().focus(); await page.keyboard.press('End')
    const lastPath = portfolioTasks.at(-1)!.workspacePath!
    await expect(option(lastPath)).toBeFocused()
    await page.keyboard.press('Enter'); await expect(detail()).toHaveAttribute('data-project-path', lastPath)
    await page.keyboard.press('Home'); await expect(option(alphaPath)).toBeFocused()
    await page.keyboard.press('Space'); await expect(detail()).toHaveAttribute('data-project-path', alphaPath)
    await expect.poll(() => options().count()).toBeLessThan(60)
    await search().fill('规模项目任务 145')
    await expect(options()).toHaveCount(1)
    await expect(detail()).toHaveAttribute('data-project-path', portfolioTasks[145].workspacePath!)
    await search().press('Escape'); await expect(detail()).toHaveAttribute('data-project-path', alphaPath)
    const path = info.outputPath('projects-large-catalog.png')
    await page.screenshot({ path }); await info.attach('projects-large-catalog', { path, contentType: 'image/png' })
    await setWindow(760, 900)
    // A new page starts in the project navigator at narrow sizes; this is a
    // separate display state, not a loss of the persisted selected project.
    await page.reload(); await expect(navigation()).toBeVisible(); await expect(detail()).not.toBeVisible()
    await options().first().focus(); await page.keyboard.press('End')
    await expect(option(lastPath)).toBeFocused()
    const navTop = await navigation().evaluate(element => element.scrollTop)
    expect(navTop).toBeGreaterThan(0)
    await page.keyboard.press('Enter'); await expect(detail()).toBeVisible()
    await expect(navigation()).not.toBeVisible()
    await projects().getByRole('button', { name: '返回项目', exact: true }).click()
    await expect(navigation()).toBeVisible(); await expect(option(lastPath)).toBeFocused()
    expect(Math.abs(await navigation().evaluate(element => element.scrollTop) - navTop)).toBeLessThanOrEqual(1)
    await option(lastPath).click()
    await detail().getByRole('button', { name: '置顶项目', exact: true }).click()
    await projects().getByRole('button', { name: '返回项目', exact: true }).click()
    await projects().getByRole('button', { name: '仅看置顶', exact: true }).click()
    await expect(options()).toHaveCount(1)
    await option(lastPath).click()
    await detail().getByRole('button', { name: '取消置顶项目', exact: true }).click()
    await expect(projects().getByRole('button', { name: '全部项目', exact: true })).toBeFocused()
    await expect(projects().locator('.work-projects__navigation')).toBeVisible()
    await expect(detail()).toHaveCount(0)
    await projects().getByRole('button', { name: '全部项目', exact: true }).click()
    await expect(navigation()).toBeVisible()
    await expect.poll(() => options().count()).toBeGreaterThan(1)
  })

  test('任务分批加载不丢键盘焦点，整行打开正确会话', async () => {
    await expect(detail()).toHaveAttribute('data-project-path', alphaPath)
    await expect(detail().locator('.work-project-task')).toHaveCount(40)
    await expect(detail().locator('.work-project-task').first()).toHaveAttribute('data-task-id', 'work-project-alpha-0')
    await detail().locator('.work-project-detail__more').focus(); await page.keyboard.press('Enter')
    await expect(detail().locator('.work-project-task')).toHaveCount(52)
    await expect(detail().locator('[data-task-id="work-project-alpha-40"]')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(detail().locator('.work-project-detail__more')).toHaveCount(0)
    await detail().locator('[data-task-id="work-project-alpha-51"]').click()
    await expect(projects()).toHaveCount(0)
    await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').activeTaskId, storageKey)).toBe('work-project-alpha-51')
    await expect(page.locator('.work-conversation')).toContainText('已打开正确任务：work-project-alpha-51')
  })

  test('完整详情和固定工具栏在浅深主题及窄窗中可用', async ({}, info) => {
    const firstTask = detail().locator('.work-project-task').first()
    await firstTask.hover()
    const tooltip = page.getByRole('tooltip', { name: '任务详情', exact: true })
    await expect(tooltip).toBeVisible(); await expect(tooltip).toContainText(longTitle)
    await tooltip.hover(); await expect(tooltip).toBeVisible()
    await page.keyboard.press('Escape'); await expect(tooltip).toHaveCount(0)
    await firstTask.focus(); await expect(firstTask).toBeFocused()
    await expect(tooltip).toBeVisible(); await expect(tooltip).toContainText(longTitle)
    await expect.poll(() => firstTask.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid')
    await page.keyboard.press('Escape'); await expect(tooltip).toHaveCount(0)
    await firstTask.press('Control+f'); await expect(search()).toBeFocused()
    for (const appearance of ['light', 'dark'] as const) {
      await setAppearance(appearance)
      for (const width of [1440, 760]) {
        await setWindow(width, 900)
        if (await navigation().isVisible() && !await detail().isVisible()) await option(alphaPath).click()
        await expect(detail()).toBeVisible()
        const scroller = projects().locator('.work-projects__task-scroll')
        await scroller.evaluate(element => { element.scrollTop = 0 })
        await expect(firstTask).toBeVisible(); await expect(firstTask.locator('time')).toBeVisible()
        const layout = await projects().evaluate(element => {
          const root = element.getBoundingClientRect()
          const panes = Array.from(element.querySelectorAll('.work-projects__task-scroll, .work-projects__navigation-list')).filter(item => item.getClientRects().length)
          return { overflow: element.scrollWidth - element.clientWidth,
            paneOverflow: panes.map(item => item.scrollWidth - item.clientWidth),
            outside: Array.from(element.querySelectorAll('.work-project-nav-item, .work-project-task')).filter(item => {
              if (!item.getClientRects().length) return false
              const rect = item.getBoundingClientRect(); return rect.left < root.left - 1 || rect.right > root.right + 1
            }).length }
        })
        expect(layout.overflow).toBe(0); expect(layout.outside).toBe(0)
        for (const overflow of layout.paneOverflow) expect(overflow).toBe(0)
        const searchBefore = await search().boundingBox()
        const pin = detail().getByRole('button', { name: '置顶项目', exact: true })
        const pinBefore = await pin.boundingBox()
        await scroller.evaluate(element => { element.scrollTop = element.scrollHeight })
        await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
        const searchAfter = await search().boundingBox(), pinAfter = await pin.boundingBox()
        expect(searchBefore).not.toBeNull(); expect(searchAfter).not.toBeNull(); expect(pinBefore).not.toBeNull(); expect(pinAfter).not.toBeNull()
        expect(Math.abs(searchAfter!.y - searchBefore!.y)).toBeLessThanOrEqual(1)
        expect(Math.abs(pinAfter!.y - pinBefore!.y)).toBeLessThanOrEqual(1)
        await scroller.evaluate(element => { element.scrollTop = 0 })
        const path = info.outputPath(`projects-${appearance}-${width}.png`)
        await page.screenshot({ path }); await info.attach(`projects-${appearance}-${width}`, { path, contentType: 'image/png' })
      }
    }
  })

  test('项目菜单始终操作右键目标，支持键盘、显示名称及复制', async ({}, info) => {
    const alias = '围棋交付项目'
    const clipboardBefore = await app!.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(),
      image: clipboard.readImage().isEmpty() ? null : clipboard.readImage().toDataURL() }))
    try {
      await expect(detail()).toHaveAttribute('data-project-path', alphaPath)
      const remembered = await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').selectedPath ?? null, preferencesKey)
      await option(betaPath).click({ button: 'right' }); await expect(projectMenu()).toBeVisible()
      await expect(option(alphaPath)).toHaveAttribute('aria-selected', 'true')
      await expect(option(betaPath)).toHaveAttribute('aria-selected', 'false')
      await expect(detail()).toHaveAttribute('data-project-path', alphaPath)
      expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').selectedPath ?? null, preferencesKey)).toBe(remembered)
      await expect(menuAction('在文件夹中打开')).toBeDisabled()
      await expect(menuAction('在文件夹中打开')).toContainText('远端目录')
      await expect(projectMenu().getByRole('menuitem', { name: /Code/ })).toHaveCount(0)
      await expect.poll(() => projectMenu().evaluate(element => Number(getComputedStyle(element).opacity))).toBe(1)
      const menuCapture = info.outputPath('project-context-menu.png')
      await page.screenshot({ path: menuCapture }); await info.attach('project-context-menu', { path: menuCapture, contentType: 'image/png' })
      await menuAction('修改显示名称').click()
      const rename = page.getByRole('dialog', { name: '修改项目显示名称', exact: true })
      await expect(rename.getByRole('textbox', { name: '项目名称', exact: true })).toHaveValue('web-go')
      await rename.getByRole('textbox', { name: '项目名称', exact: true }).fill(alias)
      await rename.getByRole('button', { name: '保存', exact: true }).click()
      await expect(rename).toHaveCount(0)
      await expect(option(betaPath)).toContainText(alias)
      await expect(option(alphaPath)).toContainText('web-2048')
      await expect.poll(() => page.evaluate(({ key, path }) => JSON.parse(localStorage.getItem(key) ?? '{}').names?.[path],
        { key: preferencesKey, path: betaPath })).toBe(alias)
      await page.reload(); await expect(projects()).toBeVisible(); await expect(option(betaPath)).toContainText(alias)
      await search().fill(alias); await expect(options()).toHaveCount(1)
      await expect(detail()).toHaveAttribute('data-project-path', betaPath)
      await expect(detail().getByRole('heading', { level: 2 })).toHaveText(alias)
      await search().press('Escape')
      await option(betaPath).click({ button: 'right' }); await menuAction('复制项目名称').click()
      await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(alias)
      await option(betaPath).click({ button: 'right' }); await menuAction('复制项目路径').click()
      await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(betaPath)
      await option(alphaPath).focus(); await option(alphaPath).press('Shift+F10')
      await expect(projectMenu()).toBeVisible()
      await page.keyboard.press('Escape'); await expect(projectMenu()).toHaveCount(0)
      await expect(option(alphaPath)).toBeFocused()
      await option(alphaPath).press('ContextMenu'); await expect(projectMenu()).toBeVisible()
      await page.keyboard.press('Escape'); await expect(projectMenu()).toHaveCount(0)
      await option(betaPath).click({ button: 'right' }); await menuAction('查看项目').click()
      await expect(option(betaPath)).toHaveAttribute('aria-selected', 'true')
      await expect(detail()).toHaveAttribute('data-project-path', betaPath)
      await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').selectedPath, preferencesKey)).toBe(betaPath)
      await detail().getByRole('button', { name: '项目操作', exact: true }).click()
      await expect(projectMenu()).toBeVisible()
      await menuAction('恢复目录名称').click()
      await expect(option(betaPath)).toContainText('web-go'); await expect(option(betaPath)).not.toContainText(alias)
      await expect(detail().getByRole('heading', { level: 2 })).toHaveText('web-go')
      expect(await page.evaluate(({ key, path }) => JSON.parse(localStorage.getItem(key) ?? '{}').names?.[path],
        { key: preferencesKey, path: betaPath })).toBeUndefined()
    } finally {
      await app!.evaluate(({ clipboard, nativeImage }, saved) => clipboard.write({ text: saved.text, html: saved.html, rtf: saved.rtf,
        ...(saved.image ? { image: nativeImage.createFromDataURL(saved.image) } : {}) }), clipboardBefore)
    }
  })

  test('项目归档可取消、重载和恢复，原任务不被修改', async () => {
    const taskIdentity = (): Promise<unknown> => page.evaluate(key => {
      const state = JSON.parse(localStorage.getItem(key) ?? '{}')
      return state.tasks.map((task: { id: string; title: string; workspacePath: string | null; archived?: boolean }) => ({
        id: task.id, title: task.title, workspacePath: task.workspacePath, archived: task.archived === true,
      })).sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id))
    }, storageKey)
    const original = await taskIdentity()
    await option(sameNamePath).click({ button: 'right' }); await expect(projectMenu()).toBeVisible(); await menuAction('归档项目').click()
    const confirmation = page.getByRole('dialog', { name: '归档项目', exact: true })
    await expect(confirmation).toContainText('任务'); await expect(confirmation).toContainText('文件')
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    await expect(confirmation).toHaveCount(0); await expect(option(sameNamePath)).toBeVisible()
    await option(sameNamePath).click({ button: 'right' }); await menuAction('归档项目').click()
    await confirmation.getByRole('button', { name: '归档', exact: true }).click()
    await expect(confirmation).toHaveCount(0); await expect(option(sameNamePath)).toHaveCount(0)
    await expect(option(alphaPath)).toBeFocused()
    await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').archivedPaths, preferencesKey)).toContain(sameNamePath)
    expect(await taskIdentity()).toEqual(original)
    await page.reload(); await expect(projects()).toBeVisible(); await expect(option(sameNamePath)).toHaveCount(0)
    await projects().getByRole('button', { name: '已归档', exact: true }).click()
    await expect(options()).toHaveCount(1); await expect(option(sameNamePath)).toBeVisible()
    await option(sameNamePath).click({ button: 'right' }); await menuAction('恢复项目').click()
    await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').archivedPaths, preferencesKey)).not.toContain(sameNamePath)
    await expect(projects().getByRole('button', { name: '全部项目', exact: true })).toBeFocused()
    await projects().getByRole('button', { name: '全部项目', exact: true }).click()
    await expect(options()).toHaveCount(3); await expect(option(sameNamePath)).toBeVisible()
    expect(await taskIdentity()).toEqual(original)
  })

  test('项目任务与侧栏共享会话菜单，更多入口、右键和键盘均不打开会话', async () => {
    const target = alphaTasks[1], beforeOpened = opened.length, beforeDeleted = deletedSessions.length
    const button = taskButton(target.id), more = button.locator('xpath=ancestor::li[1]')
      .getByRole('button', { name: `${target.title}的会话菜单`, exact: true })
    await button.click({ button: 'right' }); await expect(taskMenu()).toBeVisible()
    for (const name of ['重命名任务', '置顶', '颜色标记', '添加到对话', '导出任务', '归档任务', '删除任务'])
      await expect(taskAction(name)).toBeVisible()
    const projectActions = (await taskMenu().getByRole('menuitem').allTextContents()).map(text => text.trim())
    await expect(projects()).toBeVisible(); await expect(detail()).toHaveAttribute('data-project-path', alphaPath)
    expect((await state()).activeTaskId).toBeNull()
    await page.keyboard.press('Escape'); await expect(taskMenu()).toHaveCount(0); await expect(button).toBeFocused()
    for (const shortcut of ['Shift+F10', 'ContextMenu']) {
      await button.press(shortcut); await expect(taskMenu()).toBeVisible(); await expect(taskAction('删除任务')).toBeEnabled()
      await page.keyboard.press('Escape'); await expect(taskMenu()).toHaveCount(0); await expect(button).toBeFocused()
    }
    await button.hover(); await expect(more).toBeVisible(); await more.click(); await expect(taskMenu()).toBeVisible()
    expect((await taskMenu().getByRole('menuitem').allTextContents()).map(text => text.trim())).toEqual(projectActions)
    await page.keyboard.press('Escape'); await expect(taskMenu()).toHaveCount(0)
    const sideButton = sidebarTask(target.id).locator('.work-sidebar__task')
    await sideButton.click({ button: 'right' }); await expect(taskMenu()).toBeVisible()
    expect((await taskMenu().getByRole('menuitem').allTextContents()).map(text => text.trim())).toEqual(projectActions)
    await page.keyboard.press('Escape'); await expect(taskMenu()).toHaveCount(0)
    await sideButton.focus(); await sideButton.press('Shift+F10'); await expect(taskMenu()).toBeVisible()
    await page.keyboard.press('Escape'); await expect(taskMenu()).toHaveCount(0)
    await more.click(); await expect(taskMenu()).toBeVisible(); await taskAction('置顶').click()
    await expect.poll(async () => (await state()).tasks.find(task => task.id === target.id)?.pinned).toBe(true)
    await expect(sidebarTask(target.id).locator('.work-sidebar__pin')).toBeVisible()
    await expect(projects()).toBeVisible(); await expect(option(alphaPath)).toHaveAttribute('aria-selected', 'true')
    expect((await state()).activeTaskId).toBeNull(); expect(opened.slice(beforeOpened)).toEqual([])
    expect(deletedSessions).toHaveLength(beforeDeleted)
  })

  test('项目任务删除可取消，确认仅删除菜单目标且刷新不恢复', async () => {
    const target = alphaTasks[1], retained = alphaTasks[0], beforeRequests = deletionRequests.length, beforeDeleted = deletedSessions.length
    const originalIds = (await state()).tasks.map(task => task.id).sort()
    const more = taskButton(target.id).locator('xpath=ancestor::li[1]')
      .getByRole('button', { name: `${target.title}的会话菜单`, exact: true })
    await more.click(); await expect(taskMenu()).toBeVisible(); await taskAction('删除任务').click()
    await expect(deleteConfirmation()).toBeVisible(); await expect(deleteConfirmation()).toContainText(target.title)
    await expect(deleteConfirmation()).not.toContainText(retained.title)
    await deleteConfirmation().getByRole('button', { name: '取消', exact: true }).click()
    await expect(deleteConfirmation()).toHaveCount(0); await expect(taskButton(target.id)).toBeVisible()
    expect(deletionRequests).toHaveLength(beforeRequests); expect(deletedSessions).toHaveLength(beforeDeleted)
    expect((await state()).tasks.map(task => task.id).sort()).toEqual(originalIds)
    await taskButton(target.id).focus(); await taskButton(target.id).press('ContextMenu')
    await expect(taskMenu()).toBeVisible(); await taskAction('删除任务').click()
    await expect(deleteConfirmation()).toContainText(target.title)
    await deleteConfirmation().getByRole('button', { name: '删除', exact: true }).click()
    await expect.poll(() => deletedSessions.slice(beforeDeleted)).toEqual([target.id])
    expect(deletionRequests.slice(beforeRequests)).toEqual([{ sessionId: target.id, keepWorkspace: 'true' }])
    expect(findTask(target.id)).toBeUndefined(); expect(findTask(retained.id)?.title).toBe(retained.title)
    await expect(deleteConfirmation()).toHaveCount(0); await expect(taskButton(target.id)).toHaveCount(0)
    await expect(taskButton(retained.id)).toBeVisible()
    await expect.poll(async () => (await state()).tasks.map(task => task.id).sort()).toEqual(originalIds.filter(id => id !== target.id))
    expect((await state()).activeTaskId).toBeNull()
    await expect(detail()).toHaveAttribute('data-project-path', alphaPath)
    await page.reload(); await expect(projects()).toBeVisible(); await expect(taskButton(target.id)).toHaveCount(0)
    await expect(taskButton(retained.id)).toBeVisible()
    expect((await state()).tasks.map(task => task.id).sort()).toEqual(originalIds.filter(id => id !== target.id))
    expect(deletionRequests).toHaveLength(beforeRequests + 1)
  })

  test('删除服务失败保留任务及未发送草稿，提示后可重试成功', async () => {
    const target: WorkTask = { ...alphaTasks[1], draft: '删除失败后仍需保留的未发送内容\n下一轮继续处理',
      attachments: [{ path: '/remote/retained-task.txt', name: '任务参考.txt', type: 'text/plain', size: 24 }],
      sources: [{ path: '/remote/retained-source.txt', name: '原始资料.txt', type: 'text/plain', size: 36 }] }
    const homeDraft = '首页另有未发送内容，删除其他任务不能影响它'
    await seed(tasks.map(task => task.id === target.id ? target : task), { homeDraft })
    const beforeRequests = deletionRequests.length, beforeDeleted = deletedSessions.length
    const originalIds = (await state()).tasks.map(task => task.id).sort()
    failNextDeletion.add(target.id)
    await taskButton(target.id).click({ button: 'right' }); await taskAction('删除任务').click()
    await expect(deleteConfirmation()).toContainText(target.title)
    await deleteConfirmation().getByRole('button', { name: '删除', exact: true }).click()
    await expect(page.locator('.toast-host__item--error')).toContainText(deletionFailureMessage)
    await expect.poll(() => deletionRequests.length).toBe(beforeRequests + 1)
    expect(deletedSessions).toHaveLength(beforeDeleted)
    expect(findTask(target.id)).toEqual(target)
    await expect(taskButton(target.id)).toBeVisible()
    const retained = await state()
    expect(retained.tasks.map(task => task.id).sort()).toEqual(originalIds)
    expect(retained.tasks.find(task => task.id === target.id)).toMatchObject({
      title: target.title, draft: target.draft, attachments: target.attachments, sources: target.sources,
      workspacePath: target.workspacePath,
    })
    expect(retained.homeDraft).toBe(homeDraft); expect(retained.activeTaskId).toBeNull()
    await page.reload(); await expect(projects()).toBeVisible(); await expect(taskButton(target.id)).toBeVisible()
    expect((await state()).tasks.find(task => task.id === target.id)?.draft).toBe(target.draft)
    await taskButton(target.id).click({ button: 'right' }); await expect(taskAction('删除任务')).toBeEnabled()
    await taskAction('删除任务').click(); await deleteConfirmation().getByRole('button', { name: '删除', exact: true }).click()
    await expect.poll(() => deletedSessions.slice(beforeDeleted)).toEqual([target.id])
    expect(deletionRequests.slice(beforeRequests)).toEqual([
      { sessionId: target.id, keepWorkspace: 'true' }, { sessionId: target.id, keepWorkspace: 'true' },
    ])
    await expect(taskButton(target.id)).toHaveCount(0)
    await expect.poll(async () => (await state()).tasks.map(task => task.id).sort()).toEqual(originalIds.filter(id => id !== target.id))
    expect((await state()).homeDraft).toBe(homeDraft); expect(findTask(target.id)).toBeUndefined()
  })

  test('侧栏删除未选中会话保留当前会话，删除当前会话后清理选择', async () => {
    const current = alphaTasks[0], target = alphaTasks[1], beforeRequests = deletionRequests.length, beforeDeleted = deletedSessions.length
    await taskButton(current.id).click(); await expect(projects()).toHaveCount(0)
    await expect.poll(async () => (await state()).activeTaskId).toBe(current.id)
    await expect(page.locator('.work-conversation')).toContainText(`已打开正确任务：${current.id}`)
    const headerMenu = page.getByRole('button', { name: '任务更多操作', exact: true })
    await headerMenu.click(); await expect(taskAction('删除任务')).toBeEnabled()
    await page.keyboard.press('Escape'); await expect(taskMenu()).toHaveCount(0); await expect(headerMenu).toBeFocused()
    expect(deletionRequests).toHaveLength(beforeRequests); expect(deletedSessions).toHaveLength(beforeDeleted)
    const beforeOpened = opened.length
    await sidebarTask(target.id).locator('.work-sidebar__task').click({ button: 'right' })
    await expect(taskMenu()).toBeVisible(); await taskAction('删除任务').click()
    await expect(deleteConfirmation()).toContainText(target.title)
    expect((await state()).activeTaskId).toBe(current.id)
    await deleteConfirmation().getByRole('button', { name: '取消', exact: true }).click()
    await expect(deleteConfirmation()).toHaveCount(0)
    expect(deletionRequests).toHaveLength(beforeRequests)
    const targetButton = sidebarTask(target.id).locator('.work-sidebar__task')
    await targetButton.focus(); await targetButton.press('Shift+F10'); await expect(taskMenu()).toBeVisible()
    await taskAction('删除任务').click(); await deleteConfirmation().getByRole('button', { name: '删除', exact: true }).click()
    await expect.poll(() => deletedSessions.slice(beforeDeleted)).toEqual([target.id])
    await expect(sidebarTask(target.id)).toHaveCount(0)
    await expect.poll(async () => (await state()).activeTaskId).toBe(current.id)
    await expect(page.locator('.work-conversation')).toContainText(`已打开正确任务：${current.id}`)
    expect(opened.slice(beforeOpened)).not.toContain(target.id)
    await sidebarTask(current.id).locator('.work-sidebar__task').click({ button: 'right' })
    await expect(taskMenu()).toBeVisible(); await taskAction('删除任务').click()
    await expect(deleteConfirmation()).toContainText(current.title)
    await deleteConfirmation().getByRole('button', { name: '删除', exact: true }).click()
    await expect.poll(() => deletedSessions.slice(beforeDeleted)).toEqual([target.id, current.id])
    expect(deletionRequests.slice(beforeRequests)).toEqual([
      { sessionId: target.id, keepWorkspace: 'true' }, { sessionId: current.id, keepWorkspace: 'true' }
    ])
    await expect.poll(async () => (await state()).activeTaskId).toBeNull()
    await expect(sidebarTask(current.id)).toHaveCount(0); await expect(page.locator('.work-conversation')).toHaveCount(0)
    await expect.poll(async () => (await state()).tasks.some(task => task.id === current.id || task.id === target.id)).toBe(false)
    await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
    expect((await state()).activeTaskId).toBeNull()
    expect((await state()).tasks.some(task => task.id === current.id || task.id === target.id)).toBe(false)
    expect(findTask(alphaTasks[2].id)?.id).toBe(alphaTasks[2].id)
  })

  test('项目中新建任务只建立指定目录的空草稿，保留首页未发送资料', async () => {
    const attachment = { path: '/remote/retained-home.txt', name: '未发送资料.txt', type: 'text/plain', size: 18 }
    const home = { homeDraft: '首页尚未发送的任务内容', homeWorkspacePath: alphaPath,
      homeAttachments: [attachment], homeSources: [attachment], homeSessionId: 'work-preserved-home-session' }
    await seed(tasks, home)
    await option(betaPath).click({ button: 'right' }); await menuAction('在此项目中新建任务').click()
    await expect(projects()).toHaveCount(0)
    await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').tasks.length, storageKey)).toBe(tasks.length + 1)
    const state = await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}'), storageKey) as WorkState
    const created = state.tasks.find(task => task.id === state.activeTaskId)
    expect(created?.id).not.toBe(home.homeSessionId)
    expect(created).toMatchObject({ status: 'draft', workspacePath: betaPath, draft: '', attachments: [], sources: [] })
    expect(tasks.some(task => task.id === created?.id)).toBe(false)
    expect({ homeDraft: state.homeDraft, homeWorkspacePath: state.homeWorkspacePath, homeAttachments: state.homeAttachments,
      homeSources: state.homeSources, homeSessionId: state.homeSessionId }).toEqual(home)
    await expect(page.locator('.work-conversation')).toBeVisible()
    await expect(page.locator('.work-conversation')).not.toContainText(home.homeDraft)
    expect(forbidden).toEqual([])
  })
})
