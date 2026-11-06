/** Real Electron + controlled HTTP/SSE. No provider calls; assertions cover actual requests and UI actions. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'
import type { RootRun } from '../src/shared/root-run'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { AetherIdeApi } from '../src/preload'

declare global { interface Window { aether: AetherIdeApi } }
const root = resolve(__dirname, '..'), token = 'interaction-fixture-token', model = 'interaction-fixture-model'
const selected = 'interaction-code', background = 'work-interaction-background'
type Session = { run: RootRun; prompt: string; seq: number; readers: Set<ServerResponse>; previous?: Session; attachments: Array<{ name: string; type: string }> }
const sessions = new Map<string, Session>(), sends: string[] = [], cancellations: Array<{ sessionId: string; runId?: string }> = []
const errors: string[] = [], requests: Record<string, unknown>[] = []
let app: ElectronApplication | undefined, page: Page, fixture = '', source = ''
let cancelMode: 'hold' | 'refuse' | 'confirm' | 'finished' = 'hold', held: ServerResponse | undefined
let holdRejection = false, rejectedResponse: ServerResponse | undefined
const envelope = (data: unknown) => JSON.stringify({ code: 200, message: 'ok', data })
function createSession(id: string, prompt: string, attachments: Session['attachments'] = []): Session {
  const now = Date.now(), previous = sessions.get(id), suffix = previous ? '-' + now : ''
  const value: Session = { prompt, previous, attachments, seq: 1, readers: new Set(), run: {
    schemaVersion: 1, runId: `run-${id}${suffix}`, sessionId: id, turnId: `turn-${id}${suffix}`, userMessageId: `user-${id}${suffix}`, assistantMessageId: `assistant-${id}${suffix}`,
    status: 'running', seq: 1, version: 1, modelId: model, pending: [], workspacePaths: [], createdAt: now, updatedAt: now
  } }
  sessions.set(id, value)
  return value
}
function user(session: Session) { return { id: session.run.userMessageId, role: 'user', content: session.prompt, conversationId: session.run.turnId, createdAt: session.run.createdAt, metadata: { rootRunId: session.run.runId, attachments: session.attachments } } }
function snapshot(id: string) {
  const session = sessions.get(id)
  const base = { schemaVersion: 1, sessionId: id, todos: [], changes: [], commandJobs: [] }
  if (!session) return { ...base, source: 'persisted', finished: true, eventId: null, projection: [], runs: [], history: [] }
  const active = session.run.status === 'running'
  const turns: Session[] = []; for (let turn: Session | undefined = session; turn; turn = turn.previous) turns.unshift(turn)
  return { ...base, source: active ? 'live' : 'persisted', finished: !active, eventId: `${session.run.runId}:${session.seq}`,
    run: session.run, runs: turns.map(turn => turn.run), projection: [], history: turns.flatMap(turn => [user(turn), {
      id: turn.run.assistantMessageId, role: 'assistant', content: '测试服务正在执行，等待后续事件', conversationId: turn.run.turnId, createdAt: turn.run.createdAt
    }]) }
}
function attach(session: Session, response: ServerResponse) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  response.write(': connected\n\n')
  session.readers.add(response)
  response.on('close', () => session.readers.delete(response))
}
function emit(session: Session, payload: ChatSsePayload) {
  const data = `id: ${session.run.runId}:${++session.seq}\ndata: ${JSON.stringify(payload)}\n\n`
  for (const response of session.readers) response.write(data)
}
function finish(session: Session, status: 'cancelled' | 'succeeded' | 'failed') {
  session.run = { ...session.run, status, ...(status === 'failed' ? { error: '测试执行失败，请修改后重试' } : {}), version: session.run.version + 1, seq: session.seq + 1, finishedAt: Date.now(), updatedAt: Date.now() }
  emit(session, { run: session.run })
  for (const response of session.readers) response.end('data: [DONE]\n\n')
}
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) { response.writeHead(401).end(); return }
    let raw = ''; for await (const part of request) raw += part.toString()
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    const id = String(body.sessionId ?? url.searchParams.get('sessionId') ?? '')
    if (path === '/api/v1/chat' && request.method === 'POST') {
      sends.push(String(body.message)); requests.push(structuredClone(body))
      if (String(body.message).startsWith('REJECT_')) {
        if (holdRejection) { rejectedResponse = response; return }
        response.writeHead(422, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 42200, message: '测试服务拒收：请检查任务配置', data: null })); return
      }
      const session = createSession(id, String(body.message), (body.attachments ?? []) as Session['attachments']); attach(session, response)
      emit(session, { run: session.run }); emit(session, { userMessage: user(session) }); emit(session, { content: '测试服务正在执行，等待后续事件' }); return
    }
    if (path === '/api/v1/chat/stream') {
      const session = sessions.get(id)
      if (!session || session.run.status !== 'running') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
      attach(session, response); return
    }
    response.setHeader('content-type', 'application/json')
    if (path === '/api/v1/chat/cancel') {
      cancellations.push({ sessionId: id, runId: body.runId as string | undefined })
      if (cancelMode === 'hold') { held = response; return }
      const session = sessions.get(id)!
      if (cancelMode === 'confirm') finish(session, 'cancelled')
      if (cancelMode === 'finished') finish(session, 'succeeded')
      response.end(envelope({ sessionId: id, runId: body.runId, cancelled: cancelMode === 'confirm', settled: cancelMode === 'confirm' })); return
    }
    if (path === '/api/v1/chat/snapshot') { response.end(envelope(snapshot(id))); return }
    if (path === '/api/v1/chat/status') { response.end(envelope({ run: sessions.get(id)?.run, running: sessions.get(id)?.run.status === 'running' })); return }
    if (path === '/api/v1/chat/admission/context') {
      const current = sessions.get(id)?.run
      const run = current ? { ...current, attemptId: 'attempt-' + current.runId } : null
      response.end(envelope({ protocolVersion: 1, tenantId: 'fixture', sessionId: id, namespace: { id: 'fixture', generation: 'one' },
        transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: run,
        predecessor: run ? { runId: run.runId, attemptId: run.attemptId, version: run.version } : null })); return
    }
    if (path === '/api/v1/subagent/capabilities') { response.end(envelope({ schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true })); return }
    if (path === '/api/v1/subagent/runs') { response.end(envelope({ schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'fixture' })); return }
    if (path === '/api/v1/cron/capabilities') { response.writeHead(404).end(); return }
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: 'sha256:' + 'f'.repeat(64), protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'interaction-fixture' }
      : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '交互测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
      : path === '/api/v1/security/mode' ? { sessionId: id, mode: 'standard' }
      : path === '/api/v1/conversation/sessions' ? [...sessions.values()].map(s => ({ sessionId: s.run.sessionId, title: s.prompt, lastAt: s.run.updatedAt, messageCount: 2 }))
      : path === '/api/v1/chat/runs' ? { runs: sessions.has(id) ? [sessions.get(id)!.run] : [] }
      : path === '/api/v1/workspace/directory' ? { root: '/remote/interaction', entries: [] }
      : []
    response.end(envelope(data))
  })().catch(cause => { errors.push(String(cause)); if (!response.headersSent) response.writeHead(500); response.end(String(cause)) })
})

test.describe.serial('引擎与客户端操作反馈', () => {
  test.beforeAll(async () => {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    source = engineStorageKey({ mode: 'remote', baseUrl: origin })
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true }); fixture = mkdtempSync(join(root, '.e2e-tmp', 'engine-interaction-ui-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true, lastModelId: model, appearance: 'light' }))
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', '--user-data-dir=' + fixture], cwd: root,
      env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
    await page.evaluate(({ key, selected }) => localStorage.setItem(key, selected), { key: sessionStorageKey('aether:lastSessionId', source), selected })
    await page.reload()
    await expect(page.locator('.chat__input')).toBeVisible()
  })
  test.afterAll(async () => {
    held?.destroy()
    rejectedResponse?.destroy()
    await app?.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    // Keep this isolated fixture with the test evidence; never touch the user's profile.
  })
  test('运行中鼠标发送与Enter一致入队，停止独立且等待期间不可重复提交', async ({}, info) => {
    await page.locator('.chat__input').fill('INTERACTION_FIRST')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
    await page.locator('.chat__input').fill('INTERACTION_QUEUED')
    await page.getByRole('button', { name: '排到下一轮', exact: true }).click()
    await expect(page.locator('.session-tray__tab--queue')).toContainText('1')
    expect(sends).toEqual(['INTERACTION_FIRST']); expect(cancellations).toHaveLength(0)
    await page.screenshot({ path: info.outputPath('code-queue-light.png'), animations: 'disabled' })
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect.poll(() => cancellations.length).toBe(1)
    await expect(page.getByRole('button', { name: '正在停止…', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '排到下一轮', exact: true })).toBeDisabled()
    expect(cancellations[0]).toEqual({ sessionId: selected, runId: 'run-' + selected })
    held!.end(envelope({ ...cancellations[0], cancelled: false, settled: false })); held = undefined
    await expect(page.getByRole('alert')).toContainText('停止未确认')
    await expect(page.locator('.session-tray__tab--queue')).toContainText('1')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeEnabled()
    expect(sessions.get(selected)!.run.status).toBe('running')
  })
  test('新建会话不会取消后台任务，切回后仍可精确停止', async ({}, info) => {
    await page.getByTitle('新建会话（开一条全新对话）').click()
    await expect(page.locator('.message--user')).toHaveCount(0)
    await expect(page.locator('.session-tray__tab--queue')).toHaveCount(0)
    expect(cancellations).toHaveLength(1); expect(sessions.get(selected)!.run.status).toBe('running')
    await page.locator('.chat__input').fill('INTERACTION_SECOND_SESSION')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => sends.length).toBe(2)
    const next = [...sessions.values()].find(session => session.prompt === 'INTERACTION_SECOND_SESSION')!
    finish(next, 'succeeded')
    await expect(page.getByRole('status', { name: '运行状态', exact: true })).toHaveText('已完成')
    expect(sends).toEqual(['INTERACTION_FIRST', 'INTERACTION_SECOND_SESSION'])
    expect(sessions.get(selected)!.run.status).toBe('running')
    await page.getByRole('button', { name: '会话历史', exact: true }).click()
    await page.locator('.history-view__item').filter({ hasText: 'INTERACTION_FIRST' }).click()
    await expect(page.locator('.message--user')).toContainText('INTERACTION_FIRST')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeEnabled()
    cancelMode = 'confirm'
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect(page.getByRole('status', { name: '运行状态', exact: true })).toHaveText('已取消')
    await expect(page.locator('.message__error')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    expect(cancellations).toHaveLength(2)
    await page.getByRole('tab', { name: '外观', exact: true }).click()
    await page.getByRole('radio', { name: '深色', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark')
    await page.screenshot({ path: info.outputPath('code-stopped-dark.png'), animations: 'disabled' })
    expect(errors).toEqual([])
  })
  test('Work后台停止遇到自然完成时显示完成，不伪造已停止', async () => {
    createSession(background, '后台交互测试')
    const task = { id: background, title: '后台交互测试', status: 'running', draft: '', createdAt: Date.now(), updatedAt: Date.now(), workspacePath: null, modelId: model, attachments: [], sources: [] }
    await page.evaluate(({ key, task }) => localStorage.setItem(key, JSON.stringify({ tasks: [task], activeTaskId: null })),
      { key: 'aether.work.state.v1:' + encodeURIComponent(source), task })
    await page.reload()
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await page.getByRole('button', { name: '查看运行中的任务，共 1 项', exact: true }).click()
    cancelMode = 'finished'
    await page.getByRole('button', { name: '停止任务：后台交互测试', exact: true }).click()
    await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').tasks?.[0]?.status,
      'aether.work.state.v1:' + encodeURIComponent(source))).toBe('done')
    expect(cancellations.at(-1)).toEqual({ sessionId: background, runId: 'run-' + background })
    expect(errors).toEqual([])
  })
  test('明确拒收恢复原稿；期间新增输入不被覆盖且可找回失败内容', async ({}, info) => {
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    await page.locator('.chat__input').fill('REJECT_ORIGINAL_DRAFT')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.locator('.chat__input')).toHaveText('REJECT_ORIGINAL_DRAFT')
    await expect(page.locator('.message__error').last()).toContainText('测试服务拒收')
    const before = sends.length
    holdRejection = true
    await page.locator('.chat__input').fill('REJECT_WITH_LATER_DRAFT')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => Boolean(rejectedResponse)).toBe(true)
    await page.locator('.chat__input').fill('正在编辑的新内容')
    rejectedResponse!.writeHead(422, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 42200, message: '测试服务拒收：请检查任务配置', data: null }))
    rejectedResponse = undefined
    await expect(page.getByRole('button', { name: '找回未发送内容', exact: true })).toBeVisible()
    await expect(page.locator('.chat__input')).toHaveText('正在编辑的新内容')
    await page.getByRole('button', { name: '找回未发送内容', exact: true }).click()
    await expect(page.locator('.chat__input')).toContainText('正在编辑的新内容')
    await expect(page.locator('.chat__input')).toContainText('REJECT_WITH_LATER_DRAFT')
    expect(sends.length).toBe(before + 1)
    await page.screenshot({ path: info.outputPath('send-rejection-draft-dark.png'), animations: 'disabled' })
    await page.reload()
    await expect(page.locator('.chat__input')).toContainText('REJECT_WITH_LATER_DRAFT')
    expect(sends.length).toBe(before + 1)
    expect(errors).toEqual([])
  })
  test('Work 重试绑定原轮，连续失败和刷新后仍保留新草稿与原附件', async ({}, info) => {
    const id = 'work-retry-exact', originalFiles = [{ name: '.ae/attachments/original.txt', type: 'text/plain' }]
    finish(createSession(id, 'WORK_OLD_FAILURE'), 'failed')
    const original = createSession(id, 'WORK_EXACT_REQUEST', originalFiles); finish(original, 'failed')
    const newFile = { path: '.ae/attachments/later.txt', name: 'later.txt', type: 'text/plain', size: 4 }
    const task = { id, title: '重试精确原轮测试', status: 'error', draft: '尚未发送的新草稿', createdAt: Date.now(), updatedAt: Date.now(), workspacePath: null, modelId: model, attachments: [newFile], sources: [] }
    await page.evaluate(({ key, task }) => localStorage.setItem(key, JSON.stringify({ tasks: [task], activeTaskId: task.id })),
      { key: 'aether.work.state.v1:' + encodeURIComponent(source), task })
    await page.reload()
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    const input = page.getByRole('textbox', { name: '继续对话', exact: true })
    await expect(input).toHaveText('尚未发送的新草稿')
    await expect(page.getByRole('button', { name: '重试这条指令', exact: true })).toHaveCount(1)
    const old = page.locator(`[data-message-id="assistant-${id}"]`)
    await expect(old).toContainText('测试执行失败')
    await expect(old.getByRole('button', { name: '重试这条指令', exact: true })).toHaveCount(0)
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = sends.length
      await page.getByRole('button', { name: '重试这条指令', exact: true }).click()
      await expect.poll(() => sends.length).toBe(before + 1)
      expect(requests.at(-1)?.message).toBe('WORK_EXACT_REQUEST')
      expect(requests.at(-1)?.attachments).toEqual(originalFiles)
      await expect(input).toHaveText('尚未发送的新草稿')
      finish(sessions.get(id)!, 'failed')
      await expect(page.getByRole('button', { name: '重试这条指令', exact: true })).toHaveCount(1)
      await expect(input).toHaveText('尚未发送的新草稿')
    }
    await page.reload()
    await expect(page.getByRole('button', { name: '重试这条指令', exact: true })).toHaveCount(1)
    const before = sends.length
    await page.getByRole('button', { name: '重试这条指令', exact: true }).click()
    await expect.poll(() => sends.length).toBe(before + 1)
    expect(requests.at(-1)?.message).toBe('WORK_EXACT_REQUEST')
    expect(requests.at(-1)?.attachments).toEqual(originalFiles)
    await expect(input).toHaveText('尚未发送的新草稿')
    cancelMode = 'confirm'
    await page.locator('.work-task-heading').getByRole('button', { name: '停止任务', exact: true }).click()
    await expect(page.getByRole('button', { name: '编辑后继续', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '编辑后继续', exact: true }).click()
    await expect(input).toHaveText('尚未发送的新草稿\n\nWORK_EXACT_REQUEST')
    await expect(input).toBeFocused()
    await expect(page.locator('.work-composer').getByText('original.txt', { exact: true })).toBeVisible()
    await expect(page.locator('.work-composer').getByText('later.txt', { exact: true })).toBeVisible()
    expect(sends.length).toBe(before + 1)
    await page.screenshot({ path: info.outputPath('work-stop-edit-dark.png'), animations: 'disabled' })
    expect(errors).toEqual([])
  })
  test('Work 普通发送失败不覆盖刚输入的下一条草稿', async () => {
    const input = page.getByRole('textbox', { name: '继续对话', exact: true })
    await input.fill('WORK_STANDARD_FAILURE')
    const before = sends.length
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => sends.length).toBe(before + 1)
    await input.fill('失败到达前刚写的草稿')
    finish(sessions.get('work-retry-exact')!, 'failed')
    await expect(page.getByRole('button', { name: '编辑后重试', exact: true })).toBeVisible()
    await expect(input).toHaveText('失败到达前刚写的草稿')
    await page.getByRole('button', { name: '编辑后重试', exact: true }).click()
    await expect(input).toHaveText('失败到达前刚写的草稿\n\nWORK_STANDARD_FAILURE')
    expect(sends.length).toBe(before + 1)
    expect(errors).toEqual([])
  })
  test('Work 输出截断显示结构化中文原因，详情可展开且重试仍绑定原指令', async ({}, info) => {
    const id = 'work-output-limit-diagnostic', original = 'Model response ended before completion'
    const failed = createSession(id, 'WORK_OUTPUT_LIMIT_ORIGINAL')
    finish(failed, 'failed')
    failed.run = { ...failed.run, stopReason: 'output_limit', error: { code: 'OUTPUT_LIMIT', message: original, retryable: false } }
    const task = { id, title: '输出截断诊断测试', status: 'error', draft: '保留新草稿', createdAt: Date.now(), updatedAt: Date.now(), workspacePath: null, modelId: model, attachments: [], sources: [] }
    await page.evaluate(({ key, task }) => localStorage.setItem(key, JSON.stringify({ tasks: [task], activeTaskId: task.id })),
      { key: 'aether.work.state.v1:' + encodeURIComponent(source), task })
    await page.reload()
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    const card = page.locator('.work-error-notice').filter({ hasText: '模型输出达到上限' })
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute('role', 'alert')
    await expect(card).toContainText('模型本轮输出达到上限，已保留现有内容')
    await expect(card.locator('pre')).toHaveCount(0)
    await card.getByText('查看诊断详情', { exact: true }).click()
    await expect(card.locator('pre')).toContainText(original)
    await expect(card.locator('pre')).toContainText('OUTPUT_LIMIT')
    await expect(card.locator('pre')).toContainText(failed.run.runId)
    await card.getByText('收起诊断详情', { exact: true }).click()
    await expect(card.locator('pre')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('work-output-limit-diagnostic.png'), animations: 'disabled' })
    const before = sends.length
    await card.getByRole('button', { name: '重试这条指令', exact: true }).click()
    await expect.poll(() => sends.length).toBe(before + 1)
    expect(requests.at(-1)?.message).toBe('WORK_OUTPUT_LIMIT_ORIGINAL')
    await expect(page.getByRole('textbox', { name: '继续对话', exact: true })).toHaveText('保留新草稿')
    finish(sessions.get(id)!, 'succeeded')
    await expect(page.getByRole('button', { name: '停止任务', exact: true })).toHaveCount(0)
    expect(errors).toEqual([])
  })
  test('Work 编辑后重试忽略首尾空白差异，反复点击与刷新不重复追加原指令', async ({}, info) => {
    const id = 'work-edit-retry-idempotent', prompt = '做一个 web 围棋 项目 可以支持 H5'
    const file = { path: '.ae/attachments/retry-once.txt', name: 'retry-once.txt', type: 'text/plain', size: 3 }
    finish(createSession(id, prompt, [{ name: file.path, type: file.type }]), 'failed')
    const task = { id, title: '编辑重试不重复测试', status: 'error', draft: ` ${prompt}\u00a0 `, createdAt: Date.now(), updatedAt: Date.now(), workspacePath: null, modelId: model, attachments: [file], sources: [] }
    await page.evaluate(({ key, task }) => localStorage.setItem(key, JSON.stringify({ tasks: [task], activeTaskId: task.id })),
      { key: 'aether.work.state.v1:' + encodeURIComponent(source), task })
    await page.reload()
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    const input = page.getByRole('textbox', { name: '继续对话', exact: true })
    const edit = page.getByRole('button', { name: '编辑后重试', exact: true })
    const text = () => input.evaluate(element => element.textContent ?? '')
    const before = sends.length
    await expect(edit).toBeVisible()
    for (let click = 0; click < 3; click++) {
      await edit.click()
      await expect(input).toBeFocused()
      await expect.poll(text).toBe(task.draft)
    }
    await input.fill('保留我补充的新要求')
    await edit.click()
    const restored = `保留我补充的新要求\n\n${prompt}`
    await expect.poll(text).toBe(restored)
    await edit.click()
    await expect.poll(text).toBe(restored)
    await expect(page.locator('.work-composer').getByText(file.name, { exact: true })).toHaveCount(1)
    await page.reload()
    await expect.poll(text).toBe(restored)
    await edit.click()
    await expect.poll(text).toBe(restored)
    await expect(input).toBeFocused()
    expect(sends.length).toBe(before)
    await page.screenshot({ path: info.outputPath('work-edit-retry-once.png'), animations: 'disabled' })
    expect(errors).toEqual([])
  })
  test('Code 添加历史消息保留新草稿、原附件，且不会自动发送', async ({}, info) => {
    const id = 'interaction-code-refill'
    finish(createSession(id, 'CODE_REUSE_ORIGINAL', [{ name: '.ae/attachments/reuse.txt', type: 'text/plain' }]), 'cancelled')
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    await page.evaluate(({ key, id }) => localStorage.setItem(key, id), { key: sessionStorageKey('aether:lastSessionId', source), id })
    await page.reload()
    const input = page.locator('.chat__input')
    await expect(page.locator('.message--user')).toContainText('CODE_REUSE_ORIGINAL')
    await input.fill('这里是新草稿')
    const before = sends.length
    await page.locator('.message--user').getByRole('button', { name: '添加到对话', exact: true }).click()
    await expect(input).toHaveText('这里是新草稿\n\nCODE_REUSE_ORIGINAL')
    await expect(input).toBeFocused()
    await expect(page.getByRole('button', { name: '移除附件 reuse.txt', exact: true })).toBeVisible()
    expect(sends.length).toBe(before)
    await page.getByRole('tab', { name: '外观', exact: true }).click()
    await page.getByRole('radio', { name: '浅色', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-appearance', 'light')
    await page.screenshot({ path: info.outputPath('code-reuse-light.png'), animations: 'disabled' })
    await page.reload()
    await expect(input).toHaveText('这里是新草稿\n\nCODE_REUSE_ORIGINAL')
    expect(sends.length).toBe(before)
    expect(errors).toEqual([])
  })
})

