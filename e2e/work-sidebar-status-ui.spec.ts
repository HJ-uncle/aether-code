/** Isolated Electron + authenticated HTTP/SSE: every recent Work task retains
 * its execution status; row menus target the requested task without selecting
 * or cancelling a neighbour, and pin/colour choices survive reload. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun, RootPending } from '../src/shared/root-run'
import type { WorkState, WorkTask } from '../src/renderer/src/contrib/work/work-state'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'work-sidebar-status-fixture', model = 'work-sidebar-status-model'
const scenarios = ['active', 'background', 'ask', 'permission', 'failed', 'interrupted', 'stopped', 'done', 'discovered'] as const
type Scenario = typeof scenarios[number]
type TaskKey = Scenario | 'draft'
const titles: Record<Scenario, string> = { active: '当前运行任务', background: '后台运行任务', ask: '等待回答任务', permission: '等待授权任务',
  failed: '失败任务', interrupted: '中断任务', stopped: '停止任务', done: '已完成任务', discovered: '后台新轮次任务' }
const rootStatuses: Record<Scenario, RootRun['status']> = { active: 'running', background: 'running', ask: 'waiting', permission: 'waiting',
  failed: 'failed', interrupted: 'interrupted', stopped: 'cancelled', done: 'succeeded', discovered: 'succeeded' }
const localStatuses: Record<Scenario, WorkTask['status']> = { active: 'running', background: 'running', ask: 'waiting', permission: 'waiting',
  failed: 'error', interrupted: 'interrupted', stopped: 'stopped', done: 'done', discovered: 'done' }
const id = (key: TaskKey): string => `work-sidebar-${key}`
const now = Date.now() - 20_000
const runs = new Map<string, RootRun>(), streams = new Map<string, Set<ServerResponse>>()
const statusReads = new Map<string, number>(), cancels: Array<{ sessionId: string; runId: string }> = [], errors: string[] = []
let fixture = '', stateKey = '', app: ElectronApplication | undefined, health: ElectronHealthMonitor | undefined, page: Page
let releaseCancel: (() => void) | undefined, releaseExport: (() => void) | undefined, holdExport = false, foreignDraftExport = false
const envelope = (data: unknown) => JSON.stringify({ code: 200, message: 'ok', data })
function pending(kind: 'ask' | 'permission'): RootPending {
  return { requestId: `sidebar-${kind}`, kind, toolCallId: `sidebar-tool-${kind}`, toolName: kind === 'ask' ? 'ask_user' : 'execute_cmd',
    args: kind === 'ask' ? { question: '请选择报告范围' } : { command: 'echo sidebar' }, status: 'pending',
    ...(kind === 'ask' ? { question: '请选择报告范围' } : { description: '确认执行只读检查' }) }
}
for (const [index, key] of scenarios.entries()) {
  runs.set(id(key), { schemaVersion: 1, sessionId: id(key), runId: `run-${key}`, turnId: `turn-${key}`,
    userMessageId: `user-${key}`, assistantMessageId: `assistant-${key}`, status: rootStatuses[key], modelId: model,
    seq: 1, version: 1, pending: key === 'ask' ? [pending('ask')] : key === 'permission' ? [pending('permission')] : [],
    workspacePaths: [], createdAt: now + index, updatedAt: now + index,
    ...(['running', 'waiting'].includes(rootStatuses[key]) ? {} : { finishedAt: now + index + 1 }) })
}
function history(sessionId: string) {
  const run = runs.get(sessionId)
  if (!run) return []
  const key = scenarios.find(key => id(key) === sessionId)!
  return [{ id: run.userMessageId, role: 'user', content: `${titles[key]}的原始要求`, conversationId: run.turnId, createdAt: run.createdAt,
    metadata: { rootRunId: run.runId, turnId: run.turnId } },
  { id: run.assistantMessageId, role: 'assistant', content: `SIDEBAR_RESPONSE_${key}`, conversationId: run.turnId,
    createdAt: run.createdAt + 1, metadata: { rootRunId: run.runId, turnId: run.turnId }, modelId: model }]
}
function snapshot(sessionId: string) {
  const run = runs.get(sessionId), live = run?.status === 'running' || run?.status === 'waiting'
  return { schemaVersion: 1, sessionId, source: live ? 'live' : 'persisted', eventId: live ? `${run!.runId}:1` : null,
    finished: !live, projection: live ? [{ content: `SIDEBAR_RESPONSE_${sessionId.slice('work-sidebar-'.length)}` }] : [],
    history: history(sessionId), run, runs: run ? [run] : [], todos: [], changes: [], commandJobs: [], subagentRuns: [] }
}
function finish(sessionId: string, status: RootRun['status']): void {
  const prior = runs.get(sessionId)!
  const run = { ...prior, status, pending: [], version: prior.version + 1, updatedAt: Date.now(), finishedAt: Date.now() }
  runs.set(sessionId, run)
  for (const response of streams.get(sessionId) ?? []) response.end(`id: ${run.runId}:2\ndata: ${JSON.stringify({ run })}\n\ndata: [DONE]\n\n`)
}
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated sidebar fixture: ${path}`)
    let raw = ''; for await (const chunk of request) raw += String(chunk)
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    const sessionId = String(body.sessionId ?? url.searchParams.get('sessionId') ?? ''), run = runs.get(sessionId)
    if (path === '/api/v1/chat' && request.method === 'POST') throw new Error('Sidebar actions must not send a model request')
    if (path === '/api/v1/chat/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); response.flushHeaders()
      if (run && ['running', 'waiting'].includes(run.status)) {
        const readers = streams.get(sessionId) ?? new Set<ServerResponse>(); streams.set(sessionId, readers)
        readers.add(response); response.on('close', () => readers.delete(response)); return
      }
      response.end('data: [DONE]\n\n'); return
    }
    if (path === '/api/v1/chat/cancel' && request.method === 'POST') {
      if (!run || body.runId !== run.runId) throw new Error('Cancellation did not identify the current target root')
      cancels.push({ sessionId, runId: run.runId })
      await new Promise<void>(done => { releaseCancel = done })
      finish(sessionId, 'cancelled'); response.setHeader('content-type', 'application/json'); response.end(envelope({ cancelled: true })); return
    }
    if (path === '/api/v1/chat/status') statusReads.set(sessionId, (statusReads.get(sessionId) ?? 0) + 1)
    if (path === '/api/v1/chat/snapshot' && sessionId === id('done') && holdExport) {
      holdExport = false
      await new Promise<void>(done => { releaseExport = done })
    }
    if (path === '/api/v1/chat/snapshot' && sessionId === id('draft') && foreignDraftExport) {
      foreignDraftExport = false
      response.setHeader('content-type', 'application/json'); response.end(envelope(snapshot('work-foreign-export-session'))); return
    }
    if (path === '/api/v1/cron/capabilities' || path === '/api/v1/workbench/clients') {
      response.writeHead(404).end(JSON.stringify({ code: 404, message: 'Unsupported fixture capability' })); return
    }
    const rows = history(sessionId)
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: 'sha256:' + 'a'.repeat(64), protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'work-sidebar-status' }
      : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '侧栏测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
      : path === '/api/v1/chat/snapshot' ? snapshot(sessionId)
      : path === '/api/v1/chat/status' ? { run, running: run?.status === 'running', finished: run && !['running', 'waiting'].includes(run.status) }
      : path === '/api/v1/chat/runs' ? { runs: run ? [run] : [] }
      : path === '/api/v1/conversation/history' ? rows
      : path === '/api/v1/conversation/display' ? { schemaVersion: 1, grouping: 'root', turns: run ? [{ userMessageId: run.userMessageId,
        conversationId: run.turnId, preview: String(rows[0].content), createdAt: run.createdAt }] : [], messages: rows,
        loadedTurnIds: run ? [run.userMessageId] : [], revision: `${sessionId}:${run?.version ?? 0}`, mutationRevision: 'sidebar:unchanged', backend: 'jsonl', completeness: 'complete' }
      : path === '/api/v1/conversation/sessions' ? scenarios.map(key => ({ sessionId: id(key), title: titles[key], lastAt: now, messageCount: 2 }))
      : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'sidebar-fixture', sessionId,
        namespace: { id: 'sidebar-db', generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 },
        root: run ? { ...run, attemptId: 'attempt-' + run.runId } : null,
        predecessor: run ? { runId: run.runId, attemptId: 'attempt-' + run.runId, version: run.version } : null }
      : path === '/api/v1/security/mode' ? { sessionId, mode: 'standard' }
      : path === '/api/v1/memory/settings' ? { sessionId, memoryScope: 'session', effectiveScope: 'session', enabled: false }
      : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
      : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'sidebar' }
      : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, durableQueueReceipts: false, receiptPagination: false, runtimeCommunication: false, mailboxConsumer: false, userControllerMutation: false, rootUserControllerMutation: false }
      : path === '/api/v1/command-jobs' ? { jobs: [] }
      : path === '/api/v1/workspace/directory' ? { root: '/remote/sidebar', entries: [] }
      : /^\/api\/v1\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
      : []
    response.setHeader('content-type', 'application/json'); response.end(envelope(data))
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(envelope(null)) })
})

const work = () => page.locator('.work-view')
const row = (key: TaskKey) => work().locator(`.work-sidebar__task-row[data-task-id="${id(key)}"]`)
const status = (key: TaskKey) => row(key).locator('[data-task-status]')
const primary = (key: TaskKey) => row(key).locator('button.work-sidebar__task')
const menu = () => page.getByRole('menu')
const stored = (): Promise<WorkState> => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), stateKey)
async function expectSelected(key: Scenario): Promise<void> {
  await expect(primary(key)).toHaveAttribute('aria-current', 'true')
  expect((await stored()).activeTaskId).toBe(id(key))
}
async function openMenu(key: TaskKey, via: 'button' | 'context' | 'keyboard' = 'button'): Promise<void> {
  if (via === 'context') await primary(key).click({ button: 'right' })
  else if (via === 'keyboard') { await primary(key).focus(); await page.keyboard.press('Shift+F10') }
  else { await row(key).hover(); await row(key).getByRole('button', { name: /更多操作$/ }).click() }
  await expect(menu()).toBeVisible()
  await expect(menu().getByRole('menuitem', { name: /删除/ })).toHaveCount(0)
}
async function waitForWorkPaint(): Promise<void> {
  await expect(work().getByRole('heading', { name: titles.active, exact: true })).toBeVisible()
  await expect(work().locator('.work-sidebar__recent > .work-sidebar__task-row')).toHaveCount(10)
  // Visibility alone accepts transparent ancestors. Theme/media changes can
  // restart entrance transitions, so wait for their real completion and paint.
  await expect.poll(() => work().evaluate(async element => {
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
    const surfaces = [element, element.querySelector('.work-sidebar__recent'), element.querySelector('h1, h2')]
    if (surfaces.some(surface => !surface || !surface.getClientRects().length)) return false
    for (const surface of surfaces) {
      for (let ancestor = surface; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor)
        if (style.visibility !== 'visible' || style.display === 'none' || Number(style.opacity) < 1) return false
        if (ancestor.getAttribute('data-motion-state') === 'entering' || ancestor.getAttribute('data-motion-state') === 'closing') return false
      }
    }
    return !document.getAnimations().some(animation =>
      (animation.playState === 'running' || animation.pending) && animation.effect?.getComputedTiming().iterations !== Infinity)
  })).toBe(true)
}

test.describe.serial('Work 最近任务状态与行操作', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing sidebar fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    stateKey = 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin }))
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'work-sidebar-status-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true, lastModelId: model, appearance: 'light', lastFolder: '' }))
    const env = { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || process.env.AETHER_E2E_MAIN || '.', `--user-data-dir=${fixture}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'work-sidebar-status', [token]); page = await app.firstWindow()
    await app.evaluate(({ session }, fallbackPath) => {
      Reflect.set(globalThis, '__sidebarDownloadCount', 0)
      session.defaultSession.on('will-download', (_event, item) => {
        Reflect.set(globalThis, '__sidebarDownloadCount', Number(Reflect.get(globalThis, '__sidebarDownloadCount')) + 1)
        item.setSavePath(fallbackPath)
      })
    }, join(fixture, 'unexpected-download.json'))
    page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 1100))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const tasks: WorkTask[] = scenarios.map((key, index) => ({ id: id(key), title: titles[key], draft: `DRAFT_${key}`, status: localStatuses[key],
      createdAt: now + index, updatedAt: now + index, workspacePath: null, modelId: model, attachments: [], sources: [],
      ...(key === 'discovered' ? { activity: { runId: 'run-discovered', seq: 1, version: 1, status: 'succeeded' as const, updatedAt: now + index, pendingAsk: 0, pendingPermission: 0 } } : {}) }))
    tasks.push({ id: id('draft'), title: '从未发送的草稿', draft: 'UNSENT_DRAFT', status: 'draft', createdAt: now - 1,
      updatedAt: now - 1, workspacePath: null, modelId: model, attachments: [], sources: [] })
    const prior = runs.get(id('discovered'))!
    runs.set(id('discovered'), { ...prior, runId: 'run-discovered-new', turnId: 'turn-discovered-new', seq: 2, status: 'running',
      userMessageId: 'user-discovered-new', assistantMessageId: 'assistant-discovered-new', createdAt: now + 100, updatedAt: now + 100, finishedAt: undefined })
    await page.evaluate(({ stateKey, tasks }) => {
      localStorage.setItem(stateKey, JSON.stringify({ tasks, activeTaskId: tasks[0].id }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', workspace: false }))
    }, { stateKey, tasks })
    await page.reload(); await expect(work().getByRole('heading', { name: titles.active, exact: true })).toBeVisible()
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus) await page.screenshot({ path: info.outputPath('sidebar-failure.png') })
    expect(errors).toEqual([]); health?.assertHealthy()
  })
  test.afterAll(async ({}, info) => {
    releaseCancel?.(); releaseExport?.()
    try { if (health) await health.closeAndAssert(info); else await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const owned = resolve(fixture)
        if (dirname(owned) !== fixtureRoot || !basename(owned).startsWith('work-sidebar-status-')) throw new Error(`Unsafe sidebar cleanup: ${owned}`)
        rmSync(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('全部任务常显运行和等待等状态，后台新轮次被发现，切换会话不丢失状态', async ({}, info) => {
    await expect(work().locator('.work-sidebar__recent > .work-sidebar__task-row')).toHaveCount(10)
    const expected: Record<Scenario, string> = { active: 'running', background: 'running', ask: 'question', permission: 'permission',
      failed: 'error', interrupted: 'interrupted', stopped: 'stopped', done: 'done', discovered: 'running' }
    for (const key of scenarios) await expect(status(key)).toHaveAttribute('data-task-status', expected[key])
    await expect(status('draft')).toHaveAttribute('data-task-status', 'draft')
    await expect(status('ask')).toHaveAttribute('aria-label', '等待回答')
    await expect(status('permission')).toHaveAttribute('aria-label', '等待授权')
    expect(statusReads.get(id('discovered'))).toBeGreaterThan(0)
    await primary('done').click(); await expectSelected('done')
    await page.mouse.move(1200, 90)
    for (const key of ['active', 'background', 'discovered'] as const) {
      await expect(status(key).locator('.ui-spinner')).toBeVisible()
      await expect(status(key)).toHaveCSS('opacity', '1')
    }
    await primary('ask').click(); await expectSelected('ask'); await expect(status('ask')).toHaveAttribute('data-task-status', 'question')
    await primary('permission').click(); await expectSelected('permission'); await expect(status('permission')).toHaveAttribute('data-task-status', 'permission')
    await primary('active').click(); await expectSelected('active')
    expect(cancels).toEqual([])
    await waitForWorkPaint()
    await page.screenshot({ path: info.outputPath('sidebar-all-statuses.png') })
  })

  test('右键和更多菜单只修改目标任务，置顶颜色重命名持久化，后台停止导出归档恢复不误切换', async () => {
    await openMenu('done', 'context'); await expectSelected('active')
    await menu().getByRole('menuitem', { name: '置顶', exact: true }).click()
    await expect.poll(async () => (await stored()).tasks.find(task => task.id === id('done'))?.pinned).toBe(true)
    await expect(work().locator('.work-sidebar__recent > .work-sidebar__task-row').first()).toHaveAttribute('data-task-id', id('done'))
    await openMenu('done'); await menu().getByRole('menuitem', { name: '颜色标记', exact: true }).click()
    await page.getByRole('dialog', { name: '颜色标记', exact: true }).getByRole('button', { name: '紫色', exact: true }).click()
    await openMenu('done'); await menu().getByRole('menuitem', { name: '重命名任务', exact: true }).click()
    const rename = page.getByRole('dialog', { name: '重命名任务', exact: true })
    const nameInput = rename.getByRole('textbox', { name: '任务名称', exact: true })
    await nameInput.fill('已完成且置顶的紫色任务')
    await nameInput.click({ button: 'right' })
    await expect(menu()).toHaveCount(0); await expect(nameInput).toBeFocused()
    await rename.getByRole('button', { name: '确定', exact: true }).click()
    await expect(primary('done')).toHaveAttribute('aria-label', /已完成且置顶的紫色任务.*已置顶.*紫色标记/)
    await expectSelected('active'); expect(cancels).toEqual([])
    await page.reload(); await expectSelected('active')
    await expect(row('done').locator('[data-label-color="purple"]')).toBeVisible()
    expect((await stored()).tasks.find(task => task.id === id('done'))).toMatchObject({ pinned: true, labelColor: 'purple', title: '已完成且置顶的紫色任务', draft: 'DRAFT_done' })
    const downloadsBeforeFailure = await app!.evaluate(() => Number(Reflect.get(globalThis, '__sidebarDownloadCount')))
    foreignDraftExport = true
    await openMenu('draft'); await menu().getByRole('menuitem', { name: '导出任务', exact: true }).click()
    await expect(page.getByText('任务历史不匹配，请重试导出', { exact: true })).toBeVisible()
    await expectSelected('active')
    expect(await app!.evaluate(() => Number(Reflect.get(globalThis, '__sidebarDownloadCount')))).toBe(downloadsBeforeFailure)
    expect(existsSync(join(fixture, 'unexpected-download.json'))).toBe(false)
    await openMenu('background'); await expectSelected('active')
    await menu().getByRole('menuitem', { name: '停止任务', exact: true }).click()
    await expect.poll(() => cancels).toEqual([{ sessionId: id('background'), runId: 'run-background' }])
    await expect(status('background')).toHaveAttribute('data-task-status', 'stopping')
    await expectSelected('active'); expect(runs.get(id('active'))?.status).toBe('running')
    releaseCancel!(); releaseCancel = undefined
    await expect(status('background')).toHaveAttribute('data-task-status', 'stopped')
    const exportPath = join(fixture, 'sidebar-task-export.json')
    await app!.evaluate(({ session }, path) => { session.defaultSession.once('will-download', (_event, item) => item.setSavePath(path)) }, exportPath)
    holdExport = true
    await openMenu('done'); await menu().getByRole('menuitem', { name: '导出任务', exact: true }).click()
    await expect.poll(() => Boolean(releaseExport)).toBe(true)
    await openMenu('done', 'keyboard')
    await expect(menu().getByRole('menuitem', { name: '取消置顶', exact: true })).toBeFocused()
    await expect(menu().getByRole('menuitem', { name: '导出任务', exact: true })).toBeDisabled()
    await expectSelected('active'); await page.keyboard.press('Escape')
    releaseExport!(); releaseExport = undefined
    await expect.poll(() => existsSync(exportPath)).toBe(true)
    await expect.poll(() => { try { return JSON.parse(readFileSync(exportPath, 'utf8')).title } catch { return null } }).toBe('已完成且置顶的紫色任务')
    expect(await app!.evaluate(() => Number(Reflect.get(globalThis, '__sidebarDownloadCount')))).toBe(downloadsBeforeFailure + 1)
    await expectSelected('active')
    await openMenu('done'); await menu().getByRole('menuitem', { name: '归档任务', exact: true }).click()
    await expect.poll(async () => (await stored()).tasks.find(task => task.id === id('done'))?.archived).toBe(true)
    await expectSelected('active')
    await work().locator('.work-sidebar__archived summary').click()
    await openMenu('done'); await menu().getByRole('menuitem', { name: '恢复任务', exact: true }).click()
    await expect.poll(async () => (await stored()).tasks.find(task => task.id === id('done'))?.archived).toBe(false)
    await expectSelected('active')
    await openMenu('background'); await menu().getByRole('menuitem', { name: '继续任务', exact: true }).click()
    await expectSelected('background')
    await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toHaveText('DRAFT_background')
    expect(cancels).toHaveLength(1)
  })

  test('键盘菜单与深浅主题可用，省动效停转但状态保持可见', async ({}, info) => {
    await primary('active').click(); await expectSelected('active')
    await openMenu('failed', 'keyboard'); await expectSelected('active')
    await page.keyboard.press('Home'); await expect(menu().getByRole('menuitem', { name: '置顶', exact: true })).toBeFocused()
    await page.keyboard.press('End'); await expect(menu().getByRole('menuitem', { name: '导出任务', exact: true })).toBeFocused()
    await page.keyboard.press('Escape'); await expect(menu()).toHaveCount(0)
    await expect(row('failed').getByRole('button', { name: /更多操作$/ })).toBeFocused()
    for (const appearance of ['light', 'dark'] as const) {
      await page.evaluate(value => { document.documentElement.dataset.appearance = value }, appearance)
      for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        await page.emulateMedia({ reducedMotion }); await page.mouse.move(1200, 90)
        const spinner = status('active').locator('.ui-spinner')
        await expect(spinner).toBeVisible()
        await expect(spinner).toHaveCSS('animation-name', reducedMotion === 'reduce' ? 'none' : 'ui-spinner-rotate')
        await expect(status('permission')).toBeVisible()
        await expect(primary('active')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
        await expect(row('done').locator('[data-label-color="purple"]')).toBeVisible()
        await waitForWorkPaint()
        await page.screenshot({ path: info.outputPath(`sidebar-${appearance}-${reducedMotion}.png`) })
        if (reducedMotion === 'reduce') {
          await work().locator('.work-sidebar__recent').screenshot({ path: info.outputPath(`sidebar-list-${appearance}.png`) })
        }
      }
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(() => window.aether.engine.stop())
    await expect(status('active')).toHaveAttribute('data-task-status', 'disconnected')
    await openMenu('active'); await expect(menu().getByRole('menuitem', { name: '停止任务', exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.aether.engine.restart())
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
    await expect(status('active')).toHaveAttribute('data-task-status', 'running')
    expect(cancels).toHaveLength(1)
  })
})
