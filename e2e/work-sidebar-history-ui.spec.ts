/** Real Electron + owned engine: sidebar recent/archive peer tabs, incremental
 * scrolling, independent list positions, archive/restore persistence, and
 * navigation availability in expanded, collapsed and narrow layouts. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer } from 'node:http'
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
let app: ElectronApplication | undefined, page: Page, profile = '', storageKey = ''
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
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const task = tasks.find(item => item.id === id)
  const run: RootRun | undefined = task ? { schemaVersion: 1, runId: `root-${id}`, sessionId: id, turnId: `turn-${id}`,
    userMessageId: `user-${id}`, assistantMessageId: `assistant-${id}`, seq: 1, version: 2, status: 'succeeded', modelId,
    pending: [], workspacePaths: [workspace], createdAt: task.createdAt, updatedAt: task.updatedAt, finishedAt: task.updatedAt } : undefined
  const rows = run ? [
    { id: run.userMessageId, role: 'user', content: task!.title, createdAt: run.createdAt, conversationId: run.turnId, metadata: { rootRunId: run.runId } },
    { id: run.assistantMessageId, role: 'assistant', content: `SIDEBAR_OPENED:${id}`, createdAt: run.updatedAt, conversationId: run.turnId, metadata: { rootRunId: run.runId } }
  ] : []
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'f'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general'], subagentSchemaVersion: 1, instanceId: 'sidebar-history-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '侧栏分页测试模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true, history: rows, projection: [], run, runs: run ? [run] : [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run, lastEventId: null }
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
const tab = (name: '最近' | '归档'): Locator => sidebar().getByRole('tab', { name, exact: true })
const panel = (): Locator => sidebar().locator('.work-sidebar__recent')
const rows = (): Locator => panel().locator('.work-sidebar__task-row')
const row = (id: string): Locator => panel().locator(`.work-sidebar__task-row[data-task-id="${id}"]`)
async function windowSize(width: number, height = 900): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, size) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(520, 600); win.setContentSize(size.width, size.height) }, { width, height })
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height })
}
async function seed(activeTaskId: string | null = null): Promise<void> {
  await page.evaluate(({ key, tasks, modelId, workspace, activeTaskId }) => {
    window.dispatchEvent(new Event('blur'))
    localStorage.setItem(key, JSON.stringify({ tasks: [...tasks].reverse(), activeTaskId, homeDraft: '', homeModelId: modelId,
      homeWorkspacePath: workspace, homeSessionId: null, homeAttachments: [], homeSources: [] }))
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
  }, { key: storageKey, tasks, modelId, workspace, activeTaskId })
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await expect(tab('最近')).toHaveAttribute('aria-selected', 'true')
}
async function loadNext(expected: number): Promise<void> {
  await panel().evaluate(element => { element.scrollTop = element.scrollHeight })
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
    server.closeAllConnections(); if (server.listening) await new Promise<void>(done => server.close(() => done()))
    if (profile) { const target = resolve(profile); if (dirname(target) !== fixtureRoot || !basename(target).startsWith('profile-')) throw new Error('Unsafe sidebar fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  }
})

test('最近任务按滚动分批显示，置顶顺序和最后一批不丢失', async () => {
  await expect(rows()).toHaveCount(20)
  await expect(rows().first()).toHaveAttribute('data-task-id', 'work-sidebar-recent-54')
  await expect(rows().nth(1)).toHaveAttribute('data-task-id', 'work-sidebar-recent-0')
  await expect(panel().getByText('最近资料 41', { exact: true })).toHaveCount(0)
  await loadNext(40); await loadNext(55)
  const ids = await rows().evaluateAll(elements => elements.map(element => element.getAttribute('data-task-id')))
  expect(ids).toHaveLength(55); expect(new Set(ids).size).toBe(55)
  expect(ids.at(-1)).toBe('work-sidebar-recent-53')
  await panel().evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect(rows()).toHaveCount(55)
})

test('归档与最近同级，分别加载并保留各自浏览位置', async () => {
  await expect(tab('归档')).toBeVisible()
  await expect(sidebar().getByRole('tablist', { name: '任务列表', exact: true }).getByRole('tab')).toHaveCount(2)
  await expect(sidebar().locator('.work-sidebar__archived, details')).toHaveCount(0)
  await loadNext(40)
  await panel().evaluate(element => { element.scrollTop = 180 })
  await expect.poll(() => panel().evaluate(element => element.scrollTop)).toBeCloseTo(180, 0)
  await tab('归档').click()
  await expect(tab('归档')).toHaveAttribute('aria-selected', 'true')
  await expect(panel()).toHaveAccessibleName('归档任务')
  await expect(rows()).toHaveCount(20)
  await expect(rows().first()).toHaveAttribute('data-task-id', 'work-sidebar-archive-0')
  await expect(panel().locator('[data-task-id^="work-sidebar-recent-"]')).toHaveCount(0)
  await loadNext(40); await loadNext(45)
  await panel().evaluate(element => { element.scrollTop = 120 })
  await tab('最近').click()
  await expect(rows()).toHaveCount(40)
  await expect.poll(() => panel().evaluate(element => element.scrollTop)).toBeCloseTo(180, 0)
  await tab('归档').click()
  await expect(rows()).toHaveCount(45)
  await expect.poll(() => panel().evaluate(element => element.scrollTop)).toBeCloseTo(120, 0)
})

test('分页内右键归档与恢复真实保存，恢复后仍可打开原会话', async () => {
  const id = 'work-sidebar-recent-0'
  await row(id).getByRole('button', { name: '最近资料 01', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '归档任务', exact: true }).click()
  await expect.poll(async () => (await savedTask(id))?.archived).toBe(true)
  await expect(row(id)).toHaveCount(0)
  await tab('归档').click()
  await expect(row(id)).toBeVisible()
  await row(id).getByRole('button', { name: '最近资料 01', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '恢复任务', exact: true }).click()
  await expect.poll(async () => (await savedTask(id))?.archived).toBe(false)
  await expect(row(id)).toHaveCount(0)
  await tab('最近').click()
  await row(id).getByRole('button', { name: '最近资料 01', exact: true }).click()
  await expect(page.locator('.work-task-heading').getByRole('heading', { name: '最近资料 01', exact: true })).toBeVisible()
  await expect(page.locator('.work-conversation')).toContainText(`SIDEBAR_OPENED:${id}`)
  await expect(row(id)).toHaveAttribute('data-selected', 'true')
})

test('取消置顶后选中任务跨出首批仍保留行与原会话', async () => {
  const id = 'work-sidebar-recent-54'
  await expect(rows()).toHaveCount(20)
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

test('侧栏收起与窄窗抽屉保留分页能力，深浅色不挤压底部设置', async ({}, info) => {
  await sidebar().getByRole('button', { name: '收起 应用导航', exact: true }).click()
  await expect(panel()).toBeHidden()
  await sidebar().getByRole('button', { name: '展开 应用导航', exact: true }).click()
  await expect(rows()).toHaveCount(20)
  for (const appearance of ['light', 'dark']) for (const width of [1440, 780]) {
    await page.evaluate(appearance => { document.documentElement.dataset.appearance = appearance }, appearance)
    await windowSize(width)
    if (width === 780) await sidebar().getByRole('button', { name: '展开 应用导航', exact: true }).click()
    await expect(tab('归档')).toBeInViewport({ ratio: 1 })
    await expect(sidebar().getByRole('button', { name: '设置', exact: true })).toBeInViewport({ ratio: 1 })
    expect(await panel().evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    expect(await sidebar().evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    const path = info.outputPath(`sidebar-history-${appearance}-${width}.png`)
    await page.mouse.move(4, 4); await page.screenshot({ path, animations: 'disabled' })
    await info.attach(`sidebar-history-${appearance}-${width}`, { path, contentType: 'image/png' })
    if (width === 780) await page.getByRole('button', { name: '关闭导航抽屉', exact: true }).click()
  }
})
