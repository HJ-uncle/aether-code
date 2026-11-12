/** Real Electron + owned HTTP/SSE: current-turn results wait for settlement,
 * while completed older turns remain visible. Covers waiting, success, failure,
 * cancellation, early published deliveries, and restoration after reload.
 * Published files and their change-review summary coexist after settlement;
 * task lists remain visible only while their owning root is active. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { ChatSsePayload, EngineFileChange, EngineTodo } from '../src/shared/ipc'
import type { FinalResult } from '../src/shared/final-result'
import type { RootRun } from '../src/shared/root-run'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const sessionId = 'work-result-visibility', title = '成果显示时机核对', token = 'result-visibility-token', modelId = 'result-visibility-model'
const workspaceRoot = '/remote/result-visibility'
const runs: RootRun[] = [], history: EngineHistoryRow[] = [], changes: EngineFileChange[] = [], projection: ChatSsePayload[] = []
const todos: EngineTodo[] = []
const errors: string[] = [], chats: Record<string, unknown>[] = [], changeReads: string[][] = []
const admissions = new Map<string, { admission: Record<string, unknown>; run: RootRun }>()
let current: RootRun, stream: ServerResponse | undefined, app: ElectronApplication | undefined, page: Page, fixture = '', storageKey = '', generation = 0
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const active = (): boolean => ['running', 'waiting'].includes(current.status)

function appendRun(status: RootRun['status'], prompt: string): RootRun {
  const seq = runs.length + 1, at = Date.now(), id = `result-${generation}-${seq}`
  const run: RootRun = { schemaVersion: 1, runId: `${id}-root`, sessionId, turnId: `${id}-turn`,
    userMessageId: `${id}-user`, assistantMessageId: `${id}-assistant`, seq, version: 1, status, modelId,
    pending: [], workspacePaths: [workspaceRoot], createdAt: at, updatedAt: at, startedAt: at,
    ...(['running', 'waiting'].includes(status) ? {} : { finishedAt: at }) }
  const metadata = { rootRunId: run.runId, turnId: run.turnId }
  runs.push(run)
  history.push({ id: run.userMessageId, role: 'user', content: prompt, conversationId: run.turnId, createdAt: at, metadata },
    { id: run.assistantMessageId, role: 'assistant', content: `RESULT_CONTENT_${seq}`, conversationId: run.turnId, createdAt: at + 1, metadata })
  changes.push({ id: `${id}-change`, sessionId, turnId: run.turnId, runId: run.runId, path: `${workspaceRoot}/result-${seq}.txt`,
    kind: 'write', oldContent: null, newContent: `RESULT_FILE_${seq}`, isNew: true, truncated: false, status: 'pending', createdAt: at + 1 })
  // Retain a stale in-progress row at settlement: root status, not todo counts,
  // determines whether this process-only feedback should remain on screen.
  todos.push({ id: `${id}-todo-done`, title: `第 ${seq} 轮：生成文件`, status: 'done', priority: 'medium' },
    { id: `${id}-todo-active`, title: `第 ${seq} 轮：核对文件`, status: 'in_progress', priority: 'medium' })
  return run
}
function closeStream(): void { stream?.end('data: [DONE]\n\n'); stream = undefined }
function publish(payload: ChatSsePayload): void {
  projection.push(payload)
  if (stream && !stream.destroyed && !stream.writableEnded) stream.write(`id: ${current.runId}:${projection.length}\ndata: ${JSON.stringify(payload)}\n\n`)
}
function transition(status: RootRun['status']): void {
  current = { ...current, status, version: current.version + 1, updatedAt: Date.now(),
    ...(['running', 'waiting'].includes(status) ? {} : { finishedAt: Date.now() }) }
  runs[runs.length - 1] = current
  for (const [key, value] of admissions) if (value.run.runId === current.runId) admissions.set(key, { ...value, run: current })
  publish({ run: current })
  if (!active()) closeStream()
}
function publishDelivery(): FinalResult {
  const result: FinalResult = { schemaVersion: 1, sessionId, runId: current.runId, turnId: current.turnId,
    assistantMessageId: current.assistantMessageId, text: '结果已准备，仍在收尾。', publishedAt: Date.now(),
    items: [{ id: `${current.runId}-item`, assetId: `${current.runId}-asset`, path: 'report.txt', name: 'report.txt',
      kind: 'file', mimeType: 'text/plain', size: 6, sha256: 'a'.repeat(64) }] }
  const row = history.find(item => item.id === current.assistantMessageId)!
  row.metadata = { ...row.metadata, finalResult: result }
  publish({ finalResult: result })
  return result
}
function reset(): void {
  closeStream(); generation++; runs.length = 0; history.length = 0; changes.length = 0; projection.length = 0; todos.length = 0; admissions.clear()
  current = appendRun('succeeded', '已完成的旧轮次')
}
reset()

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  let raw = ''; for await (const chunk of request) raw += chunk.toString()
  const parsed: unknown = raw ? JSON.parse(raw) : {}, input = record(parsed) ? parsed : {}
  if (path === '/api/v1/chat/admission/context') {
    const owned = id === sessionId ? { ...current, attemptId: `attempt-${current.runId}` } : null
    response.end(envelope({ protocolVersion: 1, tenantId: 'visibility-tenant', sessionId: id,
      namespace: { id: 'visibility-db', generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 },
      root: owned, predecessor: owned ? { runId: owned.runId, attemptId: owned.attemptId, version: owned.version } : null })); return
  }
  if (path === '/api/v1/chat/admission/receipt') {
    const accepted = admissions.get(String(input.requestKey))
    response.end(envelope(accepted ? { protocolVersion: 1, status: 'accepted', receipt: { ...accepted.admission, sessionId,
      rootRunId: accepted.run.runId, turnId: accepted.run.turnId, userMessageId: accepted.run.userMessageId, assistantMessageId: accepted.run.assistantMessageId },
      run: accepted.run, projection: { rootVersion: accepted.run.version, rootAttemptId: `attempt-${accepted.run.runId}`,
        user: { messageId: accepted.run.userMessageId, state: 'projected' }, assistant: { anchorMessageId: accepted.run.assistantMessageId, state: 'persisted', messageId: accepted.run.assistantMessageId } } }
      : { protocolVersion: 1, status: 'absent', namespace: input.namespace, sessionId: input.sessionId, requestKey: input.requestKey })); return
  }
  if (path === '/api/v1/chat' && request.method === 'POST') {
    if (input.sessionId !== sessionId || typeof input.message !== 'string' || active()) throw new Error('Unexpected result fixture send')
    chats.push(input); current = appendRun('running', input.message); projection.length = 0
    if (record(input.admission)) admissions.set(String(input.admission.requestKey), { admission: input.admission, run: current })
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); stream = response
    response.once('close', () => { if (stream === response) stream = undefined })
    publish({ run: current }); publish({ userMessage: history.at(-2)! }); publish({ content: `RESULT_CONTENT_${current.seq}` })
    publish({ todo: { todos: [...todos], runId: current.runId, turnId: current.turnId } })
    response.flushHeaders(); return
  }
  if (path === '/api/v1/chat/stream') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    if (id === sessionId && active()) {
      stream = response; response.once('close', () => { if (stream === response) stream = undefined }); response.flushHeaders()
    } else response.end('data: [DONE]\n\n')
    return
  }
  if (path === '/api/v1/changes') { const rows = id === sessionId ? changes : []; changeReads.push(rows.map(item => item.runId!)); response.end(envelope(rows)); return }
  if (path === '/api/v1/workspace/bind') { response.end(envelope({ workspaceRoot })); return }
  const matching = id === sessionId, rows = matching ? history : []
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows, loadedTurnIds: users.map(row => row.id),
      revision: `visibility-${generation}-${rows.length}-${current.version}`, mutationRevision: `visibility-${generation}`, backend: 'jsonl', completeness: 'complete' })); return
  }
  if (['/api/v1/cron/capabilities', '/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET') throw new Error(`Unexpected mutation ${request.method} ${path}`)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'e'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'result-visibility' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '成果时机测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: matching && active() ? 'live' : 'persisted',
      eventId: matching && projection.length ? `${current.runId}:${projection.length}` : null, finished: !matching || !active(),
      history: rows, projection: matching ? projection : [], run: matching ? current : undefined, runs: matching ? runs : [], subagentRuns: [], todos: matching ? todos : [], changes: matching ? changes : [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: matching && active(), finished: !matching || !active(), run: matching ? current : undefined, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: matching ? runs : [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: current.updatedAt, messageCount: history.length }]
    : path === '/api/v1/workspace/directory' ? { root: workspaceRoot, bindingEpoch: 'visibility-binding', entries: [] }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/command-jobs' ? { jobs: [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const work = (): Locator => page.locator('.work-view')
const turn = (run: RootRun): Locator => work().locator(`.work-conversation-turn[data-turn-id="message:${run.userMessageId}"]`)
const card = (run: RootRun): Locator => turn(run).getByRole('region', { name: '本轮成果摘要', exact: true })
const taskList = (run: RootRun): Locator => turn(run).getByRole('region', { name: '任务清单', exact: true })
const taskLists = (): Locator => work().getByRole('region', { name: '任务清单', exact: true })
async function begin(prompt: string): Promise<RootRun> {
  const before = chats.length
  await work().getByRole('textbox', { name: '继续对话', exact: true }).fill(prompt)
  const send = work().getByRole('button', { name: '发送', exact: true }); await expect(send).toBeEnabled(); await send.click()
  await expect.poll(() => chats.length).toBe(before + 1)
  await expect(turn(current)).toContainText(`RESULT_CONTENT_${current.seq}`)
  await expect.poll(() => changeReads.some(ids => ids.includes(current.runId))).toBe(true)
  await expect(taskList(current)).toBeVisible()
  await expect(taskLists()).toHaveCount(1)
  return { ...current }
}

test.describe.serial('本轮成果只在运行结束后显示', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'result-visibility-profile-'))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    storageKey = 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin }))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, remoteWorkspaceRoot: workspaceRoot,
      autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
    const env = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 1000); window.show(); window.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  })
  test.beforeEach(async () => {
    reset()
    await page.evaluate(({ key, sessionId, title, modelId, workspaceRoot }) => {
      localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'done', draft: '', mentions: [],
        createdAt: Date.now(), updatedAt: Date.now(), workspacePath: workspaceRoot, modelId, attachments: [], sources: [] }], activeTaskId: sessionId }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
    }, { key: storageKey, sessionId, title, modelId, workspaceRoot })
    await page.reload(); await expect(work().getByRole('heading', { name: title, exact: true })).toBeVisible()
    await expect(card(runs[0])).toBeVisible()
    await expect(taskLists()).toHaveCount(0)
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && page && !page.isClosed()) {
      const path = info.outputPath('result-visibility-failure.png'); await page.screenshot({ path }); await info.attach('失败页面', { path, contentType: 'image/png' })
    }
    await info.attach('app-errors', { body: JSON.stringify({ errors, chats, changeReads }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([])
  })
  test.afterAll(async () => {
    closeStream()
    try { await app?.close() } finally {
      server.closeAllConnections(); if (server.listening) await new Promise<void>(done => server.close(() => done()))
      if (fixture) { const target = resolve(fixture); if (dirname(target) !== fixtureRoot || !basename(target).startsWith('result-visibility-profile-')) throw new Error('Unsafe result fixture cleanup')
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    }
  })

  test('运行和等待期间隐藏本轮成果，完成后显示且旧轮一直保留', async () => {
    const old = runs[0], run = await begin('继续生成本轮文件')
    await expect(card(run)).toHaveCount(0); await expect(card(old)).toBeVisible()
    transition('waiting'); await expect(work().locator('.work-task-heading__actions')).toContainText('待处理')
    await expect(card(run)).toHaveCount(0); await expect(card(old)).toBeVisible()
    await expect(taskList(run)).toBeVisible()
    transition('running'); await expect(work().locator('.work-task-heading__actions')).toContainText('进行中')
    await expect(card(run)).toHaveCount(0)
    transition('succeeded'); await expect(card(run)).toBeVisible(); await expect(card(old)).toBeVisible()
    await expect(taskLists()).toHaveCount(0)
    await expect(card(run)).toContainText('1 个文件')
    await card(run).getByRole('button', { name: '展开成果文件列表，共 1 个文件', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(card(run).getByRole('button', { name: /result-2\.txt/ })).toBeVisible()
    await page.reload(); await expect(card(run)).toBeVisible(); await expect(card(old)).toBeVisible()
    await expect(taskLists()).toHaveCount(0)
  })

  test('失败和停止后仍显示已有成果，提前发布的交付物也等待本轮结束', async () => {
    const completed = [runs[0]]
    for (const status of ['failed', 'cancelled'] as const) {
      const run = await begin(`核对终态 ${status}`)
      await expect(card(run)).toHaveCount(0)
      for (const old of completed) await expect(card(old)).toBeVisible()
      transition(status); await expect(card(run)).toBeVisible(); completed.push(run)
      await expect(taskLists()).toHaveCount(0)
    }
    const run = await begin('先发布文件，再完成收尾')
    publishDelivery()
    publish({ content: 'DELIVERY_PUBLISHED_WHILE_RUNNING' })
    await expect(turn(run)).toContainText('DELIVERY_PUBLISHED_WHILE_RUNNING')
    await expect(turn(run).locator('.work-final-deliverables')).toHaveCount(0)
    await expect(card(run)).toHaveCount(0)
    await expect(taskList(run)).toBeVisible()
    for (const old of completed) await expect(card(old)).toBeVisible()
    transition('succeeded')
    await expect(turn(run).getByRole('region', { name: '最终交付物', exact: true })).toBeVisible()
    await expect(turn(run).getByRole('button', { name: '预览 report.txt', exact: true })).toBeVisible()
    await expect(card(run)).toBeVisible()
    await expect(card(run)).toContainText('1 个文件')
    await expect(taskLists()).toHaveCount(0)
    await page.reload()
    await expect(turn(run).getByRole('region', { name: '最终交付物', exact: true })).toBeVisible()
    await expect(card(run)).toBeVisible()
    for (const old of completed) await expect(card(old)).toBeVisible()
    await expect(taskLists()).toHaveCount(0)
  })

  test('单文件成果没有重复底栏，标题直达且待确认按钮完整可点击', async ({}, info) => {
    const run = { ...current }
    changes[0] = { ...changes[0], path: workspaceRoot + '/办公验收/第6轮/围棋Web项目介绍-客户版.pptx',
      isNew: false, oldContent: null, newContent: null, oldHash: 'a'.repeat(64), newHash: 'b'.repeat(64), truncated: true }
    await page.reload()
    const summary = card(run), toggle = summary.locator('.work-progress-panel__changes-toggle')
    await expect(summary).toBeVisible()
    await toggle.focus(); await page.keyboard.press('Enter')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(summary.locator('.work-progress-panel__footer')).toHaveCount(0)
    const file = summary.locator('.work-progress-panel__file')
    await expect(file).toContainText('围棋Web项目介绍-客户版.pptx')
    await expect(file.locator('.tree-row__glyph')).toHaveCount(1)
    await expect(file.locator('[data-change-code="M"]')).toHaveText('M')
    const pending = summary.getByRole('button', { name: '查看本轮成果，1 个文件待确认', exact: true })
    await expect(pending.locator('svg')).toHaveCount(1)
    expect(await pending.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
    expect((await pending.boundingBox())!.height).toBeGreaterThanOrEqual(30)
    for (const theme of ['light', 'dark'] as const) for (const width of [1440, 720]) {
      await app!.evaluate(({ BrowserWindow }, width) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(520, 600); win.setContentSize(width, 900) }, width)
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
      if (await page.locator('html').getAttribute('data-appearance') !== theme) {
        await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
        const settings = page.getByRole('dialog', { name: '设置', exact: true })
        await settings.getByRole('tab', { name: '外观', exact: true }).click()
        await settings.getByRole('group', { name: '主题', exact: true }).getByRole('radio', { name: theme === 'dark' ? '深色' : '浅色', exact: true }).click()
        await page.keyboard.press('Escape'); await expect(settings).toBeHidden()
      }
      await expect(page.locator('html')).toHaveAttribute('data-appearance', theme)
      await summary.scrollIntoViewIfNeeded()
      expect(await summary.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)
      await toggle.hover({ position: { x: 8, y: 12 } })
      expect(await toggle.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
      expect(await toggle.evaluate(node => getComputedStyle(node).cursor)).toBe('default')
      expect(await summary.locator('.work-progress-panel__review-summary').evaluate(node => getComputedStyle(node).cursor)).toBe('default')
      const path = info.outputPath('single-result-' + theme + '-' + width + '.png')
      await page.mouse.move(4, 4)
      await page.screenshot({ path, animations: 'disabled' })
      await info.attach('单文件成果 ' + theme + ' ' + width, { path, contentType: 'image/png' })
    }
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
    await summary.getByRole('button', { name: '撤回本轮成果', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: '撤回本轮成果', exact: true })
    await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    await expect(confirmation).toBeHidden()
    expect(changes[0].status).toBe('pending')
    await toggle.focus(); await page.keyboard.press('Enter')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await pending.click()
    await expect(page.getByRole('region', { name: '本会话成果与改动', exact: true })).toBeVisible()
    // Opening review is distinct from the disclosure and preserves its state.
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await page.reload()
    await expect(summary).toBeVisible()
    await summary.getByRole('button', { name: '查看本轮全部成果', exact: true }).click()
    await expect(page.getByRole('region', { name: '本会话成果与改动', exact: true })).toBeVisible()
  })

  test('二进制文件用 U M D 标识，同轮新增后删除的文件不出现在摘要', async () => {
    const original = changes[0], run = { ...current }
    changes.length = 0
    changes.push(
      { ...original, id: original.id + '-u', path: workspaceRoot + '/新增.png', oldContent: null, newContent: null, oldHash: 'missing', newHash: 'a'.repeat(64), isNew: true, truncated: true },
      { ...original, id: original.id + '-m', path: workspaceRoot + '/修改.pptx', oldContent: null, newContent: null, oldHash: 'a'.repeat(64), newHash: 'b'.repeat(64), isNew: false, truncated: true },
      { ...original, id: original.id + '-d', path: workspaceRoot + '/删除.pdf', kind: 'delete', oldContent: null, newContent: null, oldHash: 'a'.repeat(64), newHash: 'missing', isNew: false, truncated: true },
      { ...original, id: original.id + '-temp-u', path: workspaceRoot + '/临时.png', oldContent: null, newContent: null, oldHash: 'missing', newHash: 'a'.repeat(64), isNew: true, truncated: true, seq: 4 },
      { ...original, id: original.id + '-temp-d', path: workspaceRoot + '/临时.png', kind: 'delete', oldContent: null, newContent: null, oldHash: 'a'.repeat(64), newHash: 'missing', isNew: false, truncated: true, seq: 5, createdAt: original.createdAt + 1 }
    )
    await page.reload()
    await expect(card(run)).toContainText('3 个文件')
    await card(run).locator('.work-progress-panel__changes-toggle').focus(); await page.keyboard.press('Enter')
    await expect(card(run).locator('.work-progress-panel__file')).toHaveCount(3)
    for (const code of ['U', 'M', 'D']) await expect(card(run).locator('[data-change-code="' + code + '"]')).toHaveText(code)
    await expect(card(run)).not.toContainText('临时.png')
    await expect(card(run).locator('.work-progress-panel__footer')).toHaveCount(0)
  })

  test('仅有已发布交付物的一轮历史仍读取成果记录并显示摘要', async ({}, info) => {
    // A fresh renderer with only a manifest-bearing turn must start its own
    // ledger reader; an older legacy turn must not accidentally keep it alive.
    reset()
    publishDelivery()
    projection.length = 0
    const originalChange = changes[0]
    for (let index = 1; index <= 6; index++) changes.push({ ...originalChange, id: `${originalChange.id}-extra-${index}`,
      path: index === 6
        ? `${workspaceRoot}/交付/${'详细验收资料目录/'.repeat(14)}${'界面验收说明-'.repeat(24)}.md`
        : `${workspaceRoot}/delivery/review-${index}/result-${index + 1}.txt`,
      createdAt: originalChange.createdAt + index })
    const run = { ...current }, beforeReads = changeReads.length
    await page.reload()
    await expect(work().locator('.work-conversation-turn')).toHaveCount(1)
    await expect(turn(run).getByRole('region', { name: '最终交付物', exact: true })).toBeVisible()
    await expect.poll(() => changeReads.slice(beforeReads).some(ids => ids.length === 7 && ids.every(id => id === run.runId))).toBe(true)
    await expect(card(run)).toBeVisible()
    await expect(card(run)).toContainText('7 个文件')
    await expect(taskLists()).toHaveCount(0)
    await card(run).getByRole('button', { name: '展开成果文件列表，共 7 个文件', exact: true }).focus()
    await page.keyboard.press('Enter')
    const rows = card(run).locator('.work-progress-panel__files > li')
    await expect(rows).toHaveCount(5)
    await expect(card(run)).toContainText('还有 2 个文件')
    await expect(rows.first().locator('.work-progress-panel__file-name')).toHaveText(`${'界面验收说明-'.repeat(24)}.md`)
    for (const width of [1440, 720]) {
      await app!.evaluate(({ BrowserWindow }, width) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(520, 600); window.setContentSize(width, 1000) }, width)
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
      await card(run).scrollIntoViewIfNeeded()
      const layout = await rows.evaluateAll(elements => elements.map(element => {
        const name = element.querySelector<HTMLElement>('.work-progress-panel__file-name')!, path = element.querySelector<HTMLElement>('.work-progress-panel__file-path')!
        const nameRect = name.getBoundingClientRect(), pathRect = path.getBoundingClientRect(), button = element.querySelector('button')!
        return { leftDelta: Math.abs(nameRect.left - pathRect.left),
          gap: pathRect.top - nameRect.bottom, overflow: button.scrollWidth - button.clientWidth,
          nameClipped: name.scrollWidth > name.clientWidth, pathClipped: path.scrollWidth > path.clientWidth,
          nameEllipsis: getComputedStyle(name).textOverflow, pathEllipsis: getComputedStyle(path).textOverflow }
      }))
      for (const row of layout) { expect(row.leftDelta).toBeLessThanOrEqual(2); expect(row.gap).toBeGreaterThanOrEqual(0); expect(row.overflow).toBeLessThanOrEqual(1) }
      expect(layout[0]).toMatchObject({ nameClipped: true, pathClipped: true, nameEllipsis: 'ellipsis', pathEllipsis: 'ellipsis' })
    }
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 1000))
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1440)
    const path = info.outputPath('published-delivery-with-result-summary.png')
    await page.mouse.move(4, 4)
    await page.screenshot({ path, animations: 'disabled' })
    await info.attach('交付物与成果摘要', { path, contentType: 'image/png' })
  })
})
