/** Real Electron + authenticated HTTP/IPC fixture for automation v2 UX.
 * Verifies disk-backed mutation effects, draft cancel/failure/conflict, no-project
 * creation, modal menu layers, target/config round trips, owned cancellation,
 * paged records, notifications, saved receipts, project sources, keyboard/IME,
 * duplicate submission and delayed cross-source HTTP effects.
 * The provider and scheduler are controlled; this is not a real scheduler/model soak. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { CronAutomationRun, CronCapabilities, CronConfigurationV2, CronJobV2, CronNotification, CronPreviewRequest } from '../src/shared/automation'
import type { RootRun } from '../src/shared/root-run'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import type { AetherIdeApi } from '../src/preload'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

declare global { interface Window { aether: AetherIdeApi } }

const root = resolve(__dirname, '..'), parent = join(root, '.e2e-tmp'), token = 'automation-v2-fixture-token', modelId = 'automation-v2-model'
const jobs = new Map<string, CronJobV2>(), runs = new Map<string, CronAutomationRun>(), notifications = new Map<string, CronNotification>()
const roots = new Map<string, RootRun>(), histories = new Map<string, EngineHistoryRow[]>(), projections = new Map<string, ChatSsePayload[]>()
const mutations: Array<{ method: string; path: string; body: Record<string, unknown> }> = [], previews: CronPreviewRequest[] = [], chats: Record<string, unknown>[] = [], ownedCancels: string[] = [], errors: string[] = []
const secondaryJobs = new Map<string, CronJobV2>(), secondaryMutations: typeof mutations = []
const workspaceBindings = new Map<string, string>(), workspaceValidations: Array<{ sourceSessionId: string; workspacePath: string }> = []
type FixtureSource = 'primary' | 'secondary'
const holdRules = new Set<string>(), heldResponses = new Map<string, { response: ServerResponse; payload: string }>()
const responseDelivery: Array<{ key: string; transport: 'delivered' | 'cancelled' }> = []
const requestLog: Array<{ source: FixtureSource; method: string; path: string }> = []
const requestKey = (source: FixtureSource, method: string, path: string): string => `${source}:${method}:${path}`
const holdNextResponse = (source: FixtureSource, method: string, path: string): string => {
  const key = requestKey(source, method, path)
  if (holdRules.has(key) || heldResponses.has(key)) throw new Error(`Response already held: ${key}`)
  holdRules.add(key); return key
}
function sendFixture(source: FixtureSource, method: string, path: string, response: ServerResponse, data: unknown): void {
  response.setHeader('content-type', 'application/json')
  const payload = envelope(data), key = requestKey(source, method, path)
  if (holdRules.delete(key)) { heldResponses.set(key, { response, payload }); return }
  response.end(payload)
}
async function releaseResponse(key: string): Promise<void> {
  const held = heldResponses.get(key)
  if (!held) throw new Error(`Expected a real held HTTP response: ${key}`)
  heldResponses.delete(key)
  responseDelivery.push({ key, transport: held.response.destroyed ? 'cancelled' : 'delivered' })
  if (!held.response.destroyed) held.response.end(held.payload)
  await settleFrames()
}
const capabilities: CronCapabilities = { version: 2, executionSupported: true, schedules: ['interval', 'calendar', 'legacy'], targets: ['session', 'standalone', 'workspace'], notificationPolicies: ['all_runs', 'silent'], overlapPolicy: 'skip', missedRunPolicy: 'skip', manualRun: false, authEnabledDispatch: false, runHistory: true, ownedCancellation: true, persistentNotifications: true }
let app: ElectronApplication, page: Page, health: ElectronHealthMonitor, fixture = '', firstJobId = '', failNextSave = false, conflictNextSave = false
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const persist = (): void => { if (fixture) writeFileSync(join(fixture, 'automation-records.json'), JSON.stringify({ jobs: [...jobs.values()], runs: [...runs.values()], notifications: [...notifications.values()] }, null, 2)) }
const disk = (): { jobs: CronJobV2[]; runs: CronAutomationRun[]; notifications: CronNotification[] } => JSON.parse(readFileSync(join(fixture, 'automation-records.json'), 'utf8'))
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, method = request.method ?? 'GET'
    requestLog.push({ source: 'primary', method, path })
    const send = (data: unknown): void => sendFixture('primary', method, path, response, data)
    const fail = (status: number, message: string): void => { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ code: status, message })) }
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) { fail(401, 'fixture authentication required'); return }
    let raw = ''
    for await (const part of request) raw += part.toString()
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    if (path === '/api/v1/subagent/capabilities') { fail(404, 'fixture has v1 child events'); return }
    if (path === '/api/v1/cron/capabilities') { send(capabilities); return }
    if (path === '/api/v1/cron/preview' && method === 'POST') {
      const input = body as unknown as CronPreviewRequest
      previews.push(input)
      const schedule = input.schedule, next = Date.now() + 60000
      const summary = schedule.kind === 'interval' ? `每 ${schedule.everyMinutes} 分钟` : schedule.kind === 'calendar' ? `${schedule.localTime} · ${schedule.timeZone}` : `${schedule.expression} · ${schedule.timeZone}`
      send({ schedule, summary, nextRunAt: next, occurrences: [next, next + 60000, next + 120000] }); return
    }
    if (path === '/api/v1/cron/notifications') {
      const list = [...notifications.values()].sort((a, b) => b.createdAt - a.createdAt), start = Number(url.searchParams.get('cursor') || 0), limit = Math.min(24, Number(url.searchParams.get('limit') || 24))
      send({ items: list.slice(start, start + limit), nextCursor: start + limit < list.length ? String(start + limit) : null, unreadCount: list.filter(item => !item.readAt).length }); return
    }
    const notificationRead = /^\/api\/v1\/cron\/notifications\/([^/]+)\/read$/.exec(path)
    if (notificationRead && method === 'POST') {
      const item = notifications.get(notificationRead[1]); if (!item) { fail(404, 'unknown notification'); return }
      mutations.push({ method, path, body }); const updated = { ...item, readAt: item.readAt || Date.now() }; notifications.set(item.id, updated); persist(); send(updated); return
    }
    const runPath = /^\/api\/v1\/cron\/runs\/([^/]+)(?:\/(cancel))?$/.exec(path)
    if (runPath) {
      const run = runs.get(runPath[1]); if (!run) { fail(404, 'unknown automation run'); return }
      if (runPath[2] && method === 'POST') {
        mutations.push({ method, path, body }); ownedCancels.push(run.id)
        const updated = { ...run, status: 'cancelled' as const, finishedAt: Date.now() }
        runs.set(run.id, updated)
        const current = roots.get(run.sessionId)
        if (current?.runId === run.rootRunId) roots.set(run.sessionId, { ...current, status: 'cancelled', finishedAt: Date.now(), updatedAt: Date.now(), version: current.version + 1 })
        persist(); send(updated)
      } else send(run)
      return
    }
    const runPage = /^\/api\/v1\/cron\/([^/]+)\/runs$/.exec(path)
    if (runPage) {
      const list = [...runs.values()].filter(run => run.jobId === runPage[1]).sort((a, b) => b.scheduledAt - a.scheduledAt), start = Number(url.searchParams.get('cursor') || 0)
      send({ items: list.slice(start, start + 24), nextCursor: start + 24 < list.length ? String(start + 24) : null }); return
    }
    if (path === '/api/v1/cron' && method === 'GET') { send([...jobs.values()]); return }
    const jobPath = /^\/api\/v1\/cron\/([^/]+)(?:\/(enable|disable))?$/.exec(path)
    if (path === '/api/v1/cron' && method === 'POST' || jobPath) {
      if (method === 'GET') { const job = jobs.get(jobPath![1]); if (job) send(job); else fail(404, 'plan no longer exists'); return }
      mutations.push({ method, path, body })
      if (failNextSave && (method === 'POST' && !jobPath || method === 'PUT')) { failNextSave = false; fail(503, 'AUTOMATION_SAVE_FAILED：草稿未保存'); return }
      if (conflictNextSave && method === 'PUT') { conflictNextSave = false; fail(409, 'AUTOMATION_REVISION_CONFLICT：计划已在其他窗口更新'); return }
      if (!jobPath || method === 'PUT') {
        const configuration = body.configuration as CronConfigurationV2
        if (configuration.target.kind === 'workspace') {
          const sourceSessionId = configuration.target.sourceSessionId, workspacePath = workspaceBindings.get(sourceSessionId)
          if (!workspacePath) { fail(422, 'WORKSPACE_SOURCE_NOT_AUTHORIZED'); return }
          workspaceValidations.push({ sourceSessionId, workspacePath })
        }
      }
      if (!jobPath) {
        const id = `plan-${jobs.size + 1}`, now = Date.now(), configuration = body.configuration as CronConfigurationV2
        const job: CronJobV2 = { id, tenantId: 'fixture', name: String(body.name), message: String(body.message), description: String(body.description || ''), agentId: typeof body.agentId === 'string' ? body.agentId : undefined,
          configuration, revision: 1, scheduleRevision: 1, cronExpr: configuration.schedule.kind === 'legacy' ? configuration.schedule.expression : null,
          sessionId: configuration.target.kind === 'session' ? configuration.target.sessionId : null, enabled: body.enabled === true,
          thinkingMode: body.thinkingMode as CronJobV2['thinkingMode'], timeoutSeconds: body.timeoutSeconds as number | null, nextRunAt: body.enabled ? now + 60000 : undefined, createdAt: now, updatedAt: now }
        jobs.set(id, job); persist(); send(job); return
      }
      const previous = jobs.get(jobPath[1]); if (!previous) { fail(404, 'unknown plan'); return }
      if (method === 'DELETE') { jobs.delete(previous.id); persist(); send({ deleted: true }); return }
      if (jobPath[2]) {
        const enabled = jobPath[2] === 'enable', updated = { ...previous, enabled, revision: previous.revision + 1, nextRunAt: enabled ? Date.now() + 60000 : undefined }
        jobs.set(updated.id, updated); persist(); send(updated); return
      }
      if (body.expectedRevision !== previous.revision) { fail(409, 'AUTOMATION_REVISION_CONFLICT'); return }
      const next = { ...previous, ...body, revision: previous.revision + 1, updatedAt: Date.now() } as CronJobV2
      if (JSON.stringify(previous.configuration.schedule) !== JSON.stringify(next.configuration.schedule)) next.scheduleRevision += 1
      next.cronExpr = next.configuration.schedule.kind === 'legacy' ? next.configuration.schedule.expression : null
      next.sessionId = next.configuration.target.kind === 'session' ? next.configuration.target.sessionId : null
      next.nextRunAt = next.enabled ? Date.now() + 60000 : undefined
      jobs.set(next.id, next); persist(); send(next); return
    }
    const sessionId = url.searchParams.get('sessionId') || '', current = roots.get(sessionId)
    if (path === '/api/v1/chat' && method === 'POST') {
      chats.push(body)
      const id = String(body.sessionId), now = Date.now(), rootRun = fixtureRootRun(id, `user-root-${chats.length}`, 'succeeded')
      roots.set(id, rootRun)
      const content = 'AUTOMATION_SOURCE_SESSION：任务与计划已经准备好。'
      const history = [{ id: rootRun.userMessageId, role: 'user', content: String(body.message), createdAt: now }, { id: rootRun.assistantMessageId, role: 'assistant', content, createdAt: now }]
      const receipt = JSON.stringify({ automationReceipt: { kind: 'automation', schemaVersion: 2, jobId: firstJobId, operation: 'created' }, summary: '计划已保存' })
      const toolId = `cron-tool-${chats.length}`, toolArgs = { name: jobs.get(firstJobId)?.name }
      histories.set(id, [history[0], { ...history[1], toolCall: { id: toolId, name: 'cron_create', args: toolArgs }, metadata: { runId: rootRun.runId, turnId: rootRun.turnId } },
        { id: `${toolId}-result`, role: 'tool', content: receipt, toolCallId: toolId, success: true, createdAt: now + 1 }])
      const frames: ChatSsePayload[] = [{ userMessage: history[0] }, { content },
        { toolStart: { id: toolId, name: 'cron_create', args: toolArgs } },
        { toolEnd: { id: toolId, name: 'cron_create', output: receipt, success: true } }, { run: rootRun }]
      projections.set(id, frames)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      frames.forEach((frame, index) => response.write(`id: ${rootRun.runId}:${index + 1}\ndata: ${JSON.stringify(frame)}\n\n`))
      response.end('data: [DONE]\n\n'); return
    }
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'f'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code', 'general'], subagentSchemaVersion: 1, instanceId: 'automation-v2-fixture' }
        : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: 'Automation v2 fixture model', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
          : path === '/api/v1/agents' ? [{ id: 'review-agent', name: '审查 Agent', model: modelId }]
            : /^\/api\/v1\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: 'review-agent', agent: { id: 'review-agent', name: '审查 Agent' } }
              : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', eventId: current ? `${current.runId}:5` : null, finished: !current || !['running', 'waiting'].includes(current.status), projection: projections.get(sessionId) || [], history: histories.get(sessionId) || [], run: current, runs: current ? [current] : [], todos: [], changes: [], commandJobs: [] }
                : path === '/api/v1/conversation/history' ? histories.get(sessionId) || []
                : path === '/api/v1/chat/runs' ? { runs: current ? [current] : [] }
                  : path === '/api/v1/chat/status' ? { running: Boolean(current && ['running', 'waiting'].includes(current.status)), run: current }
                    : path === '/api/v1/security/mode' ? { mode: 'safe', sessionId }
                      : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: true, sessionId }
                        : path === '/api/v1/workspace/directory' ? { root: workspaceBindings.get(sessionId) || '/remote/automation-v2', entries: [] } : []
    send(data)
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})
const secondary = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, method = request.method ?? 'GET'
    requestLog.push({ source: 'secondary', method, path })
    const send = (data: unknown): void => sendFixture('secondary', method, path, response, data)
    const fail = (status: number, message: string): void => { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ code: status, message })) }
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) { fail(401, 'fixture authentication required'); return }
    let raw = ''; for await (const part of request) raw += part.toString()
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    if (path === '/api/v1/subagent/capabilities') { fail(404, 'fixture has v1 child events'); return }
    if (path === '/api/v1/cron/capabilities') { send(capabilities); return }
    if (path === '/api/v1/cron' && method === 'GET') { send([...secondaryJobs.values()]); return }
    if (path === '/api/v1/cron/notifications') { send({ items: [], nextCursor: null, unreadCount: 0 }); return }
    if (path === '/api/v1/cron/preview' && method === 'POST') {
      const schedule = (body as unknown as CronPreviewRequest).schedule, next = Date.now() + 60000
      send({ schedule, summary: 'SECONDARY_SCHEDULE_PREVIEW', nextRunAt: next, occurrences: [next, next + 60000, next + 120000] }); return
    }
    const jobPath = /^\/api\/v1\/cron\/([^/]+)(?:\/(enable|disable))?$/.exec(path)
    if (jobPath) {
      const previous = secondaryJobs.get(jobPath[1]); if (!previous) { fail(404, 'secondary plan missing'); return }
      if (method === 'GET') { send(previous); return }
      secondaryMutations.push({ method, path, body })
      if (method === 'POST' && jobPath[2]) {
        const enabled = jobPath[2] === 'enable', updated = { ...previous, enabled, revision: previous.revision + 1, nextRunAt: enabled ? Date.now() + 60000 : undefined }
        secondaryJobs.set(updated.id, updated); persistSecondary(); send(updated); return
      }
      fail(405, 'This source must not receive the old-source save/delete'); return
    }
    const sessionId = url.searchParams.get('sessionId') || ''
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'b'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code', 'general'], subagentSchemaVersion: 1, instanceId: 'automation-secondary-fixture' }
        : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: 'Secondary fixture model', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
          : path === '/api/v1/agents' ? [{ id: 'review-agent', name: '第二来源审查 Agent', model: modelId }]
            : /^\/api\/v1\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: 'review-agent', agent: { id: 'review-agent', name: '第二来源审查 Agent' } }
              : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', eventId: null, finished: true, projection: [], history: [], runs: [], todos: [], changes: [], commandJobs: [] }
                : path === '/api/v1/chat/runs' ? { runs: [] }
                  : path === '/api/v1/chat/status' ? { running: false }
                    : path === '/api/v1/security/mode' ? { mode: 'safe', sessionId }
                      : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: true, sessionId }
                        : path === '/api/v1/workspace/directory' ? { root: '/remote/automation-secondary', entries: [] } : []
    send(data)
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})
const origin = (instance: Server): string => {
  const address = instance.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  return `http://127.0.0.1:${address.port}`
}
function persistSecondary(): void { writeFileSync(join(fixture, 'secondary-automation-records.json'), JSON.stringify([...secondaryJobs.values()], null, 2)) }
const secondaryDisk = (): CronJobV2[] => JSON.parse(readFileSync(join(fixture, 'secondary-automation-records.json'), 'utf8'))
async function settleFrames(): Promise<void> { await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))) }
async function switchSource(instance: Server): Promise<void> {
  await page.evaluate(async destination => { await window.aether.settings.update({ remoteBaseUrl: destination }); await window.aether.engine.restart() }, origin(instance))
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await openView()
}
async function selectOperation(name: string, operation: string): Promise<void> {
  await view().getByRole('button', { name: `自动化 ${name} 更多操作`, exact: true }).click()
  await page.getByRole('menuitem', { name: operation, exact: true }).click()
}
function fixtureRootRun(sessionId: string, runId: string, status: RootRun['status']): RootRun {
  const now = Date.now()
  return { schemaVersion: 1, sessionId, runId, turnId: `${runId}-turn`, userMessageId: `${runId}-user`, assistantMessageId: `${runId}-assistant`, seq: 5, version: 1, status, modelId,
    pending: status === 'waiting' ? [{ requestId: `${runId}-pending`, kind: 'ask', toolCallId: `${runId}-ask`, toolName: 'ask_user', args: { question: '是否继续合成审查？' }, question: '是否继续合成审查？', status: 'pending' }] : [],
    workspacePaths: [], createdAt: now, updatedAt: now, ...(status === 'succeeded' ? { finishedAt: now } : {}) }
}
const view = () => page.getByRole('region', { name: '自动化管理', exact: true })
const editor = () => page.getByRole('dialog', { name: /^(新建|编辑)自动化$/, exact: true })
async function openView(): Promise<void> {
  const navigation = page.locator('.work-view .work-navigation').getByRole('button', { name: '自动化', exact: true })
  if (!await navigation.isVisible()) await page.getByRole('button', { name: '展开 Work 导航', exact: true }).click()
  await navigation.click(); await expect(view().getByRole('button', { name: '新建自动化', exact: true })).toBeEnabled()
}
async function openEditor(name: string): Promise<void> { await view().getByRole('button', { name: `编辑自动化 ${name}`, exact: true }).click(); await expect(editor()).toBeVisible() }
async function advanced(): Promise<void> { const details = editor().locator('.automation-advanced'); if (!await details.evaluate(element => (element as HTMLDetailsElement).open)) await details.locator('summary').click() }
async function choose(label: string, option: string): Promise<void> {
  await editor().getByRole('button', { name: label, exact: true }).click()
  // A rich option's accessible name also includes its description/model; select its exact visible label.
  await page.getByRole('menu', { name: label, exact: true }).getByRole('menuitem').filter({ has: page.getByText(option, { exact: true }) }).click()
  await expect(page.getByRole('menu', { name: label, exact: true })).toHaveCount(0)
}
async function launch(): Promise<void> {
  const env = { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root, env })
  health = await monitorElectronHealth(app, 'automation-v2', [token]); page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
}

test.describe.serial('Automation v2 real interaction contract', () => {
  test.beforeAll(async () => {
    for (const instance of [server, secondary]) await new Promise<void>((done, reject) => { instance.once('error', reject); instance.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing v2 fixture port')
    mkdirSync(parent, { recursive: true }); fixture = mkdtempSync(join(parent, 'automation-v2-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: `http://127.0.0.1:${address.port}`, autoStartEngine: true, lastSessionId: '', lastModelId: modelId, thinkingMode: 'off', appearance: 'dark', graphicsMode: 'software', lastFolder: '' }))
    persist(); await launch()
  })
  test.afterEach(() => { expect(errors).toEqual([]); health.assertHealthy() })
  // eslint-disable-next-line no-empty-pattern
  test.afterAll(async ({}, testInfo) => {
    try { await health?.closeAndAssert(testInfo) }
    finally {
      for (const held of heldResponses.values()) held.response.destroy()
      heldResponses.clear(); holdRules.clear()
      for (const instance of [server, secondary]) { instance.closeAllConnections(); await new Promise<void>(done => instance.close(() => done())) }
      const target = resolve(fixture)
      if (dirname(target) !== parent || !basename(target).startsWith('automation-v2-')) throw new Error('Unsafe automation fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test('standalone creation needs no existing task; preview and closing drafts never write a plan', async () => {
    await openView()
    await view().getByRole('button', { name: '新建自动化', exact: true }).click()
    await expect(editor().getByRole('button', { name: '自动化聊天方式', exact: true })).toHaveText('每次新建独立聊天')
    await editor().getByLabel('名称', { exact: true }).fill('不应保存的草稿')
    await editor().getByRole('textbox', { name: '每次运行的目标', exact: true }).fill('只预览，不保存')
    await expect.poll(() => previews.length).toBeGreaterThan(0)
    const count = mutations.length
    await page.keyboard.press('Escape'); await expect(editor()).toHaveCount(0)
    expect(mutations).toHaveLength(count); expect(disk().jobs).toEqual([])
    await view().getByRole('button', { name: '新建自动化', exact: true }).click()
    await expect(editor().getByLabel('名称', { exact: true })).toHaveValue('')
    await editor().getByLabel('名称', { exact: true }).fill('每日独立审查')
    await editor().getByRole('textbox', { name: '每次运行的目标', exact: true }).fill('检查合成项目的测试结果，输出简短结论。')
    await editor().getByLabel('执行时间', { exact: true }).fill('09:25')
    await editor().getByLabel('时区', { exact: true }).fill('Asia/Shanghai')
    await advanced(); await choose('自动化思考档位', 'Off · 关闭思考')
    await editor().getByRole('button', { name: '保存自动化', exact: true }).click()
    await expect.poll(() => disk().jobs.length).toBe(1); firstJobId = disk().jobs[0].id
    expect(disk().jobs[0]).toMatchObject({ thinkingMode: false, sessionId: null, cronExpr: null, configuration: { version: 2, target: { kind: 'standalone' }, schedule: { kind: 'calendar', localTime: '09:25', timeZone: 'Asia/Shanghai' }, notificationPolicy: 'all_runs' } })
    const submitted = mutations.at(-1)!.body
    expect(submitted).not.toHaveProperty('sessionId'); expect(submitted).not.toHaveProperty('cronExpr')
    expect(chats).toEqual([])
  })

  test('menu is above the modal at three window sizes and both themes; close discards edits', async ({}, testInfo) => {
    const before = mutations.length
    for (const appearance of ['dark', 'light'] as const) {
      await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await settings.getByRole('tab', { name: '外观', exact: true }).click()
      await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
      await settings.getByRole('button', { name: '关闭', exact: true }).click()
      for (const size of [{ width: 940, height: 640 }, { width: 1100, height: 760 }, { width: 1440, height: 900 }]) {
        await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), size)
        await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(size)
        await openEditor('每日独立审查')
        const repeat = editor().getByRole('button', { name: '自动化重复类型', exact: true })
        await repeat.click()
        const menu = page.getByRole('menu', { name: '自动化重复类型', exact: true })
        await expect(menu).toBeInViewport()
        expect(await menu.evaluate(element => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.left + 16, box.top + 16)) })).toBe(true)
        await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await expect(editor()).toBeVisible(); await expect(repeat).toBeFocused()
        await repeat.press('ArrowDown'); await page.getByRole('menuitem', { name: '每周', exact: true }).click()
        await expect(repeat).toHaveAttribute('aria-expanded', 'false'); await expect(repeat).toBeFocused()
        await editor().getByRole('button', { name: '周三', exact: true }).click()
        await advanced(); await choose('自动化通知策略', '静默 · 只保留运行记录')
        const footer = editor().locator('.modal__footer')
        const box = await footer.boundingBox(); expect(box).not.toBeNull(); expect(box!.y + box!.height).toBeLessThanOrEqual(size.height - 2)
        expect(await editor().evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(2)
        await page.screenshot({ path: testInfo.outputPath(`automation-v2-${appearance}-${size.width}.png`), animations: 'disabled' })
        await editor().getByRole('button', { name: '取消', exact: true }).click()
      }
    }
    expect(mutations).toHaveLength(before); expect(disk().jobs[0].configuration.notificationPolicy).toBe('all_runs')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
  })

  test('save failure and revision conflict retain the draft; pause does not save or stop it', async () => {
    await openEditor('每日独立审查')
    await editor().getByLabel('名称', { exact: true }).fill('尚未提交的新名称')
    failNextSave = true
    await editor().getByRole('button', { name: '保存自动化', exact: true }).click()
    await expect(editor()).toContainText('AUTOMATION_SAVE_FAILED'); await expect(editor().getByLabel('名称', { exact: true })).toHaveValue('尚未提交的新名称')
    expect(disk().jobs[0].name).toBe('每日独立审查')
    await editor().getByRole('button', { name: '暂停未来触发', exact: true }).click()
    await expect.poll(() => disk().jobs[0].enabled).toBe(false)
    expect(disk().jobs[0].name).toBe('每日独立审查'); expect(ownedCancels).toEqual([])
    expect(mutations.at(-1)).toMatchObject({ method: 'POST', path: `/api/v1/cron/${firstJobId}/disable`, body: {} })
    conflictNextSave = true
    await editor().getByRole('button', { name: '保存自动化', exact: true }).click()
    await expect(editor()).toContainText('AUTOMATION_REVISION_CONFLICT')
    await expect(editor().getByLabel('名称', { exact: true })).toHaveValue('尚未提交的新名称')
    await editor().getByRole('button', { name: '取消', exact: true }).click()
    expect(disk().jobs[0].name).toBe('每日独立审查')
  })

  test('interval and silent settings save honestly; app restart recovers the saved plan', async ({}, testInfo) => {
    await openEditor('每日独立审查')
    await choose('自动化重复类型', '按间隔')
    await editor().getByRole('spinbutton', { name: '间隔（分钟）', exact: true }).fill('90')
    await advanced(); await choose('自动化通知策略', '静默 · 只保留运行记录')
    await choose('自动化使用的 Agent', '审查 Agent')
    await editor().getByRole('button', { name: '保存自动化', exact: true }).click()
    await expect.poll(() => disk().jobs[0].configuration.schedule.kind).toBe('interval')
    expect(disk().jobs[0]).toMatchObject({ agentId: 'review-agent', enabled: false, configuration: { schedule: { kind: 'interval', everyMinutes: 90 }, notificationPolicy: 'silent', target: { kind: 'standalone' } } })
    await health.closeAndAssert(testInfo); await launch(); await openView()
    await expect(view()).toContainText('每 90 分钟'); await expect(view()).toContainText('已暂停')
    await openEditor('每日独立审查'); await expect(editor().getByRole('spinbutton', { name: '间隔（分钟）', exact: true })).toHaveValue('90')
    await editor().getByRole('button', { name: '取消', exact: true }).click()
  })

  test('owned run cancellation and paged records keep a separate manual root untouched', async () => {
    const job = jobs.get(firstJobId)!, now = Date.now()
    const manual = fixtureRootRun('manual-session', 'manual-root-unchanged', 'running'); roots.set(manual.sessionId, manual)
    for (let index = 0; index < 30; index++) {
      const id = `automation-record-${index}`, sessionId = `automated-session-${index}`, rootRunId = `automated-root-${index}`, status = index === 0 ? 'waiting' as const : 'succeeded' as const
      const run: CronAutomationRun = { id, tenantId: 'fixture', jobId: job.id, jobRevision: job.revision, scheduleRevision: job.scheduleRevision, scheduledAt: now - index * 60000, status,
        sessionId, rootRunId, snapshot: { name: job.name, message: job.message, configuration: job.configuration, effectiveAgentId: 'review-agent', effectiveAgentName: '审查 Agent', effectiveModelId: modelId } }
      runs.set(id, run); roots.set(sessionId, fixtureRootRun(sessionId, rootRunId, status))
      histories.set(sessionId, [{ id: `${rootRunId}-assistant`, role: 'assistant', content: `AUTOMATION_ARCHIVE_${index}：真实读取对应运行会话。`, createdAt: now }])
    }
    persist(); await openEditor('每日独立审查'); await editor().getByRole('tab', { name: '运行记录', exact: true }).click()
    await expect(editor().locator('.automation-run')).toHaveCount(24)
    const run = editor().locator('.automation-run[data-run-id="automation-record-0"]')
    await expect(run).toContainText(modelId); await expect(run).toContainText('审查 Agent')
    await run.getByRole('button', { name: '停止本次运行', exact: true }).click()
    await expect.poll(() => disk().runs.find(run => run.id === 'automation-record-0')?.status).toBe('cancelled')
    expect(ownedCancels).toEqual(['automation-record-0']); expect(roots.get(manual.sessionId)).toEqual(manual)
    expect(disk().jobs[0].enabled).toBe(false)
    await editor().getByRole('button', { name: '加载更早的记录', exact: true }).click(); await expect(editor().locator('.automation-run')).toHaveCount(30)
    await editor().getByRole('button', { name: '完成', exact: true }).click()
  })

  test('notification read state persists and opens the corresponding new Work session without a chat send', async () => {
    const run = runs.get('automation-record-1')!
    const item: CronNotification = { id: 'notice-1', tenantId: 'fixture', runId: run.id, eventKey: 'terminal', payload: { jobId: run.jobId, jobName: run.snapshot.name, status: run.status, sessionId: run.sessionId, rootRunId: run.rootRunId }, createdAt: Date.now() }
    notifications.set(item.id, item); persist()
    await view().getByRole('button', { name: '刷新自动化', exact: true }).click()
    await expect(view().getByRole('button', { name: /^通知\s*1$/, exact: true })).toBeVisible()
    await view().getByRole('button', { name: /^通知\s*1$/, exact: true }).click()
    const before = chats.length
    await page.getByRole('region', { name: '自动化通知', exact: true }).locator('.automation-notification').click()
    await expect.poll(() => disk().notifications[0].readAt).toBeGreaterThan(0)
    await expect(page.locator('.work-conversation')).toContainText('AUTOMATION_ARCHIVE_1')
    expect(chats).toHaveLength(before)
    await page.reload(); await expect(page.locator('.work-conversation')).toContainText('AUTOMATION_ARCHIVE_1')
    await openView(); await view().getByRole('button', { name: '通知', exact: true }).click()
    await expect(page.locator('.automation-notification')).toHaveAttribute('data-read', 'true')
    await view().getByRole('button', { name: '通知', exact: true }).click()
  })

  test('structured tool receipt opens the unified editor; a reuse target retains the original Agent', async () => {
    await page.locator('.work-view').getByRole('button', { name: '新任务', exact: true }).click()
    await page.getByRole('textbox', { name: '任务目标', exact: true }).fill('AUTOMATION_RECEIPT_SOURCE')
    await page.getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(() => chats.length).toBe(1)
    const sourceSessionId = String(chats[0].sessionId)
    const group = page.locator('.work-inline-activity').first(); await group.locator('.work-process').click()
    await group.locator('button.logline').click()
    await expect(group.locator('.automation-card')).toContainText('每日独立审查')
    await group.locator('.automation-card').getByRole('button', { name: '打开', exact: true }).click()
    await expect(editor()).toBeVisible()
    await choose('自动化聊天方式', '复用已有聊天')
    await choose('自动化复用聊天', 'AUTOMATION_RECEIPT_SOURCE')
    await expect(editor()).toContainText('Agent：审查 Agent')
    await expect(editor().getByRole('button', { name: '自动化使用的 Agent', exact: true })).toHaveCount(0)
    await editor().getByRole('button', { name: '保存自动化', exact: true }).click()
    await expect.poll(() => disk().jobs[0].configuration.target).toEqual({ kind: 'session', sessionId: sourceSessionId })
    expect(mutations.at(-1)!.body).not.toHaveProperty('agentId')
    await openEditor('每日独立审查'); await expect(editor().getByRole('button', { name: '自动化复用聊天', exact: true })).toHaveText('AUTOMATION_RECEIPT_SOURCE')
    await editor().getByRole('button', { name: '取消', exact: true }).click()
  })

  test('a project source opened from a real run saves only its server binding and survives restart', async ({}, testInfo) => {
    const sourceRun = runs.get('automation-record-29')!, workspacePath = '/remote/automation-v2-authorized-project'
    workspaceBindings.set(sourceRun.sessionId, workspacePath)
    const sourceRoot = roots.get(sourceRun.sessionId)!
    roots.set(sourceRun.sessionId, { ...sourceRoot, workspacePaths: [workspacePath] })
    await openEditor('每日独立审查'); await editor().getByRole('tab', { name: '运行记录', exact: true }).click()
    await expect(editor().locator('.automation-run')).toHaveCount(24)
    await editor().getByRole('button', { name: '加载更早的记录', exact: true }).click()
    await editor().locator('.automation-run[data-run-id="automation-record-29"]').getByRole('button', { name: '打开运行聊天', exact: true }).click()
    await expect(page.locator('.work-conversation')).toContainText('AUTOMATION_ARCHIVE_29')
    await openView(); await view().getByRole('button', { name: '新建自动化', exact: true }).click()
    await editor().getByLabel('名称', { exact: true }).fill('项目来源跟随计划')
    await editor().getByRole('textbox', { name: '每次运行的目标', exact: true }).fill('审查源聊天授权的项目，后续运行跟随源聊天绑定。')
    await choose('自动化聊天方式', '每次新建项目聊天')
    await choose('自动化项目来源', '每日独立审查')
    const before = mutations.length
    await editor().getByRole('button', { name: '保存自动化', exact: true }).click()
    await expect(editor()).toHaveCount(0)
    const stored = disk().jobs.find(job => job.name === '项目来源跟随计划')!
    expect(stored.configuration.target).toEqual({ kind: 'workspace', sourceSessionId: sourceRun.sessionId })
    expect(mutations.slice(before)).toHaveLength(1)
    expect(mutations.at(-1)!.body).not.toHaveProperty('sessionId')
    expect(mutations.at(-1)!.body).not.toHaveProperty('workspacePaths')
    expect(mutations.at(-1)!.body.configuration).toMatchObject({ target: { kind: 'workspace', sourceSessionId: sourceRun.sessionId } })
    expect(workspaceValidations.at(-1)).toEqual({ sourceSessionId: sourceRun.sessionId, workspacePath })
    await health.closeAndAssert(testInfo); await launch(); await openView()
    await openEditor('项目来源跟随计划')
    await expect(editor().getByRole('button', { name: '自动化聊天方式', exact: true })).toHaveText('每次新建项目聊天')
    await expect(editor().getByRole('button', { name: '自动化项目来源', exact: true })).toHaveText('每日独立审查')
    expect(disk().jobs.find(job => job.id === stored.id)?.configuration.target).toEqual(stored.configuration.target)
    await editor().getByRole('button', { name: '取消', exact: true }).click()
  })

  test('Tab and Shift+Tab trap the dialog, close portal menus, and restore the opening control', async () => {
    const before = mutations.length, trigger = view().getByRole('button', { name: '新建自动化', exact: true })
    await trigger.click(); await expect(editor().getByLabel('名称', { exact: true })).toBeFocused()
    const save = editor().getByRole('button', { name: '保存自动化', exact: true }), close = editor().getByRole('button', { name: '关闭', exact: true })
    await save.focus(); await page.keyboard.press('Tab'); await expect(close).toBeFocused()
    await page.keyboard.press('Shift+Tab'); await expect(save).toBeFocused()
    const repeat = editor().getByRole('button', { name: '自动化重复类型', exact: true })
    await repeat.focus(); await page.keyboard.press('ArrowDown')
    const menu = page.getByRole('menu', { name: '自动化重复类型', exact: true })
    await expect(menu.getByRole('menuitem', { name: '每天', exact: true })).toBeFocused()
    await page.keyboard.press('Tab'); await expect(menu).toHaveCount(0)
    await expect(editor().getByLabel('执行时间', { exact: true })).toBeFocused()
    await repeat.focus(); await page.keyboard.press('ArrowDown'); await expect(menu).toBeVisible()
    await page.keyboard.press('Shift+Tab'); await expect(menu).toHaveCount(0)
    await expect(editor().getByRole('textbox', { name: '每次运行的目标', exact: true })).toBeFocused()
    await editor().getByRole('button', { name: '取消', exact: true }).click()
    await expect(trigger).toBeFocused(); expect(mutations).toHaveLength(before)
  })

  test('IME commit key events cannot save; a subsequent normal Ctrl+Enter saves exactly once', async () => {
    await view().getByRole('button', { name: '新建自动化', exact: true }).click()
    await editor().getByLabel('名称', { exact: true }).fill('输入法提交保护')
    const message = editor().getByRole('textbox', { name: '每次运行的目标', exact: true })
    await message.fill('保留中文组字过程，只有明确提交快捷键才保存。')
    const before = mutations.length
    await message.evaluate(element => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中文' }))
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true }))
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }))
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, keyCode: 229, bubbles: true, cancelable: true }))
    })
    await settleFrames()
    await expect(editor().getByLabel('名称', { exact: true })).toBeEnabled()
    await expect(editor().getByRole('button', { name: '保存自动化', exact: true })).toBeEnabled()
    expect(mutations).toHaveLength(before); expect(disk().jobs.some(job => job.name === '输入法提交保护')).toBe(false)
    await message.focus(); await page.keyboard.press('Control+Enter'); await expect(editor()).toHaveCount(0)
    expect(mutations.slice(before)).toHaveLength(1)
    expect(disk().jobs.filter(job => job.name === '输入法提交保护')).toHaveLength(1)
  })

  test('two same-frame save clicks create only one disk-backed plan while its response is pending', async () => {
    await view().getByRole('button', { name: '新建自动化', exact: true }).click()
    await editor().getByLabel('名称', { exact: true }).fill('重复点击保护')
    await editor().getByRole('textbox', { name: '每次运行的目标', exact: true }).fill('同一次用户提交只创建一个自动化。')
    const before = mutations.length, key = holdNextResponse('primary', 'POST', '/api/v1/cron')
    // Both DOM click events arrive before React renders the disabled state.
    await editor().getByRole('button', { name: '保存自动化', exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click() })
    await expect.poll(() => heldResponses.has(key)).toBe(true)
    await expect(editor().getByRole('button', { name: '正在保存…', exact: true })).toBeDisabled()
    expect(mutations.slice(before)).toHaveLength(1)
    expect(disk().jobs.filter(job => job.name === '重复点击保护')).toHaveLength(1)
    await releaseResponse(key); await expect(editor()).toHaveCount(0)
    expect(mutations.slice(before)).toHaveLength(1)
  })

  test('delayed old-source list and save responses cannot replace a new list or close its draft', async () => {
    const original = jobs.get(firstJobId)!, secondaryName = '第二来源隔离计划'
    secondaryJobs.set(firstJobId, { ...original, name: secondaryName, message: 'SOURCE_B_MESSAGE', configuration: { ...original.configuration, target: { kind: 'standalone' } }, sessionId: null, revision: 1, enabled: false, nextRunAt: undefined })
    persistSecondary()
    const delayedList = holdNextResponse('primary', 'GET', '/api/v1/cron')
    await view().getByRole('button', { name: '刷新自动化', exact: true }).click()
    await expect.poll(() => heldResponses.has(delayedList)).toBe(true)
    await switchSource(secondary); await openEditor(secondaryName)
    await editor().getByLabel('名称', { exact: true }).fill('第二来源列表迟到期间的草稿')
    await releaseResponse(delayedList)
    await expect(editor().getByLabel('名称', { exact: true })).toHaveValue('第二来源列表迟到期间的草稿')
    await expect(view().locator('.automation-list-row')).toHaveCount(1)
    await expect(view().getByRole('button', { name: `编辑自动化 ${secondaryName}`, exact: true })).toBeVisible()
    await expect(view().getByRole('button', { name: `编辑自动化 ${original.name}`, exact: true })).toHaveCount(0)
    await editor().getByRole('button', { name: '取消', exact: true }).click()
    await switchSource(server); await openEditor(original.name)
    await editor().getByLabel('名称', { exact: true }).fill('第一来源迟到保存')
    const before = mutations.length, delayedSave = holdNextResponse('primary', 'PUT', `/api/v1/cron/${firstJobId}`)
    await editor().getByRole('button', { name: '保存自动化', exact: true }).click()
    await expect.poll(() => heldResponses.has(delayedSave)).toBe(true)
    expect(disk().jobs.find(job => job.id === firstJobId)?.name).toBe('第一来源迟到保存')
    await switchSource(secondary); await view().getByRole('button', { name: '新建自动化', exact: true }).click()
    await editor().getByLabel('名称', { exact: true }).fill('第二来源保存迟到期间的草稿')
    await releaseResponse(delayedSave)
    await expect(editor().getByLabel('名称', { exact: true })).toHaveValue('第二来源保存迟到期间的草稿')
    expect(mutations.slice(before)).toHaveLength(1); expect(secondaryMutations).toEqual([])
    expect(secondaryDisk().map(job => job.name)).toEqual([secondaryName])
    await editor().getByRole('button', { name: '取消', exact: true }).click()
  })

  test('old enable/delete responses cannot release a new-source lock or remove its same-ID plan', async ({}, testInfo) => {
    const primaryName = jobs.get(firstJobId)!.name, secondaryName = secondaryJobs.get(firstJobId)!.name
    await switchSource(server)
    const enablePath = `/api/v1/cron/${firstJobId}/enable`, oldEnable = holdNextResponse('primary', 'POST', enablePath), before = mutations.length
    await selectOperation(primaryName, '恢复计划'); await expect.poll(() => heldResponses.has(oldEnable)).toBe(true)
    await switchSource(secondary)
    const newEnable = holdNextResponse('secondary', 'POST', enablePath)
    await selectOperation(secondaryName, '恢复计划'); await expect.poll(() => heldResponses.has(newEnable)).toBe(true)
    const newMenu = view().getByRole('button', { name: `自动化 ${secondaryName} 更多操作`, exact: true })
    await expect(newMenu).toBeDisabled()
    const refreshedBefore = requestLog.filter(call => call.source === 'secondary' && call.method === 'GET' && call.path === '/api/v1/cron').length
    await view().getByRole('button', { name: '刷新自动化', exact: true }).click()
    await expect.poll(() => requestLog.filter(call => call.source === 'secondary' && call.method === 'GET' && call.path === '/api/v1/cron').length).toBe(refreshedBefore + 1)
    await expect(view().getByRole('button', { name: '刷新自动化', exact: true })).toBeEnabled()
    await expect(newMenu).toBeDisabled(); expect(secondaryMutations).toHaveLength(1)
    await releaseResponse(oldEnable); await expect(newMenu).toBeDisabled()
    expect(mutations.slice(before)).toHaveLength(1); expect(secondaryMutations).toHaveLength(1)
    expect(secondaryMutations[0]).toMatchObject({ method: 'POST', path: enablePath, body: {} })
    await releaseResponse(newEnable); await expect(newMenu).toBeEnabled()
    await expect(view().locator(`.automation-list-row[data-job-id="${firstJobId}"]`)).toContainText('已启用')
    expect(secondaryDisk()[0].enabled).toBe(true)
    await switchSource(server)
    await selectOperation(primaryName, '删除计划')
    const confirmation = page.getByRole('dialog', { name: '删除自动化', exact: true })
    const oldDelete = holdNextResponse('primary', 'DELETE', `/api/v1/cron/${firstJobId}`), secondaryBefore = secondaryMutations.length
    await confirmation.getByRole('button', { name: '删除计划', exact: true }).click()
    await expect.poll(() => heldResponses.has(oldDelete)).toBe(true)
    expect(disk().jobs.some(job => job.id === firstJobId)).toBe(false)
    await switchSource(secondary); await openEditor(secondaryName)
    await editor().getByLabel('名称', { exact: true }).fill('第二来源删除迟到期间的草稿')
    await releaseResponse(oldDelete)
    await expect(editor().getByLabel('名称', { exact: true })).toHaveValue('第二来源删除迟到期间的草稿')
    await expect(newMenu).toBeEnabled()
    expect(secondaryMutations).toHaveLength(secondaryBefore); expect(secondaryDisk()[0].id).toBe(firstJobId)
    expect(requestLog.filter(call => call.source === 'primary' && call.method === 'DELETE' && call.path === `/api/v1/cron/${firstJobId}`)).toHaveLength(1)
    await testInfo.attach('delayed-http-delivery', { body: JSON.stringify(responseDelivery, null, 2), contentType: 'application/json' })
    await editor().getByRole('button', { name: '取消', exact: true }).click()
  })
})
