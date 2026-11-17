/** Real Electron dialogs: service deletion, pending queue confirmation/CAS,
 * service lifecycle and queue races.
 * Only engine HTTP and the queue IPC boundary are controlled. Build first, then run
 * with --config e2e/config/playwright.dialog-consistency.config.ts; workers must remain one. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { CommandJobSnapshot } from '../src/shared/command-job'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import type { NextTurnQueueEnvelope, NextTurnQueueState } from '../src/shared/next-turn-queue'
import { applyNextTurnQueueMutation, assertQueueState, emptyNextTurnQueue } from '../src/shared/next-turn-queue-state'
import { SESSION_QUEUE_IPC, type SessionQueueRequest } from '../src/shared/session-next-turn-api'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'dialog-consistency-fixture', model = 'dialog-fixture-model', now = Date.now() - 10_000
const taskId = 'work-dialog-consistency-task'
const runningJob = 'dialog-service-running', finishedJob = 'dialog-service-finished'
const titles = new Map([[taskId, '弹窗回归任务']])
const manifest = { version: '2.0.0', buildId: `sha256:${'b'.repeat(64)}`, protocolVersion: 1,
  toolProfiles: ['general', 'code'], subagentSchemaVersion: 1 }
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const errors: string[] = [], unexpectedWrites: string[] = []
const deletes: { sessionId: string; jobId: string }[] = []
const roots = new Map<string, RootRun>(), jobs = new Map<string, CommandJobSnapshot>()
type QueueFixture = { state: NextTurnQueueState; mutations: SessionQueueRequest[]; unexpected: SessionQueueRequest[] }
type MainFixture = typeof globalThis & { __dialogQueue: QueueFixture }
let app: ElectronApplication | undefined, page: Page, fixture = '', sessionCwd = ''

function history(id: string): EngineHistoryRow[] {
  const run = roots.get(id)
  return run ? [
    { id: run.userMessageId, role: 'user', content: titles.get(id), conversationId: run.turnId, createdAt: now, metadata: { rootRunId: run.runId } },
    { id: run.assistantMessageId, role: 'assistant', content: '任务已完成，可以查看记录。', conversationId: run.turnId, createdAt: now + 1, metadata: { rootRunId: run.runId } }
  ] : []
}
function queueEnvelope(text: string): NextTurnQueueEnvelope {
  return { draft: { text, revision: 1, mentions: [] }, model: { kind: 'explicit', modelId: model },
    workspace: { kind: 'local-workspace', identity: sessionCwd }, agent: { primaryAgentId: null, collaborators: [] },
    resources: { skills: { kind: 'inherit' }, mcpServers: { kind: 'inherit' }, knowledgeBases: { kind: 'inherit' } },
    thinking: { kind: 'off' }, memory: { kind: 'inherit' }, security: { policy: 'engine-session' }, attachments: [] }
}
function seededQueue(): NextTurnQueueState {
  let state = emptyNextTurnQueue({ source: { mode: 'embedded', endpoint: '', accountId: null }, tenantId: 'dialog-fixture',
    namespace: { id: 'dialog-fixture-db', generation: 'one' }, owner: 'work', taskId })
  for (const [index, text] of ['第一条待发消息', '第二条待发消息'].entries()) state = applyNextTurnQueueMutation(state, state.revision,
    { kind: 'enqueue', id: `dialog-queue-${index}`, envelope: queueEnvelope(text), at: now })
  return applyNextTurnQueueMutation(state, state.revision, { kind: 'pause', reason: '回归夹具暂停自动发送' })
}

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
  response.setHeader('content-type', 'application/json')
  if (request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated fixture request: ${path}`)
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const payload: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
  const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
  const id = url.searchParams.get('sessionId') ?? (typeof body.sessionId === 'string' ? body.sessionId : '')
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/browser/hosts', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(JSON.stringify({ code: 404, message: 'Capability unavailable in dialog fixture', data: null })); return
  }
  const command = path.match(/^\/api\/v1\/command-jobs\/([^/]+)(?:\/(output))?$/)
  if (command) {
    const jobId = decodeURIComponent(command[1]), job = jobs.get(jobId)
    if (!job || job.sessionId !== id) throw new Error(`Wrong command owner: ${id}/${jobId}`)
    if (request.method === 'DELETE' && !command[2]) {
      if (job.status === 'running') throw new Error('Attempted to delete an active service')
      deletes.push({ sessionId: id, jobId }); jobs.delete(jobId); response.end(envelope({ deleted: true })); return
    }
    if (request.method === 'GET' && command[2] === 'output') {
      const cursor = Number(url.searchParams.get('cursor') ?? 0)
      response.end(envelope({ job, entries: cursor < 1 ? [{ seq: 1, stream: 'stdout', text: `LOG_${jobId}\n` }] : [],
        nextCursor: 1, earliestCursor: 0, truncated: false, hasMore: false })); return
    }
    if (request.method === 'GET' && !command[2]) { response.end(envelope(job)); return }
  }
  if (request.method !== 'GET' && !['/api/v1/workspace/bind', '/api/v1/chat/admission/receipt'].includes(path)) {
    unexpectedWrites.push(`${request.method} ${path}`)
    response.writeHead(404).end(JSON.stringify({ code: 404, message: 'Unsupported fixture operation', data: null })); return
  }
  const rows = history(id), current = roots.get(id), ownJobs = [...jobs.values()].filter(job => job.sessionId === id)
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows,
      loadedTurnIds: users.map(row => row.id), revision: `${id}-stable`, mutationRevision: `${id}-stable`, backend: 'jsonl', completeness: 'complete' })); return
  }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { ...manifest, instanceId: 'dialog-consistency-fixture' }
    : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '弹窗测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: rows, projection: [], run: current, runs: current ? [current] : [], subagentRuns: [], todos: [], changes: [], commandJobs: ownJobs }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: current, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: current ? [current] : [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [...titles].map(([sessionId, title]) => ({ sessionId, title, lastAt: now, messageCount: 2 }))
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'dialog-fixture', sessionId: id,
      namespace: { id: 'dialog-fixture-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, durableQueueReceipts: false, receiptPagination: false, runtimeCommunication: false, mailboxConsumer: false, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: sessionCwd, bindingEpoch: 'one', entries: [] }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: sessionCwd }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: ownJobs } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const work = (): Locator => page.locator('.work-view')
const queue = (): Locator => work().getByRole('region', { name: '下一轮消息队列', exact: true })
const dialog = (name: string): Locator => page.getByRole('dialog', { name, exact: true })
async function queueSnapshot(): Promise<QueueFixture> {
  return app!.evaluate(() => (globalThis as MainFixture).__dialogQueue)
}
async function setQueue(state: NextTurnQueueState): Promise<void> {
  assertQueueState(state, state.scope)
  await app!.evaluate(({ BrowserWindow }, { state, channel }) => {
    ;(globalThis as MainFixture).__dialogQueue.state = state
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, { scope: state.scope, revision: state.revision })
  }, { state, channel: SESSION_QUEUE_IPC.changed })
  await expect(queue().locator('.work-next-turn__summary')).toContainText(`${state.entries.length} 条待发`)
}
async function openQueueClear(): Promise<Locator> {
  const summary = queue().locator('.work-next-turn__summary')
  if (await summary.getAttribute('aria-expanded') !== 'true') await summary.click()
  await queue().getByRole('button', { name: '清空待发', exact: true }).click()
  const confirmation = dialog('清空待发消息')
  await expect(confirmation).toBeVisible()
  return confirmation
}

test.describe.serial('统一弹窗真实交互回归', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'dialog-consistency-profile-'))
    sessionCwd = join(fixture, 'work-task')
    mkdirSync(sessionCwd)
    for (const sessionId of titles.keys()) roots.set(sessionId, { schemaVersion: 1, runId: `root-${sessionId}`, sessionId,
      turnId: `turn-${sessionId}`, userMessageId: `user-${sessionId}`, assistantMessageId: `assistant-${sessionId}`,
      seq: 1, version: 2, status: 'succeeded', modelId: model, pending: [], workspacePaths: [sessionCwd],
      createdAt: now, updatedAt: now, finishedAt: now })
    for (const jobId of [runningJob, finishedJob]) jobs.set(jobId, { schemaVersion: 1, jobId, sessionId: taskId, ownerSessionId: taskId,
      runId: `root-${taskId}`, turnId: `turn-${taskId}`, toolCallId: `call-${jobId}`, version: 1,
      status: jobId === runningJob ? 'running' : 'succeeded', command: 'node', args: [`${jobId}.js`], cwd: sessionCwd, background: true,
      createdAt: now, updatedAt: now, ...(jobId === finishedJob ? { finishedAt: now } : {}),
      exitCode: jobId === runningJob ? null : 0, signal: null, cursor: 1, earliestCursor: 0 })
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture server port')
    const runtime = join(fixture, 'runtime-fixture'), entry = join(runtime, 'entry.cjs')
    mkdirSync(join(runtime, 'runtime'), { recursive: true })
    writeFileSync(join(runtime, 'runtime', 'build-manifest.json'), JSON.stringify(manifest))
    writeFileSync(entry, `const http = require('node:http');
const upstream = ${JSON.stringify(`http://127.0.0.1:${address.port}`)};
const token = ${JSON.stringify(token)};
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/') && req.headers['x-aether-instance-token'] !== process.env.AETHER_INSTANCE_TOKEN) {
    res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({code:401,message:'Invalid or missing instance token'})); return;
  }
  const forwarded = http.request(upstream + req.url, { method: req.method, headers: { ...req.headers, 'x-aether-instance-token': token } }, remote => {
    res.writeHead(remote.statusCode || 500, remote.headers); remote.pipe(res);
  });
  forwarded.on('error', error => { if (!res.headersSent) res.writeHead(502); res.end(error.message); });
  req.pipe(forwarded);
});
server.listen(Number(process.env.AETHER_ENGINE_PORT), '127.0.0.1');
`)
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'embedded', autoStartEngine: true, preferredPort: 12559,
      lastSessionId: taskId, lastModelId: model, appearance: 'light', lastFolder: sessionCwd, thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const name of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY',
      'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_REMOTE_INSTANCE_TOKEN', 'AETHER_INSTANCE_TOKEN', 'WORKSPACE_ROOT'].includes(name.toUpperCase())) delete env[name]
    env.AETHER_IDE_ENGINE_ENTRY = entry; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    // Fail native browser confirms rather than auto-accepting a fallback that
    // would hide a regression in the application's shared dialog host.
    page.on('dialog', async native => { errors.push(`Unexpected native dialog: ${native.message()}`); await native.dismiss() })
    await app.evaluate(({ ipcMain, BrowserWindow }, { state, channel }) => {
      const fixture: QueueFixture = { state, mutations: [], unexpected: [] }
      ;(globalThis as MainFixture).__dialogQueue = fixture
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event, input: SessionQueueRequest) => {
        if (input.taskId !== fixture.state.scope.taskId) {
          if (input.action.kind !== 'read') fixture.unexpected.push(input)
          return { ok: true, value: { state: { ...fixture.state, scope: { ...fixture.state.scope, taskId: input.taskId }, entries: [], removed: [] } } }
        }
        if (input.action.kind === 'read') return { ok: true, value: { state: fixture.state } }
        fixture.mutations.push(input)
        if (input.action.kind !== 'mutate' || input.action.operation.kind !== 'clear-pending') {
          fixture.unexpected.push(input); return { ok: false, code: 'INVALID', message: '夹具只允许清空待发' }
        }
        if (input.action.expectedRevision !== fixture.state.revision) return { ok: false, code: 'CAS', message: '队列已更新，请重新确认' }
        const at = input.action.operation.at
        fixture.state = { ...fixture.state, revision: fixture.state.revision + 1,
          removed: [...fixture.state.removed, ...fixture.state.entries.filter(entry => entry.phase === 'pending').map(entry => ({ id: entry.id, entryRevision: entry.revision, removedAt: at }))],
          entries: fixture.state.entries.filter(entry => entry.phase !== 'pending') }
        return { ok: true, value: { state: fixture.state } }
      })
      const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900); window.show(); window.focus()
    }, { state: seededQueue(), channel: SESSION_QUEUE_IPC.invoke })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.evaluate(({ taskId, title, now, workspacePath, model }) => {
      localStorage.setItem('aether.work.state.v1', JSON.stringify({ tasks: [{ id: taskId, title, status: 'done', draft: '',
        createdAt: now, updatedAt: now, workspacePath, modelId: model, attachments: [], sources: [] }], activeTaskId: taskId }))
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
    }, { taskId, title: titles.get(taskId), now, workspacePath: sessionCwd, model })
    await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
    await expect(work().getByRole('heading', { name: titles.get(taskId), exact: true })).toBeVisible()
    await expect(queue()).toBeVisible()
  })
  test.afterEach(async ({}, info) => {
    const queueState = app ? await queueSnapshot() : null
    await info.attach('dialog-side-effects', { body: JSON.stringify({ deletes, queue: queueState, errors, unexpectedWrites }, null, 2), contentType: 'application/json' })
    if (info.status !== info.expectedStatus && page && !page.isClosed()) {
      const path = info.outputPath('dialog-failure.png'); await page.screenshot({ path }); await info.attach('失败时窗口', { path, contentType: 'image/png' })
    }
    expect(errors).toEqual([]); expect(unexpectedWrites).toEqual([]); expect(queueState?.unexpected ?? []).toEqual([])
  })
  test.afterAll(async () => {
    try { await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('dialog-consistency-profile-')) throw new Error(`Unsafe dialog fixture cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('删除服务历史：取消不发请求，确认仅删除所属历史记录', async () => {
    await page.locator('.status-bar .service-tray__button').click()
    const activity = page.locator('.service-tray__panel')
    await expect(activity).toBeVisible()
    // Command activity rows open their terminal directly; details are a context-menu action.
    await activity.getByRole('button', { name: `node ${runningJob}.js，运行中`, exact: true }).click()
    const panel = work().getByRole('region', { name: '任务终端', exact: true })
    await expect(panel).toBeVisible()
    await expect(activity).toHaveCount(0)
    await expect(panel.getByRole('tab', { name: /^后台运行/ })).toHaveAttribute('aria-selected', 'true')
    const historyRow = panel.locator(`.work-terminal-panel__job[data-job-id="${finishedJob}"]`)
    await historyRow.click()
    const detail = panel.locator(`.work-terminal-panel__detail[data-job-id="${finishedJob}"]`)
    await expect(detail.locator('.work-terminal-panel__output')).toContainText(`LOG_${finishedJob}`)
    const remove = detail.getByRole('button', { name: '删除服务历史', exact: true })
    await remove.click()
    const confirmation = dialog('删除后台运行记录')
    await expect(confirmation).toContainText('删除这条服务历史及其日志？此操作无法撤销。')
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    await expect(confirmation).toHaveCount(0); expect(deletes).toEqual([]); expect(jobs.has(finishedJob)).toBe(true)
    await expect(historyRow).toBeVisible()
    await remove.click(); await confirmation.getByRole('button', { name: '删除', exact: true }).click()
    await expect.poll(() => deletes).toEqual([{ sessionId: taskId, jobId: finishedJob }])
    await expect(historyRow).toHaveCount(0); expect(jobs.has(finishedJob)).toBe(false); expect(jobs.has(runningJob)).toBe(true)
    const terminalTabs = work().getByRole('tablist', { name: '已打开的工作区', exact: true })
    // Workspace tab close buttons become interactive only while hovered or keyboard-focused.
    await terminalTabs.getByRole('tab', { name: '终端', exact: true }).hover()
    const closeTerminal = terminalTabs.getByRole('button', { name: '关闭终端', exact: true })
    await expect(closeTerminal).toHaveCSS('pointer-events', 'auto')
    await closeTerminal.click()
    await expect(panel).toHaveCount(0)
  })

  test('清空待发：取消保留消息，确认只提交一次原版本清空', async () => {
    const initial = await queueSnapshot(), confirmation = await openQueueClear()
    await expect(confirmation).toContainText('取消 2 条待发消息？正在执行的任务会继续。')
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    expect(await queueSnapshot()).toEqual(initial)
    await expect(queue().locator('.work-next-turn__item')).toHaveCount(2)
    await openQueueClear(); await confirmation.getByRole('button', { name: '清空待发', exact: true }).click()
    await expect(queue()).toHaveCount(0)
    const cleared = await queueSnapshot()
    expect(cleared.mutations).toHaveLength(initial.mutations.length + 1)
    expect(cleared.mutations.at(-1)).toMatchObject({ taskId, action: { kind: 'mutate', expectedRevision: initial.state.revision, operation: { kind: 'clear-pending' } } })
    expect(cleared.state.entries).toEqual([])
    expect(cleared.state.removed.map(entry => entry.id)).toEqual(initial.state.entries.map(entry => entry.id))
    expect(jobs.get(runningJob)?.status).toBe('running')
  })

  test('确认期间新增待发消息：旧确认触发 CAS，保留全部消息', async () => {
    const previous = await queueSnapshot(), seeded = { ...seededQueue(), revision: previous.state.revision + 1 }
    await setQueue(seeded)
    const confirmation = await openQueueClear()
    const changed = applyNextTurnQueueMutation(seeded, seeded.revision, { kind: 'enqueue', id: 'dialog-queue-new', envelope: queueEnvelope('确认期间到达的新消息'), at: Date.now() })
    await setQueue(changed)
    await confirmation.getByRole('button', { name: '清空待发', exact: true }).click()
    await expect(queue().getByRole('alert')).toHaveText('队列已更新，请重新确认')
    const result = await queueSnapshot()
    expect(result.mutations).toHaveLength(previous.mutations.length + 1)
    expect(result.mutations.at(-1)).toMatchObject({ action: { expectedRevision: seeded.revision } })
    expect(result.state).toEqual(changed)
    await expect(queue().locator('.work-next-turn__item')).toHaveCount(3)
  })
})
