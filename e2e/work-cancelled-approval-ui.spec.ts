/** New isolated Work regression: cancellation expires approval UI and queued writes.
 * Uses real Electron clicks, HTTP/SSE and durable root snapshots. The fixture keeps
 * cancelled pending history intact, so hiding old cards cannot depend on erasing it.
 * No production profile, model, command execution, old E2E or export is involved. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'cancelled-approval-token', modelId = 'cancelled-approval-model', workspaceRoot = '/remote/cancel-approval-fixture'
const errors: string[] = [], chats: Record<string, unknown>[] = [], history: EngineHistoryRow[] = []
const roots: RootRun[] = [], projection: ChatSsePayload[] = []
const admissions = new Map<string, { admission: Record<string, unknown>; run: RootRun }>()
const requests: Array<{ method: string; path: string; input: Record<string, unknown>; runId?: string; runStatus?: string }> = []
const cancellations: Array<{ sessionId: string; runId: string }> = []
const securityWrites: Array<{ sessionId: string; mode: string; runId: string; runStatus: string }> = []
const securityModes = new Map<string, string>()
let current: RootRun | undefined, activeStream: ServerResponse | undefined
let app: ElectronApplication | undefined, page: Page, fixture = '', holdNextSecurityWrite = false
let releaseSecurityWrite: (() => void) | undefined
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const attempt = (): string => `attempt-${current?.runId ?? 'none'}-${current?.version ?? 0}`

function updateRun(patch: Partial<RootRun>): RootRun {
  if (!current) throw new Error('Missing fixture root')
  current = { ...current, ...patch, version: current.version + 1, updatedAt: Date.now() }
  roots[roots.findIndex(run => run.runId === current!.runId)] = current
  return current
}
function publish(payload: ChatSsePayload): void {
  if (!current || !activeStream || activeStream.writableEnded) throw new Error('Missing owned SSE stream')
  projection.push(payload)
  activeStream.write(`id: ${current.runId}:${projection.length}\ndata: ${JSON.stringify(payload)}\n\n`)
}
function appendContent(text: string): void {
  if (!current) throw new Error('Missing fixture root')
  const row = history.find(message => message.id === current!.assistantMessageId)
  if (!row || typeof row.content !== 'string') throw new Error('Missing assistant archive')
  row.content += text
  publish({ content: text })
}
function requestPermission(): void {
  if (!current) throw new Error('Missing fixture root')
  const ordinal = current.seq, toolCallId = `cancel-tool-${ordinal}`
  const description = `CANCEL_PERMISSION_${ordinal}：此隔离夹具不会执行任何真实命令。`
  publish({ ask_user: { toolCallId, question: description, options: ['approved', 'rejected'] } })
  publish({ permissionRequest: { requestId: toolCallId, toolName: 'execute_command', args: { command: 'fixture-only' }, description } })
  publish({ run: updateRun({ status: 'waiting', pending: [{ requestId: `cancel-permission-${ordinal}`, toolCallId,
    toolName: 'execute_command', kind: 'permission', args: { command: 'fixture-only' }, description, status: 'pending' }] }) })
  activeStream!.end('data: [DONE]\n\n'); activeStream = undefined
}
function finishRun(): void {
  if (!current || !activeStream) throw new Error('No active fixture root')
  const finalResult = { schemaVersion: 1 as const, sessionId: current.sessionId, turnId: current.turnId, runId: current.runId,
    assistantMessageId: current.assistantMessageId, text: `CANCEL_FINISHED_${current.seq}：本轮已完成。`, publishedAt: Date.now(), items: [] }
  const row = history.find(message => message.id === current!.assistantMessageId)!
  row.content = finalResult.text; row.metadata = { ...row.metadata, finalResult }
  publish({ finalResult }); publish({ run: updateRun({ status: 'succeeded', finishedAt: Date.now() }) })
  activeStream.end('data: [DONE]\n\n'); activeStream = undefined
}

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
  const sessionId = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  let raw = ''; for await (const part of request) raw += part.toString()
  const value: unknown = raw ? JSON.parse(raw) : {}, input = record(value) ? value : {}
  requests.push({ method: request.method ?? 'GET', path, input, runId: current?.runId, runStatus: current?.status })
  if (path === '/api/v1/chat/admission/context') {
    const matching = current?.sessionId === sessionId ? { ...current, attemptId: attempt() } : null
    response.end(envelope({ protocolVersion: 1, tenantId: 'cancel-tenant', sessionId,
      namespace: { id: 'cancel-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general',
        runLifetime: 'durable', subagentProtocol: 2 }, root: matching,
      predecessor: matching ? { runId: matching.runId, attemptId: matching.attemptId, version: matching.version } : null })); return
  }
  if (path === '/api/v1/chat/admission/receipt') {
    const accepted = admissions.get(String(input.requestKey))
    response.end(envelope(accepted ? { protocolVersion: 1, status: 'accepted', receipt: { ...accepted.admission, sessionId: accepted.run.sessionId,
      rootRunId: accepted.run.runId, turnId: accepted.run.turnId, userMessageId: accepted.run.userMessageId, assistantMessageId: accepted.run.assistantMessageId },
      run: accepted.run, projection: { rootVersion: accepted.run.version, rootAttemptId: attempt(),
        user: { messageId: accepted.run.userMessageId, state: 'projected' }, assistant: { anchorMessageId: accepted.run.assistantMessageId, state: 'persisted', messageId: accepted.run.assistantMessageId } } }
      : { protocolVersion: 1, status: 'absent', namespace: input.namespace, sessionId: input.sessionId, requestKey: input.requestKey })); return
  }
  if (path === '/api/v1/chat' && request.method === 'POST') {
    chats.push(input)
    if (activeStream) throw new Error('A second chat was submitted before the previous stream finished')
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    activeStream = response
    if (record(input.toolResponse)) {
      const toolResponse = input.toolResponse
      const pending = current?.pending.find(item => item.requestId === toolResponse.requestId)
      if (!current || current.status !== 'waiting' || input.sessionId !== current.sessionId || input.runId !== current.runId ||
        pending?.status !== 'pending' || toolResponse.output !== 'rejected') throw new Error('Expired or unexpected permission response')
      publish({ run: updateRun({ status: 'running', pending: current.pending.map(item => ({ ...item, status: 'answered', output: 'rejected' })) }) })
      appendContent(`\n\nCANCEL_RESUMED_${current.seq}：只恢复当前运行。`)
      return
    }
    const ordinal = roots.length + 1, now = Date.now(), id = String(input.sessionId)
    if (current && id !== current.sessionId) throw new Error('This regression must retain the same task session')
    current = { schemaVersion: 1, runId: `cancel-run-${ordinal}`, sessionId: id, turnId: `cancel-turn-${ordinal}`,
      userMessageId: `cancel-user-${ordinal}`, assistantMessageId: `cancel-assistant-${ordinal}`, seq: ordinal, version: 1,
      status: 'running', modelId, pending: [], workspacePaths: [workspaceRoot], createdAt: now, updatedAt: now, startedAt: now }
    roots.push(current); projection.length = 0
    const user: EngineHistoryRow = { id: current.userMessageId, role: 'user', content: String(input.message), createdAt: now,
      conversationId: current.turnId, metadata: { rootRunId: current.runId, turnId: current.turnId } }
    const assistant: EngineHistoryRow = { id: current.assistantMessageId, role: 'assistant', content: '', createdAt: now + 1,
      conversationId: current.turnId, metadata: { rootRunId: current.runId, turnId: current.turnId } }
    history.push(user, assistant)
    publish({ run: current }); publish({ userMessage: user }); appendContent(`CANCEL_ACTIVE_${ordinal}：正在执行当前任务。`)
    if (record(input.admission)) admissions.set(String(input.admission.requestKey), { admission: input.admission, run: current })
    return
  }
  if (path === '/api/v1/chat/cancel' && request.method === 'POST') {
    if (!current || input.sessionId !== current.sessionId || input.runId !== current.runId) throw new Error('Cancellation targeted another root')
    cancellations.push({ sessionId: current.sessionId, runId: current.runId })
    // Preserve the still-pending receipt in its terminal run, as the production
    // cancellation did. Only current root status can make it non-actionable.
    const cancelled = updateRun({ status: 'cancelled', finishedAt: Date.now(), stopReason: 'Owned run cancelled' })
    projection.push({ run: cancelled })
    if (activeStream) { activeStream.end('data: [DONE]\n\n'); activeStream = undefined }
    response.end(envelope({ sessionId: cancelled.sessionId, runId: cancelled.runId, cancelled: true, settled: true })); return
  }
  if (path === '/api/v1/security/mode' && request.method === 'PUT') {
    if (!current || input.sessionId !== current.sessionId || typeof input.mode !== 'string') throw new Error('Security write missing current session')
    const mode = input.mode, owner = current.sessionId
    securityWrites.push({ sessionId: owner, mode, runId: current.runId, runStatus: current.status })
    const complete = (): void => { securityModes.set(owner, mode); response.end(envelope({ sessionId: owner, mode })) }
    if (holdNextSecurityWrite) {
      holdNextSecurityWrite = false
      releaseSecurityWrite = () => { releaseSecurityWrite = undefined; complete() }
    } else complete()
    return
  }
  if (path.endsWith('/controller-context') && current) {
    if (current.status !== 'running') { response.writeHead(409).end(JSON.stringify({ code: 409, message: 'Controller root is not running', data: null })); return }
    const recipient = { participantId: 'root', kind: 'root', sessionId: current.sessionId, invocationRunId: current.runId, admittedSeq: 1, admittedAt: current.createdAt }
    response.end(envelope({ outcome: 'ready', scope: { rootRunId: current.runId, rootAttemptId: attempt(), rootSessionId: current.sessionId }, recipient,
      participants: { entries: [recipient], revision: 1, hasMore: false } })); return
  }
  if (path.endsWith('/messages') && request.method === 'POST') throw new Error('No immediate supplement is authorized by this regression')
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  if (path === '/api/v1/conversation/display') {
    const rows = current?.sessionId === sessionId ? history : []
    const users = rows.flatMap((row, index) => row.role === 'user' ? [{ row, index }] : [])
    const limit = Number(url.searchParams.get('limit') ?? '2'), anchor = url.searchParams.get('anchorMessageId')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('Invalid display history limit')
    const start = anchor ? users.findIndex(({ row }) => row.id === anchor) : Math.max(0, users.length - limit)
    if (start < 0) {
      response.end(JSON.stringify({ code: 40400, message: 'Display anchor was not found', data: null })); return
    }
    const loaded = users.slice(start, start + limit)
    // The index is complete, but bodies must follow the requested whole-turn
    // window. Returning every body becomes invalid when the third root starts.
    const messages = loaded.length ? rows.slice(loaded[0].index, users[start + limit]?.index ?? rows.length) : []
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(({ row }) => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages,
      loadedTurnIds: loaded.map(({ row }) => row.id), revision: `cancel-history-${rows.length}`, mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (['/api/v1/cron/capabilities', '/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  const matching = current?.sessionId === sessionId ? current : undefined
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'c'.repeat(64)}`, protocolVersion: 1,
      toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'cancel-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '取消审批测试模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: matching ? 'live' : 'persisted', eventId: matching ? `${matching.runId}:${projection.length}` : null,
      finished: matching?.status !== 'running', projection: matching ? projection : [], history: matching ? history : [], run: matching,
      runs: matching ? roots : [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: matching?.status === 'running', finished: matching?.status !== 'running', run: matching,
      lastEventId: matching ? `${matching.runId}:${projection.length}` : null }
    : path === '/api/v1/chat/runs' ? { runs: matching ? roots : [] }
    : path === '/api/v1/conversation/history' ? matching ? history : []
    : path === '/api/v1/conversation/sessions' ? []
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: true, rootUserControllerMutation: true }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: securityModes.get(sessionId) ?? 'safe', sessionId }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId }
    : path === '/api/v1/workspace/directory' ? { root: workspaceRoot, entries: [] }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const work = (): Locator => page.locator('.work-view')
const conversation = (): Locator => work().getByRole('region', { name: '协作对话', exact: true })
const composer = (): Locator => conversation().getByRole('textbox', { name: '继续对话', exact: true })
const send = (): Locator => conversation().locator('.work-send')
const cards = (): Locator => conversation().locator('.work-pending')
const stop = (): Locator => work().getByRole('button', { name: '停止任务', exact: true }).filter({ hasText: /^停止任务$/ })
const permissions = (): Locator => conversation().getByRole('button', { name: /^切换本会话访问权限：/ })
async function expectCancelledUi(): Promise<void> {
  await expect(cards()).toHaveCount(0)
  await expect(work().getByRole('button', { name: '停止任务', exact: true })).toHaveCount(0)
  await expect(conversation().locator('.input-composer__followup')).not.toContainText('请先处理上方确认')
  await expect(send()).toHaveAttribute('aria-label', '发送')
  await expect(work().locator('.work-history-status')).toHaveCount(0)
  await expect(work()).not.toContainText('完整对话记录格式不正确')
}

test.beforeAll(async () => {
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'cancelled-approval-profile-'))
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: `http://127.0.0.1:${address.port}`,
    remoteWorkspaceRoot: workspaceRoot, autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: modelId, thinkingMode: 'off', appearance: 'light' }))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY',
    'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900); window.show(); window.focus() })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
})
test.afterEach(async ({}, info) => {
  if (page && !page.isClosed()) {
    const path = info.outputPath(info.status === info.expectedStatus ? 'cancelled-approval-final.png' : 'cancelled-approval-failure.png')
    await page.screenshot({ path }); await info.attach('实际 Work 窗口', { path, contentType: 'image/png' })
  }
  const path = info.outputPath('cancelled-approval-receipts.json')
  writeFileSync(path, JSON.stringify({ chats, roots, cancellations, securityWrites, requests, errors }, null, 2))
  await info.attach('实际取消与权限请求记录', { path, contentType: 'application/json' })
  if (page && !page.isClosed()) await expect(work()).not.toContainText('完整对话记录格式不正确')
  expect(errors).toEqual([])
})
test.afterAll(async () => {
  releaseSecurityWrite?.()
  try { await app?.close() }
  finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== fixtureRoot || !basename(target).startsWith('cancelled-approval-profile-')) throw new Error(`Unsafe fixture cleanup: ${target}`)
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

test('取消撤下旧审批并保留草稿，新 root 不继承旧请求，排队的旧权限写入也失效', async ({}, info) => {
  await work().getByRole('button', { name: '新任务', exact: true }).click()
  await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('取消等待审批的隔离验收')
  await work().getByRole('button', { name: '开始任务', exact: true }).click()
  await expect(conversation()).toContainText('CANCEL_ACTIVE_1')
  requestPermission()
  await expect(cards()).toHaveCount(1)
  await expect(cards()).toContainText('CANCEL_PERMISSION_1')
  const draft = '停止后保留这份草稿，作为同一会话的下一轮。'
  await composer().fill(draft)
  await expect(conversation().locator('.input-composer__followup')).toContainText('请先处理上方确认')
  await stop().click()
  await expect.poll(() => current?.status).toBe('cancelled')
  await expectCancelledUi()
  await expect(composer()).toHaveText(draft)
  await expect(send()).toBeEnabled()
  expect(roots[0].pending).toMatchObject([{ requestId: 'cancel-permission-1', status: 'pending' }])
  expect(chats.filter(item => record(item.toolResponse))).toEqual([])
  expect(securityWrites).toEqual([])
  await page.screenshot({ path: info.outputPath('cancelled-draft-retained.png') })

  await composer().press('Enter')
  await expect(conversation()).toContainText('CANCEL_ACTIVE_2')
  await expect(cards()).toHaveCount(0)
  expect(chats.filter(item => !record(item.toolResponse)).map(item => item.message)).toEqual(['取消等待审批的隔离验收', draft])
  expect(roots[1].sessionId).toBe(roots[0].sessionId)
  requestPermission()
  await expect(cards()).toHaveCount(1)
  await expect(cards()).toContainText('CANCEL_PERMISSION_2')
  await expect(cards()).not.toContainText('CANCEL_PERMISSION_1')
  await cards().getByRole('button', { name: '拒绝', exact: true }).click()
  await expect(conversation()).toContainText('CANCEL_RESUMED_2')
  await expect(cards()).toHaveCount(0)
  expect(chats.filter(item => record(item.toolResponse))).toMatchObject([
    { runId: 'cancel-run-2', toolResponse: { requestId: 'cancel-permission-2', output: 'rejected' } },
  ])
  expect(securityWrites).toEqual([])
  finishRun()
  await expect(conversation()).toContainText('CANCEL_FINISHED_2')
  await expect(send()).toHaveAttribute('aria-label', '发送')

  await composer().fill('检查取消与排队权限写入竞争')
  await composer().press('Enter')
  await expect(conversation()).toContainText('CANCEL_ACTIVE_3')
  requestPermission()
  await expect(cards()).toContainText('CANCEL_PERMISSION_3')
  holdNextSecurityWrite = true
  await expect(permissions()).toHaveAttribute('aria-label', '切换本会话访问权限：安全模式')
  await permissions().click()
  await page.getByRole('menuitem', { name: /^标准模式/ }).click()
  await expect.poll(() => securityWrites.length).toBe(1)
  expect(securityWrites[0]).toMatchObject({ mode: 'standard', runId: 'cancel-run-3', runStatus: 'waiting' })
  expect(releaseSecurityWrite).toBeDefined()
  // This click really enters the card handler. Its full-access write queues
  // behind the separately requested standard-mode PUT held by the fixture.
  await cards().getByRole('button', { name: '本会话改为完全访问并放行', exact: true }).click()
  await expect(cards()).toHaveAttribute('aria-busy', 'true')
  await expect(cards()).toContainText('正在切换权限并放行当前操作')
  expect(securityWrites).toHaveLength(1)
  await stop().click()
  await expect.poll(() => current?.status).toBe('cancelled')
  await expectCancelledUi()
  releaseSecurityWrite!()
  // Loading ends only after the queued continuation settles, so this is a
  // readiness signal rather than an arbitrary delay before checking no PUT.
  await expect(permissions()).toBeEnabled()
  expect(securityWrites.map(item => item.mode)).toEqual(['standard'])
  expect(chats.filter(item => record(item.toolResponse))).toMatchObject([
    { runId: 'cancel-run-2', toolResponse: { requestId: 'cancel-permission-2', output: 'rejected' } },
  ])
  expect(cancellations.map(item => item.runId)).toEqual(['cancel-run-1', 'cancel-run-3'])
  expect(roots[2].pending).toMatchObject([{ requestId: 'cancel-permission-3', status: 'pending' }])
  await expect.poll(() => requests.some(item => item.path === '/api/v1/conversation/display' && item.runId === 'cancel-run-3')).toBe(true)
  await expect(work().locator('.work-history-status')).toHaveCount(0)
  await expect(work()).not.toContainText('完整对话记录格式不正确')
  await page.screenshot({ path: info.outputPath('cancelled-queued-permission-blocked.png') })
})
