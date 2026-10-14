/** Real Electron/HTTP/SSE task-plan presentation in Code, Work, child run
 * details and replay of a controlled automation run. This fixture exercises
 * renderer/IPC/recovery, not a real provider or the scheduler clock. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { ChatSsePayload, EngineTodo } from '../src/shared/ipc'
import type { RootRun } from '../src/shared/root-run'
import type { SubagentRun } from '../src/shared/subagent'
import type { CronAutomationRun, CronCapabilities, CronJobV2, CronPreviewRequest } from '../src/shared/automation'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'silent-plan-ui-token', modelId = 'silent-plan-ui-model'
interface Session { run?: RootRun; history: EngineHistoryRow[]; projection: ChatSsePayload[]; todos: EngineTodo[]; stream?: ServerResponse; sequence: number; content: string }
const sessions = new Map<string, Session>(), requests: Record<string, unknown>[] = [], children = new Map<string, SubagentRun>()
const httpRequests: Array<{ method: string; path: string; sessionId: string | null; status?: number }> = []
const errors: string[] = []
let app: ElectronApplication | undefined, page: Page, health: ElectronHealthMonitor | undefined, fixture = '', workSession = ''
let automationRun: CronAutomationRun | undefined
const fixtureCreatedAt = Date.now()
const cronCapabilities: CronCapabilities = {
  version: 2, executionSupported: false, reason: 'authenticated_dispatch_not_supported',
  schedules: ['legacy'], targets: ['session'], notificationPolicies: ['silent'],
  overlapPolicy: 'skip', missedRunPolicy: 'skip', manualRun: false, authEnabledDispatch: false,
  runHistory: true, ownedCancellation: false, persistentNotifications: false
}
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
function fixtureAutomationJob(): CronJobV2 {
  return {
    id: 'plan-automation', tenantId: 'tenant', name: '计划状态例行检查', message: '验证计划状态',
    enabled: false, cronExpr: '*/15 * * * *', sessionId: workSession, thinkingMode: false,
    configuration: { version: 2, schedule: { kind: 'legacy', expression: '*/15 * * * *', timeZone: 'UTC' },
      target: { kind: 'session', sessionId: workSession }, notificationPolicy: 'silent', toolProfile: 'general' },
    revision: 1, scheduleRevision: 1, createdAt: fixtureCreatedAt, updatedAt: fixtureCreatedAt,
    lastRunAt: automationRun?.scheduledAt
  }
}
function session(id: string): Session {
  if (!sessions.has(id)) sessions.set(id, { history: [], projection: [], todos: [], sequence: 0, content: '' })
  return sessions.get(id)!
}
function frame(id: string, payload: ChatSsePayload): void {
  const state = session(id)
  if (!state.run || !state.stream || state.stream.writableEnded) throw new Error(`Missing stream ${id}`)
  if (payload.todo) state.todos = structuredClone(payload.todo.todos)
  if (typeof payload.content === 'string') state.content += payload.content
  if (payload.subagentEvent) children.set(payload.subagentEvent.runId, structuredClone(payload.subagentEvent.snapshot))
  state.projection.push(structuredClone(payload))
  state.stream.write(`id: ${state.run.runId}:${++state.sequence}\ndata: ${JSON.stringify(payload)}\n\n`)
}
function rememberControl(id: string, name: string, callId: string, success: boolean, error?: string): void {
  const state = session(id), run = state.run!
  state.history.push(
    { id: `call-${callId}`, role: 'assistant', conversationId: run.turnId, toolCall: { id: callId, name, args: name === 'plan_update' ? { plan: [{ step: '验证功能', status: 'in_progress' }] } : { title: '验证功能' } } },
    { id: `result-${callId}`, role: 'tool', toolCallId: callId, content: success ? 'ok' : '保留原计划，请重试', success, error }
  )
}
function finish(id: string): void {
  const state = session(id), prior = state.run!
  state.run = { ...prior, status: 'succeeded', version: prior.version + 1, seq: state.sequence + 1, updatedAt: Date.now(), finishedAt: Date.now() }
  state.history.push({ id: prior.assistantMessageId, role: 'assistant', conversationId: prior.turnId, content: state.content, modelId })
  frame(id, { run: state.run })
  state.stream!.end('data: [DONE]\n\n')
  state.projection = []
}
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    const receipt: (typeof httpRequests)[number] = { method: request.method ?? 'GET', path, sessionId: url.searchParams.get('sessionId') }
    httpRequests.push(receipt)
    response.once('finish', () => { receipt.status = response.statusCode })
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) { response.writeHead(401).end(envelope(null)); return }
    let raw = ''; for await (const part of request) raw += part.toString()
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    // Child snapshots intentionally retain the supported v1 fallback. Cron
    // exposes read-only v2 history so replay enters through the real records UI.
    if (path === '/api/v1/subagent/capabilities') {
      response.writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ code: 404, message: 'Capability is not implemented by this legacy fixture' }))
      return
    }
    if (path === '/api/v1/cron/capabilities') {
      response.setHeader('content-type', 'application/json'); response.end(envelope(cronCapabilities)); return
    }
    if (path === '/api/v1/cron/plan-automation/runs') {
      response.setHeader('content-type', 'application/json')
      response.end(envelope({ items: automationRun ? [automationRun] : [], nextCursor: null })); return
    }
    if (path === '/api/v1/cron/plan-automation') {
      response.setHeader('content-type', 'application/json'); response.end(envelope(fixtureAutomationJob())); return
    }
    if (path === '/api/v1/cron/preview' && request.method === 'POST') {
      const input = body as unknown as CronPreviewRequest
      response.setHeader('content-type', 'application/json')
      response.end(envelope({ schedule: input.schedule, summary: '夹具只验证已保存的规则与运行回放', nextRunAt: null, occurrences: [] })); return
    }
    if (path === '/api/v1/chat' && request.method === 'POST') {
      requests.push(body)
      const id = String(body.sessionId), state = session(id), now = Date.now(), index = requests.length
      state.run = { schemaVersion: 1, runId: `plan-run-${index}`, sessionId: id, turnId: `plan-turn-${index}`, userMessageId: `plan-user-${index}`, assistantMessageId: `plan-assistant-${index}`, seq: 1, version: 1, status: 'running', modelId, pending: [], workspacePaths: [], createdAt: now, updatedAt: now }
      const user = { id: state.run.userMessageId, role: 'user', content: String(body.message), conversationId: state.run.turnId, createdAt: now }
      state.history.push(user); state.stream = response; state.sequence = 0; state.projection = []; state.content = ''
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      frame(id, { run: state.run }); frame(id, { userMessage: user }); return
    }
    const id = url.searchParams.get('sessionId') ?? '', state = session(id)
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'f'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'silent-plan-ui' }
        : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: 'Task plan fixture model', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
          : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, source: state.run?.status === 'running' ? 'live' : 'persisted', sessionId: id, eventId: state.run ? `${state.run.runId}:${state.sequence}` : null, finished: state.run?.status !== 'running', history: state.history, projection: state.projection, run: state.run, runs: state.run ? [state.run] : [], todos: state.todos, changes: [], commandJobs: [], subagentRuns: [...children.values()].filter(child => child.parentSessionId === id) }
            : path === '/api/v1/chat/runs' ? { runs: state.run ? [state.run] : [] }
              : path === '/api/v1/subagent/runs' ? [...children.values()].filter(child => child.parentSessionId === url.searchParams.get('parentSessionId'))
                : path.startsWith('/api/v1/subagent/runs/') ? children.get(path.split('/').at(-1)!)
                  : path === '/api/v1/security/mode' ? { mode: 'safe', sessionId: id }
                    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: true, sessionId: id }
                      : path === '/api/v1/workspace/directory' ? { root: '/remote/task-plan', entries: [] }
                        : path === '/api/v1/workspace/bind' ? { workspaceRoot: '/remote/task-plan' }
                          : /^\/api\/v1\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, agent: null }
                            : path === '/api/v1/cron' ? workSession ? [fixtureAutomationJob()] : [] : []
    response.setHeader('content-type', 'application/json'); response.end(envelope(data))
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})
const work = (): Locator => page.locator('.work-view')
const code = (): Locator => page.locator('.mode-surface[data-mode="code"]')
async function expand(button: Locator): Promise<void> {
  const expanded = await button.evaluate(element => element.tagName === 'SUMMARY'
    ? element.parentElement instanceof HTMLDetailsElement && element.parentElement.open
    : element.getAttribute('aria-expanded') === 'true')
  if (!expanded) await button.click()
}
async function startWork(prompt: string): Promise<string> {
  await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
  await work().getByRole('button', { name: '新任务', exact: true }).click()
  await work().getByRole('textbox', { name: '任务目标', exact: true }).fill(prompt)
  const count = requests.length
  await work().getByRole('button', { name: '开始任务', exact: true }).click()
  await expect.poll(() => requests.length).toBe(count + 1)
  return String(requests[count].sessionId)
}
test.describe.serial('内建任务计划静默展示', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'silent-plan-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: `http://127.0.0.1:${address.port}`, remoteWorkspaceRoot: '/remote/task-plan', autoStartEngine: true, lastModelId: modelId, lastSessionId: '', lastFolder: '', appearance: 'dark' }))
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root, env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    health = await monitorElectronHealth(app, 'silent-task-plan', [token]); page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    // Engine health alone cannot prove the first session snapshot was restored.
    // Code enables this shared selector only after its session/model guard passes.
    await expect(code().getByRole('button', { name: '选择模型', exact: true })).toBeEnabled()
    expect(httpRequests.some(item => item.path === '/api/v1/subagent/capabilities' && item.status === 404)).toBe(true)
    expect(httpRequests.some(item => item.path === '/api/v1/chat/snapshot' && Boolean(item.sessionId) && item.status === 200)).toBe(true)
  })
  test.afterEach(() => health?.assertHealthy())
  test.afterAll(async ({}, info) => {
    for (const state of sessions.values()) state.stream?.destroy()
    try {
      const path = info.outputPath('task-plan-fixture-http-receipts.json')
      writeFileSync(path, JSON.stringify(httpRequests, null, 2))
      await info.attach('task-plan-fixture-http-receipts', { path, contentType: 'application/json' })
      if (health) await health.closeAndAssert(info); else await app?.close()
    }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) { const target = resolve(fixture); if (dirname(target) !== fixtureRoot || !basename(target).startsWith('silent-plan-')) throw new Error(`Unsafe cleanup: ${target}`); rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    }
  })

  test('Code 的独立计划快照即时更新；end-only 保存失败可见且刷新不丢原计划', async () => {
    const count = requests.length
    await code().locator('.chat__input').fill('CODE_SILENT_PLAN')
    await expect(code().getByRole('button', { name: '发送', exact: true })).toBeEnabled()
    await code().getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => requests.length).toBe(count + 1)
    const id = String(requests[count].sessionId)
    const todos: EngineTodo[] = [{ id: 'check', title: 'CODE_PLAN_STEP', status: 'in_progress', priority: 'medium' }]
    frame(id, { todo: { todos } })
    frame(id, { content: 'CODE_PLAN_RUNNING' })
    await expect(code().getByRole('button', { name: '任务 0/1', exact: true })).toBeVisible()
    await code().getByRole('button', { name: '任务 0/1', exact: true }).click()
    await expect(code().locator('.todo-tray')).toContainText('CODE_PLAN_STEP')
    await expect(code().locator('.todo-tray')).toContainText('进行中')
    await expect(code().locator('.compact-tool-row')).toHaveCount(0)
    await expect(code().locator('.process')).toHaveCount(0)
    frame(id, { todo: { todos: [{ ...todos[0], status: 'done' }] } })
    await expect(code().getByRole('button', { name: '任务 1/1', exact: true })).toBeVisible()
    frame(id, { toolEnd: { id: 'code-plan-failure', name: 'plan_update', args: { plan: [{ step: 'CODE_PLAN_STEP', status: 'in_progress' }] }, success: false, error: 'CODE_PLAN_SAVE_FAILED', output: '原计划未改变，请重试' } })
    rememberControl(id, 'todo_create', 'code-legacy-ok', true)
    rememberControl(id, 'plan_update', 'code-plan-failure', false, 'CODE_PLAN_SAVE_FAILED')
    finish(id)
    // A running process is auto-expanded and closes on its terminal frame.
    // Inspect completed activity after that frame, rather than mistaking the
    // transient auto-open state for a persisted user expansion.
    await expect(code().locator('.process__summary')).toContainText(/^过程 ·/)
    await expand(code().locator('.process__summary'))
    await expect(code().locator('.process__summary')).toContainText('工具调用 1')
    await expect(code().locator('.compact-tool-row')).toHaveCount(1)
    await expect(code().locator('.compact-tool-row')).toContainText('更新任务计划')
    await expand(code().locator('.compact-tool-row button.logline'))
    await expect(code()).toContainText('CODE_PLAN_SAVE_FAILED')
    await page.reload()
    await expect(code().getByRole('button', { name: '任务 1/1', exact: true })).toBeVisible()
    await expect(code().locator('.process__summary')).toContainText('工具调用 1')
    await expand(code().locator('.process__summary'))
    await expect(code().locator('.compact-tool-row')).toHaveCount(1)
    await expect(code().locator('.compact-tool-row[data-tool-id="code-legacy-ok"]')).toHaveCount(0)
  })

  test('Work 计划不计入操作和当前工具，成功legacy静默而失败保留，并可历史回放', async ({}, info) => {
    workSession = await startWork('WORK_SILENT_PLAN')
    const todos: EngineTodo[] = [{ id: 'check', title: 'WORK_PLAN_STEP', status: 'in_progress', priority: 'medium' }]
    frame(workSession, { todo: { todos } }); frame(workSession, { content: 'WORK_PLAN_RUNNING' })
    frame(workSession, { toolStart: { id: 'work-legacy-ok', name: 'todo_create', args: { title: 'WORK_PLAN_STEP' } } })
    await expect(work().locator('.work-turn-feedback')).not.toContainText('创建待办')
    frame(workSession, { toolEnd: { id: 'work-legacy-ok', name: 'todo_create', success: true, output: 'created' } })
    await expect(work().locator('.work-inline-activity')).toHaveCount(0)
    await work().getByRole('button', { name: '打开工作区', exact: true }).click()
    await work().getByRole('tab', { name: '活动', exact: true }).click()
    await expect(work().locator('.work-activities__header')).toContainText('0 个工具调用')
    await work().locator('.work-steps summary').click()
    await expect(work().locator('.work-steps')).toContainText('WORK_PLAN_STEP')
    await expect(work().locator('.work-steps')).toContainText('进行中')
    frame(workSession, { todo: { todos: [{ ...todos[0], status: 'done' }] } })
    await expect(work().locator('.work-steps summary')).toContainText('1 / 1')
    frame(workSession, { toolEnd: { id: 'work-plan-failure', name: 'plan_update', args: { plan: [{ step: 'WORK_PLAN_STEP', status: 'in_progress' }] }, success: false, error: 'WORK_PLAN_SAVE_FAILED', output: '保留已保存计划' } })
    rememberControl(workSession, 'todo_create', 'work-legacy-ok', true)
    rememberControl(workSession, 'plan_update', 'work-plan-failure', false, 'WORK_PLAN_SAVE_FAILED')
    finish(workSession)
    await expect(work().locator('.work-inline-activity')).toHaveAttribute('data-tool-count', '1')
    await expect(work().locator('.work-activities__header')).toContainText('1 个工具调用')
    await expect(work().locator('.work-activity-detail')).toContainText('WORK_PLAN_SAVE_FAILED')
    await page.reload()
    await expect(work().locator('.work-inline-activity')).toHaveAttribute('data-tool-count', '1')
    await expect(work().locator('.work-steps summary')).toContainText('1 / 1')
    await expect(work().locator('.work-activities__header')).toContainText('1 个工具调用')
    await page.screenshot({ path: info.outputPath('work-silent-plan.png'), animations: 'disabled' })
  })

  test('自动化任务回放仍用独立计划；子代理调用次数、当前操作和失败遵循同一规则', async () => {
    // Simulate a persisted scheduler turn in the automation's associated session.
    const state = session(workSession), parent = state.run!
    state.todos = [{ id: 'automatic-step', title: 'AUTOMATION_PLAN_STEP', status: 'in_progress', priority: 'medium' }]
    state.history.push({ id: 'automation-user', role: 'user', content: 'AUTOMATION_CHECK', conversationId: 'automation-turn' },
      { id: 'automation-plan-call', role: 'assistant', conversationId: 'automation-turn', toolCall: { id: 'automation-plan', name: 'plan_update', args: { plan: [{ step: 'AUTOMATION_PLAN_STEP', status: 'in_progress' }] } } },
      { id: 'automation-plan-result', role: 'tool', toolCallId: 'automation-plan', success: true, content: 'ok' },
      { id: 'automation-result', role: 'assistant', conversationId: 'automation-turn', content: 'AUTOMATION_RESULT' })
    const child: SubagentRun = { schemaVersion: 1, runId: 'plan-child-run', tenantId: 'tenant', rootSessionId: workSession, parentSessionId: workSession, parentToolCallId: 'plan-child-call', parentConversationId: parent.turnId, parentMessageId: parent.assistantMessageId, childSessionId: 'plan-child-session', task: '检查执行结果', description: '计划验证子代理', agentName: '计划验证 Agent', modelId, status: 'running', lastSeq: 1, createdAt: Date.now(), updatedAt: Date.now(), usage: {}, toolCalls: [
      { id: 'child-plan-ok', name: 'plan_update', status: 'succeeded', args: { plan: [{ step: '检查实现', status: 'pending' }] } },
      { id: 'child-read', name: 'read_file', status: 'running', args: { path: 'src/index.ts' } },
      { id: 'child-plan-fail', name: 'plan_update', status: 'failed', error: { code: 'CHILD_PLAN_SAVE_FAILED', message: 'CHILD_PLAN_SAVE_FAILED', retryable: true } },
      { id: 'child-plan-running', name: 'todo_update', status: 'running' }
    ] }
    children.set(child.runId, child)
    const job = fixtureAutomationJob(), now = Date.now()
    automationRun = { id: 'plan-automation-run', tenantId: job.tenantId, jobId: job.id,
      jobRevision: job.revision, scheduleRevision: job.scheduleRevision, scheduledAt: now,
      status: 'succeeded', sessionId: workSession, rootRunId: parent.runId, startedAt: now, finishedAt: now,
      snapshot: { name: job.name, message: job.message, configuration: job.configuration,
        thinkingMode: false, effectiveModelId: modelId } }
    await work().locator('.work-navigation').getByRole('button', { name: '自动化', exact: true }).click()
    const editor = page.getByRole('dialog', { name: '编辑自动化', exact: true })
    if (await editor.count()) {
      await editor.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(editor).toHaveCount(0)
    }
    const jobRow = work().getByRole('region', { name: '自动化管理', exact: true }).locator('[data-job-id="plan-automation"]')
    await expect(jobRow).toContainText('计划状态例行检查')
    await jobRow.getByRole('button', { name: '自动化 计划状态例行检查 更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '运行记录', exact: true }).click()
    await expect(editor.getByRole('tab', { name: '运行记录', exact: true })).toHaveAttribute('aria-selected', 'true')
    const record = editor.getByRole('region', { name: '自动化运行记录', exact: true }).locator('[data-run-id="plan-automation-run"]')
    await expect(record).toContainText(modelId)
    await expect(record).toHaveAttribute('data-status', 'succeeded')
    await expect.poll(() => httpRequests.some(item => item.path === '/api/v1/cron/plan-automation/runs' && item.status === 200)).toBe(true)
    const snapshotReads = httpRequests.filter(item => item.path === '/api/v1/chat/snapshot' && item.sessionId === workSession && item.status === 200).length
    await expect(record.getByRole('button', { name: '打开运行聊天', exact: true })).toBeEnabled()
    await record.getByRole('button', { name: '打开运行聊天', exact: true }).click()
    await expect(editor).toHaveCount(0)
    await expect.poll(() => httpRequests.filter(item => item.path === '/api/v1/chat/snapshot' && item.sessionId === workSession && item.status === 200).length).toBeGreaterThan(snapshotReads)
    await expect(work()).toContainText('AUTOMATION_RESULT')
    await page.reload()
    await expect(work()).toContainText('AUTOMATION_RESULT')
    await work().getByRole('tab', { name: '活动', exact: true }).click()
    await expand(work().locator('.work-steps summary'))
    await expect(work().locator('.work-steps')).toContainText('AUTOMATION_PLAN_STEP')
    await expect(work().locator('.work-steps')).toContainText('进行中')
    await expect(work().locator('.work-activities__header')).toContainText('2 个工具调用')
    await expect(work().locator('.work-inline-activity[data-tool-count="1"]')).toHaveCount(2)
    await work().getByRole('tab', { name: '子代理', exact: true }).click()
    const panel = work().getByRole('region', { name: '协作代理', exact: true })
    await expect(panel).toContainText('正在读取文件')
    await panel.getByRole('button', { name: '查看 计划验证 Agent 子代理详情', exact: true }).click()
    const card = panel.locator('.subagent-card')
    await expect(card.locator('.subagent-card__stats')).toContainText('2 次调用')
    await expect(card.locator('.subagent-card__running', { hasText: '当前：' })).toHaveText('当前：读取文件')
    await card.locator('.subagent-card__tools-header').click()
    await expect(card.locator('.subagent-card__call')).toHaveCount(2)
    await expect(card.locator('.subagent-card__tools-list')).toContainText('更新任务计划')
    await expect(card.locator('.subagent-card__tools-list')).not.toContainText('更新待办')
    await card.locator('.subagent-card__call').filter({ hasText: '更新任务计划' }).getByRole('button').click()
    await expect(card).toContainText('CHILD_PLAN_SAVE_FAILED')
    expect(state.todos[0].status).toBe('in_progress')
    expect(errors).toEqual([])
  })
})
