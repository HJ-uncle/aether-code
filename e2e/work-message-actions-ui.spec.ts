/** Real Electron + controlled HTTP/SSE: user-message actions mutate authoritative history by stable IDs. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'
import type { RootRun } from '../src/shared/root-run'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { AetherIdeApi } from '../src/preload'
import { monitorElectronHealth } from './helpers/electron-health'

declare global { interface Window { aether: AetherIdeApi } }

const root = resolve(__dirname, '..'), token = 'work-message-actions-fixture-token', model = 'work-actions-fixture-model'
const actionNames = ['添加到对话', '重新发起', '从此处重新编辑', '回退文件', '复制', '删除本轮'] as const
const mutationNames = ['重新发起', '从此处重新编辑', '回退文件', '删除本轮'] as const
const originalAttachment = { name: '.ae/attachments/original-actions.txt', type: 'text/plain' }
const laterAttachment = { path: '.ae/attachments/later-actions.txt', name: 'later-actions.txt', type: 'text/plain', size: 4 }
type Turn = { run: RootRun; prompt: string; response: string; attachments: Array<{ name: string; type: string }> }
type Session = { id: string; turns: Turn[]; seq: number; readers: Set<ServerResponse> }
type Call = { method: string; path: string; sessionId: string; body: Record<string, unknown> }
const sessions = new Map<string, Session>(), calls: Call[] = [], errors: string[] = []
let app: ElectronApplication | undefined, page: Page, health: Awaited<ReturnType<typeof monitorElectronHealth>> | undefined
let fixture = '', source = '', scenario = 0, rejectTruncate = false, revertConflict = false
let historyMutationGate: Promise<void> | undefined
let releaseHistoryMutation = (): void => {}
let snapshotGate: { sessionId: string; entered: boolean; promise: Promise<void>; release: () => void } | undefined
const envelope = (data: unknown) => JSON.stringify({ code: 200, message: 'ok', data })
const latest = (session: Session | undefined) => session?.turns.at(-1)
const active = (session: Session | undefined) => latest(session)?.run.status === 'running'
function turn(id: string, index: number, prompt: string, status: RootRun['status'] = 'succeeded', attachments: Turn['attachments'] = []): Turn {
  const now = Date.now() - 10_000 + index * 1000
  return { prompt, response: `已完成：${prompt}`, attachments, run: {
    schemaVersion: 1, runId: `run-${id}-${index}`, sessionId: id, turnId: `turn-${id}-${index}`,
    userMessageId: `user-${id}-${index}`, assistantMessageId: `assistant-${id}-${index}`,
    status, seq: index, version: 1, modelId: model, pending: [], workspacePaths: [], createdAt: now, updatedAt: now,
    ...(status === 'running' ? {} : { finishedAt: now + 100 })
  } }
}
function user(value: Turn) {
  return { id: value.run.userMessageId, role: 'user', content: value.prompt, conversationId: value.run.turnId,
    createdAt: value.run.createdAt, metadata: { rootRunId: value.run.runId, attachments: value.attachments } }
}
function history(session: Session | undefined) {
  return session?.turns.flatMap(value => [user(value), {
    id: value.run.assistantMessageId, role: 'assistant', content: value.response, conversationId: value.run.turnId,
    createdAt: value.run.createdAt + 1, metadata: { rootRunId: value.run.runId }
  }]) ?? []
}
function snapshot(id: string) {
  const session = sessions.get(id), last = latest(session)
  return { schemaVersion: 1, sessionId: id, source: active(session) ? 'live' : 'persisted', finished: !active(session),
    eventId: last ? `${last.run.runId}:${session!.seq}` : null, run: last?.run,
    runs: session?.turns.map(value => value.run) ?? [], history: history(session), projection: [], todos: [], changes: [], commandJobs: [] }
}
function attach(session: Session, response: ServerResponse) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  response.write(': connected\n\n'); session.readers.add(response)
  response.on('close', () => session.readers.delete(response))
}
function emit(session: Session, payload: ChatSsePayload) {
  const last = latest(session)!
  for (const response of session.readers) response.write(`id: ${last.run.runId}:${++session.seq}\ndata: ${JSON.stringify(payload)}\n\n`)
}
function finish(session: Session) {
  const value = latest(session)!
  value.run = { ...value.run, status: 'succeeded', version: value.run.version + 1, updatedAt: Date.now(), finishedAt: Date.now() }
  emit(session, { run: value.run })
  for (const response of session.readers) response.end('data: [DONE]\n\n')
}
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, method = request.method ?? 'GET'
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) { response.writeHead(401).end(); return }
    let raw = ''; for await (const chunk of request) raw += String(chunk)
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    const id = String(body.sessionId ?? url.searchParams.get('sessionId') ?? ''), session = sessions.get(id)
    if (method !== 'GET') calls.push({ method, path, sessionId: id, body: structuredClone(body) })
    if (path === '/api/v1/chat' && method === 'POST') {
      if (!session) throw new Error(`Unknown fixture session: ${id}`)
      const value = turn(id, 100 + calls.length, String(body.message), 'running', (body.attachments ?? []) as Turn['attachments'])
      value.run = { ...value.run, seq: Math.max(0, ...session.turns.map(item => item.run.seq)) + 1,
        createdAt: Date.now(), updatedAt: Date.now(), startedAt: Date.now() }
      session.turns.push(value); attach(session, response)
      emit(session, { run: value.run }); emit(session, { userMessage: user(value) }); emit(session, { content: value.response }); return
    }
    if (path === '/api/v1/chat/stream') {
      if (session && active(session)) attach(session, response)
      else response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n')
      return
    }
    response.setHeader('content-type', 'application/json')
    if (path === '/api/v1/conversation/truncate' && method === 'POST') {
      await historyMutationGate
      if (rejectTruncate) {
        response.writeHead(409).end(JSON.stringify({ code: 40900, message: '测试截断被拒绝，历史保持原样', data: null })); return
      }
      const index = session?.turns.findIndex(value => value.run.userMessageId === body.messageId) ?? -1
      if (!session || index < 0) throw new Error('Truncate used a missing or non-user message ID')
      const removed = session.turns.splice(index).length * 2
      response.end(envelope({ removed })); return
    }
    if (path.startsWith('/api/v1/conversation/turns/') && method === 'DELETE') {
      const turnId = decodeURIComponent(path.slice('/api/v1/conversation/turns/'.length))
      const index = session?.turns.findIndex(value => value.run.turnId === turnId) ?? -1
      if (!session || index < 0) throw new Error('Delete used an unknown turn ID')
      session.turns.splice(index, 1); response.end(envelope({ removed: 2 })); return
    }
    if (path === '/api/v1/changes/revert-batch' && method === 'POST') {
      await historyMutationGate
      const conflict = revertConflict
      response.end(envelope({ results: [{ id: 'fixture-change', path: 'project.txt', status: conflict ? 'conflict' : 'reverted',
        message: conflict ? '文件有后续手动修改' : undefined }], total: 1, reverted: conflict ? 0 : 1, conflicts: conflict ? 1 : 0, unavailable: 0, failed: 0 })); return
    }
    if (path === '/api/v1/chat/admission/context') {
      const current = latest(session)?.run, run = current ? { ...current, attemptId: 'attempt-' + current.runId } : null
      response.end(envelope({ protocolVersion: 1, tenantId: 'fixture', sessionId: id, namespace: { id: 'fixture', generation: 'one' },
        transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: run,
        predecessor: run ? { runId: run.runId, attemptId: run.attemptId, version: run.version } : null })); return
    }
    if (path === '/api/v1/subagent/capabilities') { response.end(envelope({ schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true })); return }
    if (path === '/api/v1/subagent/runs') { response.end(envelope({ schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'fixture' })); return }
    if (path === '/api/v1/cron/capabilities') { response.writeHead(404).end(); return }
    if (path === '/api/v1/chat/snapshot' && snapshotGate?.sessionId === id) {
      snapshotGate.entered = true
      await snapshotGate.promise
    }
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: 'sha256:' + 'a'.repeat(64), protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'work-message-actions' }
      : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '消息操作测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
      : path === '/api/v1/chat/snapshot' ? snapshot(id)
      : path === '/api/v1/chat/status' ? { run: latest(session)?.run, running: active(session), finished: !active(session) }
      : path === '/api/v1/chat/runs' ? { runs: session?.turns.map(value => value.run) ?? [] }
      : path === '/api/v1/conversation/history' ? history(session)
      : path === '/api/v1/conversation/sessions' ? [...sessions.values()].map(value => ({ sessionId: value.id, title: '消息操作测试', lastAt: latest(value)?.run.updatedAt, messageCount: value.turns.length * 2 }))
      : path === '/api/v1/security/mode' ? { sessionId: id, mode: 'standard' }
      : path === '/api/v1/workspace/directory' ? { root: '/remote/actions', entries: [] }
      : []
    response.end(envelope(data))
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})

const work = () => page.locator('.work-view')
const input = () => work().getByRole('textbox', { name: '继续对话', exact: true })
const message = (value: Turn) => work().locator(`[data-message-id="${value.run.userMessageId}"]`)
const actions = (value: Turn) => message(value).getByRole('group', { name: '用户消息操作', exact: true })
const sidebarStatus = (id: string) => work().locator(`.work-sidebar__task-row[data-task-id="${id}"] [data-task-status]`)
const storedTask = (id: string) => page.evaluate(({ key, id }) => {
  const state = JSON.parse(localStorage.getItem(key) ?? '{}') as { tasks?: Array<{ id: string; status: string; activity?: { runId: string; seq: number } }> }
  return state.tasks?.find(task => task.id === id)
}, { key: 'aether.work.state.v1:' + encodeURIComponent(source), id })
const mutations = () => calls.filter(call => call.path === '/api/v1/chat' || call.path === '/api/v1/conversation/truncate'
  || call.path === '/api/v1/changes/revert-batch' || call.path.startsWith('/api/v1/conversation/turns/'))
async function confirm(value: Turn, name: typeof mutationNames[number], accept = true) {
  await actions(value).getByRole('button', { name, exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await (accept ? dialog.locator('button.btn--primary') : dialog.getByRole('button', { name: '取消', exact: true })).click()
  await expect(dialog).toHaveCount(0)
}
async function installScenario(options: { running?: boolean; draft?: string; failedLast?: boolean } = {}) {
  const id = `work-message-actions-${++scenario}`
  const turns = [turn(id, 1, '保留最早的要求'), turn(id, 2, '修改目标项目并检查结果', 'succeeded', [originalAttachment]),
    turn(id, 3, '保留后续的讨论', options.running ? 'running' : options.failedLast ? 'failed' : 'succeeded')]
  const session: Session = { id, turns, seq: 1, readers: new Set() }; sessions.set(id, session)
  const task = { id, title: '消息操作测试', status: options.running ? 'running' : options.failedLast ? 'error' : 'done', draft: options.draft ?? '尚未发送的新草稿',
    createdAt: Date.now(), updatedAt: Date.now(), workspacePath: null, modelId: model, attachments: [laterAttachment], sources: [] }
  await page.evaluate(({ key, task }) => localStorage.setItem(key, JSON.stringify({ tasks: [task], activeTaskId: task.id })),
    { key: 'aether.work.state.v1:' + encodeURIComponent(source), task })
  await page.reload()
  await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
  await expect(message(turns[1])).toBeVisible()
  await expect(actions(turns[1])).toBeVisible()
  await expect(input()).toHaveText(task.draft)
  return { session, first: turns[0], target: turns[1], last: turns[2], task }
}

test.describe('Work 用户消息操作', () => {
  test.beforeAll(async () => {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`; source = engineStorageKey({ mode: 'remote', baseUrl: origin })
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true }); fixture = mkdtempSync(join(root, '.e2e-tmp', 'work-message-actions-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin,
      autoStartEngine: true, lastModelId: model, appearance: 'light' }))
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', '--user-data-dir=' + fixture], cwd: root,
      env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    health = await monitorElectronHealth(app, 'work-message-actions', [token])
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  })
  test.beforeEach(() => { calls.length = 0; errors.length = 0; rejectTruncate = false; revertConflict = false; historyMutationGate = undefined; snapshotGate = undefined })
  test.afterEach(() => {
    releaseHistoryMutation()
    snapshotGate?.release()
    for (const session of sessions.values()) {
      if (active(session)) finish(session)
      for (const response of session.readers) response.destroy()
    }
    health?.assertHealthy(); expect(errors).toEqual([])
  })
  test.afterAll(async ({}, info) => {
    try { if (health) await health.closeAndAssert(info); else await app?.close() }
    finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
  })

  test('六个入口可见，回填保留新草稿与附件且重复操作不重复，复制正文成功', async ({}, info) => {
    const { target, task } = await installScenario()
    for (const name of actionNames) await expect(actions(target).getByRole('button', { name, exact: true })).toBeVisible()
    const add = actions(target).getByRole('button', { name: '添加到对话', exact: true })
    const expected = `${task.draft}\n\n${target.prompt}`
    await add.click(); await expect(input()).toHaveText(expected); await expect(input()).toBeFocused()
    await add.click(); await expect(input()).toHaveText(expected)
    for (const name of ['original-actions.txt', laterAttachment.name]) await expect(work().locator('.work-composer').getByText(name, { exact: true })).toHaveCount(1)
    await page.reload(); await expect(input()).toHaveText(expected)
    await actions(target).getByRole('button', { name: '添加到对话', exact: true }).click()
    await expect(input()).toHaveText(expected)
    await actions(target).getByRole('button', { name: '复制', exact: true }).click()
    await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(target.prompt)
    expect(mutations()).toEqual([])
    await message(target).hover()
    await page.screenshot({ path: info.outputPath('work-message-actions-light.png'), animations: 'disabled' })
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    await page.getByRole('tab', { name: '外观', exact: true }).click()
    await page.getByRole('radio', { name: '深色', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark')
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await message(target).hover()
    await page.screenshot({ path: info.outputPath('work-message-actions-dark.png'), animations: 'disabled' })
  })

  test('取消四项历史变更均不发请求，原消息和新草稿保留', async () => {
    const { target, first, last, task } = await installScenario()
    for (const name of mutationNames) await confirm(target, name, false)
    expect(mutations()).toEqual([])
    for (const value of [first, target, last]) await expect(message(value)).toBeVisible()
    await expect(input()).toHaveText(task.draft)
  })

  test('重新发起按稳定消息ID截断后发送原文附件，当前草稿不被覆盖', async () => {
    const { session, target, first, last, task } = await installScenario()
    await confirm(target, '重新发起')
    await expect.poll(() => mutations().map(call => call.path)).toEqual(['/api/v1/conversation/truncate', '/api/v1/chat'])
    expect(mutations()[0].body).toEqual({ sessionId: session.id, messageId: target.run.userMessageId })
    expect(mutations()[1].body).toMatchObject({ sessionId: session.id, message: target.prompt, attachments: [originalAttachment] })
    await expect(message(first)).toBeVisible(); await expect(message(target)).toHaveCount(0); await expect(message(last)).toHaveCount(0)
    await expect(input()).toHaveText(task.draft)
    const replacement = latest(session)!
    expect(replacement.run.seq).toBe(first.run.seq + 1)
    expect(replacement.run.seq).toBeLessThan(last.run.seq)
    await expect(sidebarStatus(session.id)).toHaveAttribute('data-task-status', 'running')
    await expect.poll(async () => (await storedTask(session.id))?.activity?.runId).toBe(replacement.run.runId)
    await expect(actions(first).getByRole('button', { name: '添加到对话', exact: true })).toBeEnabled()
    for (const name of mutationNames) await expect(actions(first).getByRole('button', { name, exact: true })).toBeDisabled()
    finish(session)
    await expect(sidebarStatus(session.id)).toHaveAttribute('data-task-status', 'done')
    await expect(page.getByRole('button', { name: '停止任务', exact: true })).toHaveCount(0)
    await page.reload()
    await expect(message(replacement)).toBeVisible(); await expect(message(first)).toBeVisible()
    await expect(message(last)).toHaveCount(0); await expect(input()).toHaveText(task.draft)
  })

  test('从此处重新编辑仅截断目标及后续，回填正文附件但不自动发送', async () => {
    const { session, target, first, last, task } = await installScenario()
    await confirm(target, '从此处重新编辑')
    await expect.poll(() => mutations().length).toBe(1)
    expect(mutations()[0]).toMatchObject({ method: 'POST', path: '/api/v1/conversation/truncate', body: { sessionId: session.id, messageId: target.run.userMessageId } })
    await expect(message(first)).toBeVisible(); await expect(message(target)).toHaveCount(0); await expect(message(last)).toHaveCount(0)
    await expect(input()).toHaveText(`${task.draft}\n\n${target.prompt}`); await expect(input()).toBeFocused()
    await expect(work().locator('.work-composer').getByText('original-actions.txt', { exact: true })).toHaveCount(1)
    await page.reload()
    await expect(message(first)).toBeVisible(); await expect(message(target)).toHaveCount(0)
    await expect(input()).toHaveText(`${task.draft}\n\n${target.prompt}`)
    expect(mutations()).toHaveLength(1)
  })

  test('服务端拒绝截断时保留全部历史和草稿，不重发也不伪装成功', async () => {
    const { target, first, last, task } = await installScenario()
    rejectTruncate = true
    await confirm(target, '从此处重新编辑')
    await expect.poll(() => mutations().length).toBe(1)
    await expect(page.getByText(/测试截断被拒绝/).last()).toBeVisible()
    for (const value of [first, target, last]) await expect(message(value)).toBeVisible()
    await expect(input()).toHaveText(task.draft)
    await page.reload()
    for (const value of [first, target, last]) await expect(message(value)).toBeVisible()
    expect(mutations().some(call => call.path === '/api/v1/chat')).toBe(false)
  })

  test('删除仅删除目标轮，保留前后轮次，刷新后不会复活', async () => {
    const { session, target, first, last, task } = await installScenario()
    await confirm(target, '删除本轮')
    await expect.poll(() => mutations().length).toBe(1)
    expect(mutations()[0]).toMatchObject({ method: 'DELETE', sessionId: session.id,
      path: `/api/v1/conversation/turns/${encodeURIComponent(target.run.turnId)}` })
    await expect(message(target)).toHaveCount(0)
    for (const value of [first, last]) await expect(message(value)).toBeVisible()
    await expect(input()).toHaveText(task.draft)
    await page.reload()
    await expect(message(target)).toHaveCount(0)
    for (const value of [first, last]) await expect(message(value)).toBeVisible()
    expect(session.turns.map(value => value.run.turnId)).toEqual([first.run.turnId, last.run.turnId])
  })

  test('删除失败末轮时延迟恢复不重建旧状态，较低序号恢复完成且删空后回草稿', async ({}, info) => {
    const { session, first, target, last, task } = await installScenario({ failedLast: true })
    await expect(sidebarStatus(session.id)).toHaveAttribute('data-task-status', 'error')
    await expect.poll(async () => (await storedTask(session.id))?.activity?.seq).toBe(last.run.seq)
    let release!: () => void
    snapshotGate = { sessionId: session.id, entered: false, promise: new Promise<void>(done => { release = done }), release: () => release() }
    await confirm(last, '删除本轮')
    await expect.poll(() => snapshotGate?.entered).toBe(true)
    expect(session.turns.map(item => item.run.seq)).toEqual([1, 2])
    await expect.poll(async () => (await storedTask(session.id))?.activity).toBeUndefined()
    // The server keeps recovery pending across a painted render. Old transcript
    // rows may remain visible, but cannot rebuild the deleted root watermark.
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
    expect((await storedTask(session.id))?.activity).toBeUndefined()
    snapshotGate.release(); snapshotGate = undefined
    await expect(sidebarStatus(session.id)).toHaveAttribute('data-task-status', 'done')
    await expect.poll(async () => (await storedTask(session.id))?.activity).toMatchObject({ runId: target.run.runId, seq: 2 })
    await expect(message(last)).toHaveCount(0)
    await confirm(target, '删除本轮')
    await expect.poll(async () => (await storedTask(session.id))?.activity).toMatchObject({ runId: first.run.runId, seq: 1 })
    await expect(sidebarStatus(session.id)).toHaveAttribute('data-task-status', 'done')
    await confirm(first, '删除本轮')
    await expect.poll(() => session.turns.length).toBe(0)
    await expect(sidebarStatus(session.id)).toHaveAttribute('data-task-status', 'draft')
    expect((await storedTask(session.id))?.activity).toBeUndefined()
    await expect(input()).toHaveText(task.draft)
    await page.screenshot({ path: info.outputPath('work-history-empty-draft.png') })
  })

  test('回退文件遇到冲突不截断；成功后按目标轮回退再截断并恢复草稿', async () => {
    const { session, target, first, last, task } = await installScenario()
    revertConflict = true
    await confirm(target, '回退文件')
    await expect.poll(() => mutations().length).toBe(1)
    expect(mutations()[0]).toMatchObject({ method: 'POST', path: '/api/v1/changes/revert-batch',
      body: { sessionId: session.id, scope: 'all', fromTurnId: target.run.turnId } })
    await expect(page.getByText(/对话历史已保留/).last()).toBeVisible()
    for (const value of [first, target, last]) await expect(message(value)).toBeVisible()
    await expect(input()).toHaveText(task.draft)
    revertConflict = false
    await confirm(target, '回退文件')
    await expect.poll(() => mutations().map(call => call.path)).toEqual(['/api/v1/changes/revert-batch', '/api/v1/changes/revert-batch', '/api/v1/conversation/truncate'])
    expect(mutations()[2].body).toEqual({ sessionId: session.id, messageId: target.run.userMessageId })
    await expect(message(first)).toBeVisible(); await expect(message(target)).toHaveCount(0); await expect(message(last)).toHaveCount(0)
    await expect(input()).toHaveText(`${task.draft}\n\n${target.prompt}`)
    await expect(work().locator('.work-composer').getByText('original-actions.txt', { exact: true })).toHaveCount(1)
  })

  test('运行中四项历史变更禁用，复制与添加到对话仍可使用', async () => {
    const { target, session, task } = await installScenario({ running: true })
    await expect(work().locator('.work-task-heading').getByRole('button', { name: '停止任务', exact: true })).toBeVisible()
    for (const name of mutationNames) await expect(actions(target).getByRole('button', { name, exact: true })).toBeDisabled()
    await expect(actions(target).getByRole('button', { name: '复制', exact: true })).toBeEnabled()
    await actions(target).getByRole('button', { name: '添加到对话', exact: true }).click()
    await expect(input()).toHaveText(`${task.draft}\n\n${target.prompt}`)
    expect(mutations()).toEqual([])
    finish(session)
  })

  test('回退期间离开又返回任务，重新读取权威历史且不回填旧草稿或误报成功', async () => {
    const { session, target, first, task } = await installScenario()
    historyMutationGate = new Promise<void>(resolve => { releaseHistoryMutation = resolve })
    await confirm(target, '回退文件')
    await expect.poll(() => mutations().map(call => call.path)).toEqual(['/api/v1/changes/revert-batch'])
    await work().getByRole('button', { name: '新任务', exact: true }).click()
    await expect(work().getByRole('textbox', { name: '任务目标', exact: true })).toBeVisible()
    await work().locator('.work-sidebar__task').filter({ hasText: task.title }).click()
    await expect(message(target)).toBeVisible()
    const newDraft = '返回任务后写的新要求'
    await input().fill(newDraft)
    releaseHistoryMutation()
    await expect.poll(() => session.turns.map(value => value.run.turnId)).toEqual([first.run.turnId])
    await expect(message(target)).toHaveCount(0)
    await expect(message(first)).toBeVisible()
    await expect(input()).toHaveText(newDraft)
    await expect(page.getByText('文件已回退，原指令已恢复', { exact: true })).toHaveCount(0)
  })

  test('Code 重新编辑等待截断时禁止发送和历史变更，保留最新草稿并恢复附件', async () => {
    const id = `code-message-actions-${++scenario}`, draft = 'Code 尚未发送的新草稿'
    const first = turn(id, 1, 'Code 保留最早要求')
    const target = turn(id, 2, 'Code 编辑原始要求', 'succeeded', [originalAttachment])
    const last = turn(id, 3, 'Code 删除后续讨论')
    const session: Session = { id, turns: [first, target, last], seq: 1, readers: new Set() }
    sessions.set(id, session)
    await page.evaluate(({ sessionKey, draftKey, id, draft }) => {
      localStorage.setItem(sessionKey, id)
      localStorage.setItem(draftKey, JSON.stringify({ [id]: { text: draft, mentions: [] } }))
    }, { sessionKey: sessionStorageKey('aether:lastSessionId', source), draftKey: sessionStorageKey('aether:chatDrafts', source), id, draft })
    await page.reload()
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    const code = page.locator('.mode-surface[data-mode="code"]')
    const original = code.locator(`[data-message-id="${target.run.userMessageId}"]`)
    const composer = code.locator('.chat__input')
    await expect(original).toBeVisible()
    await expect(composer).toHaveText(draft)
    historyMutationGate = new Promise<void>(resolve => { releaseHistoryMutation = resolve })
    await original.hover()
    await original.getByRole('button', { name: '从此处重新编辑', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '从此处重新编辑', exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '重新编辑', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => mutations().length).toBe(1)
    expect(mutations()[0]).toMatchObject({ method: 'POST', path: '/api/v1/conversation/truncate',
      body: { sessionId: id, messageId: target.run.userMessageId } })
    await expect(code.locator('.chat__send')).toBeDisabled()
    for (const name of ['重新发送', '从此处重新编辑', '回退到此处', '删除本轮']) {
      await expect(original.getByRole('button', { name, exact: true })).toBeDisabled()
    }
    const latestDraft = draft + '，等待期间补充要求'
    await composer.fill(latestDraft)
    await composer.press('Enter')
    await expect(composer).toHaveText(latestDraft)
    expect(mutations()).toHaveLength(1)
    expect(session.turns).toHaveLength(3)
    releaseHistoryMutation()
    await expect(original).toHaveCount(0)
    await expect(code.locator(`[data-message-id="${last.run.userMessageId}"]`)).toHaveCount(0)
    await expect(code.locator(`[data-message-id="${first.run.userMessageId}"]`)).toBeVisible()
    await expect(composer).toHaveText(`${latestDraft}\n\n${target.prompt}`)
    await expect(composer).toBeFocused()
    await expect(code.locator('.attach-chip').filter({ hasText: 'original-actions.txt' })).toHaveCount(1)
    expect(session.turns.map(value => value.run.turnId)).toEqual([first.run.turnId])
    await page.reload()
    await expect(composer).toHaveText(`${latestDraft}\n\n${target.prompt}`)
    await expect(original).toHaveCount(0)
    expect(mutations()).toHaveLength(1)
  })
})
