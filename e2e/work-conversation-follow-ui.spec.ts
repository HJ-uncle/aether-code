/** Real Electron + authenticated HTTP/SSE: Work follows layout changes only
 * while reading the live tail; upward wheel pauses, manual bottom/latest resume.
 * This fixture owns its profile and port. Build first; never run alongside
 * another Electron spec because the app holds a single-instance lock. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'work-conversation-follow-token', modelId = 'work-conversation-follow-model'
const workspaceRoot = '/remote/follow-fixture'
const errors: string[] = [], chats: Record<string, unknown>[] = [], history: EngineHistoryRow[] = []
const roots: RootRun[] = [], projection: ChatSsePayload[] = []
const admissions = new Map<string, { admission: Record<string, unknown>; run: RootRun }>()
const geometry: Array<Record<string, unknown>> = []
let current: RootRun | undefined, activeStream: ServerResponse | undefined
let app: ElectronApplication | undefined, page: Page, fixture = ''
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const paragraphs = (label: string, count: number): string => Array.from({ length: count }, (_, index) =>
  `${label}_${index + 1}：这是已经收到的真实会话正文，用于核对窗口变化和新内容到达后的阅读位置。`).join('\n\n')

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
  const description = 'FOLLOW_SAFETY_CONFIRM：安全策略需要确认这次操作。\n这张卡片在已经到达底部之后才由 SSE 到达。\n拒绝操作后继续观察滚动；夹具不会执行命令。'
  publish({ ask_user: { toolCallId: 'follow-tool', question: description, options: ['approved', 'rejected'] } })
  publish({ permissionRequest: { requestId: 'follow-tool', toolName: 'execute_command', args: { command: 'fixture-only' }, description } })
  publish({ run: updateRun({ status: 'waiting', pending: [{ requestId: 'follow-permission', toolCallId: 'follow-tool',
    toolName: 'execute_command', kind: 'permission', args: { command: 'fixture-only' }, description, status: 'pending' }] }) })
  activeStream!.end('data: [DONE]\n\n'); activeStream = undefined
}

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
  const sessionId = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  let raw = ''; for await (const part of request) raw += part.toString()
  const value: unknown = raw ? JSON.parse(raw) : {}, input = record(value) ? value : {}
  if (path === '/api/v1/chat/admission/context') {
    const matching = current?.sessionId === sessionId ? { ...current, attemptId: `attempt-${current.runId}` } : null
    response.end(envelope({ protocolVersion: 1, tenantId: 'follow-tenant', sessionId,
      namespace: { id: 'follow-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general',
        runLifetime: 'durable', subagentProtocol: 2 }, root: matching,
      predecessor: matching ? { runId: matching.runId, attemptId: matching.attemptId, version: matching.version } : null })); return
  }
  if (path === '/api/v1/chat/admission/receipt') {
    const accepted = admissions.get(String(input.requestKey))
    response.end(envelope(accepted ? { protocolVersion: 1, status: 'accepted', receipt: { ...accepted.admission, sessionId: accepted.run.sessionId,
      rootRunId: accepted.run.runId, turnId: accepted.run.turnId, userMessageId: accepted.run.userMessageId, assistantMessageId: accepted.run.assistantMessageId },
      run: accepted.run, projection: { rootVersion: accepted.run.version, rootAttemptId: `attempt-${accepted.run.runId}`,
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
      publish({ run: updateRun({ status: 'running', pending: current.pending.map(item => ({ ...item, status: 'answered', output: 'rejected' })) }) })
      appendContent('\n\nFOLLOW_RESUMED：已拒绝测试操作，继续输出只读核对结果。')
      return
    }
    const ordinal = roots.length + 1, now = Date.now(), id = String(input.sessionId)
    current = { schemaVersion: 1, runId: `follow-run-${ordinal}`, sessionId: id, turnId: `follow-turn-${ordinal}`,
      userMessageId: `follow-user-${ordinal}`, assistantMessageId: `follow-assistant-${ordinal}`, seq: ordinal, version: 1,
      status: 'running', modelId, pending: [], workspacePaths: [workspaceRoot], createdAt: now, updatedAt: now, startedAt: now }
    roots.push(current); projection.length = 0
    const user: EngineHistoryRow = { id: current.userMessageId, role: 'user', content: String(input.message), createdAt: now,
      conversationId: current.turnId, metadata: { rootRunId: current.runId, turnId: current.turnId } }
    const assistant: EngineHistoryRow = { id: current.assistantMessageId, role: 'assistant', content: '', createdAt: now + 1,
      conversationId: current.turnId, metadata: { rootRunId: current.runId, turnId: current.turnId } }
    history.push(user, assistant)
    publish({ run: current }); publish({ userMessage: user })
    appendContent(ordinal === 1 ? paragraphs('FOLLOW_BASELINE', 60) : 'FOLLOW_ACTIVE：正在核对下一项操作。')
    if (ordinal === 1) {
      const finalResult = { schemaVersion: 1 as const, sessionId: id, turnId: current.turnId, runId: current.runId,
        assistantMessageId: current.assistantMessageId, text: String(assistant.content), publishedAt: now + 2, items: [] }
      assistant.metadata = { ...assistant.metadata, finalResult }
      publish({ finalResult }); publish({ run: updateRun({ status: 'succeeded', finishedAt: now + 2 }) })
    }
    if (record(input.admission)) admissions.set(String(input.admission.requestKey), { admission: input.admission, run: current })
    if (ordinal === 1) { response.end('data: [DONE]\n\n'); activeStream = undefined }
    return
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
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'safe', sessionId }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId }
    : path === '/api/v1/workspace/directory' ? { root: workspaceRoot, entries: [] }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const work = (): Locator => page.locator('.work-view')
const conversation = (): Locator => work().getByRole('region', { name: '协作对话', exact: true })
const scroll = (): Locator => conversation().locator('.work-conversation__scroll')
const latest = (): Locator => conversation().getByRole('button', { name: '回到最新', exact: true })
const composer = (): Locator => conversation().getByRole('textbox', { name: '继续对话', exact: true })
async function metrics() {
  return scroll().evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight,
    gap: element.scrollHeight - element.clientHeight - element.scrollTop }))
}
async function settleLayout(): Promise<void> {
  // ResizeObserver and React can schedule the next frame; wait for rendering
  // work and stable geometry rather than assuming a wheel or transition is
  // finished after an arbitrary delay (or a fixed number of fast frames).
  await scroll().evaluate(element => new Promise<void>((resolve, reject) => {
    let frames = 0, stable = 0, previous = ''
    const next = (): void => {
      const geometry = `${element.scrollTop}:${element.scrollHeight}:${element.clientHeight}`
      stable = geometry === previous ? stable + 1 : 0; previous = geometry; frames++
      if (frames >= 12 && stable >= 6) resolve()
      else if (frames >= 120) reject(new Error('Conversation geometry did not settle'))
      else requestAnimationFrame(next)
    }
    requestAnimationFrame(next)
  }))
}
async function expectBottom(label: string): Promise<void> {
  await expect.poll(async () => Math.abs((await metrics()).gap), { message: `${label}: conversation must stay at the live tail` }).toBeLessThanOrEqual(4)
  await settleLayout()
  const current = await metrics(); geometry.push({ label, ...current })
  expect(Math.abs(current.gap), label).toBeLessThanOrEqual(4)
  await expect(latest()).toBeHidden()
}
async function growAtBottom(label: string): Promise<void> {
  const previous = await metrics()
  appendContent(`\n\n${paragraphs(label, 5)}`)
  await expect(conversation()).toContainText(`${label}_5`)
  await expect.poll(async () => (await metrics()).height).toBeGreaterThan(previous.height + 80)
  await expectBottom(label)
}
async function wheelAway(): Promise<number> {
  const box = await scroll().boundingBox(); if (!box) throw new Error('Missing conversation viewport')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -600)
  await expect.poll(async () => (await metrics()).gap).toBeGreaterThan(150)
  await expect(latest()).toBeVisible(); await settleLayout()
  return (await metrics()).top
}
async function setWindow(width: number, height: number): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(size.width, size.height); window.show(); window.focus()
  }, { width, height })
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height })
}

test.beforeAll(async () => {
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'work-follow-profile-'))
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: `http://127.0.0.1:${address.port}`,
    remoteWorkspaceRoot: workspaceRoot, autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: modelId, thinkingMode: 'off', appearance: 'light' }))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY',
    'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  await setWindow(1440, 900)
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
})
test.afterEach(async ({}, info) => {
  if (page && !page.isClosed()) {
    geometry.push({ label: 'after-test', ...await metrics().catch(() => ({})) })
    if (info.status !== info.expectedStatus) {
      const path = info.outputPath('work-follow-failure.png')
      await page.screenshot({ path }); await info.attach('失败时滚动位置', { path, contentType: 'image/png' })
    }
  }
  const path = info.outputPath('work-follow-receipts.json')
  writeFileSync(path, JSON.stringify({ chats, roots, geometry, errors }, null, 2))
  await info.attach('滚动几何与HTTP回执', { path, contentType: 'application/json' })
  expect(errors).toEqual([])
})
test.afterAll(async () => {
  try { await app?.close() }
  finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== fixtureRoot || !basename(target).startsWith('work-follow-profile-')) throw new Error(`Unsafe fixture cleanup: ${target}`)
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

test('Work live tail survives pending cards, viewport and composer changes while explicit reading stays put', async () => {
  await work().getByRole('button', { name: '新任务', exact: true }).click()
  await work().getByRole('textbox', { name: '任务目标', exact: true }).fill('准备一段完整结果，随后核对滚动跟随')
  await work().getByRole('button', { name: '开始任务', exact: true }).click()
  await expect.poll(() => chats.length).toBe(1)
  await expect(conversation()).toContainText('FOLLOW_BASELINE_60')
  await expect.poll(async () => (await metrics()).height - (await metrics()).client).toBeGreaterThan(800)
  await expectBottom('completed-baseline')
  await composer().fill('继续核对，需要确认时先等我选择')
  await composer().press('Enter')
  await expect.poll(() => chats.length).toBe(2)
  await expect(conversation()).toContainText('FOLLOW_ACTIVE')
  await expectBottom('active-before-permission')

  const beforePermission = await metrics()
  requestPermission()
  const card = conversation().locator('.work-pending')
  await expect(card).toContainText('FOLLOW_SAFETY_CONFIRM')
  await expect(card.getByRole('button', { name: '拒绝', exact: true })).toBeEnabled()
  await expect.poll(async () => (await metrics()).height).toBeGreaterThan(beforePermission.height + 40)
  await expectBottom('permission-arrived')
  const cardInside = await card.getByRole('button', { name: '允许执行', exact: true }).evaluate(button => {
    const viewport = button.closest('.work-conversation__scroll')!.getBoundingClientRect(), rect = button.getBoundingClientRect()
    return rect.top >= viewport.top && rect.bottom <= viewport.bottom
  })
  expect(cardInside, 'permission controls must be visible without another scroll').toBe(true)

  const beforeResize = await metrics()
  await setWindow(1120, 720)
  await expect.poll(async () => (await metrics()).client).toBeLessThan(beforeResize.client - 50)
  await expectBottom('window-shorter')
  const beforeDraft = await metrics(), draft = paragraphs('未发送草稿', 8)
  await composer().fill(draft)
  await expect.poll(async () => (await metrics()).client).toBeLessThan(beforeDraft.client - 70)
  await expectBottom('composer-grows')
  await composer().fill('')
  await expect.poll(async () => (await metrics()).client).toBeGreaterThan(beforeDraft.client - 10)
  await expectBottom('composer-clears')
  await card.getByRole('button', { name: '拒绝', exact: true }).click()
  await expect.poll(() => chats.length).toBe(3)
  expect(chats[2].toolResponse).toMatchObject({ requestId: 'follow-permission', toolCallId: 'follow-tool', name: 'execute_command', output: 'rejected' })
  await expect(card).toHaveCount(0)
  await expect(conversation()).toContainText('FOLLOW_RESUMED')
  await expectBottom('permission-answered')

  const workspace = work().getByRole('button', { name: `当前工作区：${workspaceRoot}`, exact: true })
  await workspace.click()
  await expect(page.getByRole('dialog', { name: '当前工作区', exact: true })).toBeVisible()
  await growAtBottom('FOLLOW_POPOVER_OPEN')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: '当前工作区', exact: true })).toHaveCount(0)
  await growAtBottom('FOLLOW_POPOVER_CLOSED')

  const readingTop = await wheelAway(), previousHeight = (await metrics()).height
  appendContent(`\n\n${paragraphs('FOLLOW_WHILE_READING', 5)}`)
  await expect(conversation()).toContainText('FOLLOW_WHILE_READING_5')
  await expect.poll(async () => (await metrics()).height).toBeGreaterThan(previousHeight + 80)
  await settleLayout()
  expect(Math.abs((await metrics()).top - readingTop), 'new SSE content must not pull the reader back').toBeLessThanOrEqual(4)
  await expect(latest()).toBeVisible()

  const pausedViewport = (await metrics()).client
  await composer().fill(paragraphs('阅读期间未发送草稿', 8))
  await expect.poll(async () => (await metrics()).client).toBeLessThan(pausedViewport - 70)
  await settleLayout()
  expect(Math.abs((await metrics()).top - readingTop), 'growing the composer must preserve the reading anchor').toBeLessThanOrEqual(4)
  await expect(latest()).toBeVisible()
  await composer().fill('')
  await expect.poll(async () => (await metrics()).client).toBeGreaterThan(pausedViewport - 10)
  await settleLayout()
  expect(Math.abs((await metrics()).top - readingTop), 'clearing the draft must not resume following').toBeLessThanOrEqual(4)
  expect((await metrics()).gap).toBeGreaterThan(150)
  await expect(latest()).toBeVisible()

  // Returning by wheel is a real change of reading intent. Merely clicking the
  // explicit latest button would miss the original stuck-follow regression.
  await page.mouse.wheel(0, 100000)
  await expect.poll(async () => Math.abs((await metrics()).gap)).toBeLessThanOrEqual(4)
  await settleLayout()
  await growAtBottom('FOLLOW_MANUAL_BOTTOM')
  await wheelAway()
  await latest().click()
  await expectBottom('explicit-latest')
  await growAtBottom('FOLLOW_EXPLICIT_LATEST')
  expect(chats).toHaveLength(3)
})
