/** Real Electron + authenticated HTTP/SSE: Work requested-model recovery,
 * external run changes, durable unsent/default choices, actual next-request
 * bodies, and task/endpoint isolation. Tasks are created through the UI; the
 * controlled provider changes server-owned runs rather than patching the UI. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'work-model-recovery-token'
const alpha = 'work-model-alpha', beta = 'work-model-beta', gamma = 'work-model-gamma'
const titles = new Map([[alpha, 'Model Alpha'], [beta, 'Model Beta'], [gamma, 'Model Gamma']])
type Source = 'A' | 'B'
interface Session { run?: RootRun; runs: RootRun[]; history: EngineHistoryRow[]; projection: ChatSsePayload[]; sequence: number; stream?: ServerResponse }
const stores: Record<Source, Map<string, Session>> = { A: new Map(), B: new Map() }
const requests: Array<{ source: Source; body: Record<string, unknown> }> = []
const errors: string[] = []
let app: ElectronApplication | undefined, page: Page, health: ElectronHealthMonitor | undefined
let fixture = '', originA = '', originB = '', task = '', otherTask = '', sequence = 0
let failedSnapshots = 0
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const stateKey = (origin: string): string => sessionStorageKey('aether.work.state.v1', engineStorageKey({ mode: 'remote', baseUrl: origin }))
const selectionKey = (origin: string): string => sessionStorageKey('aether:sessionModelSelections', engineStorageKey({ mode: 'remote', baseUrl: origin }))
function session(source: Source, id: string): Session {
  let value = stores[source].get(id)
  if (!value) { value = { runs: [], history: [], projection: [], sequence: 0 }; stores[source].set(id, value) }
  return value
}
function startRun(source: Source, id: string, modelId: string | undefined, prompt: string, status: RootRun['status'] = 'running'): RootRun {
  const value = session(source, id), index = ++sequence, now = Date.now()
  const run: RootRun = { schemaVersion: 1, runId: `work-model-${source}-run-${index}`, sessionId: id,
    turnId: `work-model-${source}-turn-${index}`, userMessageId: `work-model-${source}-user-${index}`,
    assistantMessageId: `work-model-${source}-assistant-${index}`, version: 1, seq: 1,
    status, modelId, actualModelId: alpha, pending: [], workspacePaths: [], createdAt: now, updatedAt: now }
  value.run = run; value.runs.push(run); value.sequence = 0; value.projection = []
  value.history.push({ id: run.userMessageId, role: 'user', content: prompt, conversationId: run.turnId, createdAt: now })
  if (status === 'succeeded') value.history.push({ id: run.assistantMessageId, role: 'assistant', content: `${prompt} completed`, modelId: alpha, conversationId: run.turnId, createdAt: now })
  return run
}
function frame(source: Source, id: string, payload: ChatSsePayload): void {
  const value = session(source, id)
  if (!value.stream || value.stream.destroyed || value.stream.writableEnded || !value.run) throw new Error(`No live fixture subscriber: ${source}/${id}`)
  value.projection.push(structuredClone(payload))
  value.stream.write(`id: ${value.run.runId}:${++value.sequence}\ndata: ${JSON.stringify(payload)}\n\n`)
}
function finish(source: Source, id: string): void {
  const value = session(source, id), prior = value.run!
  value.run = { ...prior, status: 'succeeded', version: prior.version + 1, seq: value.sequence + 1, updatedAt: Date.now(), finishedAt: Date.now() }
  value.runs = value.runs.map(run => run.runId === prior.runId ? value.run! : run)
  value.history.push({ id: prior.assistantMessageId, role: 'assistant', content: 'MODEL_REQUEST_COMPLETED', modelId: alpha, conversationId: prior.turnId, createdAt: Date.now() })
  frame(source, id, { content: 'MODEL_REQUEST_COMPLETED' }); frame(source, id, { run: value.run })
  value.stream!.end('data: [DONE]\n\n'); value.projection = []
}
async function handle(source: Source, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) { response.writeHead(401).end(envelope(null)); return }
  let raw = ''; for await (const part of request) raw += part.toString()
  const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
  if (path === '/api/v1/chat' && request.method === 'POST') {
    const id = String(body.sessionId)
    if (!id.startsWith('work-')) throw new Error(`Work sent to a Code session: ${id}`)
    requests.push({ source, body: structuredClone(body) })
    const run = startRun(source, id, typeof body.model === 'string' ? body.model : undefined, String(body.message))
    const value = session(source, id); value.stream = response
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    frame(source, id, { run }); frame(source, id, { userMessage: value.history.at(-1)! }); return
  }
  const id = url.searchParams.get('sessionId') ?? '', value = session(source, id)
  if (path === '/api/v1/chat/snapshot' && id === otherTask && failedSnapshots > 0) {
    failedSnapshots--
    response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 503, message: 'MODEL_SNAPSHOT_UNAVAILABLE' })); return
  }
  if (path === '/api/v1/chat/stream') { value.stream = response; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'d'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: `work-model-${source}` }
      : path === '/api/v1/models' ? [alpha, beta, gamma].map(modelId => ({ id: `record-${modelId}`, modelId, provider: 'openai', displayName: titles.get(modelId), isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }))
        : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, source: value.run?.status === 'running' ? 'live' : 'persisted', sessionId: id, eventId: value.run ? `${value.run.runId}:${value.sequence}` : null, finished: value.run?.status !== 'running', history: value.history, projection: value.projection, run: value.run, runs: value.runs, todos: [], changes: [], commandJobs: [], subagentRuns: [] }
          : path === '/api/v1/chat/status' ? { running: value.run?.status === 'running', finished: Boolean(value.run && value.run.status !== 'running'), run: value.run }
            : path === '/api/v1/chat/runs' ? { runs: value.runs }
              : path === '/api/v1/security/mode' ? { mode: 'safe', sessionId: id }
                : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: true, sessionId: id }
                  : path === '/api/v1/workspace/directory' ? { root: '/remote/work-model', entries: [] }
                    : path === '/api/v1/workspace/bind' ? { workspaceRoot: '/remote/work-model' } : []
  response.setHeader('content-type', 'application/json'); response.end(envelope(data))
}
const server = (source: Source) => createServer((request, response) => {
  void handle(source, request, response).catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})
const serverA = server('A'), serverB = server('B')
const work = () => page.locator('.work-view')
const picker = () => work().getByRole('button', { name: 'Work 使用的模型', exact: true })
async function expectModel(modelId: string): Promise<void> {
  await expect(picker()).toHaveAttribute('title', `当前模型：${modelId}`)
  await expect(picker().locator('.select__value')).toHaveText(titles.get(modelId) ?? modelId)
}
async function storedTaskModel(id: string, origin = originA): Promise<string | undefined> {
  return page.evaluate(({ key, id }) => JSON.parse(localStorage.getItem(key) ?? '{}').tasks?.find((item: { id: string }) => item.id === id)?.modelId, { key: stateKey(origin), id })
}
async function chooseModel(modelId: string): Promise<void> {
  await picker().click()
  await page.getByRole('menuitem', { name: new RegExp(`^${titles.get(modelId) ?? modelId}`) }).click()
  await expectModel(modelId)
}
async function send(prompt: string, source: Source = 'A'): Promise<Record<string, unknown>> {
  await work().getByRole('textbox', { name: '继续对话', exact: true }).fill(prompt)
  const count = requests.length
  await work().getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => requests.length).toBe(count + 1)
  const last = requests.at(-1)!
  expect(last.source).toBe(source)
  await expect(picker()).toBeDisabled()
  return last.body
}
async function completed(source: Source, id: string): Promise<void> { finish(source, id); await expect(picker()).toBeEnabled() }
async function openTask(title: string): Promise<void> {
  await work().locator('.work-sidebar__task').filter({ hasText: title }).click()
  await expect(work().locator('.work-task-heading h1')).toHaveText(title)
  await expect(picker()).toBeEnabled()
}
async function createTask(title: string): Promise<string> {
  await work().getByRole('button', { name: '新任务', exact: true }).click()
  await work().getByRole('textbox', { name: '任务目标', exact: true }).fill(title)
  const count = requests.length
  await work().getByRole('button', { name: '开始任务', exact: true }).click()
  await expect.poll(() => requests.length).toBe(count + 1)
  const id = String(requests.at(-1)!.body.sessionId)
  await expect(picker()).toBeDisabled(); await completed('A', id)
  return id
}
async function switchSource(origin: string): Promise<void> {
  await page.evaluate(async origin => { await window.aether.settings.update({ remoteBaseUrl: origin }); await window.aether.engine.restart() }, origin)
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 30_000 })
  await page.reload()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 30_000 })
}

test.describe.serial('Work 会话请求模型恢复', () => {
  test.beforeAll(async () => {
    await new Promise<void>(done => serverA.listen(0, '127.0.0.1', done)); await new Promise<void>(done => serverB.listen(0, '127.0.0.1', done))
    const addressA = serverA.address(), addressB = serverB.address()
    if (!addressA || typeof addressA === 'string' || !addressB || typeof addressB === 'string') throw new Error('Missing fixture ports')
    originA = `http://127.0.0.1:${addressA.port}`; originB = `http://127.0.0.1:${addressB.port}`
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'work-model-recovery-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: originA, autoStartEngine: true, lastModelId: alpha, thinkingMode: 'off', lastSessionId: '', appearance: 'dark' }))
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    health = await monitorElectronHealth(app, 'work-model-recovery', [token]); page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
  })
  test.afterEach(() => { health?.assertHealthy(); expect(errors).toEqual([]) })
  test.afterAll(async ({}, info) => {
    for (const store of Object.values(stores)) for (const value of store.values()) value.stream?.destroy()
    try { if (health) await health.closeAndAssert(info); else await app?.close() }
    finally {
      serverA.closeAllConnections(); serverB.closeAllConnections()
      await new Promise<void>(done => serverA.close(() => done())); await new Promise<void>(done => serverB.close(() => done()))
      if (fixture) { const target = resolve(fixture); if (dirname(target) !== fixtureRoot || !basename(target).startsWith('work-model-recovery-')) throw new Error(`Unsafe cleanup: ${target}`); rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    }
  })
  test('初次恢复使用服务器requested模型，同步旧任务元数据且不误用actual回退模型', async () => {
    task = await createTask('MODEL_RECOVERY_TASK')
    expect(await storedTaskModel(task)).toBe(alpha)
    startRun('A', task, beta, 'EXTERNAL_REQUESTED_BETA', 'succeeded')
    await page.reload(); await expectModel(beta)
    await expect.poll(() => storedTaskModel(task)).toBe(beta)
    const body = await send('SEND_RECOVERED_MODEL')
    expect(body).toMatchObject({ sessionId: task, model: beta, message: 'SEND_RECOVERED_MODEL' })
    await completed('A', task)
  })
  test('真实SSE中的外部新run更新输入框和持久化模型，后续HTTP请求使用该模型', async () => {
    const body = await send('SUBSCRIBE_EXTERNAL_RUN')
    expect(body.model).toBe(beta)
    const old = session('A', task).run!
    const ended = { ...old, status: 'interrupted' as const, version: old.version + 1, updatedAt: Date.now(), finishedAt: Date.now() }
    session('A', task).run = ended
    session('A', task).runs = session('A', task).runs.map(run => run.runId === old.runId ? ended : run)
    session('A', task).history.push({ id: old.assistantMessageId, role: 'assistant', content: 'EXTERNAL_RUN_REPLACED_PREVIOUS', conversationId: old.turnId, modelId: alpha })
    frame('A', task, { run: ended })
    const external = startRun('A', task, gamma, 'EXTERNAL_LIVE_GAMMA')
    frame('A', task, { run: external }); frame('A', task, { userMessage: session('A', task).history.at(-1)! })
    await expectModel(gamma); await expect.poll(() => storedTaskModel(task)).toBe(gamma)
    await completed('A', task)
    await page.reload(); await expectModel(gamma)
    await expect(work().locator(`.work-message--user[data-message-id="${external.userMessageId}"]`)).toContainText('EXTERNAL_LIVE_GAMMA')
    expect(session('A', task).runs.find(run => run.runId === old.runId)?.status).toBe('interrupted')
    const next = await send('NEXT_AFTER_LIVE_EXTERNAL')
    expect(next).toMatchObject({ sessionId: task, model: gamma })
    await completed('A', task)
  })
  test('未发送手选按run锚点保存，同run回读和刷新不覆盖，发送的真实模型一致', async () => {
    await chooseModel(beta)
    const anchored = session('A', task).run!.runId
    const selection = await page.evaluate(({ key, id }) => JSON.parse(localStorage.getItem(key) ?? '{}')[id], { key: selectionKey(originA), id: task })
    expect(selection).toEqual({ modelId: beta, anchorRunId: anchored })
    // An updated snapshot for this same run must not erase the unsent choice.
    session('A', task).run = { ...session('A', task).run!, modelId: alpha, version: 20 }
    await page.reload(); await expectModel(beta)
    await expect.poll(() => storedTaskModel(task)).toBe(beta)
    const body = await send('ANCHORED_UNSENT_MODEL')
    expect(body).toMatchObject({ sessionId: task, model: beta })
    await completed('A', task)
  })
  test('外部不同run替换旧手选，列表外模型也保留并用于真实请求', async () => {
    await chooseModel(gamma)
    startRun('A', task, beta, 'EXTERNAL_OVERRIDES_UNSENT', 'succeeded')
    await page.reload(); await expectModel(beta)
    const body = await send('FOLLOW_NEW_REQUESTED')
    expect(body).toMatchObject({ sessionId: task, model: beta })
    await completed('A', task)
    startRun('A', task, 'work-unlisted-model', 'EXTERNAL_UNLISTED', 'succeeded')
    await page.reload(); await expectModel('work-unlisted-model')
    const unlisted = await send('KEEP_UNLISTED_REQUESTED')
    expect(unlisted).toMatchObject({ sessionId: task, model: 'work-unlisted-model' })
    await completed('A', task)
  })
  test('明确默认选择跨刷新保留客户端默认语义，无默认配置则交给Agent引擎', async () => {
    await picker().click(); await page.getByRole('menuitem', { name: /^默认 · Model Alpha/ }).click()
    await expect(picker()).toHaveAttribute('title', 'Model Alpha · 客户端默认')
    await page.reload(); await expect(picker()).toHaveAttribute('title', 'Model Alpha · 客户端默认')
    await expect.poll(() => storedTaskModel(task)).toBe(alpha)
    const body = await send('EXPLICIT_CLIENT_DEFAULT')
    expect(body).toMatchObject({ sessionId: task, model: alpha })
    await completed('A', task)
    await page.evaluate(() => window.aether.settings.update({ lastModelId: '' })); await page.reload()
    await picker().click(); await page.getByRole('menuitem', { name: /^默认 · 跟随引擎配置/ }).click()
    await page.reload(); await expect(picker()).toHaveAttribute('title', '跟随引擎配置 · 发送时由引擎解析')
    const engineDefault = await send('EXPLICIT_ENGINE_DEFAULT')
    expect(engineDefault).toMatchObject({ sessionId: task, message: 'EXPLICIT_ENGINE_DEFAULT' })
    expect(engineDefault).not.toHaveProperty('model')
    await completed('A', task)
    await page.evaluate(model => window.aether.settings.update({ lastModelId: model }), alpha)
    startRun('A', task, beta, 'FINAL_FIRST_TASK_MODEL', 'succeeded'); await page.reload(); await expectModel(beta)
  })
  test('未发送选择不串任务；同会话ID和runID的不同引擎各自显示并发送其模型', async () => {
    otherTask = await createTask('OTHER_MODEL_TASK'); await chooseModel(gamma)
    await openTask('MODEL_RECOVERY_TASK'); await expectModel(beta)
    const first = await send('FIRST_TASK_ISOLATION'); expect(first).toMatchObject({ sessionId: task, model: beta }); await completed('A', task)
    await openTask('OTHER_MODEL_TASK'); await expectModel(gamma)
    const sourceARun = session('A', otherTask).run!
    // Seed only the restored task index for an independent endpoint. Matching
    // IDs deliberately make a leaked source-A selection fail this assertion.
    const sourceBValue = session('B', otherTask)
    sourceBValue.run = { ...sourceARun, modelId: beta }; sourceBValue.runs = [sourceBValue.run]
    sourceBValue.history = structuredClone(session('A', otherTask).history)
    await page.evaluate(({ from, to }) => localStorage.setItem(to, localStorage.getItem(from)!), { from: stateKey(originA), to: stateKey(originB) })
    await switchSource(originB); await expectModel(beta)
    await expect.poll(() => storedTaskModel(otherTask, originB)).toBe(beta)
    await chooseModel(alpha); await page.reload(); await expectModel(alpha)
    const secondSource = await send('SOURCE_B_SELECTION', 'B')
    expect(secondSource).toMatchObject({ sessionId: otherTask, model: alpha }); await completed('B', otherTask)
    await switchSource(originA); await expectModel(gamma)
    await expect.poll(() => storedTaskModel(otherTask, originA)).toBe(gamma)
    const originalSource = await send('SOURCE_A_SELECTION')
    expect(originalSource).toMatchObject({ sessionId: otherTask, model: gamma }); await completed('A', otherTask)
    expect(await storedTaskModel(task)).toBe(beta)
  })
  test('恢复的空requested或旧默认占位明确显示引擎配置，不冒充全局默认模型', async () => {
    for (const modelId of [undefined, '', '当前配置 of AI']) {
      startRun('A', otherTask, modelId, 'UNKNOWN_REQUESTED_ENGINE_DEFAULT', 'succeeded')
      await page.reload()
      await expect(picker()).toHaveAttribute('title', '跟随引擎配置 · 发送时由引擎解析')
      await expect.poll(() => storedTaskModel(otherTask)).toBe('')
      const body = await send('UNKNOWN_REQUESTED_MUST_NOT_INVENT_MODEL')
      expect(body).toMatchObject({ sessionId: otherTask })
      expect(body).not.toHaveProperty('model')
      await completed('A', otherTask)
    }
  })
  test('快照失败时模型按钮禁用而重新加载可用，恢复后选择并发送正常', async () => {
    failedSnapshots = 1
    const before = requests.length
    await page.reload()
    await expect(work().getByRole('alert')).toContainText('MODEL_SNAPSHOT_UNAVAILABLE')
    await expect(picker()).toBeDisabled()
    const retry = work().getByRole('button', { name: '重新加载', exact: true })
    await expect(retry).toBeEnabled()
    expect(requests.length).toBe(before)
    await retry.click(); await expect(picker()).toBeEnabled()
    await chooseModel(gamma)
    const body = await send('SEND_AFTER_MODEL_RECOVERY_RETRY')
    expect(body).toMatchObject({ sessionId: otherTask, model: gamma })
    await completed('A', otherTask)
  })
})
