/** New isolated Electron regression for pending approvals and immediate follow-up.
 * Records actual HTTP/SSE side effects, including current attempt identity.
 * No real model, production profile, old E2E, or document export is involved. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'waiting-followup-token', modelId = 'waiting-followup-model'
const workspaceRoot = '/remote/follow-fixture'
const errors: string[] = [], chats: Record<string, unknown>[] = [], history: EngineHistoryRow[] = []
const roots: RootRun[] = [], projection: ChatSsePayload[] = []
const admissions = new Map<string, { admission: Record<string, unknown>; run: RootRun }>()
const requests: Array<{ method: string; path: string; attempt: string | null; runStatus?: string }> = []
const supplements: Array<{ input: Record<string, unknown>; runId: string; attempt: string | null }> = []
const receipts = new Map<string, Record<string, unknown>>()
let attempt = 'attempt-initial'
let current: RootRun | undefined, activeStream: ServerResponse | undefined
let app: ElectronApplication | undefined, page: Page, fixture = ''
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })

function publish(payload: ChatSsePayload): void {
  if (!current || !activeStream || activeStream.writableEnded) throw new Error('Missing owned SSE stream')
  projection.push(payload)
  activeStream.write(`id: ${current.runId}:${projection.length}\ndata: ${JSON.stringify(payload)}\n\n`)
}
function updateRun(patch: Partial<RootRun>): RootRun {
  if (!current) throw new Error('Missing parent run')
  current = { ...current, ...patch, version: current.version + 1, updatedAt: Date.now() }
  roots[roots.findIndex(run => run.runId === current!.runId)] = current
  return current
}
function appendContent(text: string): void {
  if (!current) throw new Error('Missing parent run')
  const row = history.find(message => message.id === current!.assistantMessageId)
  if (!row || typeof row.content !== 'string') throw new Error('Missing assistant archive')
  row.content += text
  publish({ content: text })
}
function requestPermission(): void {
  const description = 'WAITING_CONFIRM：请先处理本次安全确认，夹具不会执行真实命令。'
  publish({ ask_user: { toolCallId: 'follow-tool', question: description, options: ['approved', 'rejected'] } })
  publish({ permissionRequest: { requestId: 'follow-tool', toolName: 'execute_command', args: { command: 'fixture-only' }, description } })
  publish({ run: updateRun({ status: 'waiting', pending: [{ requestId: 'follow-permission', toolCallId: 'follow-tool',
    toolName: 'execute_command', kind: 'permission', args: { command: 'fixture-only' }, description, status: 'pending' }] }) })
  activeStream!.end('data: [DONE]\n\n'); activeStream = undefined
}

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
  const sessionId = url.searchParams.get('sessionId') ?? ''
  requests.push({ method: request.method ?? 'GET', path, attempt: url.searchParams.get('rootAttemptId'), runStatus: current?.status })
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  let raw = ''; for await (const part of request) raw += part.toString()
  const value: unknown = raw ? JSON.parse(raw) : {}, input = record(value) ? value : {}
  if (path === '/api/v1/chat/admission/context') {
    const matching = current?.sessionId === sessionId ? { ...current, attemptId: attempt } : null
    response.end(envelope({ protocolVersion: 1, tenantId: 'follow-tenant', sessionId,
      namespace: { id: 'follow-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general',
        runLifetime: 'durable', subagentProtocol: 2 }, root: matching,
      predecessor: matching ? { runId: matching.runId, attemptId: matching.attemptId, version: matching.version } : null })); return
  }
  if (path === '/api/v1/chat/admission/receipt') {
    const accepted = admissions.get(String(input.requestKey))
    response.end(envelope(accepted ? { protocolVersion: 1, status: 'accepted', receipt: { ...accepted.admission, sessionId: accepted.run.sessionId,
      rootRunId: accepted.run.runId, turnId: accepted.run.turnId, userMessageId: accepted.run.userMessageId, assistantMessageId: accepted.run.assistantMessageId },
      run: accepted.run, projection: { rootVersion: accepted.run.version, rootAttemptId: attempt,
        user: { messageId: accepted.run.userMessageId, state: 'projected' }, assistant: { anchorMessageId: accepted.run.assistantMessageId, state: 'persisted', messageId: accepted.run.assistantMessageId } } }
      : { protocolVersion: 1, status: 'absent', namespace: input.namespace, sessionId: input.sessionId, requestKey: input.requestKey })); return
  }
  if (path === '/api/v1/chat' && request.method === 'POST') {
    chats.push(input)
    if (activeStream) throw new Error('A second chat was submitted before the current stream finished')
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    activeStream = response
    if (record(input.toolResponse)) {
      if (!current || current.status !== 'waiting' || input.sessionId !== current.sessionId || input.runId !== current.runId ||
        input.toolResponse.requestId !== 'follow-permission' || input.toolResponse.output !== 'rejected') throw new Error('Unexpected permission response')
      attempt = 'attempt-after-approval'
      publish({ run: updateRun({ status: 'running', pending: current.pending.map(item => ({ ...item, status: 'answered', output: 'rejected' })) }) })
      appendContent('\n\nFOLLOW_RESUMED：已拒绝测试操作，继续输出只读核对结果。')
      return
    }
    const ordinal = roots.length + 1, now = Date.now(), id = String(input.sessionId)
    current = { schemaVersion: 1, runId: `follow-run-${ordinal}`, sessionId: id, turnId: `follow-turn-${ordinal}`,
      userMessageId: `follow-user-${ordinal}`, assistantMessageId: `follow-assistant-${ordinal}`, seq: ordinal, version: 1,
      status: 'running', modelId, pending: [], workspacePaths: [workspaceRoot], createdAt: now, updatedAt: now, startedAt: now }
    attempt = `attempt-${ordinal}-initial`
    roots.push(current); projection.length = 0
    const user: EngineHistoryRow = { id: current.userMessageId, role: 'user', content: String(input.message), createdAt: now,
      conversationId: current.turnId, metadata: { rootRunId: current.runId, turnId: current.turnId } }
    const assistant: EngineHistoryRow = { id: current.assistantMessageId, role: 'assistant', content: '', createdAt: now + 1,
      conversationId: current.turnId, metadata: { rootRunId: current.runId, turnId: current.turnId } }
    history.push(user, assistant)
    publish({ run: current }); publish({ userMessage: user })
    appendContent(`FOLLOW_ACTIVE_${ordinal}：正在执行当前任务。`)
    if (record(input.admission)) admissions.set(String(input.admission.requestKey), { admission: input.admission, run: current })
    return
  }
  if (path.endsWith('/controller-context') && current) {
    if (current.status !== 'running') { response.writeHead(409).end(JSON.stringify({ code: 409, message: 'Controller root is not running', data: null })); return }
    const recipient = { participantId: 'root', kind: 'root', sessionId: current.sessionId, invocationRunId: current.runId, admittedSeq: 1, admittedAt: current.createdAt }
    response.end(envelope({ outcome: 'ready', scope: { rootRunId: current.runId, rootAttemptId: attempt, rootSessionId: current.sessionId }, recipient,
      participants: { entries: [recipient], revision: 1, hasMore: false } })); return
  }
  if (path.endsWith('/messages') && request.method === 'POST' && current) {
    supplements.push({ input, runId: current.runId, attempt: url.searchParams.get('rootAttemptId') })
    if (current.status !== 'running' || url.searchParams.get('rootAttemptId') !== attempt) throw new Error('Supplement used an inactive or stale attempt')
    const receipt = { messageId: `supplement-${supplements.length}`, rootRunId: current.runId, rootAttemptId: attempt,
      senderParticipantId: 'user', senderInvocationRunId: current.runId, recipientParticipantId: input.recipientParticipantId,
      requestKey: input.requestKey, payloadHash: createHash('sha256').update(String(input.message)).digest('hex'), payloadBytes: Buffer.byteLength(String(input.message)),
      acceptedSeq: 1, acceptedAt: Date.now(), state: 'queued', delivery: { state: 'integrated', historyMessageId: `integrated-${supplements.length}`, integratedAt: Date.now() } }
    receipts.set(String(input.requestKey), receipt)
    response.end(envelope({ outcome: 'accepted', receipt })); return
  }
  if (path.includes('/controller-receipts/')) {
    const receipt = receipts.get(decodeURIComponent(path.split('/').at(-1)!))
    response.end(envelope({ outcome: 'accepted', receipt })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  if (path === '/api/v1/conversation/display') {
    const rows = current?.sessionId === sessionId ? history : [], users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows,
      loadedTurnIds: users.map(row => row.id), revision: `follow-history-${rows.length}`, mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (['/api/v1/cron/capabilities', '/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  const matching = current?.sessionId === sessionId ? current : undefined
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'e'.repeat(64)}`, protocolVersion: 1,
      toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'follow-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '滚动测试模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
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
    : path === '/api/v1/security/mode' ? { mode: 'safe', sessionId }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId }
    : path === '/api/v1/workspace/directory' ? { root: workspaceRoot, entries: [] }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const work = (): Locator => page.locator('.work-view')
const conversation = (): Locator => work().getByRole('region', { name: '协作对话', exact: true })
const composer = (): Locator => conversation().getByRole('textbox', { name: '继续对话', exact: true })
const send = (): Locator => conversation().locator('.work-send')
function finishRun(): void {
  if (!current || !activeStream) throw new Error('No active fixture run')
  const finalResult = { schemaVersion: 1 as const, sessionId: current.sessionId, turnId: current.turnId, runId: current.runId,
    assistantMessageId: current.assistantMessageId, text: '任务已完成，补充只处理一次。', publishedAt: Date.now(), items: [] }
  const assistant = history.find(row => row.id === current!.assistantMessageId)!
  assistant.content = finalResult.text; assistant.metadata = { ...assistant.metadata, finalResult }
  publish({ finalResult }); publish({ run: updateRun({ status: 'succeeded', finishedAt: Date.now() }) })
  activeStream.end('data: [DONE]\n\n'); activeStream = undefined
}

test.beforeAll(async () => {
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'waiting-followup-profile-'))
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
    const path = info.outputPath(info.status === info.expectedStatus ? 'waiting-followup-final.png' : 'waiting-followup-failure.png')
    await page.screenshot({ path }); await info.attach('实际 Work 窗口', { path, contentType: 'image/png' })
  }
  const path = info.outputPath('waiting-followup-receipts.json')
  writeFileSync(path, JSON.stringify({ chats, roots, supplements, requests, errors }, null, 2))
  await info.attach('实际请求与补充回执', { path, contentType: 'application/json' })
  expect(errors).toEqual([])
})
test.afterAll(async () => {
  try { await app?.close() }
  finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== fixtureRoot || !basename(target).startsWith('waiting-followup-profile-')) throw new Error(`Unsafe fixture cleanup: ${target}`)
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

test('审批等待禁用立即补充，恢复后草稿只发一次且使用新 attempt，下一轮不重发', async ({}, info) => {
  await work().getByRole('button', { name: '新任务', exact: true }).click()
  await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('启动审批等待补充的隔离验收')
  await work().getByRole('button', { name: '开始任务', exact: true }).click()
  await expect(conversation()).toContainText('FOLLOW_ACTIVE_1')
  await expect.poll(() => requests.filter(item => item.path.endsWith('/collaboration/capabilities')).length).toBeGreaterThan(0)
  requestPermission()
  const card = conversation().locator('.work-pending')
  await expect(card).toContainText('WAITING_CONFIRM')
  const draft = '请保留真实截图，只调整排版，不额外重复全量检查。'
  await composer().fill(draft)
  await expect(composer()).toBeEditable()
  await expect(send()).toBeDisabled()
  await expect(conversation().locator('.input-composer__followup')).toContainText('请先处理上方确认')
  const before = requests.length
  await composer().press('Enter')
  await expect(composer()).toHaveText(draft)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  expect(requests.slice(before).filter(item => item.path.endsWith('/controller-context') || item.method === 'POST' && item.path.endsWith('/messages'))).toEqual([])
  expect(supplements).toHaveLength(0)
  await page.screenshot({ path: info.outputPath('waiting-draft-retained.png') })

  const capabilityReads = requests.filter(item => item.path.endsWith('/collaboration/capabilities')).length
  await card.getByRole('button', { name: '拒绝', exact: true }).click()
  await expect(card).toHaveCount(0)
  await expect(conversation()).toContainText('FOLLOW_RESUMED')
  await expect.poll(() => requests.filter(item => item.path.endsWith('/collaboration/capabilities')).length).toBeGreaterThan(capabilityReads)
  await expect(composer()).toHaveText(draft)
  await expect(send()).toBeEnabled()
  expect(supplements).toHaveLength(0)
  await send().click()
  await expect.poll(() => supplements.length).toBe(1)
  expect(supplements[0]).toMatchObject({ input: { message: draft }, runId: 'follow-run-1', attempt: 'attempt-after-approval' })
  await expect(composer()).toHaveText('')
  expect(requests.filter(item => item.runStatus === 'waiting' && (item.path.endsWith('/controller-context') || item.method === 'POST' && item.path.endsWith('/messages')))).toEqual([])

  finishRun()
  await expect(conversation()).toContainText('任务已完成，补充只处理一次。')
  await expect(send()).toHaveAttribute('aria-label', '发送')
  await composer().fill('开启新的独立一轮')
  await composer().press('Enter')
  await expect(conversation()).toContainText('FOLLOW_ACTIVE_2')
  expect(supplements).toHaveLength(1)
  expect(chats.filter(item => !record(item.toolResponse)).map(item => item.message)).toEqual(['启动审批等待补充的隔离验收', '开启新的独立一轮'])
  expect(chats).toHaveLength(3)
  finishRun()
})

