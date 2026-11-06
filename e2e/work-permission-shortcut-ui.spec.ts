/** Fresh Work permission acceptance: real Electron UI + authenticated HTTP/SSE.
 * Seed durable waiting runs, then verify exact mode-write/approval receipts,
 * failure recovery, repeated clicks, task/mode navigation and ordinary asks.
 * No existing suites, export flows, live models or real user sessions are used. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'work-permission-shortcut-fixture-token', model = 'work-permission-shortcut-fixture-model'
const shortcutLabel = '本会话改为完全访问并放行'
type Session = { id: string; title: string; run: RootRun; mode: string; result?: string }
type Receipt = { kind: 'mode-request' | 'mode-committed' | 'chat'; sessionId: string; body: Record<string, unknown> }
type ModeGate = { promise: Promise<void>; release: () => void }
const sessions = new Map<string, Session>(), receipts: Receipt[] = [], errors: string[] = []
const gates = new Map<string, ModeGate>(), failModeOnce = new Set<string>()
let app: ElectronApplication | undefined, page: Page, health: ElectronHealthMonitor | undefined
let fixture = '', source = '', scenario = 0
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })

function history(session?: Session): EngineHistoryRow[] {
  if (!session) return []
  const run = session.run
  return [
    { id: run.userMessageId, role: 'user', content: `处理 ${session.title}`, conversationId: run.turnId,
      createdAt: run.createdAt, metadata: { rootRunId: run.runId } },
    { id: run.assistantMessageId, role: 'assistant', content: session.result ?? '需要确认后才能继续。',
      conversationId: run.turnId, createdAt: run.createdAt + 1, metadata: { rootRunId: run.runId } }
  ]
}

function snapshot(id: string) {
  const session = sessions.get(id)
  return { schemaVersion: 1, sessionId: id, source: 'persisted', finished: true,
    eventId: session ? `${session.run.runId}:${session.run.seq}` : null, run: session?.run,
    runs: session ? [session.run] : [], history: history(session), projection: [],
    todos: [], changes: [], commandJobs: [], subagentRuns: [] }
}

function holdMode(session: Session): ModeGate {
  let release!: () => void
  const gate = { promise: new Promise<void>(done => { release = done }), release: () => release() }
  gates.set(session.id, gate)
  return gate
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    const method = request.method ?? 'GET'
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token)
      throw new Error(`Unauthenticated request: ${method} ${path}`)
    let raw = ''; for await (const chunk of request) raw += String(chunk)
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    const id = String(body.sessionId ?? url.searchParams.get('sessionId') ?? ''), session = sessions.get(id)

    if (path === '/api/v1/security/mode' && method === 'PUT') {
      receipts.push({ kind: 'mode-request', sessionId: id, body: structuredClone(body) })
      if (!session || body.mode !== 'full-access' || Object.keys(body).sort().join(',') !== 'mode,sessionId')
        throw new Error('Mode write must target the exact seeded session and requested full-access value')
      await gates.get(id)?.promise
      if (failModeOnce.delete(id)) {
        response.writeHead(503, { 'content-type': 'application/json' })
          .end(JSON.stringify({ code: 503, message: 'PERMISSION_MODE_RETRY：权限服务暂时不可用' }))
        return
      }
      session.mode = 'full-access'
      receipts.push({ kind: 'mode-committed', sessionId: id, body: structuredClone(body) })
      response.writeHead(200, { 'content-type': 'application/json' }).end(envelope({ sessionId: id, mode: session.mode }))
      return
    }
    if (path === '/api/v1/chat' && method === 'POST') {
      receipts.push({ kind: 'chat', sessionId: id, body: structuredClone(body) })
      const answer = body.toolResponse as Record<string, unknown> | undefined
      const pending = session?.run.pending[0]
      if (!session || session.run.status !== 'waiting' || !pending || pending.status !== 'pending' || !answer ||
        body.runId !== session.run.runId || answer.runId !== session.run.runId ||
        answer.requestId !== pending.requestId || answer.toolCallId !== pending.toolCallId || answer.name !== pending.toolName ||
        request.headers['x-aether-tool-profile'] !== 'general') throw new Error('Approval crossed or lost its session/run/request/tool identity')
      if (pending.kind === 'permission' && !['approved', 'rejected'].includes(String(answer.output)))
        throw new Error('Permission output must use the engine approved/rejected protocol')
      session.result = `已处理：${String(answer.output)}`
      session.run = { ...session.run, status: 'succeeded', version: session.run.version + 1, seq: session.run.seq + 1,
        updatedAt: Date.now(), finishedAt: Date.now(), pending: [{ ...pending, status: 'answered', output: String(answer.output) }] }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.end(`id: ${session.run.runId}:${session.run.seq}\ndata: ${JSON.stringify({ run: session.run })}\n\ndata: [DONE]\n\n`)
      return
    }
    if (path === '/api/v1/chat/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n')
      return
    }
    response.setHeader('content-type', 'application/json')
    if (path === '/api/v1/chat/admission/context') {
      response.end(envelope({ protocolVersion: 1, tenantId: 'permission-fixture', sessionId: id,
        namespace: { id: 'permission-fixture-db', generation: 'one' },
        transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'general' ? 'general' : 'code',
          runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }))
      return
    }
    if (path === '/api/v1/subagent/capabilities') {
      response.end(envelope({ schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'],
        toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true })); return
    }
    if (path === '/api/v1/collaboration/capabilities') {
      // This fixture supports permission replies, not controller messages. An
      // explicit unavailable capability is valid; [] becomes a visible error.
      response.end(envelope({ protocolVersion: 1, durableQueueReceipts: false, receiptPagination: false,
        runtimeCommunication: false, mailboxConsumer: false, userControllerMutation: false,
        rootUserControllerMutation: false })); return
    }
    if (path === '/api/v1/subagent/runs') {
      response.end(envelope({ schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'permission-fixture' })); return
    }
    if (path === '/api/v1/cron/capabilities') { response.writeHead(404).end(); return }
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: 'sha256:' + 'c'.repeat(64), protocolVersion: 1,
        toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'work-permission-shortcut' }
      : path === '/api/v1/models' ? [{ id: model, modelId: model, displayName: '权限确认测试模型', provider: 'openai',
        isEnabled: true, capabilities: { toolCalling: true } }]
      : path === '/api/v1/chat/snapshot' ? snapshot(id)
      : path === '/api/v1/chat/status' ? { running: false, finished: true, run: session?.run,
        lastEventId: session ? `${session.run.runId}:${session.run.seq}` : null }
      : path === '/api/v1/chat/runs' ? { runs: session ? [session.run] : [] }
      : path === '/api/v1/conversation/history' ? history(session)
      : path === '/api/v1/conversation/sessions' ? [...sessions.values()].map(value => ({ sessionId: value.id,
        title: value.title, lastAt: value.run.updatedAt, messageCount: 2 }))
      : path === '/api/v1/security/mode' ? { sessionId: id, mode: session?.mode ?? 'standard' }
      : path === '/api/v1/memory/settings' ? { sessionId: id, memoryScope: 'session', effectiveScope: 'session',
        enabled: true, globalEnabled: false, sessionDefaultEnabled: true, sessionOverride: null, sessionEnabled: true }
      : path === '/api/v1/workspace/directory' ? { root: '/remote/permission-fixture', entries: [] }
      : path === '/api/v1/command-jobs' ? { jobs: [] }
      : []
    response.end(envelope(data))
  })().catch(error => {
    errors.push(String(error))
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ code: 500, message: String(error) }))
  })
})

function createSession(kind: 'permission' | 'ask' = 'permission'): Session {
  const number = ++scenario, id = `work-permission-shortcut-${number}`, now = Date.now() - 1000
  const pending = { requestId: `request-${id}`, toolCallId: `tool-${id}`, kind, status: 'pending' as const,
    toolName: kind === 'permission' ? 'execute_cmd' : 'ask_user',
    args: kind === 'permission' ? { command: 'echo permission-fixture' }
      : { question: '报告需要哪种格式？', options: [{ label: '简明结论' }, { label: '详细分析' }], allowInput: false },
    ...(kind === 'permission' ? { description: '该命令需要你的确认，是否允许执行？' } : {}) }
  const value: Session = { id, title: `权限确认任务 ${number}`, mode: 'standard',
    run: { schemaVersion: 1, runId: `run-${id}`, sessionId: id, turnId: `turn-${id}`,
      userMessageId: `user-${id}`, assistantMessageId: `assistant-${id}`, seq: 1, version: 1,
      status: 'waiting', modelId: model, pending: [pending], workspacePaths: [], createdAt: now, updatedAt: now } }
  sessions.set(id, value)
  return value
}

const work = () => page.locator('.work-view')
const card = () => work().locator('.work-pending')
const shortcut = () => card().getByRole('button', { name: shortcutLabel, exact: true })
const chatReceipts = () => receipts.filter(receipt => receipt.kind === 'chat')
const modeRequests = () => receipts.filter(receipt => receipt.kind === 'mode-request')

async function installScenario(kind: 'permission' | 'ask' = 'permission'): Promise<{ current: Session; other: Session }> {
  const current = createSession(kind), other = createSession()
  const tasks = [current, other].map(value => ({ id: value.id, title: value.title, status: 'waiting', draft: '',
    createdAt: value.run.createdAt, updatedAt: value.run.updatedAt, workspacePath: null,
    modelId: model, attachments: [], sources: [] }))
  await page.evaluate(({ key, tasks, activeTaskId }) => {
    localStorage.setItem(key, JSON.stringify({ tasks, activeTaskId }))
    localStorage.setItem('aether.app.mode', 'work')
  }, { key: 'aether.work.state.v1:' + encodeURIComponent(source), tasks, activeTaskId: current.id })
  await page.reload()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await expect(work().getByRole('heading', { name: current.title, exact: true })).toBeVisible()
  await expect(card()).toBeVisible()
  await expect(work().getByRole('button', { name: '切换本会话访问权限：标准模式', exact: true })).toBeEnabled()
  // Wait for the capability probe to settle before the no-error check. Visible
  // application errors do not necessarily throw pageerror or console.error.
  await expect(work().locator('.input-composer__followup').getByRole('status')).toHaveText('当前引擎未启用立即补充，可选择排到下一轮。')
  await expect(work().locator('[role="alert"]:visible')).toHaveCount(0)
  if (kind === 'permission') await expect(shortcut()).toBeEnabled()
  return { current, other }
}

async function selectTask(session: Session): Promise<void> {
  await work().locator('.work-sidebar__task').filter({ hasText: session.title }).click()
  await expect(work().getByRole('heading', { name: session.title, exact: true })).toBeVisible()
  await expect(card()).toBeVisible()
}

async function waitForModeCommit(session: Session): Promise<void> {
  // The browser's persisted receipt is written after the real IPC response,
  // so this waits beyond the server write without an arbitrary sleep.
  const key = `aether:security-mode:${encodeURIComponent(source)}:${encodeURIComponent(session.id)}`
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), key)).toBe('full-access')
}

function expectedApproval(session: Session, output: string): Receipt {
  const pending = session.run.pending[0]
  return { kind: 'chat', sessionId: session.id, body: { sessionId: session.id, runId: session.run.runId,
    toolResponse: { requestId: pending.requestId, runId: session.run.runId,
      toolCallId: pending.toolCallId, name: pending.toolName, output } } }
}

test.describe('Work 权限确认快捷入口（新专项）', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`; source = engineStorageKey({ mode: 'remote', baseUrl: origin })
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'work-permission-shortcut-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin,
      autoStartEngine: true, lastModelId: model, appearance: 'dark', lastFolder: '', lastSessionId: '' }))
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`],
      cwd: root, env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    health = await monitorElectronHealth(app, 'work-permission-shortcut', [token])
    page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  })
  test.beforeEach(() => { receipts.length = 0; errors.length = 0; failModeOnce.clear() })
  test.afterEach(async ({}, info) => {
    for (const gate of gates.values()) gate.release()
    gates.clear()
    await info.attach('permission-http-receipts', { body: JSON.stringify(receipts, null, 2), contentType: 'application/json' })
    health?.assertHealthy()
    expect(errors, 'Fixture protocol violations or real renderer errors').toEqual([])
    await expect(work().locator('[role="alert"]:visible'), 'No visible application error may remain after the scenario').toHaveCount(0)
    await expect(work().getByText(/协作能力响应无效|Admission response is not an object/)).toHaveCount(0)
  })
  test.afterAll(async ({}, info) => {
    try { if (health) await health.closeAndAssert(info); else await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('work-permission-shortcut-'))
          throw new Error(`Unsafe fixture cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('完全访问先写入当前会话，再准确放行当前审批，并同步输入框权限', async ({}, info) => {
    const { current, other } = await installScenario()
    await expect(card().getByRole('radio')).toHaveCount(0)
    await expect(card().getByRole('button', { name: '提交回复', exact: true })).toHaveCount(0)
    const screenshot = info.outputPath('work-permission-card.png')
    await page.screenshot({ path: screenshot })
    await info.attach('Work 权限确认卡', { path: screenshot, contentType: 'image/png' })
    expect(await card().evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Permission actions must stay inside the card').toBe(true)
    await shortcut().click()
    await expect.poll(() => chatReceipts().length).toBe(1)
    expect(receipts).toEqual([
      { kind: 'mode-request', sessionId: current.id, body: { sessionId: current.id, mode: 'full-access' } },
      { kind: 'mode-committed', sessionId: current.id, body: { sessionId: current.id, mode: 'full-access' } },
      expectedApproval(current, 'approved')
    ])
    await expect(card()).toHaveCount(0)
    await expect(work().getByRole('button', { name: '切换本会话访问权限：完全访问', exact: true })).toBeEnabled()
    expect(other.mode).toBe('standard')
    expect(other.run.pending[0].status).toBe('pending')
  })

  test('等待切换时全部审批按钮禁用，连续双击仅写一次模式和一次应答', async () => {
    const { current } = await installScenario(), gate = holdMode(current)
    const bounds = await shortcut().boundingBox(); if (!bounds) throw new Error('Shortcut has no clickable bounds')
    // Native double click keeps the second event at the original position even
    // after the first click changes the label and disables the button.
    await page.mouse.dblclick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { delay: 20 })
    await expect.poll(() => modeRequests().length).toBe(1)
    await expect(card()).toHaveAttribute('aria-busy', 'true')
    await expect(card().getByRole('button', { name: '允许执行', exact: true })).toBeDisabled()
    await expect(card().getByRole('button', { name: '拒绝', exact: true })).toBeDisabled()
    await expect(card().getByRole('button', { name: '切换并放行中…', exact: true })).toBeDisabled()
    expect(chatReceipts()).toEqual([])
    gate.release()
    await expect.poll(() => chatReceipts().length).toBe(1)
    await expect(card()).toHaveCount(0)
    expect(modeRequests()).toHaveLength(1)
    expect(chatReceipts()).toEqual([expectedApproval(current, 'approved')])
  })

  test('权限切换失败保留审批且不放行，原入口可重试成功', async () => {
    const { current } = await installScenario()
    failModeOnce.add(current.id)
    await shortcut().click()
    await expect(card().getByRole('alert')).toContainText('PERMISSION_MODE_RETRY')
    await expect(card().getByRole('alert')).toContainText('尚未提交放行')
    await expect(shortcut()).toBeEnabled()
    await expect(card().getByRole('button', { name: '允许执行', exact: true })).toBeEnabled()
    expect(current.mode).toBe('standard')
    expect(current.run.pending[0].status).toBe('pending')
    expect(chatReceipts()).toEqual([])
    await shortcut().click()
    await expect.poll(() => chatReceipts().length).toBe(1)
    await expect(card()).toHaveCount(0)
    expect(modeRequests()).toHaveLength(2)
    expect(chatReceipts()).toEqual([expectedApproval(current, 'approved')])
  })

  test('切到另一任务后才完成权限请求，不串改权限或批准任一旧审批', async () => {
    const { current, other } = await installScenario(), gate = holdMode(current)
    await shortcut().click()
    await expect.poll(() => modeRequests().length).toBe(1)
    await selectTask(other)
    await expect(work().getByRole('button', { name: '切换本会话访问权限：标准模式', exact: true })).toBeEnabled()
    gate.release()
    await waitForModeCommit(current)
    expect(chatReceipts()).toEqual([])
    expect(other.mode).toBe('standard')
    expect(other.run.pending[0].status).toBe('pending')
    await expect(shortcut()).toBeEnabled()
    await selectTask(current)
    await expect(card().getByRole('button', { name: '拒绝', exact: true })).toBeEnabled()
    await card().getByRole('button', { name: '拒绝', exact: true }).click()
    await expect.poll(() => chatReceipts().length).toBe(1)
    expect(chatReceipts()).toEqual([expectedApproval(current, 'rejected')])
    expect(modeRequests()).toEqual([{ kind: 'mode-request', sessionId: current.id,
      body: { sessionId: current.id, mode: 'full-access' } }])
  })

  test('挂起权限切换期间往返 Code 和 Work，晚返回不得恢复旧批准操作', async () => {
    const { current } = await installScenario(), gate = holdMode(current)
    await shortcut().click()
    await expect.poll(() => modeRequests().length).toBe(1)
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    await expect(page.locator('.mode-surface[data-mode="work"]')).toBeHidden()
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await expect(page.locator('.mode-surface[data-mode="work"]')).toBeVisible()
    gate.release()
    await waitForModeCommit(current)
    expect(chatReceipts()).toEqual([])
    await expect(card().getByRole('button', { name: '拒绝', exact: true })).toBeEnabled()
    await card().getByRole('button', { name: '拒绝', exact: true }).click()
    await expect.poll(() => chatReceipts().length).toBe(1)
    expect(chatReceipts()).toEqual([expectedApproval(current, 'rejected')])
  })

  for (const [label, output] of [['允许执行', 'approved'], ['拒绝', 'rejected']] as const) {
    test(`普通“${label}”只回复当前审批，不修改会话权限`, async () => {
      const { current } = await installScenario()
      await card().getByRole('button', { name: label, exact: true }).click()
      await expect.poll(() => chatReceipts().length).toBe(1)
      await expect(card()).toHaveCount(0)
      expect(receipts).toEqual([expectedApproval(current, output)])
      expect(current.mode).toBe('standard')
    })
  }

  test('普通问答保留选择与提交，不出现完全访问入口，回答准确送达', async () => {
    const { current } = await installScenario('ask')
    await expect(shortcut()).toHaveCount(0)
    await expect(card().getByRole('button', { name: '允许执行', exact: true })).toHaveCount(0)
    await expect(card().getByRole('button', { name: '提交回复', exact: true })).toBeDisabled()
    await card().getByRole('radio', { name: '简明结论', exact: true }).check()
    await card().getByRole('button', { name: '提交回复', exact: true }).click()
    await expect.poll(() => chatReceipts().length).toBe(1)
    await expect(card()).toHaveCount(0)
    expect(receipts).toEqual([expectedApproval(current, '简明结论')])
    expect(current.mode).toBe('standard')
  })
})
