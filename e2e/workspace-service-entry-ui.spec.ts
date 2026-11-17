/** Current workspace service entry: one launcher owns live status updates even
 * with the terminal closed; its internal history stays session-scoped and opens
 * the exact completed job output. Reopening returns to live activity. Isolated
 * Electron/HTTP fixture, no real model, user data, shell or legacy E2E runs.
 * Build first; run with --output .e2e-tmp/workspace-service-entry/results. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { CommandJobSnapshot } from '../src/shared/command-job'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp/workspace-service-entry')
const token = 'workspace-service-fixture', model = 'workspace-service-model', now = Date.now() - 5000
const taskA = 'work-service-entry-alpha', taskB = 'work-service-entry-beta'
const firstJobId = 'service-alpha-first', targetJobId = 'service-alpha-target', otherJobId = 'service-beta'
const sessions = [{ id: taskA, title: '服务入口 Alpha', workspace: '/remote/service-alpha' },
  { id: taskB, title: '服务入口 Beta', workspace: '/remote/service-beta' }]
const jobs = new Map<string, CommandJobSnapshot>([
  [firstJobId, command(firstJobId, taskA, 'alpha-first.mjs', now + 2)],
  [targetJobId, command(targetJobId, taskA, 'alpha-target.mjs', now + 1)],
  [otherJobId, command(otherJobId, taskB, 'beta-server.mjs', now)]
])
const errors: string[] = [], writes: string[] = []
const outputReads: Array<{ sessionId: string; jobId: string }> = []
const listReads: Array<{ sessionId: string; at: number }> = []
let app: ElectronApplication | undefined, page: Page, fixture = '', origin = '', historyKey = ''
function command(jobId: string, sessionId: string, file: string, time: number): CommandJobSnapshot {
  return { schemaVersion: 1, jobId, sessionId, ownerSessionId: sessionId, version: 1, status: 'running',
    command: 'node', args: [file], cwd: sessions.find(item => item.id === sessionId)!.workspace,
    background: true, createdAt: time, updatedAt: time, exitCode: null, signal: null, cursor: 1, earliestCursor: 0 }
}
const sessionJobs = (id: string): CommandJobSnapshot[] => [...jobs.values()].filter(job => job.sessionId === id)
const run = (id: string) => ({ schemaVersion: 1, runId: `run-${id}`, sessionId: id, turnId: `turn-${id}`,
  userMessageId: `user-${id}`, assistantMessageId: `assistant-${id}`, seq: 1, version: 2,
  status: 'succeeded', modelId: model, pending: [], workspacePaths: [sessions.find(item => item.id === id)?.workspace],
  createdAt: now, updatedAt: now, finishedAt: now })
const history = (id: string) => sessions.some(item => item.id === id) ? [
  { id: `user-${id}`, role: 'user', content: sessions.find(item => item.id === id)!.title, conversationId: `turn-${id}`, createdAt: now, metadata: { rootRunId: `run-${id}` } },
  { id: `assistant-${id}`, role: 'assistant', content: '后台服务已经启动。', conversationId: `turn-${id}`, createdAt: now + 1, metadata: { rootRunId: `run-${id}` } }
] : []
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', origin || 'http://127.0.0.1'), path = url.pathname
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Missing fixture token: ${path}`)
  let raw = ''; for await (const chunk of request) raw += chunk.toString()
  const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
  const id = url.searchParams.get('sessionId') ?? (typeof body.sessionId === 'string' ? body.sessionId : '')
  const commandRoute = /^\/api\/v1\/command-jobs\/([^/]+)(\/output)?$/.exec(path)
  if (commandRoute) {
    const job = jobs.get(decodeURIComponent(commandRoute[1]))
    if (!job || job.sessionId !== id || request.method !== 'GET') throw new Error(`Wrong command owner or operation: ${request.method} ${id} ${path}`)
    if (commandRoute[2]) {
      outputReads.push({ sessionId: id, jobId: job.jobId })
      const cursor = Number(url.searchParams.get('cursor') ?? 0)
      response.end(envelope({ job, entries: cursor ? [] : [{ seq: 1, stream: 'stdout', text: `OUTPUT:${job.jobId}\n` }],
        nextCursor: 1, earliestCursor: 0, truncated: false, hasMore: false })); return
    }
    response.end(envelope(job)); return
  }
  if (path === '/api/v1/command-jobs') {
    listReads.push({ sessionId: id, at: Date.now() })
    response.end(envelope({ jobs: sessionJobs(id) })); return
  }
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/browser/hosts', '/api/v1/lsp/request', '/api/v1/cron/capabilities', '/api/v1/terminal/create'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && !['/api/v1/workspace/bind', '/api/v1/chat/admission/receipt'].includes(path)) {
    writes.push(`${request.method} ${path}`); throw new Error(`Unexpected write: ${request.method} ${path}`)
  }
  const known = sessions.some(item => item.id === id), rows = history(id), currentRun = known ? run(id) : null
  if (path === '/api/v1/conversation/display') {
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: currentRun ? [{ userMessageId: currentRun.userMessageId, conversationId: currentRun.turnId, preview: sessions.find(item => item.id === id)!.title, createdAt: now }] : [],
      messages: rows, loadedTurnIds: currentRun ? [currentRun.userMessageId] : [], revision: 'stable', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'9'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: token }
    : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '服务入口测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true, history: rows, projection: [], run: currentRun, runs: currentRun ? [currentRun] : [], subagentRuns: [], todos: [], changes: [], commandJobs: sessionJobs(id) }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: currentRun, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: currentRun ? [currentRun] : [] }
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: token, sessionId: id, namespace: { id: token, generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? sessions.map(item => ({ sessionId: item.id, title: item.title, lastAt: now, messageCount: 2 }))
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : /\/sessions\/[^/]+\/toolkits$/.test(path) ? { toolkits: [] }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'off', effectiveScope: 'off', enabled: false }
    : path === '/api/v1/memory/preferences' ? { enabled: false, globalEnabled: false, sessionDefaultEnabled: false }
    : path === '/api/v1/workspace/directory' ? { root: sessions.find(item => item.id === id)?.workspace ?? sessions[0].workspace, bindingEpoch: 'one', entries: [] }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: sessions[0].workspace }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/plugins' ? { plugins: [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const entry = () => page.getByRole('button', { name: '更多工作区', exact: true })
const card = () => page.getByRole('menu', { name: '更多工作区', exact: true })
const terminal = () => page.getByRole('region', { name: '任务终端', exact: true })
const historyPanel = () => card().locator('.work-workspace-card__history')
async function openCard(): Promise<void> {
  if (await entry().getAttribute('aria-expanded') !== 'true') await entry().click()
  await expect(entry()).toHaveAttribute('aria-expanded', 'true')
  await expect(card()).toBeVisible()
}
async function openHistory(): Promise<void> {
  await openCard()
  if (!await historyPanel().isVisible()) await card().getByRole('menuitem', { name: '查看服务历史', exact: true }).click()
  await expect(historyPanel()).toBeVisible()
  await expect(historyPanel()).toHaveAttribute('aria-label', '当前会话服务历史')
}
async function switchSession(id: string): Promise<void> {
  if (await card().isVisible()) await page.keyboard.press('Escape')
  await page.locator(`[data-task-id="${id}"] .work-sidebar__task`).click()
  await expect(page.getByRole('heading', { name: sessions.find(item => item.id === id)!.title, exact: true })).toBeVisible()
}

test.describe.serial('工作区内服务入口', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'profile-'))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    origin = `http://127.0.0.1:${address.port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, remoteWorkspaceRoot: sessions[0].workspace,
      autoStartEngine: true, lastFolder: '', lastModelId: model, appearance: 'dark', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_ENGINE_ENTRY'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900); window.show(); window.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const stateKey = sessionStorageKey('aether.work.state.v1', engineStorageKey({ mode: 'remote', baseUrl: origin }))
    historyKey = sessionStorageKey('aether.activity-history.v1', engineStorageKey({ mode: 'remote', baseUrl: origin }))
    await page.evaluate(({ stateKey, historyKey, sessions, taskA, now, model }) => {
      localStorage.setItem(stateKey, JSON.stringify({ tasks: sessions.map(item => ({ id: item.id, title: item.title, status: 'done', draft: '', createdAt: now, updatedAt: now,
        workspacePath: item.workspace, modelId: model, attachments: [], sources: [], resources: { toolkits: [], skills: [], mcpServers: [], knowledgeBases: [] } })), activeTaskId: taskA }))
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
      localStorage.setItem(historyKey, JSON.stringify([
        ...sessions.map((item, index) => ({ id: `plugin:fixture-history-${item.id}`, kind: 'service', sessionId: item.id,
          label: index === 0 ? 'Alpha 插件历史' : 'Beta 插件历史', detail: `${item.workspace} · 已结束的插件任务`,
          status: 'completed', statusLabel: '已完成', tone: 'quiet', updatedAt: now - 1000, readAt: now })),
        { id: 'plugin:global-notice', kind: 'notification', sessionId: taskA, label: '全局已读通知', detail: '仅属于消息历史',
          status: 'completed', statusLabel: '已完成', tone: 'quiet', updatedAt: now - 1000, readAt: now }
      ]))
    }, { stateKey, historyKey, sessions, taskA, now, model })
    await page.reload(); await expect(page.getByRole('heading', { name: sessions[0].title, exact: true })).toBeVisible()
  })
  test.afterEach(async ({}, info) => {
    if (page && !page.isClosed()) {
      const path = info.outputPath(info.status === info.expectedStatus ? 'workspace-service.png' : 'workspace-service-failure.png')
      await page.screenshot({ path, animations: 'disabled' }); await info.attach('工作区服务入口', { path, contentType: 'image/png' })
    }
    await info.attach('fixture-requests', { body: JSON.stringify({ errors, writes, outputReads, listReads }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([]); expect(writes).toEqual([])
  })
  test.afterAll(async () => {
    try { await app?.close() } finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('profile-')) throw new Error(`Unsafe service-entry fixture cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('删除标题栏重复服务按钮，更多工作区保留当前会话终端活动', async () => {
    await expect(page.locator('.work-task-heading .service-tray--services')).toHaveCount(0)
    await expect(entry()).toHaveCount(1)
    await expect(terminal()).toHaveCount(0)
    await openCard()
    const active = card().getByRole('region', { name: '终端', exact: true })
    await expect(card().locator('.work-workspace-card__header')).toContainText('正在进行')
    await expect(active.getByRole('menuitem')).toHaveCount(2)
    await expect(active.getByRole('menuitem').filter({ hasText: 'alpha-first.mjs' })).toContainText('运行中')
    await expect(active.getByRole('menuitem').filter({ hasText: 'alpha-target.mjs' })).toContainText('运行中')
    await expect(card()).not.toContainText('beta-server.mjs')
    await expect(card().locator('.work-workspace-card__header').getByRole('menuitem', { name: '查看服务历史', exact: true })).toBeVisible()
    await expect(page.locator('.work-task-heading > .service-tray')).toHaveCount(0)
    await expect(historyPanel()).toHaveCount(0)
    expect(outputReads).toEqual([])
  })

  test('终端从未打开时仍刷新完成状态，历史只在卡片内部且重开默认实时', async () => {
    await expect(terminal()).toHaveCount(0)
    await openCard()
    const finishedAt = Date.now()
    const first = jobs.get(firstJobId)!
    jobs.set(firstJobId, { ...first, version: first.version + 1, status: 'succeeded', updatedAt: finishedAt, finishedAt, exitCode: 0 })
    await expect.poll(() => listReads.some(read => read.sessionId === taskA && read.at >= finishedAt)).toBe(true)
    const active = card().getByRole('region', { name: '终端', exact: true })
    await expect(active.getByRole('menuitem')).toHaveCount(1)
    await expect(active).toContainText('alpha-target.mjs')
    await expect(card()).not.toContainText('alpha-first.mjs')
    await expect(entry().locator('.work-workspace-card__badge')).toHaveText('1')
    await expect(terminal()).toHaveCount(0)
    expect(outputReads).toEqual([])

    await openHistory()
    await expect(historyPanel().getByRole('menuitem').filter({ hasText: 'alpha-first.mjs' })).toContainText('已完成')
    await expect(historyPanel()).toContainText('Alpha 插件历史')
    await expect(historyPanel()).not.toContainText('alpha-target.mjs')
    await expect(historyPanel()).not.toContainText('Beta 插件历史')
    await expect(historyPanel()).not.toContainText('全局已读通知')
    await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '[]'), historyKey)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `command:${firstJobId}`, sessionId: taskA, status: 'succeeded' })
    ]))
    await card().getByRole('menuitem', { name: '返回工作区', exact: true }).click()
    await expect(historyPanel()).toHaveCount(0)
    await expect(active.getByRole('menuitem')).toHaveCount(1)
    await openHistory()
    await page.keyboard.press('Escape')
    await expect(entry()).toBeFocused()
    await expect(card()).toBeHidden()
    await openCard()
    await expect(historyPanel()).toHaveCount(0)
    await expect(card().locator('.work-workspace-card__header')).toContainText('正在进行')
    await expect(active.getByRole('menuitem')).toHaveCount(1)
  })

  test('正在进行中的终端行直接打开指定 job 的输出与会话', async () => {
    await openCard()
    const target = card().getByRole('region', { name: '终端', exact: true }).getByRole('menuitem').filter({ hasText: 'alpha-target.mjs' })
    await expect(target).toBeEnabled(); await target.click()
    await expect(card()).toBeHidden()
    await expect(terminal()).toBeVisible()
    await expect(terminal()).toHaveAttribute('data-session-id', taskA)
    await expect(terminal().locator('.work-terminal-panel__detail')).toHaveAttribute('data-job-id', targetJobId)
    await expect(terminal().locator('.work-terminal-panel__output')).toContainText(`OUTPUT:${targetJobId}`)
    await expect.poll(() => outputReads.some(read => read.sessionId === taskA && read.jobId === targetJobId)).toBe(true)
    expect(outputReads.some(read => read.jobId === firstJobId || read.jobId === otherJobId)).toBe(false)
  })

  test('服务历史打开已完成任务的指定输出，保留实时任务', async () => {
    await openHistory()
    await historyPanel().getByRole('menuitem').filter({ hasText: 'alpha-first.mjs' }).click()
    await expect(card()).toBeHidden()
    await expect(terminal()).toHaveAttribute('data-session-id', taskA)
    await expect(terminal().locator('.work-terminal-panel__detail')).toHaveAttribute('data-job-id', firstJobId)
    await expect(terminal().locator('.work-terminal-panel__detail')).toHaveAttribute('data-status', 'succeeded')
    await expect(terminal().locator('.work-terminal-panel__output')).toContainText(`OUTPUT:${firstJobId}`)
    await expect(terminal().locator(`[data-job-id="${targetJobId}"]`)).toContainText('运行中')
    await expect.poll(() => outputReads.some(read => read.sessionId === taskA && read.jobId === firstJobId)).toBe(true)
    expect(outputReads.some(read => read.jobId === otherJobId)).toBe(false)
  })

  test('切换会话后实时服务、插件历史和终端输出互不串用', async () => {
    await switchSession(taskB)
    await openCard()
    await expect(historyPanel()).toHaveCount(0)
    const beta = card().getByRole('region', { name: '终端', exact: true })
    await expect(beta.getByRole('menuitem')).toHaveCount(1)
    await expect(beta).toContainText('beta-server.mjs')
    await expect(card()).not.toContainText('alpha-')
    await openHistory()
    await expect(historyPanel()).toContainText('Beta 插件历史')
    await expect(historyPanel()).not.toContainText('Alpha 插件历史')
    await expect(historyPanel()).not.toContainText('alpha-first.mjs')
    await expect(historyPanel()).not.toContainText('全局已读通知')
    await card().getByRole('menuitem', { name: '返回工作区', exact: true }).click()
    await beta.getByRole('menuitem').filter({ hasText: 'beta-server.mjs' }).click()
    await expect(terminal()).toHaveAttribute('data-session-id', taskB)
    await expect(terminal().locator('.work-terminal-panel__detail')).toHaveAttribute('data-job-id', otherJobId)
    await expect(terminal().locator('.work-terminal-panel__output')).toContainText(`OUTPUT:${otherJobId}`)
    await expect(terminal()).not.toContainText('alpha-')

    await switchSession(taskA)
    await openHistory()
    await expect(historyPanel()).toContainText('Alpha 插件历史')
    await expect(historyPanel()).toContainText('alpha-first.mjs')
    await expect(historyPanel()).not.toContainText('Beta 插件历史')
    await expect(historyPanel()).not.toContainText('beta-server.mjs')
    expect(outputReads.every(read => jobs.get(read.jobId)?.sessionId === read.sessionId)).toBe(true)
  })

  test('全部服务结束后仍保留内部历史入口，刷新后历史不丢失', async () => {
    const job = jobs.get(targetJobId)!, finishedAt = Date.now()
    jobs.set(targetJobId, { ...job, version: job.version + 1, status: 'succeeded', updatedAt: finishedAt, finishedAt, exitCode: 0 })
    await openHistory()
    await expect(historyPanel().getByRole('menuitem')).toHaveCount(2)
    await card().getByRole('menuitem', { name: '返回工作区', exact: true }).click()
    await expect(card().locator('.work-workspace-card__activity')).toHaveCount(0)
    await expect(entry().locator('.work-workspace-card__badge')).toHaveCount(0)
    await expect(card().locator('.work-workspace-card__header strong')).toHaveText('工作区')
    await expect(card().getByRole('menuitem', { name: '查看服务历史', exact: true })).toBeVisible()

    await page.reload()
    await expect(page.getByRole('heading', { name: sessions[0].title, exact: true })).toBeVisible()
    await openCard()
    await expect(historyPanel()).toHaveCount(0)
    await expect(card().locator('.work-workspace-card__activity')).toHaveCount(0)
    await openHistory()
    await expect(historyPanel().getByRole('menuitem')).toHaveCount(2)
    await expect(historyPanel()).toContainText('Alpha 插件历史')
    await expect(historyPanel()).not.toContainText('Beta 插件历史')
    await expect(historyPanel()).not.toContainText('全局已读通知')
  })
})
