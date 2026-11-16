/** Real isolated Electron continuation UI; synthetic server, no model or production data. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { canonicalAdmissionJson } from '../src/main/next-turn-admission-protocol'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp'), token = 'isolated-continuation-token', modelId = 'continue-model'
const namespace = { id: 'continue-db', generation: 'one' }, workspaceRoot = '/remote/continue-fixture'
const errors: string[] = [], posts: Record<string, unknown>[] = [], history: EngineHistoryRow[] = [], projection: ChatSsePayload[] = []
const receipts = new Map<string, { receipt: Record<string, unknown>; run: RootRun }>()
let current: RootRun | undefined, activeStream: ServerResponse | undefined, sequence = 0, attempt = 1, loseReceipt = true
let app: ElectronApplication | undefined, page: Page, fixture = ''
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const envelope = (data: unknown) => JSON.stringify({ code: 200, message: 'ok', data })
const streamId = () => `continuation-attempt-${attempt}`
function publish(payload: ChatSsePayload): void {
  sequence++
  if (payload.run) {
    const index = projection.findIndex(item => item.run)
    if (index >= 0) projection[index] = payload; else projection.push(payload)
  } else projection.push(payload)
  if (activeStream && !activeStream.writableEnded) activeStream.write(`id: ${streamId()}:${sequence}\ndata: ${JSON.stringify(payload)}\n\n`)
}
function setRun(patch: Partial<RootRun>): RootRun {
  if (!current) throw new Error('Missing run')
  current = { ...current, ...patch, version: current.version + 1, updatedAt: Date.now() }
  const accepted = [...receipts.values()].find(item => item.run.attemptId === current!.attemptId)
  if (accepted) accepted.run = current
  return current
}
function addText(text: string): void {
  const row = history.find(item => item.id === current?.assistantMessageId)
  if (!row) throw new Error('Missing assistant row')
  row.content = String(row.content) + text
  publish({ content: text })
}
function startSegment(): void {
  if (!current) throw new Error('Missing run')
  history.push({ id: current.assistantMessageId, role: 'assistant', content: '', createdAt: Date.now(), conversationId: current.turnId,
    metadata: { rootRunId: current.runId, turnId: current.turnId, attemptId: current.attemptId, assistantSegmentId: current.assistantMessageId } })
  publish({ assistantSegment: { runId: current.runId, turnId: current.turnId, attemptId: current.attemptId!, messageId: current.assistantMessageId, createdAt: Date.now() } })
}
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, sessionId = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  let raw = ''; for await (const part of request) raw += part.toString()
  const value: unknown = raw ? JSON.parse(raw) : {}, input = record(value) ? value : {}
  if (path === '/api/v1/chat/admission/context') {
    const matching = current?.sessionId === sessionId ? current : null
    response.end(envelope({ protocolVersion: 1, tenantId: 'continue-tenant', sessionId, namespace, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: matching,
      predecessor: matching ? { runId: matching.runId, attemptId: matching.attemptId, version: matching.version } : null })); return
  }
  if (path === '/api/v1/chat/continuation/receipt') {
    const accepted = receipts.get(String(input.requestKey))
    if (loseReceipt && accepted) { loseReceipt = false; response.writeHead(503).end(JSON.stringify({ code: 503, message: 'isolated lost receipt' })); return }
    response.end(envelope(accepted ? { protocolVersion: 1, status: 'accepted', ...accepted }
      : { protocolVersion: 1, status: 'absent', namespace, sessionId: input.sessionId, requestKey: input.requestKey })); return
  }
  if (path === '/api/v1/chat' && request.method === 'POST') {
    posts.push(input)
    if (record(input.continuation)) {
      if (!current) throw new Error('Missing continued root')
      const { requestKey, bodyDigest, ...selector } = input.continuation
      if (Object.keys(input).some(key => !['sessionId', 'continuation'].includes(key))) throw new Error('Continuation replayed user content/settings')
      const digest = createHash('sha256').update(canonicalAdmissionJson({ selector, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, body: { sessionId: current.sessionId } })).digest('hex')
      if (digest !== bodyDigest || canonicalAdmissionJson(selector.predecessor) !== canonicalAdmissionJson({ runId: current.runId, attemptId: current.attemptId, version: current.version })) throw new Error('Incorrect continuation digest/predecessor')
      const previousAttemptId = current.attemptId!, previous = current
      activeStream?.end('data: [DONE]\n\n'); activeStream = undefined; attempt++; sequence = 0
      const now = Date.now(), nextId = `continue-assistant-${attempt}`
      const receipt = { ...input.continuation, sessionId: current.sessionId, rootRunId: current.runId, turnId: current.turnId, userMessageId: current.userMessageId,
        assistantMessageId: nextId, assistantIdentityKind: 'continuation-segment' as const, assistantAnchorId: 'continue-assistant-1',
        attemptId: `attempt-${attempt}`, previousAttemptId, rootVersion: current.version + 1, rootSequence: current.seq, acceptedAt: now }
      current = { ...previous, assistantMessageId: nextId, attemptId: `attempt-${attempt}`, version: current.version + 1, status: 'running', error: undefined,
        stopReason: undefined, startedAt: now, finishedAt: undefined, updatedAt: now, continuationReceipt: receipt as RootRun['continuationReceipt'] }
      receipts.set(String(requestKey), { receipt, run: current }); startSegment(); publish({ run: current })
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${JSON.stringify({ run: current })}\n\ndata: [DONE]\n\n`); return
    }
    const now = Date.now()
    current = { schemaVersion: 1, runId: 'continue-root', attemptId: 'attempt-1', sessionId: String(input.sessionId), turnId: 'continue-turn', userMessageId: 'continue-user', assistantMessageId: 'continue-assistant-1',
      version: 1, seq: 1, status: 'running', modelId, requestConfig: { thinkingMode: false }, workspacePaths: [workspaceRoot], pending: [], createdAt: now, updatedAt: now, startedAt: now }
    history.push({ id: current.userMessageId, role: 'user', content: String(input.message), createdAt: now, conversationId: current.turnId, metadata: { rootRunId: current.runId, turnId: current.turnId } })
    response.writeHead(200, { 'content-type': 'text/event-stream' }); activeStream = response
    publish({ run: current }); publish({ userMessage: history[0] }); startSegment(); addText('保留的第一段正文。')
    return
  }
  if (path === '/api/v1/chat/cancel' && current) {
    publish({ run: setRun({ status: 'cancelled', finishedAt: Date.now(), stopReason: 'User stopped' }) })
    activeStream?.end('data: [DONE]\n\n'); activeStream = undefined
    response.end(envelope({ sessionId: current.sessionId, runId: current.runId, cancelled: true, settled: true })); return
  }
  if (path === '/api/v1/chat/stream') {
    response.writeHead(200, { 'content-type': 'text/event-stream' }); activeStream = response
    response.write(': attached\n\n'); return
  }
  const matching = current?.sessionId === sessionId ? current : undefined
  if (path === '/api/v1/conversation/display') {
    const rows = matching ? history : [], users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id, conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows,
      loadedTurnIds: users.map(row => row.id), revision: `continue-${current?.version}-${rows.length}`, mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (['/api/v1/cron/capabilities', '/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request'].includes(path)) { response.writeHead(404).end(envelope(null)); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'e'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'continuation-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '继续测试模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: matching ? 'live' : 'persisted', eventId: matching ? `${streamId()}:${sequence}` : null,
      finished: matching?.status !== 'running', projection: matching ? projection : [], history: matching ? history : [], run: matching, runs: matching ? [matching] : [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: matching?.status === 'running', finished: matching?.status !== 'running', run: matching, lastEventId: matching ? `${streamId()}:${sequence}` : null }
    : path === '/api/v1/chat/runs' ? { runs: matching ? [matching] : [] }
    : path === '/api/v1/conversation/history' || path === '/api/v1/conversation/archive' ? matching ? history : []
    : path === '/api/v1/conversation/sessions' ? []
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'safe', sessionId }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId }
    : path === '/api/v1/workspace/directory' ? { root: workspaceRoot, entries: [] }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const conversation = () => page.locator('.work-view').getByRole('region', { name: '协作对话', exact: true })
test.beforeAll(async () => {
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'continuation-profile-'))
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: `http://127.0.0.1:${address.port}`, remoteWorkspaceRoot: workspaceRoot,
    autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: modelId, thinkingMode: 'off', appearance: 'light' }))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900); window.show(); window.focus() })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
})
test.afterEach(async ({}, info) => {
  if (page && !page.isClosed()) { const path = info.outputPath('continuation-window.png'); await page.screenshot({ path }); await info.attach('继续后的真实隔离窗口', { path, contentType: 'image/png' }) }
  mkdirSync(info.outputDir, { recursive: true }); writeFileSync(info.outputPath('continuation-receipts.json'), JSON.stringify({ posts, current, history, receipts: [...receipts.values()], errors }, null, 2))
  expect(errors).toEqual([])
})
test.afterAll(async () => {
  try { await app?.close() } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) { const target = resolve(fixture); if (dirname(target) !== fixtureRoot || !basename(target).startsWith('continuation-profile-')) throw new Error('Unsafe test cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  }
})

test('停止后继续保留同一轮，连续继续、未知回执和刷新不插入用户指令', async ({}, info) => {
  const work = page.locator('.work-view')
  await work.getByRole('button', { name: '新任务', exact: true }).click()
  await work.getByRole('textbox', { name: '任务目标', exact: true }).fill('验证原任务持续执行')
  await work.getByRole('button', { name: '开始任务', exact: true }).click()
  await expect(conversation()).toContainText('保留的第一段正文。')
  await conversation().getByRole('button', { name: '停止任务', exact: true }).click()
  await expect(conversation().getByRole('button', { name: '继续', exact: true })).toBeVisible()
  expect(posts).toHaveLength(1)
  await page.screenshot({ path: info.outputPath('stopped-light.png') })
  await conversation().getByRole('button', { name: '继续', exact: true }).click()
  await expect.poll(() => receipts.size).toBe(1)
  const retry = conversation().getByRole('button', { name: '核对并继续', exact: true })
  if (await retry.isVisible()) await retry.click()
  await expect(conversation().getByRole('button', { name: '停止任务', exact: true })).toBeVisible()
  await expect.poll(() => Boolean(activeStream && !activeStream.writableEnded)).toBe(true)
  addText('继续后的第二段正文。')
  await expect(conversation()).toContainText('继续后的第二段正文。')
  await expect(conversation().locator('.work-conversation-turn')).toHaveCount(1)
  expect(history.filter(row => row.role === 'user')).toHaveLength(1)
  expect(posts).toHaveLength(2)
  await conversation().getByRole('button', { name: '停止任务', exact: true }).click()
  await expect(conversation().getByRole('button', { name: '继续', exact: true })).toBeVisible()
  await conversation().getByRole('button', { name: '继续', exact: true }).click()
  await expect.poll(() => receipts.size).toBe(2)
  await expect(conversation().getByRole('button', { name: '停止任务', exact: true })).toBeVisible()
  await expect.poll(() => Boolean(activeStream && !activeStream.writableEnded)).toBe(true)
  addText('继续后的第三段正文。')
  await expect(conversation()).toContainText('继续后的第三段正文。')
  await conversation().getByRole('button', { name: '停止任务', exact: true }).click()
  await expect(conversation().getByRole('button', { name: '继续', exact: true })).toBeVisible()
  await page.reload()
  await expect(conversation()).toContainText('继续后的第三段正文。')
  await expect(conversation().locator('.work-conversation-turn')).toHaveCount(1)
  await expect(conversation().locator('.message__bubble').filter({ hasText: '验证原任务持续执行' })).toHaveCount(1)
  await expect(conversation()).not.toContainText('继续本会话中尚未完成')
  expect(posts).toHaveLength(3)
  expect(posts.slice(1).every(post => !('message' in post) && !('admission' in post))).toBe(true)
  expect(new Set([...receipts.values()].map(item => item.run.runId))).toEqual(new Set(['continue-root']))
  await page.evaluate(() => { document.documentElement.dataset.appearance = 'dark' })
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 780))
  await page.screenshot({ path: info.outputPath('continued-dark.png') })
})

