/** Real Electron + controlled authenticated engine: workbench commands reach the
 * actual Work preview; cancelled and late commands cannot cross task ownership. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import type { WorkbenchCommand } from '../src/renderer/src/core/workbench/client'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), token = 'workbench-client-fixture-token', model = 'workbench-client-fixture-model'
const firstSession = 'work-workbench-first', secondSession = 'work-workbench-second'
const titles = new Map([[firstSession, '工作台预览任务'], [secondSession, '独立的第二个任务']])
type Client = { clientId: string; clientToken: string; sessionId: string; active: boolean; queue: WorkbenchCommand[]; poll?: ServerResponse; timer?: NodeJS.Timeout }
type Reply = { success: boolean; output: string; metadata: { code: string; operationPerformed: boolean | 'unknown' } }
const clients = new Map<string, Client>(), commands = new Map<string, WorkbenchCommand>(), results = new Map<string, Reply>()
const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [], reads: Array<{ sessionId: string; path: string }> = [], errors: string[] = []
const files = new Map<string, string>(), cancelled = new Set<string>(), heldStates = new Map<string, ServerResponse>(), heldStateIds = new Set<string>()
const admissionSessions = new Set<string>()
let app: ElectronApplication | undefined, page: Page, health: ElectronHealthMonitor | undefined, fixture = ''
let codeSession = '', codePath = ''
const envelope = (data: unknown) => JSON.stringify({ code: 200, message: 'ok', data })
function send(response: ServerResponse, data: unknown) {
  if (!response.destroyed && !response.writableEnded) response.writeHead(200, { 'content-type': 'application/json' }).end(envelope(data))
}
function flush(client: Client) {
  if (!client.poll) return
  const response = client.poll; client.poll = undefined; clearTimeout(client.timer)
  send(response, { commands: client.queue.splice(0) })
}
function currentClient(sessionId: string) { return [...clients.values()].filter(item => item.active && item.sessionId === sessionId).at(-1) }
function enqueue(sessionId: string, action: WorkbenchCommand['action'], args: WorkbenchCommand['args'] = {}, options: { cancelled?: boolean; holdState?: boolean } = {}) {
  const client = currentClient(sessionId)
  if (!client) throw new Error(`Missing live workbench client for ${sessionId}`)
  const command: WorkbenchCommand = { requestId: randomUUID(), sessionId, action, args,
    execution: { rootSessionId: sessionId, rootRunId: `root-${sessionId}`, ownerRunId: `root-${sessionId}` }, expiresAt: Date.now() + 60_000 }
  commands.set(command.requestId, command)
  if (options.cancelled) cancelled.add(command.requestId)
  if (options.holdState) heldStateIds.add(command.requestId)
  client.queue.push(command); flush(client)
  return command
}
async function reply(command: WorkbenchCommand) {
  await expect.poll(() => results.has(command.requestId)).toBe(true)
  return results.get(command.requestId)!
}
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, method = request.method ?? 'GET'
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) { response.writeHead(401).end(); return }
    let raw = ''; for await (const chunk of request) raw += String(chunk)
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    const sessionId = String(body.sessionId ?? url.searchParams.get('sessionId') ?? '')
    if (path.startsWith('/api/v1/workbench/')) calls.push({ method, path, body: structuredClone(body) })
    if (path === '/api/v1/workbench/clients') {
      if (method !== 'POST' || !Array.isArray(body.actions)) throw new Error('Invalid workbench registration')
      const client: Client = { clientId: randomUUID(), clientToken: randomUUID(), sessionId, active: true, queue: [] }
      clients.set(client.clientId, client); send(response, { clientId: client.clientId, clientToken: client.clientToken }); return
    }
    const route = /^\/api\/v1\/workbench\/clients\/([^/]+)\/(poll|state|results|disconnect)$/.exec(path)
    if (route) {
      const client = clients.get(route[1])
      if (method !== 'POST' || !client || body.clientToken !== client.clientToken) throw new Error('Invalid workbench transport identity')
      if (route[2] === 'disconnect') { client.active = false; flush(client); send(response, { disconnected: true }); return }
      if (route[2] === 'poll') {
        client.poll = response
        response.on('close', () => { if (client.poll === response) { client.poll = undefined; clearTimeout(client.timer) } })
        if (client.queue.length) flush(client)
        else client.timer = setTimeout(() => flush(client), 1000)
        return
      }
      const command = commands.get(String(body.requestId))
      if (!command || command.sessionId !== client.sessionId || JSON.stringify(body.execution) !== JSON.stringify(command.execution)) throw new Error('Wrong workbench execution envelope')
      if (route[2] === 'state') {
        if (heldStateIds.has(command.requestId)) heldStates.set(command.requestId, response)
        else send(response, { active: !cancelled.has(command.requestId) })
        return
      }
      results.set(command.requestId, body.result as Reply); send(response, { accepted: true }); return
    }
    if (path === '/api/v1/workspace/file/content' || path === '/api/v1/workspace/file/info') {
      const relative = url.searchParams.get('path') ?? '', content = files.get(`${sessionId}:${relative}`)
      if (path.endsWith('/content')) reads.push({ sessionId, path: relative })
      if (content === undefined) { response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 404, message: '测试文件不存在' })); return }
      send(response, path.endsWith('/content') ? { content, isBinary: false, totalSize: Buffer.byteLength(content) }
        : { workspacePath: `/remote/workbench/${sessionId}/${relative}`, size: Buffer.byteLength(content), isDirectory: false, mtimeMs: 1 }); return
    }
    if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
    if (path === '/api/v1/chat/admission/context') {
      admissionSessions.add(sessionId)
      send(response, { protocolVersion: 1, tenantId: 'fixture', sessionId,
        namespace: { id: 'workbench-client', generation: 'one' },
        transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }); return
    }
    if (path === '/api/v1/cron/capabilities') { response.writeHead(404).end(); return }
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: 'sha256:' + 'c'.repeat(64), protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'workbench-client-fixture' }
      : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '工作台测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
      : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', finished: true, eventId: null, runs: [], history: [], projection: [], todos: [], changes: [], commandJobs: [] }
      : path === '/api/v1/chat/status' ? { running: false, finished: true }
      : path === '/api/v1/chat/runs' ? { runs: [] }
      : path === '/api/v1/conversation/sessions' ? [...titles].map(([id, title]) => ({ sessionId: id, title, lastAt: Date.now(), messageCount: 0 }))
      : path === '/api/v1/security/mode' ? { sessionId, mode: 'standard' }
      : path === '/api/v1/workspace/directory' ? { root: `/remote/workbench/${sessionId}`, entries: [] }
      : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
      : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'fixture' }
      : []
    send(response, data)
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})

const work = () => page.locator('.work-view')
const preview = (path: string) => work().locator(`[data-document-path=${JSON.stringify(path)}][data-document-active="true"]`)
async function expectNoProtocolErrors() {
  await expect(page.getByText('Admission response is not an object', { exact: false })).toHaveCount(0)
  await expect(page.locator('.work-next-turn__error')).toHaveCount(0)
}
async function selectSession(id: string) {
  const item = work().locator('.work-sidebar__task', { hasText: titles.get(id)! })
  if (!await item.isVisible()) await work().getByRole('button', { name: '展开 Work 导航', exact: true }).click()
  await item.click()
  await expect(work().locator('.work-task-heading h1')).toContainText(titles.get(id)!)
  await expect.poll(() => Boolean(currentClient(id))).toBe(true)
}

test.describe.serial('Work 工作台模型工具的真实客户端闭环', () => {
  test.beforeAll(async () => {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`, source = engineStorageKey({ mode: 'remote', baseUrl: origin })
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true }); fixture = mkdtempSync(join(root, '.e2e-tmp', 'workbench-client-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true, lastModelId: model, appearance: 'light' }))
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', '--user-data-dir=' + fixture], cwd: root,
      env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    health = await monitorElectronHealth(app, 'workbench-client', [token])
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const tasks = [...titles].map(([id, title]) => ({ id, title, status: 'done', draft: '', createdAt: Date.now(), updatedAt: Date.now(), workspacePath: null, modelId: model, attachments: [], sources: [] }))
    await page.evaluate(({ key, tasks, activeTaskId }) => localStorage.setItem(key, JSON.stringify({ tasks, activeTaskId })),
      { key: 'aether.work.state.v1:' + encodeURIComponent(source), tasks, activeTaskId: firstSession })
    await page.reload(); await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await expect(work().locator('.work-task-heading h1')).toContainText(titles.get(firstSession)!)
    await expect.poll(() => Boolean(currentClient(firstSession))).toBe(true)
    await expect.poll(() => admissionSessions.has(firstSession)).toBe(true)
    await expectNoProtocolErrors()
  })
  test.afterEach(async () => { health?.assertHealthy(); expect(errors).toEqual([]); await expectNoProtocolErrors() })
  test.afterAll(async ({}, info) => {
    for (const response of heldStates.values()) send(response, { active: false })
    for (const client of clients.values()) { clearTimeout(client.timer); flush(client) }
    try { if (health) await health.closeAndAssert(info); else await app?.close() }
    finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
  })

  test('注册能力和查询上下文经过真实 POST 注册、轮询、状态和结果回路', async () => {
    const result = await reply(enqueue(firstSession, 'workspace.context'))
    expect(result.success).toBe(true)
    expect(JSON.parse(result.output)).toMatchObject({ mode: 'work', files: [], terminals: [], actions: ['artifact.open', 'workspace.context', 'terminal.read'] })
    expect(JSON.parse(result.output).previewFormats).toEqual(expect.arrayContaining(['pdf', 'docx', 'xlsx', 'pptx', 'txt']))
    expect(calls.filter(call => call.path === '/api/v1/workbench/clients').at(-1)?.body.actions).toEqual(['artifact.open', 'workspace.context', 'terminal.read'])
    for (const suffix of ['poll', 'state', 'results']) expect(calls.some(call => call.path.endsWith('/' + suffix) && call.method === 'POST')).toBe(true)
  })

  test('打开文本必须真实读取并显示，再报告读取状态；上下文反映选择', async ({}, info) => {
    const path = 'actual-preview.txt', content = '真实工作台预览：生成文件已经读取并显示。'
    files.set(`${firstSession}:${path}`, content)
    const result = await reply(enqueue(firstSession, 'artifact.open', { path }))
    expect(result.success, result.output).toBe(true)
    expect(JSON.parse(result.output)).toMatchObject({ path, opened: true, readStatus: 'current', renderStatus: 'preview-requested', visualVerification: false })
    expect(reads).toContainEqual({ sessionId: firstSession, path })
    await expect(preview(path)).toBeVisible(); await expect(preview(path)).toContainText(content)
    const context = await reply(enqueue(firstSession, 'workspace.context'))
    expect(JSON.parse(context.output).selectedArtifact).toBe(`path:${path}`)
    await expectNoProtocolErrors()
    await page.screenshot({ path: info.outputPath('workbench-open-text.png'), animations: 'disabled' })
  })

  test('再次打开同一路径要读取新文件内容，不能把缓存预览当作新回执', async () => {
    const path = 'actual-preview.txt', content = '同路径的第二个版本：文件已经由引擎更新。'
    const count = reads.filter(read => read.sessionId === firstSession && read.path === path).length
    files.set(`${firstSession}:${path}`, content)
    const result = await reply(enqueue(firstSession, 'artifact.open', { path }))
    expect(result.success, result.output).toBe(true)
    expect(JSON.parse(result.output)).toMatchObject({ path, opened: true, readStatus: 'current', visualVerification: false })
    expect(reads.filter(read => read.sessionId === firstSession && read.path === path).length).toBeGreaterThan(count)
    await expect(preview(path)).toContainText(content)
    await expect(preview(path)).not.toContainText('真实工作台预览：生成文件已经读取并显示。')
  })

  test('缺失文件返回失败，不能将预览请求伪装成成功读取', async () => {
    const result = await reply(enqueue(firstSession, 'artifact.open', { path: 'missing-file.txt' }))
    expect(result.success).toBe(false)
    expect(result.output).toContain('无法读取当前文件')
    expect(reads).toContainEqual({ sessionId: firstSession, path: 'missing-file.txt' })
    await expect(preview('missing-file.txt')).toHaveAttribute('data-file-read-status', 'unavailable')
  })

  test('引擎已取消的命令不打开、不读取、不提交成功结果', async () => {
    const path = 'cancelled-open.txt'; files.set(`${firstSession}:${path}`, '不应该显示')
    const command = enqueue(firstSession, 'artifact.open', { path }, { cancelled: true })
    const barrier = await reply(enqueue(firstSession, 'workspace.context'))
    expect(barrier.success).toBe(true)
    expect(results.has(command.requestId)).toBe(false)
    expect(reads.some(read => read.path === path)).toBe(false)
    await expect(preview(path)).toHaveCount(0)
  })

  test('切换会话后才返回的 active 状态不能打开旧任务文件或报告已执行', async () => {
    const path = 'late-old-task.txt'; files.set(`${firstSession}:${path}`, '旧会话晚到内容')
    const command = enqueue(firstSession, 'artifact.open', { path }, { holdState: true })
    await expect.poll(() => heldStates.has(command.requestId)).toBe(true)
    await selectSession(secondSession)
    send(heldStates.get(command.requestId)!, { active: true }); heldStates.delete(command.requestId)
    const barrier = await reply(enqueue(secondSession, 'workspace.context'))
    expect(barrier.success).toBe(true)
    expect(results.has(command.requestId)).toBe(false)
    expect(reads.some(read => read.path === path)).toBe(false)
    await expect(preview(path)).toHaveCount(0)
    expect(calls.some(call => call.path.endsWith('/disconnect'))).toBe(true)
  })

  test('Code 打开到真实编辑器，重复打开保留用户未保存内容且不重读覆盖', async ({}, info) => {
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    await expect.poll(() => [...clients.values()].filter(client => client.active && !client.sessionId.startsWith('work-')).length).toBeGreaterThan(0)
    codeSession = [...clients.values()].filter(client => client.active && !client.sessionId.startsWith('work-')).at(-1)!.sessionId
    codePath = `/remote/workbench/${codeSession}/code-note.txt`
    files.set(`${codeSession}:code-note.txt`, 'original editor buffer')
    const opened = await reply(enqueue(codeSession, 'artifact.open', { path: codePath }))
    expect(opened.success, opened.output).toBe(true)
    expect(JSON.parse(opened.output)).toMatchObject({ path: codePath, opened: true, readStatus: 'ready', dirty: false, contentSource: 'editor-buffer', visualVerification: false })
    const editor = page.locator('.mode-surface[data-mode="code"] .doc-view__source .monaco-editor .view-lines').first()
    await expect(page.locator('.editor-tab.is-active')).toContainText('code-note.txt')
    await expect(editor).toContainText('original editor buffer')
    await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' USER_UNSAVED_BUFFER')
    await expect(editor).toContainText('USER_UNSAVED_BUFFER')
    const context = await reply(enqueue(codeSession, 'workspace.context'))
    expect(JSON.parse(context.output)).toMatchObject({ mode: 'code', activePath: codePath, files: [{ path: codePath, dirty: true }] })
    const readCount = reads.filter(read => read.sessionId === codeSession && read.path === 'code-note.txt').length
    files.set(`${codeSession}:code-note.txt`, 'SERVER_REPLACEMENT_MUST_NOT_OVERWRITE_USER')
    const reopened = await reply(enqueue(codeSession, 'artifact.open', { path: codePath }))
    expect(reopened.success, reopened.output).toBe(true)
    expect(JSON.parse(reopened.output)).toMatchObject({ dirty: true, contentSource: 'editor-buffer' })
    expect(reads.filter(read => read.sessionId === codeSession && read.path === 'code-note.txt')).toHaveLength(readCount)
    await expect(editor).toContainText('USER_UNSAVED_BUFFER')
    await expect(editor).not.toContainText('SERVER_REPLACEMENT_MUST_NOT_OVERWRITE_USER')
    await expectNoProtocolErrors()
    await page.screenshot({ path: info.outputPath('workbench-code-dirty-buffer.png'), animations: 'disabled' })
  })

  test('模式切换保留后台工作台；后台预览回执不冒充已经显示', async () => {
    await expect(page.locator('#mode-code')).toHaveAttribute('aria-hidden', 'false')
    await expect.poll(() => Boolean(currentClient(secondSession))).toBe(true)
    const context = await reply(enqueue(secondSession, 'workspace.context'))
    expect(context.success, context.output).toBe(true)
    expect(JSON.parse(context.output)).toMatchObject({ mode: 'work', foreground: false })
    const path = 'background-preview.txt', content = '后台工作台保留的真实文件'
    files.set(`${secondSession}:${path}`, content)
    const result = await reply(enqueue(secondSession, 'artifact.open', { path }))
    expect(result.success, result.output).toBe(true)
    expect(JSON.parse(result.output)).toMatchObject({ opened: true, foreground: false, readStatus: 'not-confirmed', renderStatus: 'deferred-until-visible', visualVerification: false })
    expect(reads.some(read => read.sessionId === secondSession && read.path === path)).toBe(false)
    await expect(page.locator('#mode-code')).toHaveAttribute('aria-hidden', 'false')
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await expect(preview(path)).toBeVisible(); await expect(preview(path)).toContainText(content)
    const codeContext = await reply(enqueue(codeSession, 'workspace.context'))
    expect(codeContext.success, codeContext.output).toBe(true)
    expect(JSON.parse(codeContext.output)).toMatchObject({ mode: 'code', foreground: false, activePath: codePath })
    const codeOpen = await reply(enqueue(codeSession, 'artifact.open', { path: codePath }))
    expect(codeOpen.success, codeOpen.output).toBe(true)
    expect(JSON.parse(codeOpen.output)).toMatchObject({ foreground: false, dirty: true, readStatus: 'ready', renderStatus: 'deferred-until-visible' })
    await expect(page.locator('#mode-work')).toHaveAttribute('aria-hidden', 'false')
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
  })

  test('Code 新会话上下文排除旧会话文档，拒绝打开旧会话路径', async () => {
    await page.getByTitle('新建会话（开一条全新对话）').click()
    await expect.poll(() => [...clients.values()].filter(client => client.active && !client.sessionId.startsWith('work-') && client.sessionId !== codeSession).length).toBeGreaterThan(0)
    const next = [...clients.values()].filter(client => client.active && !client.sessionId.startsWith('work-') && client.sessionId !== codeSession).at(-1)!.sessionId
    const context = await reply(enqueue(next, 'workspace.context'))
    expect(context.success, context.output).toBe(true)
    expect(JSON.parse(context.output)).toMatchObject({ mode: 'code', workspaceRoot: `/remote/workbench/${next}`, activePath: null, files: [] })
    const before = reads.length
    const rejected = await reply(enqueue(next, 'artifact.open', { path: codePath }))
    expect(rejected.success).toBe(false); expect(rejected.output).toContain('不属于当前任务工作区')
    expect(reads).toHaveLength(before)
    await expect(page.locator('.mode-surface[data-mode="code"] .doc-view__source .view-lines').first()).toContainText('USER_UNSAVED_BUFFER')
  })
})
