/** Real Electron + owned engine: sidebar recent/archive peer tabs, incremental
 * scrolling, independent list positions, archive/restore persistence with
 * read-only archived history and retained drafts across reloads, and
 * navigation availability in expanded, collapsed and narrow layouts, plus
 * trailing status/pin replacement, project activity summaries and preserving
 * manual collapse during background updates. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { SessionState, SessionTask } from '../src/renderer/src/features/sessions/state'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp/sidebar-history')
const token = 'sidebar-history-token', modelId = 'sidebar-history-model', workspace = '/remote/sidebar-history'
const now = Date.now() - 60_000
const tasks: SessionTask[] = [false, true].flatMap(archived => Array.from({ length: archived ? 45 : 55 }, (_, index) => ({
  id: `work-sidebar-${archived ? 'archive' : 'recent'}-${index}`,
  title: `${archived ? '归档' : '最近'}资料 ${String(index + 1).padStart(2, '0')}`,
  status: 'done' as const, createdAt: now - index * 60_000 - 5_000, updatedAt: now - index * 60_000,
  archived, pinned: !archived && index === 54, draft: '', modelId, workspacePath: workspace, attachments: [], sources: []
})))
const errors: string[] = [], fixtureErrors: string[] = []
const liveStreams = new Set<ServerResponse>()
let fixtureTasks = tasks
let app: ElectronApplication | undefined, page: Page, profile = '', storageKey = '', preferencesKey = ''
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  let raw = ''; for await (const chunk of request) raw += chunk.toString()
  if (path === '/api/v1/workspace/bind' && request.method === 'POST') {
    response.end(envelope({ workspaceRoot: workspace, bindingEpoch: 'sidebar-history', contractVersion: 2 })); return
  }
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET') throw new Error(`Unexpected mutation ${request.method} ${path}: ${raw}`)
  const task = fixtureTasks.find(item => item.id === id)
  const active = task?.status === 'running' || task?.status === 'waiting'
  const pending: RootRun['pending'] = task?.status === 'waiting' ? [
    ...(task.activity?.pendingPermission ? [{ requestId: `permission-${id}`, kind: 'permission' as const, toolCallId: `tool-permission-${id}`,
      toolName: 'run_command', args: { command: 'git status' }, description: '等待确认命令', status: 'pending' as const }] : []),
    ...(task.activity?.pendingAsk ? [{ requestId: `ask-${id}`, kind: 'ask' as const, toolCallId: `tool-ask-${id}`,
      toolName: 'ask_user', args: {}, question: '请补充交付要求', status: 'pending' as const }] : [])
  ] : []
  const run: RootRun | undefined = task ? { schemaVersion: 1, runId: `root-${id}`, sessionId: id, turnId: `turn-${id}`,
    userMessageId: `user-${id}`, assistantMessageId: `assistant-${id}`, seq: 1, version: task.activity?.version ?? 2,
    status: task.status === 'running' ? 'running' : task.status === 'waiting' ? 'waiting' : task.status === 'error' ? 'failed' : task.status === 'interrupted' ? 'interrupted' : task.status === 'stopped' ? 'cancelled' : 'succeeded', modelId,
    pending, workspacePaths: [workspace], createdAt: task.createdAt, updatedAt: task.updatedAt,
    ...(active ? {} : { finishedAt: task.updatedAt }) } : undefined
  const cursor = run?.status === 'running' ? `${run.runId}:${run.version}` : null
  if (path === '/api/v1/chat/stream') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    if (run?.status !== 'running') { response.end('data: [DONE]\n\n'); return }
    liveStreams.add(response); response.on('close', () => liveStreams.delete(response))
    response.write(': connected\n\n'); return
  }
  const rows = run ? [
    { id: run.userMessageId, role: 'user', content: task!.title, createdAt: run.createdAt, conversationId: run.turnId, metadata: { rootRunId: run.runId } },
    { id: run.assistantMessageId, role: 'assistant', content: `SIDEBAR_OPENED:${id}`, createdAt: run.updatedAt, conversationId: run.turnId, metadata: { rootRunId: run.runId } }
  ] : []
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'f'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general'], subagentSchemaVersion: 1, instanceId: 'sidebar-history-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '侧栏分页测试模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: cursor ? 'live' : 'persisted', eventId: cursor, finished: !active, history: rows, projection: [], run, runs: run ? [run] : [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: active, finished: !active, run, lastEventId: cursor }
    : path === '/api/v1/chat/runs' ? { runs: run ? [run] : [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? []
    : path === '/api/v1/conversation/display' ? { schemaVersion: 1, grouping: 'root', turns: rows.filter(row => row.role === 'user').map(row => ({ userMessageId: row.id, conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows, loadedTurnIds: rows.filter(row => row.role === 'user').map(row => row.id), revision: id, mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' }
    : path === '/api/v1/workspace/directory' ? { root: workspace, entries: [], bindingEpoch: 'sidebar-history' }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: Boolean(task), agentId: null, metadata: null, agent: null }
    : /\/sessions\/[^/]+\/toolkits$/.test(path) ? { toolkits: [] }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/memory/preferences' ? { enabled: false, globalEnabled: false, sessionDefaultEnabled: false }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] }
    : path === '/api/v1/toolkits' ? { toolkits: [] }
    : path === '/api/v1/settings' ? {} : []
  response.end(envelope(data))
})().catch(error => { fixtureErrors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end('Sidebar history fixture failed') }) })

const sidebar = (): Locator => page.locator('.work-sidebar')
const tab = (name: '最近' | '项目' | '归档'): Locator => sidebar().getByRole('tab', { name, exact: true })
const panel = (): Locator => sidebar().locator('.work-sidebar__recent')
const rows = (): Locator => panel().locator('.work-sidebar__task-row')
const row = (id: string): Locator => panel().locator(`.work-sidebar__task-row[data-task-id="${id}"]`)
async function windowSize(width: number, height = 900): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, size) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(520, 600); win.setContentSize(size.width, size.height) }, { width, height })
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height })
}
async function seed(activeTaskId: string | null = null, seededTasks = tasks): Promise<void> {
  for (const response of liveStreams) response.end('data: [DONE]\n\n')
  liveStreams.clear()
  fixtureTasks = seededTasks
  await page.evaluate(({ key, preferencesKey, tasks, modelId, workspace, activeTaskId }) => {
    window.dispatchEvent(new Event('blur'))
    localStorage.setItem(key, JSON.stringify({ tasks: [...tasks].reverse(), activeTaskId, homeDraft: '', homeModelId: modelId,
      homeWorkspacePath: workspace, homeSessionId: null, homeAttachments: [], homeSources: [] }))
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
    localStorage.removeItem(preferencesKey)
  }, { key: storageKey, preferencesKey, tasks: seededTasks, modelId, workspace, activeTaskId })
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await expect(tab('最近')).toHaveAttribute('aria-selected', 'true')
}
async function loadNext(expected: number): Promise<void> {
  await panel().getByRole('button', { name: '展开显示', exact: true }).click()
  await expect(rows()).toHaveCount(expected)
}
async function savedTask(id: string): Promise<SessionTask | undefined> {
  return page.evaluate(({ key, id }) => {
    window.dispatchEvent(new Event('blur'))
    return (JSON.parse(localStorage.getItem(key) ?? '{}') as SessionState).tasks?.find(task => task.id === id)
  }, { key: storageKey, id })
}

test.beforeAll(async () => {
  mkdirSync(fixtureRoot, { recursive: true }); profile = mkdtempSync(join(fixtureRoot, 'profile-'))
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  const origin = `http://127.0.0.1:${address.port}`
  storageKey = sessionStorageKey('aether.work.state.v1', engineStorageKey({ mode: 'remote', baseUrl: origin }))
  preferencesKey = sessionStorageKey('aether.work.projects.v1', engineStorageKey({ mode: 'remote', baseUrl: origin }))
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, remoteWorkspaceRoot: workspace,
    autoStartEngine: true, lastFolder: '', lastSessionId: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
  const env = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY',
    'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_REMOTE_INSTANCE_TOKEN'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(profile, 'global')
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${profile}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.show(); win.focus() })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
})
test.beforeEach(async () => { await windowSize(1440); await seed() })
test.afterEach(async ({}, info) => {
  await info.attach('app-errors', { body: JSON.stringify({ errors, fixtureErrors }, null, 2), contentType: 'application/json' })
  if (info.status !== info.expectedStatus && page && !page.isClosed()) await page.screenshot({ path: info.outputPath('failure.png') })
  expect(errors).toEqual([]); expect(fixtureErrors).toEqual([])
})
test.afterAll(async () => {
  try { await app?.close() } finally {
    for (const response of liveStreams) response.end('data: [DONE]\n\n')
    liveStreams.clear()
    server.closeAllConnections(); if (server.listening) await new Promise<void>(done => server.close(() => done()))
    if (profile) { const target = resolve(profile); if (dirname(target) !== fixtureRoot || !basename(target).startsWith('profile-')) throw new Error('Unsafe sidebar fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  }
})

test('最近默认十二条，展开每次增加六条，置顶顺序和最后一批不丢失', async () => {
  await expect(rows()).toHaveCount(12)
  await expect(rows().first()).toHaveAttribute('data-task-id', 'work-sidebar-recent-54')
  await expect(rows().nth(1)).toHaveAttribute('data-task-id', 'work-sidebar-recent-0')
  await expect(panel().getByText('最近资料 41', { exact: true })).toHaveCount(0)
  for (const expected of [18, 24, 30, 36, 42, 48, 54, 55]) await loadNext(expected)
  const ids = await rows().evaluateAll(elements => elements.map(element => element.getAttribute('data-task-id')))
  expect(ids).toHaveLength(55); expect(new Set(ids).size).toBe(55)
  expect(ids.at(-1)).toBe('work-sidebar-recent-53')
  await panel().evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect(rows()).toHaveCount(55)
})

test('归档与最近同级，分别加载并保留各自浏览位置', async () => {
  await expect(tab('归档')).toBeVisible()
  await expect(sidebar().getByRole('tablist', { name: '任务列表', exact: true }).getByRole('tab')).toHaveCount(3)
  await expect(sidebar().locator('.work-sidebar__archived, details')).toHaveCount(0)
  await loadNext(18)
  await panel().evaluate(element => { element.scrollTop = element.scrollHeight })
  const recentPosition = await panel().evaluate(element => element.scrollTop)
  expect(recentPosition).toBeGreaterThan(0)
  await tab('归档').click()
  await expect(tab('归档')).toHaveAttribute('aria-selected', 'true')
  await expect(panel()).toHaveAccessibleName('归档任务')
  await expect(rows()).toHaveCount(6)
  await expect(rows().first()).toHaveAttribute('data-task-id', 'work-sidebar-archive-0')
  await expect(panel().locator('[data-task-id^="work-sidebar-recent-"]')).toHaveCount(0)
  for (const expected of [12, 18, 24, 30, 36, 42, 45]) await loadNext(expected)
  await panel().evaluate(element => { element.scrollTop = 120 })
  await tab('最近').click()
  await expect(rows()).toHaveCount(18)
  await expect.poll(() => panel().evaluate(element => element.scrollTop)).toBeCloseTo(recentPosition, 0)
  await tab('归档').click()
  await expect(rows()).toHaveCount(45)
  await expect.poll(() => panel().evaluate(element => element.scrollTop)).toBeCloseTo(120, 0)
})

test('归档历史在打开与重载后不显示输入，恢复及再次归档当前会话均保留草稿', async () => {
  const id = 'work-sidebar-recent-0'
  const draft = '归档前尚未发送的草稿', revisedDraft = '恢复后修改，重新归档也要保留的草稿'
  const heading = page.locator('.work-task-heading').getByRole('heading', { name: '最近资料 01', exact: true })
  const conversation = page.locator('.work-conversation')
  const composer = page.locator('.work-view .work-composer')
  const input = conversation.getByRole('textbox', { name: '继续对话', exact: true })
  const activeTask = (): Promise<string | null> => page.evaluate(key =>
    (JSON.parse(localStorage.getItem(key) ?? '{}') as SessionState).activeTaskId, storageKey)
  const storedTask = (): Promise<SessionTask | undefined> => page.evaluate(({ key, id }) =>
    (JSON.parse(localStorage.getItem(key) ?? '{}') as SessionState).tasks?.find(task => task.id === id), { key: storageKey, id })
  const expectArchivedHistory = async (): Promise<void> => {
    await expect(heading).toBeVisible()
    await expect(conversation).toContainText(`SIDEBAR_OPENED:${id}`)
    await expect(composer).toHaveCount(0)
    await expect(input).toHaveCount(0)
    await expect(conversation.locator('[contenteditable="true"]')).toHaveCount(0)
    await expect(conversation.getByRole('button', { name: '恢复会话', exact: true })).toBeVisible()
    await expect(conversation.getByRole('button', { name: '复制回复', exact: true })).toBeEnabled()
    await expect(conversation.getByRole('button', { name: '复制', exact: true })).toBeEnabled()
    await expect(conversation.getByRole('button', { name: /^(添加到对话|重新发起|从此处重新编辑|重新生成|编辑后继续|编辑后重试)$/ })).toHaveCount(0)
    await expect.poll(activeTask).toBe(id)
  }
  await seed(null, tasks.map(task => task.id === id ? { ...task, draft } : task))
  await row(id).getByRole('button', { name: '最近资料 01', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '归档任务', exact: true }).click()
  await expect.poll(async () => (await storedTask())?.archived).toBe(true)
  await expect(row(id)).toHaveCount(0)
  await tab('归档').click()
  await expect(row(id)).toBeVisible()
  await row(id).locator('.work-sidebar__task').click()
  await expectArchivedHistory()
  await expect.poll(async () => (await storedTask())?.draft).toBe(draft)

  await page.reload()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await expect(tab('归档')).toHaveAttribute('aria-selected', 'true')
  await expectArchivedHistory()
  await expect(row(id)).toHaveAttribute('data-selected', 'true')
  await row(id).getByRole('button', { name: '最近资料 01', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '恢复任务', exact: true }).click()
  await expect.poll(async () => (await storedTask())?.archived).toBe(false)
  await expect(heading).toBeVisible()
  await expect(conversation).toContainText(`SIDEBAR_OPENED:${id}`)
  await expect(composer).toBeVisible()
  await expect(input).toBeEditable()
  await expect(input).toHaveText(draft)
  await expect(conversation.getByRole('button', { name: '添加到对话', exact: true })).toBeEnabled()
  await tab('最近').click()
  await expect(row(id)).toHaveAttribute('data-selected', 'true')

  // Archive directly after editing: the interaction itself must preserve the
  // live draft, without a test-triggered autosave or navigation to Home.
  await input.fill(revisedDraft)
  await row(id).locator('.work-sidebar__task').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '归档任务', exact: true }).click()
  await expectArchivedHistory()
  await expect.poll(async () => {
    const task = await storedTask()
    return { archived: task?.archived, draft: task?.draft }
  }).toEqual({ archived: true, draft: revisedDraft })
  await tab('归档').click()
  await expect(row(id)).toHaveAttribute('data-selected', 'true')
  await conversation.getByRole('button', { name: '恢复会话', exact: true }).click()
  await expect(heading).toBeVisible()
  await expect(conversation).toContainText(`SIDEBAR_OPENED:${id}`)
  await expect(composer).toBeVisible()
  await expect(input).toBeEditable()
  await expect(input).toHaveText(revisedDraft)
  await expect.poll(async () => {
    const task = await storedTask()
    return { archived: task?.archived, draft: task?.draft }
  }).toEqual({ archived: false, draft: revisedDraft })
  await tab('最近').click()
  await expect(row(id)).toHaveAttribute('data-selected', 'true')
})

test('取消置顶后选中任务跨出首批仍保留行与原会话', async () => {
  const id = 'work-sidebar-recent-54'
  await expect(rows()).toHaveCount(12)
  await row(id).locator('.work-sidebar__task').click()
  await expect(page.locator('.work-task-heading').getByRole('heading', { name: '最近资料 55', exact: true })).toBeVisible()
  await expect(page.locator('.work-conversation')).toContainText(`SIDEBAR_OPENED:${id}`)
  await row(id).hover()
  await row(id).getByRole('button', { name: '取消置顶', exact: true }).click()
  await expect.poll(async () => {
    const task = await savedTask(id)
    return [task?.id, task?.pinned]
  }).toEqual([id, undefined])
  await expect(row(id)).toHaveCount(1)
  await expect(row(id)).toHaveAttribute('data-selected', 'true')
  await expect(page.locator('.work-task-heading').getByRole('heading', { name: '最近资料 55', exact: true })).toBeVisible()
  await expect(page.locator('.work-conversation')).toContainText(`SIDEBAR_OPENED:${id}`)
})

test('侧栏状态默认靠右，悬停与键盘焦点原位切换置顶且标题不跳动', async ({}, info) => {
  const activeId = 'work-sidebar-recent-2'
  const statusTasks = [
    { id: 'work-sidebar-recent-0', title: '等待授权的超长项目资料整理与发布前命令检查会话，状态与置顶共用行尾位置', label: '待授权', kind: 'permission', status: 'waiting' as const, permission: 1, ask: 0, pinned: false },
    { id: 'work-sidebar-recent-1', title: '等待补充的超长需求澄清与交付说明会话，需要继续填写项目目标和验收标准', label: '等你补充', kind: 'question', status: 'waiting' as const, permission: 0, ask: 1, pinned: false },
    { id: 'work-sidebar-recent-3', title: '正在运行的超长资料分析与交付文件生成会话，置顶后默认继续显示运行状态', label: '运行中', kind: 'running', status: 'running' as const, permission: 0, ask: 0, pinned: true },
    { id: 'work-sidebar-recent-4', title: '已经完成但尚未查看的超长项目资料会话，未读圆点与置顶共用右侧位置', label: '已完成，未查看', kind: 'unread', status: 'done' as const, permission: 0, ask: 0, pinned: true }
  ]
  await seed(activeId, tasks.map(task => {
    const state = statusTasks.find(item => item.id === task.id)
    return state ? { ...task, title: state.title, status: state.status, pinned: state.pinned, completionUnread: state.kind === 'unread',
      activity: { runId: `root-${task.id}`, seq: 1, version: 2, status: state.status === 'done' ? 'succeeded' : state.status,
        updatedAt: task.updatedAt, pendingAsk: state.ask, pendingPermission: state.permission } } : task
  }))
  const heading = page.locator('.work-task-heading').getByRole('heading', { name: '最近资料 03', exact: true })
  await expect(heading).toBeVisible()
  const activeTask = () => page.evaluate(key => (JSON.parse(localStorage.getItem(key) ?? '{}') as SessionState).activeTaskId, storageKey)
  const titleWidth = (id: string): Promise<number> => row(id).locator('.work-sidebar__task-title').evaluate(element => element.getBoundingClientRect().width)
  const verifyRest = async (state: typeof statusTasks[number], pinned: boolean): Promise<number> => {
    const target = row(state.id), status = target.getByRole('img', { name: state.label, exact: true })
    const actions = target.locator('.work-sidebar__task-actions'), pin = actions.getByRole('button')
    await page.mouse.move(4, 4)
    await expect(status).toBeVisible(); await expect(status).toHaveCSS('opacity', '1')
    await expect(actions).toHaveCSS('opacity', '0'); await expect(actions).toHaveCSS('pointer-events', 'none')
    await expect(pin).toHaveAccessibleName(pinned ? '取消置顶' : '置顶'); await expect(pin).toHaveAttribute('aria-pressed', String(pinned))
    await expect(target.locator('.work-sidebar__task')).toHaveAccessibleName(new RegExp(state.label))
    if (state.kind === 'running') await expect(status.locator('.ui-spinner')).toHaveCount(1)
    else if (state.kind === 'unread') await expect(status.locator('.work-sidebar__completion-dot')).toHaveCount(1)
    else await expect(status).toHaveText(state.label)
    const geometry = await target.evaluate(element => {
      const bounds = element.getBoundingClientRect(), status = element.querySelector('.work-sidebar__task-status')!.getBoundingClientRect()
      const pin = element.querySelector('.work-sidebar__task-actions button')!.getBoundingClientRect()
      const title = element.querySelector('.work-sidebar__task-title')!.getBoundingClientRect()
      return { rightGap: bounds.right - status.right, pinRightGap: bounds.right - pin.right,
        sameRightEdge: Math.abs(status.right - pin.right), sameCenterY: Math.abs(status.top + status.height / 2 - pin.top - pin.height / 2),
        titleGap: status.left - title.right, titleWidth: title.width }
    })
    expect(geometry.rightGap).toBeGreaterThanOrEqual(0); expect(geometry.rightGap).toBeLessThanOrEqual(12)
    expect(geometry.pinRightGap).toBeGreaterThanOrEqual(0); expect(geometry.pinRightGap).toBeLessThanOrEqual(12)
    expect(geometry.sameRightEdge).toBeLessThanOrEqual(1); expect(geometry.sameCenterY).toBeLessThanOrEqual(1)
    expect(geometry.titleGap).toBeGreaterThanOrEqual(0); expect(geometry.titleWidth).toBeGreaterThan(0)
    return geometry.titleWidth
  }
  const verifyPin = async (state: typeof statusTasks[number], width: number): Promise<void> => {
    const target = row(state.id), actions = target.locator('.work-sidebar__task-actions')
    await expect(target.getByRole('img', { name: state.label, exact: true })).toHaveCSS('opacity', '0')
    await expect(actions).toHaveCSS('opacity', '1'); await expect(actions).toHaveCSS('pointer-events', 'auto')
    expect(Math.abs(await titleWidth(state.id) - width)).toBeLessThanOrEqual(1)
    expect(await actions.getByRole('button').evaluate(element => {
      const bounds = element.getBoundingClientRect(), hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      return hit === element || Boolean(hit && element.contains(hit))
    })).toBe(true)
  }
  const verifySelection = async (): Promise<void> => {
    expect(await activeTask()).toBe(activeId); await expect(heading).toBeVisible()
    await expect(page.locator('.work-conversation')).toContainText(`SIDEBAR_OPENED:${activeId}`)
    for (const state of statusTasks) await expect(row(state.id)).not.toHaveAttribute('data-selected', 'true')
  }
  const originalAppearance = await page.evaluate(() => document.documentElement.getAttribute('data-appearance'))
  try {
    for (const appearance of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.appearance = value }, appearance)
      await tab('最近').click()
      for (const state of statusTasks) {
        const pinned = Boolean((await savedTask(state.id))?.pinned), width = await verifyRest(state, pinned)
        const restPath = info.outputPath(`sidebar-status-${state.kind}-${appearance}.png`)
        await sidebar().screenshot({ path: restPath, animations: 'disabled' })
        await row(state.id).hover(); await verifyPin(state, width)
        const path = info.outputPath(`sidebar-pin-hover-${state.kind}-${appearance}.png`)
        await sidebar().screenshot({ path, animations: 'disabled' })
        await info.attach(`侧栏状态 ${state.label} ${appearance}`, { path: restPath, contentType: 'image/png' })
        await info.attach(`侧栏悬停置顶 ${state.label} ${appearance}`, { path, contentType: 'image/png' })
        await page.mouse.move(4, 4); expect(await verifyRest(state, pinned)).toBeCloseTo(width, 1)
        await row(state.id).hover()
        const pin = row(state.id).locator('.work-sidebar__task-actions').getByRole('button')
        await pin.click()
        await expect.poll(async () => Boolean((await savedTask(state.id))?.pinned)).toBe(!pinned)
        expect(await pin.evaluate(element => element.matches(':focus-visible'))).toBe(false)
        expect(await verifyRest(state, !pinned)).toBeCloseTo(width, 1)
        await verifySelection()
      }
      const state = statusTasks[0], target = row(state.id), main = target.locator('.work-sidebar__task')
      const width = await titleWidth(state.id), wasPinned = Boolean((await savedTask(state.id))?.pinned)
      await tab('最近').click(); await page.mouse.move(4, 4)
      // Reach the row through actual Tab navigation so Chromium uses keyboard focus-visible, not script focus heuristics.
      for (let attempt = 0; attempt < 45; attempt++) {
        await page.keyboard.press('Tab')
        if (await main.evaluate(element => element === document.activeElement)) break
      }
      await expect(main).toBeFocused(); expect(await main.evaluate(element => element.matches(':focus-visible'))).toBe(true)
      await verifyPin(state, width)
      await page.keyboard.press('Tab')
      const pin = target.locator('.work-sidebar__task-actions').getByRole('button')
      await expect(pin).toBeFocused(); expect(await pin.evaluate(element => element.matches(':focus-visible'))).toBe(true)
      await verifyPin(state, width)
      await page.keyboard.press('Enter')
      await expect.poll(async () => Boolean((await savedTask(state.id))?.pinned)).toBe(!wasPinned)
      await verifySelection()
      await tab('最近').click(); await verifyRest(state, !wasPinned)
    }
    for (const state of statusTasks.slice(0, 2)) if (!(await savedTask(state.id))?.pinned) {
      await row(state.id).hover(); await row(state.id).getByRole('button', { name: '置顶', exact: true }).click()
      await expect.poll(async () => (await savedTask(state.id))?.pinned).toBe(true)
    }
    await tab('最近').focus()
    for (const [key, destination] of [['ArrowRight', '项目'], ['ArrowLeft', '最近'], ['End', '归档'], ['Home', '最近']] as const) {
      await page.keyboard.press(key)
      await expect(tab(destination)).toHaveAttribute('aria-selected', 'true')
      await expect(tab(destination)).toBeFocused()
      await expect(panel()).toHaveAccessibleName(destination === '最近' ? '最近任务' : destination === '项目' ? '项目会话' : '归档任务')
      if (destination === '项目') await expect(panel().locator('.work-sidebar__project-group')).toHaveCount(1)
      else await expect(rows().first()).toHaveAttribute('data-task-id', destination === '最近' ? statusTasks[0].id : 'work-sidebar-archive-0')
      expect(await activeTask()).toBe(activeId)
    }
    await page.reload(); await expect(tab('最近')).toHaveAttribute('aria-selected', 'true')
    await tab('最近').click()
    for (const state of statusTasks) await verifyRest(state, Boolean((await savedTask(state.id))?.pinned))
    for (const state of statusTasks.slice(0, 2)) expect((await savedTask(state.id))?.pinned).toBe(true)
    await verifySelection()
  } finally {
    await page.evaluate(value => {
      if (value === null) document.documentElement.removeAttribute('data-appearance')
      else document.documentElement.setAttribute('data-appearance', value)
    }, originalAppearance)
  }
})

test('侧栏收起与窄窗抽屉保留分页能力，深浅色不挤压底部设置', async ({}, info) => {
  await sidebar().getByRole('button', { name: '收起 应用导航', exact: true }).click()
  await expect(panel()).toBeHidden()
  await sidebar().getByRole('button', { name: '展开 应用导航', exact: true }).click()
  await expect(rows()).toHaveCount(12)
  for (const appearance of ['light', 'dark']) for (const width of [1440, 780]) {
    await page.evaluate(appearance => { document.documentElement.dataset.appearance = appearance }, appearance)
    await windowSize(width)
    if (width === 780) {
      // Resizing animates the navigation button's position; keyboard activation
      // targets the settled control rather than its moving screen coordinates.
      await sidebar().getByRole('button', { name: '展开 应用导航', exact: true }).press('Enter')
      await expect(page.locator('.work-view')).toHaveAttribute('data-nav-open', 'true')
      await expect(sidebar().getByRole('button', { name: '收起 应用导航', exact: true })).toBeVisible()
    }
    await expect(tab('归档')).toBeInViewport({ ratio: 1 })
    await expect(sidebar().getByRole('button', { name: '设置', exact: true })).toBeInViewport({ ratio: 1 })
    const more = panel().getByRole('button', { name: '展开显示', exact: true })
    if (await more.count()) await more.click()
    expect(await panel().evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    expect(await sidebar().evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    const path = info.outputPath(`sidebar-history-${appearance}-${width}.png`)
    await page.mouse.move(4, 4); await page.screenshot({ path, animations: 'disabled' })
    await info.attach(`sidebar-history-${appearance}-${width}`, { path, contentType: 'image/png' })
    if (width === 780) {
      await expect(page.locator('.work-view')).toHaveAttribute('data-nav-open', 'true')
      await sidebar().getByRole('button', { name: '收起 应用导航', exact: true }).press('Enter')
      await expect(page.locator('.work-view')).toHaveAttribute('data-nav-open', 'false')
      await expect(panel()).toBeHidden()
      await expect(sidebar().getByRole('button', { name: '展开 应用导航', exact: true })).toBeVisible()
    }
  }
})

test('项目视图按工作目录分组，独立会话单列且不混入归档', async () => {
  const projectPaths = ['/remote/project-alpha', '/remote/project-beta', null] as const
  const projectTasks = tasks.slice(0, 9).map((task, index) => ({
    ...task,
    id: `work-sidebar-project-${index}`,
    title: `项目会话 ${index + 1}`,
    workspacePath: projectPaths[index % projectPaths.length]
  }))
  const archived = { ...projectTasks[0], id: 'work-sidebar-project-archived', title: '项目归档会话', archived: true }
  await seed(null, [...projectTasks, archived])
  await tab('项目').click()
  await expect(tab('项目')).toHaveAttribute('aria-selected', 'true')
  await expect(panel()).toHaveAccessibleName('项目会话')
  const groups = panel().locator('.work-sidebar__project-group')
  await expect(groups).toHaveCount(3)
  const groupSnapshot = await groups.evaluateAll(elements => elements.map(element => ({ key: element.getAttribute('data-project-key'), title: element.querySelector('.work-sidebar__project-heading')?.textContent?.trim(), count: element.querySelectorAll('.work-sidebar__task-row').length })))
  expect(groupSnapshot).toEqual([
    { key: '/remote/project-alpha', title: 'project-alpha', count: 3 },
    { key: '/remote/project-beta', title: 'project-beta', count: 3 },
    { key: '__independent__', title: '独立会话', count: 3 }
  ])
  expect(await groups.nth(1).locator('.work-sidebar__task-title').allTextContents()).toEqual(['项目会话 2', '项目会话 5', '项目会话 8'])
  await expect(panel().getByText('项目归档会话', { exact: true })).toHaveCount(0)
  await tab('归档').click()
  await expect(row('work-sidebar-project-archived')).toBeVisible()
})

test('项目组默认六条，可折叠并通过项目菜单置顶与新建', async () => {
  const projectTasks = tasks.slice(0, 8).map((task, index) => ({
    ...task,
    id: `work-sidebar-project-controls-${index}`,
    title: `项目控制会话 ${index + 1}`,
    workspacePath: '/remote/project-controls'
  }))
  await seed(null, projectTasks)
  await tab('项目').click()
  const group = panel().locator('.work-sidebar__project-group').first()
  await expect(group.locator('.work-sidebar__task-row')).toHaveCount(6)
  await expect(group.getByRole('button', { name: '展开显示', exact: true })).toBeVisible()
  await group.getByRole('button', { name: '展开显示', exact: true }).click()
  await expect(group.locator('.work-sidebar__task-row')).toHaveCount(8)
  const heading = group.locator('.work-sidebar__project-heading')
  await heading.click()
  await expect(group).toHaveAttribute('data-collapsed', 'true')
  await expect.poll(() => group.locator('.work-sidebar__project-content').evaluate(element => element.getBoundingClientRect().height)).toBe(0)
  await heading.click()
  await expect(group.locator('.work-sidebar__task-row')).toHaveCount(8)
  await group.hover()
  await expect(group.getByRole('button', { name: '在project-controls中新建会话', exact: true })).toBeVisible()
  await heading.click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: '置顶项目', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '收起项目', exact: true })).toBeVisible()
  await page.getByRole('menuitem', { name: '置顶项目', exact: true }).click()
  await expect(group.locator('.work-sidebar__project-pin')).toHaveCount(1)
})

test('项目页和侧栏实时同步置顶、名称、归档与恢复，保留独立的会话归档和运行状态', async ({}, info) => {
  const alpha = '/remote/unified-alpha', beta = '/remote/unified-beta'
  const active: SessionTask = { ...tasks[0], id: 'work-sidebar-unified-active', title: '仍在运行的项目会话', workspacePath: alpha, status: 'running',
    activity: { runId: 'root-work-sidebar-unified-active', seq: 1, version: 2, status: 'running', updatedAt: now, pendingAsk: 0, pendingPermission: 0 } }
  const archived: SessionTask = { ...tasks[1], id: 'work-sidebar-unified-archived', title: '单独归档的会话', workspacePath: alpha, archived: true }
  await seed(null, [active, archived, { ...tasks[2], workspacePath: beta }])
  await sidebar().getByRole('button', { name: '项目', exact: true }).click()
  const projects = page.locator('.work-projects')
  const option = (path: string) => projects.locator(`.work-project-nav-item[data-project-path="${path}"]`)
  const sideGroup = () => panel().locator(`.work-sidebar__project-group[data-project-key="${alpha}"]`)
  const sideHeading = () => sideGroup().locator('.work-sidebar__project-heading')
  const action = (label: string) => page.getByRole('menuitem', { name: label, exact: true })
  await expect(option(alpha)).toBeVisible()
  await tab('项目').click()
  await sideHeading().click({ button: 'right' }); await action('置顶项目').click()
  await expect(option(alpha)).toHaveAccessibleName(/已置顶/)
  await projects.getByRole('button', { name: '仅看置顶', exact: true }).click()
  await expect(projects.getByRole('option')).toHaveCount(1)
  await option(alpha).click({ button: 'right' }); await action('取消置顶项目').click()
  await expect(sideGroup().locator('.work-sidebar__project-pin')).toHaveCount(0)
  await projects.getByRole('button', { name: '全部项目', exact: true }).click()

  await option(alpha).click({ button: 'right' }); await action('修改显示名称').click()
  const rename = page.getByRole('dialog', { name: '修改项目显示名称', exact: true })
  await rename.getByRole('textbox', { name: '项目名称', exact: true }).fill('统一项目')
  await rename.getByRole('button', { name: '保存', exact: true }).click()
  await expect(sideHeading()).toContainText('统一项目')
  await sideHeading().click({ button: 'right' }); await action('修改显示名称').click()
  await rename.getByRole('textbox', { name: '项目名称', exact: true }).fill('双向同步项目')
  await rename.getByRole('button', { name: '保存', exact: true }).click()
  await expect(option(alpha)).toContainText('双向同步项目')
  await sideHeading().click({ button: 'right' }); await action('置顶项目').click()
  await expect(option(alpha)).toHaveAccessibleName(/已置顶/)

  await option(alpha).click({ button: 'right' }); await action('归档项目').click()
  await page.getByRole('dialog', { name: '归档项目', exact: true }).getByRole('button', { name: '归档', exact: true }).click()
  await expect(sideGroup()).toHaveCount(0)
  await expect(option(alpha)).toHaveCount(0)
  await tab('最近').click(); await expect(row(active.id)).toHaveCount(0)
  await tab('归档').click()
  await projects.getByRole('button', { name: '已归档', exact: true }).click()
  await expect(sideHeading()).toContainText('双向同步项目')
  await expect(sideGroup().locator('.work-sidebar__task-row')).toHaveCount(2)
  await expect(option(alpha)).toHaveAccessibleName(/2 项任务.*已置顶/)
  await expect(projects.locator('.work-project-task')).toHaveCount(2)
  await expect(sideGroup().locator('.work-sidebar__project-status')).toHaveAttribute('data-project-status', 'running')
  expect((await savedTask(active.id))?.status).toBe('running')
  expect(Boolean((await savedTask(active.id))?.archived)).toBe(false)
  expect((await savedTask(archived.id))?.archived).toBe(true)
  const path = info.outputPath('unified-project-archive.png')
  await page.screenshot({ path, animations: 'disabled' })
  await info.attach('项目与侧栏归档同步', { path, contentType: 'image/png' })

  await sideHeading().click({ button: 'right' }); await action('恢复项目').click()
  await expect(sideGroup().locator('.work-sidebar__task-row')).toHaveCount(1)
  await expect(sideGroup().locator(`[data-task-id="${archived.id}"]`)).toBeVisible()
  await expect(option(alpha)).toHaveAccessibleName(/1 项任务.*已置顶/)
  await expect(projects.locator('.work-project-task')).toHaveCount(1)
  expect((await savedTask(archived.id))?.archived).toBe(true)
  expect((await savedTask(active.id))?.status).toBe('running')
  await tab('项目').click()
  await projects.getByRole('button', { name: '全部项目', exact: true }).click()
  await expect(sideGroup().locator(`[data-task-id="${active.id}"]`)).toBeVisible()
  await expect(sideGroup().locator('.work-sidebar__project-pin')).toHaveCount(1)
  await expect(projects.locator(`.work-project-task[data-task-id="${active.id}"]`)).toBeVisible()
  await expect(sideGroup().locator(`[data-task-id="${archived.id}"]`)).toHaveCount(0)

  // A restore performed in the project page also updates the mounted sidebar.
  await sideHeading().click({ button: 'right' }); await action('归档项目').click()
  await page.getByRole('dialog', { name: '归档项目', exact: true }).getByRole('button', { name: '归档', exact: true }).click()
  await expect(option(alpha)).toHaveCount(0)
  await projects.getByRole('button', { name: '已归档', exact: true }).click()
  await option(alpha).click({ button: 'right' }); await action('恢复项目').click()
  await expect(sideHeading()).toContainText('双向同步项目')
  await expect(sideGroup().locator('.work-sidebar__project-pin')).toHaveCount(1)
})

test('项目标题汇总分页外状态，收起后持续更新且不自动展开', async ({}, info) => {
  const projectPath = '/remote/project-status'
  const projectTasks: SessionTask[] = tasks.slice(0, 8).map((task, index) => ({
    ...task, id: `work-sidebar-project-status-${index}`, title: `项目状态会话 ${index + 1}`,
    workspacePath: projectPath, status: index >= 6 ? 'running' : 'done',
    activity: { runId: `root-work-sidebar-project-status-${index}`, seq: 1, version: 2,
      status: index >= 6 ? 'running' : 'succeeded', updatedAt: task.updatedAt, pendingAsk: 0, pendingPermission: 0 }
  }))
  const quietTask = { ...tasks[0], id: 'work-sidebar-project-quiet', workspacePath: '/remote/quiet-project', title: '已完成会话' }
  await seed(projectTasks[0].id, [...projectTasks, quietTask])
  await tab('项目').click()
  const group = panel().locator(`.work-sidebar__project-group[data-project-key="${projectPath}"]`)
  const heading = group.locator('.work-sidebar__project-heading')
  const status = group.locator('.work-sidebar__project-status')
  const content = group.locator('.work-sidebar__project-content')
  const create = group.getByRole('button', { name: '在project-status中新建会话', exact: true })
  const quietGroup = panel().locator('[data-project-key="/remote/quiet-project"]')
  const verifyRest = async (target: Locator, hasStatus: boolean): Promise<void> => {
    await page.mouse.move(4, 4)
    const add = target.locator('.work-sidebar__project-create')
    await expect(add).toHaveCSS('opacity', '0')
    await expect(add).toHaveCSS('pointer-events', 'none')
    if (hasStatus) await expect(target.locator('.work-sidebar__project-status')).toHaveCSS('opacity', '1')
    else await expect(target.locator('.work-sidebar__project-status')).toHaveCount(0)
  }
  const verifyHover = async (target: Locator, hasStatus: boolean): Promise<void> => {
    const main = target.locator('.work-sidebar__project-heading')
    const name = target.locator('.work-sidebar__project-name')
    const add = target.locator('.work-sidebar__project-create')
    const before = await name.boundingBox()
    await main.hover()
    await expect(add).toHaveCSS('opacity', '1')
    await expect(add).toHaveCSS('pointer-events', 'auto')
    if (hasStatus) {
      await expect(target.locator('.work-sidebar__project-status')).toHaveCSS('opacity', '0')
      await expect(target.locator('.work-sidebar__project-status')).toHaveCSS('pointer-events', 'none')
    }
    const geometry = await target.evaluate(element => {
      const heading = element.querySelector('.work-sidebar__project-heading')!.getBoundingClientRect()
      const row = element.querySelector('.work-sidebar__project-heading-row')!.getBoundingClientRect()
      const status = element.querySelector('.work-sidebar__project-status')?.getBoundingClientRect()
      const create = element.querySelector('.work-sidebar__project-create')!.getBoundingClientRect()
      const name = element.querySelector('.work-sidebar__project-name')!.getBoundingClientRect()
      const hit = document.elementFromPoint(create.x + create.width / 2, create.y + create.height / 2)
      return { height: heading.height, addWidth: create.width, addHeight: create.height,
        rightGap: row.right - create.right, titleGap: (status?.left ?? create.left) - name.right,
        sameRightEdge: status ? Math.abs(status.right - create.right) : 0,
        sameCenter: Math.abs((status ?? row).top + (status ?? row).height / 2 - create.top - create.height / 2),
        hitCreate: Boolean(hit?.closest('.work-sidebar__project-create')) }
    })
    expect(geometry.height).toBe(32)
    expect(geometry.addWidth).toBe(24); expect(geometry.addHeight).toBe(24)
    expect(geometry.rightGap).toBeGreaterThanOrEqual(3); expect(geometry.rightGap).toBeLessThanOrEqual(5)
    expect(geometry.titleGap).toBeGreaterThanOrEqual(0)
    expect(geometry.sameRightEdge).toBeLessThanOrEqual(1)
    expect(geometry.sameCenter).toBeLessThanOrEqual(1)
    expect(geometry.hitCreate).toBe(true)
    const after = await name.boundingBox()
    expect(after?.x).toBe(before?.x); expect(after?.width).toBe(before?.width)
  }
  await expect(group.locator('.work-sidebar__task-row')).toHaveCount(6)
  await expect(group.locator(`[data-task-id="${projectTasks[6].id}"]`)).toHaveCount(0)
  await expect(status).toHaveAttribute('data-project-status', 'running')
  await expect(status).toHaveAccessibleName('运行中 · 2 个会话')
  await expect(status).toHaveText('2')
  await expect(status.locator('.ui-spinner')).toHaveCount(1)
  await verifyRest(group, true)
  await verifyHover(group, true)
  await verifyRest(group, true)
  await verifyRest(quietGroup, false)
  await verifyHover(quietGroup, false)
  await verifyRest(quietGroup, false)
  await heading.click()
  await expect(heading).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(() => content.evaluate(element => element.getBoundingClientRect().height)).toBe(0)
  await expect(content).toHaveAttribute('inert', '')
  expect(await heading.evaluate(element => element.matches(':focus-visible'))).toBe(false)
  await verifyRest(group, true)

  const update = (index: number, next: 'running' | 'waiting' | 'done', pendingPermission = 0, pendingAsk = 0): void => {
    fixtureTasks = fixtureTasks.map(task => task.id === projectTasks[index].id ? {
      ...task, status: next, updatedAt: Date.now(), activity: { ...task.activity!, version: task.activity!.version + 1,
        status: next === 'done' ? 'succeeded' : next, updatedAt: Date.now(), pendingPermission, pendingAsk }
    } : task)
  }
  update(6, 'waiting', 1)
  await expect(status).toHaveAttribute('data-project-status', 'permission')
  await expect(status).toHaveAccessibleName('待授权 · 1 个会话；运行中 · 1 个会话')
  await expect(heading).toHaveAccessibleName(/待授权 · 1 个会话/)
  await expect(heading).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(() => content.evaluate(element => element.getBoundingClientRect().height)).toBe(0)

  for (const appearance of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.appearance = value }, appearance)
    await verifyRest(group, true)
    const restPath = info.outputPath(`project-status-rest-${appearance}.png`)
    await sidebar().screenshot({ path: restPath, animations: 'disabled' })
    await info.attach(`项目默认状态 ${appearance}`, { path: restPath, contentType: 'image/png' })
    await verifyHover(group, true)
    const hoverPath = info.outputPath(`project-status-hover-${appearance}.png`)
    await sidebar().screenshot({ path: hoverPath, animations: 'disabled' })
    await info.attach(`项目悬停新建 ${appearance}`, { path: hoverPath, contentType: 'image/png' })
    await verifyRest(group, true)
    await verifyRest(quietGroup, false)
    await verifyHover(quietGroup, false)
    await verifyRest(quietGroup, false)
  }

  // Actual keyboard navigation must expose the shared action slot even with
  // the pointer elsewhere; a later mouse click must not leave it stuck open.
  await tab('项目').click()
  await page.mouse.move(4, 4)
  for (let attempt = 0; attempt < 30; attempt++) {
    await page.keyboard.press('Tab')
    if (await heading.evaluate(element => element === document.activeElement)) break
  }
  await expect(heading).toBeFocused()
  expect(await heading.evaluate(element => element.matches(':focus-visible'))).toBe(true)
  await expect(create).toHaveCSS('opacity', '1')
  await expect(status).toHaveCSS('opacity', '0')
  await page.keyboard.press('Tab')
  await expect(create).toBeFocused()
  expect(await create.evaluate(element => element.matches(':focus-visible'))).toBe(true)
  await expect(create).toHaveCSS('opacity', '1')
  await expect(create).toHaveCSS('pointer-events', 'auto')
  await expect(status).toHaveCSS('opacity', '0')
  await heading.click()
  await expect(heading).toHaveAttribute('aria-expanded', 'true')
  expect(await heading.evaluate(element => element.matches(':focus-visible'))).toBe(false)
  await verifyRest(group, true)
  await heading.click()
  await expect(heading).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(() => content.evaluate(element => element.getBoundingClientRect().height)).toBe(0)
  await verifyRest(group, true)

  update(6, 'waiting', 0, 1)
  await expect(status).toHaveAttribute('data-project-status', 'question')
  await expect(status).toHaveAccessibleName('等你补充 · 1 个会话；运行中 · 1 个会话')
  await expect(heading).toHaveAttribute('aria-expanded', 'false')
  update(6, 'running')
  await expect(status).toHaveAttribute('data-project-status', 'running')
  await expect(status).toHaveText('2')
  update(6, 'done'); update(7, 'done')
  await expect(status).toHaveAttribute('data-project-status', 'unread')
  await expect(status).toHaveAccessibleName('已完成，未查看 · 2 个会话')
  await expect(status.locator('.work-sidebar__completion-dot')).toHaveCount(1)
  await expect(heading).toHaveAttribute('aria-expanded', 'false')

  // Selecting a different session intentionally reveals its folded project.
  await tab('最近').click()
  await row(projectTasks[6].id).locator('.work-sidebar__task').click()
  await tab('项目').click()
  await expect(heading).toHaveAttribute('aria-expanded', 'true')
  await expect(row(projectTasks[6].id)).toHaveAttribute('data-selected', 'true')
})
