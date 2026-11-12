/** Real Electron + authenticated owned engine: Work home draft/template
 * retention, recent-task filters and search, true multipart upload + Enter
 * delivery, home run-list navigation, workspace selection/ownership, and
 * light/dark responsive layouts. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import type { SessionState, SessionTask } from '../src/renderer/src/features/sessions/state'
import type { ChatAttachment } from '../src/renderer/src/core/engine/useChat'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'
import { OUTLINE_ICON_PATHS } from '../src/renderer/src/ui/outline-icons'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'disposable-work-home-token', modelId = 'work-home-model'
const modelName = '面向文档研究与复杂推理的超长模型名称 · Professional Writing and Reasoning Edition'
const workspaceRoot = '/remote/home-ui/project', homeId = 'work-home-6c9a5914-8bdb-4613-9801-051398088ede'
const otherWorkspace = '/remote/home-ui/团队资料与项目成果/客户研究项目'
const foreignWorkspace = '/another-engine/private-workspace'
const now = Date.now() - 60_000
const longTitle = '请为当前项目整理一套面向技术客户的完整介绍材料，包含 Word 项目说明、Excel 功能清单与演示文稿，并逐项核对最终交付文件和资料来源'
const tasks: SessionTask[] = Array.from({ length: 52 }, (_, index) => ({
  id: `work-home-task-${index}`, title: index === 0 ? '正在整理会议纪要' : index === 1 ? '等待确认项目交付范围'
    : index === 4 ? longTitle : index === 51 ? '核对验收搜索关键词的历史记录' : `项目资料核对 ${String(index + 1).padStart(2, '0')}`,
  status: index === 0 ? 'running' : index === 1 ? 'waiting' : index === 2 ? 'error' : index === 3 ? 'stopped' : 'done',
  createdAt: now - index * 60_000 - 30_000, updatedAt: now - index * 60_000,
  workspacePath: workspaceRoot, modelId, draft: '', attachments: [], sources: [],
}))
tasks.push({ ...tasks[4], id: 'work-home-archived', title: '已归档的首页任务不可见', archived: true, updatedAt: now + 1_000 })
const attachments: ChatAttachment[] = [
  { attachmentId: 'home-attachment-a', path: '.ae/attachments/project-notes.txt', name: '客户需求与现有资料说明.txt', type: 'text/plain', size: 18 },
  { attachmentId: 'home-attachment-b', path: '.ae/attachments/long-report.pdf', name: '跨部门协作项目的完整验收资料与说明报告.pdf', type: 'application/pdf', size: 4096 },
  { attachmentId: 'home-attachment-c', path: '.ae/attachments/proposal.docx', name: '面向技术客户的项目介绍文档.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 8192 },
]
const errors: string[] = [], forbidden: string[] = [], chats: Record<string, unknown>[] = []
const chatWorkspaces: Array<{ sessionId: string; root: string }> = []
const bindingEvents: Array<{ sessionId: string; workspaceRoot: string }> = []
interface WorkspaceHistoryEntry { path: string; updatedAt: number }
interface BindingFault { sessionId: string; targetRoot: string; previousRoot: string; rollbackFails: boolean; stage: 'armed' | 'read-pending' | 'rollback-pending' | 'complete' }
let bindingFault: BindingFault | undefined
interface UploadedFile { sessionId: string; path: string; bytes: Buffer; type: string }
const uploads: UploadedFile[] = [], files = new Map<string, UploadedFile>(), bindings = new Map<string, string>()
const homeSessions = new Set([homeId])
const runs = new Map<string, RootRun[]>(), histories = new Map<string, EngineHistoryRow[]>()
const liveStreams = new Map<string, Set<ServerResponse>>()
const streamRequests: Array<{ sessionId: string; lastEventId: string | null }> = []
const admissions = new Map<string, { admission: Record<string, unknown>; run: RootRun }>()
let app: ElectronApplication | undefined, page: Page, fixture = '', storageKey = '', workspaceHistoryKey = '', foreignHistoryKey = '', generation = 0
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const fileKey = (owner: string, path: string): string => JSON.stringify([owner, path])
const latest = (id: string): RootRun | undefined => runs.get(id)?.at(-1)
const workspaceFor = (id: string): string => bindings.get(id) ?? (homeSessions.has(id) ? `/remote/home-ui/scratch/${id}` : workspaceRoot)
const streamCursor = (run: RootRun): string => `${run.runId}:${run.version}`

function closeLiveStreams(): void {
  for (const streams of liveStreams.values()) for (const response of streams) response.end('data: [DONE]\n\n')
  liveStreams.clear()
}

function resetFixture(fixtureTasks: readonly SessionTask[] = tasks): void {
  closeLiveStreams(); streamRequests.length = 0
  generation++; runs.clear(); histories.clear(); admissions.clear(); bindings.clear(); uploads.length = 0; files.clear(); chats.length = 0; chatWorkspaces.length = 0; bindingEvents.length = 0
  homeSessions.clear(); homeSessions.add(homeId)
  bindingFault = undefined
  bindings.set(homeId, workspaceRoot)
  for (const task of fixtureTasks) {
    const run: RootRun = { schemaVersion: 1, runId: `home-root-${generation}-${task.id}`, sessionId: task.id, turnId: `home-turn-${task.id}`,
      userMessageId: `home-user-${task.id}`, assistantMessageId: `home-assistant-${task.id}`, seq: 1, version: 2,
      status: task.status === 'running' ? 'running' : task.status === 'waiting' ? 'waiting' : task.status === 'error' ? 'failed' : task.status === 'stopped' ? 'cancelled' : 'succeeded',
      modelId, pending: [], workspacePaths: [workspaceRoot], createdAt: task.createdAt, updatedAt: task.updatedAt, startedAt: task.createdAt,
      ...(['running', 'waiting'].includes(task.status) ? {} : { finishedAt: task.updatedAt }) }
    runs.set(task.id, [run]); bindings.set(task.id, workspaceRoot)
    histories.set(task.id, [
      { id: run.userMessageId, role: 'user', content: task.title, createdAt: task.createdAt, conversationId: run.turnId, metadata: { rootRunId: run.runId } },
      { id: run.assistantMessageId, role: 'assistant', content: `HOME_OPENED:${task.id}`, createdAt: task.updatedAt, conversationId: run.turnId, metadata: { rootRunId: run.runId } },
    ])
  }
}
resetFixture()

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  if (/^work-home-[a-f\d-]{36}$/i.test(id)) homeSessions.add(id)
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const bytes = Buffer.concat(chunks)
  if (path === '/api/v1/workspace/upload' && request.method === 'POST') {
    const form = await new Request('http://fixture/upload', { method: 'POST', headers: { 'content-type': String(request.headers['content-type']) }, body: Uint8Array.from(bytes) }).formData()
    const blob = form.get('file'), owner = form.get('sessionId'), relative = form.get('path')
    if (!blob || typeof blob === 'string' || typeof owner !== 'string' || !homeSessions.has(owner) || typeof relative !== 'string') throw new Error('Upload lost the home draft session')
    const file = { sessionId: owner, path: relative, bytes: Buffer.from(await blob.arrayBuffer()), type: blob.type }
    uploads.push(file); files.set(fileKey(owner, relative), file)
    response.end(envelope({ path: relative, size: file.bytes.length })); return
  }
  const parsed: unknown = bytes.length ? JSON.parse(bytes.toString('utf8')) : {}, input = record(parsed) ? parsed : {}
  const current = latest(id), rows = histories.get(id) ?? []
  if (path === '/api/v1/workspace/bind') {
    const owner = String(input.sessionId), workspace = String(input.workspaceRoot)
    bindingEvents.push({ sessionId: owner, workspaceRoot: workspace })
    if (bindingFault?.sessionId === owner) {
      if (bindingFault.stage === 'rollback-pending' && workspace === bindingFault.previousRoot) {
        bindingFault.stage = 'complete'
        if (bindingFault.rollbackFails) { response.writeHead(503).end(JSON.stringify({ code: 503, message: 'HOME_ROLLBACK_REJECTED', data: null })); return }
      } else if (bindingFault.stage === 'armed' && workspace === bindingFault.targetRoot) bindingFault.stage = 'read-pending'
    }
    bindings.set(owner, workspace); response.end(envelope({ workspaceRoot: workspace })); return
  }
  if (path === '/api/v1/workspace/directory' && bindingFault?.sessionId === id && bindingFault.stage === 'read-pending') {
    bindingFault.stage = 'rollback-pending'
    response.writeHead(503).end(JSON.stringify({ code: 503, message: 'HOME_BINDING_READ_REJECTED', data: null })); return
  }
  if (path === '/api/v1/workspace/file/info' || path === '/api/v1/workspace/file/content') {
    const relative = url.searchParams.get('path') ?? '', file = files.get(fileKey(id, relative))
    const workspace = workspaceFor(id)
    if (!file) { response.writeHead(404).end(envelope(null)); return }
    response.end(envelope(path.endsWith('/info') ? { workspacePath: `${workspace}/${relative}`, size: file.bytes.length, isDirectory: false }
      : { content: file.bytes.toString('utf8'), isBinary: false, totalSize: file.bytes.length, root: workspace, bindingEpoch: `home-${id}` })); return
  }
  if (path === '/api/v1/chat/admission/context') {
    const owned = current ? { ...current, attemptId: `attempt-${current.runId}` } : null
    response.end(envelope({ protocolVersion: 1, tenantId: 'home-fixture', sessionId: id, namespace: { id: 'home-db', generation: 'one' },
      transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 },
      root: owned, predecessor: owned ? { runId: owned.runId, attemptId: owned.attemptId, version: owned.version } : null })); return
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
    const owner = String(input.sessionId)
    if (!homeSessions.has(owner) || typeof input.message !== 'string') throw new Error('Home delivery changed the draft owner')
    chats.push(input)
    chatWorkspaces.push({ sessionId: owner, root: workspaceFor(owner) })
    const at = Date.now(), run: RootRun = { schemaVersion: 1, runId: `home-send-${generation}`, sessionId: owner, turnId: `home-send-turn-${generation}`,
      userMessageId: `home-send-user-${generation}`, assistantMessageId: `home-send-assistant-${generation}`, seq: 1, version: 1, status: 'running',
      modelId, pending: [], workspacePaths: [workspaceFor(owner)], createdAt: at, updatedAt: at, startedAt: at }
    const sentAttachments = Array.isArray(input.attachments) ? input.attachments.flatMap(value => record(value) && typeof value.name === 'string'
      ? [{ name: value.name, type: typeof value.type === 'string' ? value.type : 'text/plain', displayName: typeof value.displayName === 'string' ? value.displayName : undefined,
        size: typeof value.size === 'number' ? value.size : undefined, attachmentId: typeof value.attachmentId === 'string' ? value.attachmentId : undefined }] : []) : []
    const user: EngineHistoryRow = { id: run.userMessageId, role: 'user', content: input.message, createdAt: at, conversationId: run.turnId,
      metadata: { rootRunId: run.runId, attachments: sentAttachments } }
    const assistant: EngineHistoryRow = { id: run.assistantMessageId, role: 'assistant', content: 'HOME_SEND_OK：已收到任务与资料。',
      createdAt: at + 1, conversationId: run.turnId, metadata: { rootRunId: run.runId } }
    const terminal: RootRun = { ...run, status: 'succeeded', version: 2, updatedAt: at + 2, finishedAt: at + 2 }
    runs.set(owner, [terminal]); histories.set(owner, [user, assistant])
    if (record(input.admission)) admissions.set(String(input.admission.requestKey), { admission: input.admission, run: terminal })
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const events: ChatSsePayload[] = [{ run }, { userMessage: user }, { content: assistant.content }, { run: terminal }]
    events.forEach((payload, index) => response.write(`id: ${run.runId}:${index + 1}\ndata: ${JSON.stringify(payload)}\n\n`))
    response.end('data: [DONE]\n\n'); return
  }
  if (path === '/api/v1/chat/stream') {
    streamRequests.push({ sessionId: id, lastEventId: url.searchParams.get('lastEventId') })
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    if (current?.status !== 'running') { response.end('data: [DONE]\n\n'); return }
    // Recovery must attach to a live cursor; ending an executing run's stream would immediately request recovery again.
    const streams = liveStreams.get(id) ?? new Set<ServerResponse>()
    liveStreams.set(id, streams); streams.add(response)
    response.on('close', () => {
      streams.delete(response)
      if (!streams.size && liveStreams.get(id) === streams) liveStreams.delete(id)
    })
    response.write(': connected\n\n'); return
  }
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id, conversationId: row.conversationId,
      preview: row.content, createdAt: row.createdAt })), messages: rows, loadedTurnIds: users.map(row => row.id),
      revision: `${generation}-${id}-${rows.length}`, mutationRevision: `${generation}`, backend: 'jsonl', completeness: 'complete' })); return
  }
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET') { forbidden.push(`${request.method} ${path}`); throw new Error(`Unexpected mutation ${path}`) }
  const active = current && ['running', 'waiting'].includes(current.status)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'c'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'work-home-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: modelName, isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: current?.status === 'running' ? 'live' : 'persisted', eventId: current?.status === 'running' ? streamCursor(current) : null, finished: !active,
      history: rows, projection: [], run: current, runs: runs.get(id) ?? [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: Boolean(active), finished: !active, run: current, lastEventId: current?.status === 'running' ? streamCursor(current) : null }
    : path === '/api/v1/chat/runs' ? { runs: runs.get(id) ?? [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? []
    : path === '/api/v1/workspace/directory' ? { root: workspaceFor(id), bindingEpoch: `home-${id}`, entries: [] }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: Boolean(current), agentId: null, metadata: null, agent: null }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/memory/preferences' ? { enabled: false, globalEnabled: false, sessionDefaultEnabled: false }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const home = (): Locator => page.locator('.work-home')
const composer = (): Locator => home().getByRole('textbox', { name: '任务目标', exact: true })
const recent = (): Locator => home().locator('.work-recent')
const taskRows = (): Locator => recent().locator('.work-task-row')
const taskSearch = (): Locator => recent().getByRole('searchbox', { name: '搜索 Work 任务', exact: true })
async function savedHome(): Promise<SessionState> {
  return page.evaluate(key => { window.dispatchEvent(new Event('blur')); return JSON.parse(localStorage.getItem(key) ?? '{}') as SessionState }, storageKey)
}
async function seed(options: Partial<Pick<SessionState, 'homeDraft' | 'homeWorkspacePath' | 'homeAttachments' | 'homeMentions' | 'homeSources'>> = {}, workspaceHistory: WorkspaceHistoryEntry[] = [], fixtureTasks: readonly SessionTask[] = tasks): Promise<void> {
  resetFixture(fixtureTasks)
  if (options.homeWorkspacePath === null) bindings.delete(homeId)
  await page.evaluate(({ key, tasks, modelId, workspaceRoot, homeId, options, workspaceHistoryKey, foreignHistoryKey, workspaceHistory, foreignWorkspace }) => {
    window.dispatchEvent(new Event('blur'))
    localStorage.setItem(key, JSON.stringify({ tasks, activeTaskId: null, homeDraft: '', homeModelId: modelId,
      homeWorkspacePath: workspaceRoot, homeSessionId: homeId, homeAttachments: [], homeSources: [], ...options }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem(workspaceHistoryKey, JSON.stringify(workspaceHistory))
    localStorage.setItem(foreignHistoryKey, JSON.stringify([{ path: foreignWorkspace, updatedAt: Date.now() }]))
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
  }, { key: storageKey, tasks: fixtureTasks.slice().reverse(), modelId, workspaceRoot, homeId, options, workspaceHistoryKey, foreignHistoryKey, workspaceHistory, foreignWorkspace })
  await page.reload(); await expect(home()).toBeVisible(); await expect(composer()).toBeVisible()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
}
async function setWindow(width: number, height = 900): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, size) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(520, 600); win.setContentSize(size.width, size.height) }, { width, height })
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height })
}
async function settleLayout(): Promise<void> {
  await page.evaluate(async () => {
    // Resize observers and presence transitions can start on the next frame.
    // Wait for their real completion before measuring or capturing the page.
    for (let pass = 0; pass < 10; pass++) {
      await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
      const animations = document.getAnimations().filter(animation => (animation.pending || animation.playState === 'running') &&
        animation.effect?.getTiming().iterations !== Infinity)
      if (!animations.length) return
      await Promise.allSettled(animations.map(animation => animation.finished))
    }
    throw new Error('Home layout did not settle after finite transitions')
  })
}
async function setAppearance(appearance: 'light' | 'dark'): Promise<void> {
  // A dismissed dialog leaves the accessibility tree before its exit callback unmounts it.
  await expect(page.locator('.work-settings-dialog')).toHaveCount(0)
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(settings).toBeVisible()
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await settings.getByRole('button', { name: '关闭', exact: true }).click(); await expect(settings).toHaveCount(0)
  await expect(page.locator('.modal-overlay')).toHaveCount(0)
  await settleLayout()
}
async function setDefaultWorkspace(path: string): Promise<void> {
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '引擎管理', exact: true }).click()
  await settings.getByRole('textbox', { name: '远端工作目录', exact: true }).fill(path)
  await settings.getByRole('button', { name: '保存', exact: true }).click()
  await expect(settings.getByText('已保存', { exact: true })).toBeVisible()
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.locator('.modal-overlay')).toHaveCount(0)
  await settleLayout()
}

async function expectOutlineIcons(container: Locator, minimum = 1): Promise<void> {
  const icons = await container.locator('svg[data-icon]:visible').evaluateAll(elements => elements.map(element => ({
    name: element.getAttribute('data-icon'), style: element.getAttribute('data-icon-style'),
    hidden: element.getAttribute('aria-hidden'), viewBox: element.getAttribute('viewBox'),
    shapes: [...element.querySelectorAll('path, circle, rect, line, polyline, polygon')].map(shape => {
      const style = getComputedStyle(shape)
      return { fill: style.fill, stroke: style.stroke, width: Number.parseFloat(style.strokeWidth), cap: style.strokeLinecap, join: style.strokeLinejoin }
    }),
  })))
  expect(icons.length).toBeGreaterThanOrEqual(minimum)
  for (const icon of icons.filter(icon => icon.name !== 'vscode')) {
    expect(icon.style, `${icon.name} must inherit the Work icon style`).toBe('outline')
    expect(icon.hidden).toBe('true'); expect(icon.viewBox).toBe('0 0 24 24')
    expect(icon.shapes.length, `${icon.name} must contain visible geometry`).toBeGreaterThan(0)
    for (const shape of icon.shapes) {
      expect(shape.fill, `${icon.name} must not fall back to the old solid glyph`).toBe('none')
      expect(shape.stroke).not.toBe('none'); expect(shape.width).toBeCloseTo(1.5, 2)
      expect(shape.cap).toBe('round'); expect(shape.join).toBe('round')
    }
  }
}

test.describe.serial('Work 首页', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'work-home-profile-'))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    const source = engineStorageKey({ mode: 'remote', baseUrl: origin })
    storageKey = sessionStorageKey('aether.work.state.v1', source)
    workspaceHistoryKey = sessionStorageKey('aether.work.workspace-history.v1', source)
    foreignHistoryKey = sessionStorageKey('aether.work.workspace-history.v1', engineStorageKey({ mode: 'remote', baseUrl: 'http://127.0.0.1:65500' }))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, remoteWorkspaceRoot: workspaceRoot,
      autoStartEngine: true, lastFolder: '', lastModelId: modelId, appearance: 'light', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1440, 900); win.show(); win.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  })
  test.beforeEach(async () => { await setWindow(1440); await seed() })
  test.afterEach(async ({}, info) => {
    if (page && !page.isClosed()) {
      if (await home().count()) {
        const layoutPath = info.outputPath('home-layout.json')
        writeFileSync(layoutPath, JSON.stringify(await home().evaluate(element => {
        const toolbar = element.querySelector('.work-recent__toolbar')
        return { home: element.getBoundingClientRect().toJSON(), toolbar: toolbar?.getBoundingClientRect().toJSON(),
          scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
          overflowY: getComputedStyle(element).overflowY, paddingTop: getComputedStyle(element).paddingTop }
        }), null, 2))
        await info.attach('home-layout', { path: layoutPath, contentType: 'application/json' })
      }
      const path = info.outputPath('work-home.png'); await page.screenshot({ path }); await info.attach('work-home', { path, contentType: 'image/png' })
    }
    await info.attach('home-fixture-requests', { body: JSON.stringify({ errors, forbidden, chats, chatWorkspaces, bindingEvents, streamRequests, uploads: uploads.map(file => ({ ...file, bytes: file.bytes.toString('utf8') })) }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([]); expect(forbidden).toEqual([])
  })
  test.afterAll(async () => {
    try { await app?.close() } finally {
      closeLiveStreams(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('work-home-profile-')) throw new Error('Unsafe home fixture cleanup')
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('首页运行列表：仅首页右上角显示，真实切换任务与浅深窄窗键盘交互可用', async ({}, info) => {
    const navigation = page.locator('.work-navigation')
    const entry = page.locator('.work-main > .work-run-list')
    const trigger = entry.getByRole('button', { name: '查看运行列表，共 2 项任务', exact: true })
    const dialog = page.getByRole('dialog', { name: '运行列表', exact: true })
    const assertHomeEntry = async (): Promise<void> => {
      await expect(home()).toBeVisible()
      expect((await savedHome()).activeTaskId).toBeNull()
      await expect(page.locator('.work-run-list')).toHaveCount(1)
      await expect(entry).toHaveCount(1)
      await expect(page.locator('.work-sidebar .work-run-list, .work-task-heading .work-run-list')).toHaveCount(0)
      await expect(trigger).toBeVisible(); await expect(trigger).toBeEnabled()
      await expect(trigger.locator('.work-run-list__label')).toHaveText('运行列表')
      await expect(trigger.locator('.work-run-list__count')).toHaveText('2')
      await expect(trigger.locator('svg[data-icon="list-play"]')).toHaveCount(1)
      await settleLayout()
      expect(await entry.evaluate(element => {
        const bounds = element.getBoundingClientRect(), main = element.parentElement!.getBoundingClientRect()
        return bounds.left >= main.left + main.width / 2 && bounds.right <= main.right + 1 && main.right - bounds.right <= 48 &&
          bounds.top >= main.top && bounds.top - main.top <= 48
      })).toBe(true)
    }
    const assertNoEntry = async (): Promise<void> => {
      await expect(page.locator('.work-run-list')).toHaveCount(0)
      await expect(page.getByRole('button', { name: /^查看运行列表，共/ })).toHaveCount(0)
      await expect(dialog).toHaveCount(0)
    }
    const returnHome = async (): Promise<void> => {
      await page.locator('.work-sidebar').getByRole('button', { name: '新任务', exact: true }).click()
      await assertHomeEntry()
      await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    }
    const openList = async (): Promise<void> => {
      await trigger.click(); await expect(dialog).toBeVisible()
      await expect(dialog.locator('.work-run-list__item-main strong')).toHaveText([tasks[0].title, tasks[1].title])
      await expect(dialog.locator('.work-run-list__status--running')).toHaveCount(1)
      await expect(dialog.locator('.work-run-list__status--waiting')).toHaveCount(1)
      await expect(dialog.locator('.work-run-list__item')).toHaveCount(2)
      await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    }
    const closeWithEscape = async (): Promise<void> => {
      await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0)
      await expect(trigger).toHaveAttribute('aria-expanded', 'false'); await expect(trigger).toBeFocused()
    }
    const selectListedTask = async (task: SessionTask): Promise<void> => {
      await dialog.locator('.work-run-list__item-main').filter({ hasText: task.title }).click()
      await expect(dialog).toHaveCount(0)
      await expect.poll(async () => (await savedHome()).activeTaskId).toBe(task.id)
      await expect(page.locator('.work-task-heading h1')).toHaveText(task.title)
      await expect(page.locator('.work-conversation')).toContainText(`HOME_OPENED:${task.id}`)
      await assertNoEntry()
    }
    try {
      await assertHomeEntry(); await openList(); await closeWithEscape()
      await taskRows().filter({ hasText: longTitle }).click()
      await expect.poll(async () => (await savedHome()).activeTaskId).toBe(tasks[4].id)
      await expect(page.locator('.work-task-heading h1')).toHaveText(longTitle)
      await assertNoEntry()
      await returnHome(); await openList(); await selectListedTask(tasks[0])
      await returnHome(); await openList(); await selectListedTask(tasks[1])
      await navigation.getByRole('button', { name: '项目', exact: true }).click()
      await expect(navigation.getByRole('button', { name: '项目', exact: true })).toHaveAttribute('aria-current', 'page')
      await expect(page.locator('.work-task-heading')).toHaveCount(0)
      await assertNoEntry(); await returnHome()
      for (const appearance of ['light', 'dark'] as const) {
        await setWindow(1440); await setAppearance(appearance)
        for (const width of [1440, 540]) {
          await setWindow(width, width === 540 ? 650 : 900)
          await assertHomeEntry(); await openList(); await settleLayout()
          expect(await dialog.evaluate(element => {
            const bounds = element.getBoundingClientRect()
            return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= window.innerWidth + 1 && bounds.bottom <= window.innerHeight + 1
          })).toBe(true)
          const screenshot = info.outputPath(`home-run-list-${appearance}-${width}.png`)
          await page.screenshot({ path: screenshot, animations: 'disabled' })
          await info.attach(`首页运行列表-${appearance}-${width}`, { path: screenshot, contentType: 'image/png' })
          await closeWithEscape()
        }
      }
      await setWindow(1440)
      await page.locator('.work-sidebar').getByRole('button', { name: '收起 应用导航', exact: true }).click()
      await expect(page.locator('.work-view')).toHaveAttribute('data-collapsed', 'true')
      await assertHomeEntry(); await openList(); await closeWithEscape()
      await openList(); await selectListedTask(tasks[1])
      expect(chats).toHaveLength(0)
    } finally {
      await page.keyboard.press('Escape'); await setWindow(1440); await setAppearance('light')
    }
  })

  test('首页运行列表：单项任务实时归零后再出现保持关闭', async () => {
    await seed({}, [], [tasks[0]])
    const trigger = page.locator('.work-main > .work-run-list').getByRole('button', { name: '查看运行列表，共 1 项任务', exact: true })
    const dialog = page.getByRole('dialog', { name: '运行列表', exact: true })
    await expect(trigger).toBeVisible(); await trigger.click()
    await expect(dialog.locator('.work-run-list__item-main strong')).toHaveText([tasks[0].title])
    await expect(dialog.locator('.work-run-list__item-main.is-active')).toHaveCount(0)
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const id = tasks[0].id, running = latest(id)!
    const finishedAt = Date.now(), terminal: RootRun = { ...running, status: 'succeeded', version: running.version + 1, updatedAt: finishedAt, finishedAt }
    runs.set(id, [terminal])
    await expect.poll(async () => (await savedHome()).tasks.find(task => task.id === id)?.status).toBe('done')
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('.work-run-list')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^查看运行列表，共/ })).toHaveCount(0)
    expect((await savedHome()).tasks.filter(task => ['running', 'waiting'].includes(task.status))).toEqual([])
    expect((await savedHome()).activeTaskId).toBeNull()
    await expect(home()).toBeVisible()

    // Idle-row discovery has a 15-second cooldown. Keep the same home mounted and wait for its real server probe.
    const restartedAt = Date.now(), seq = running.seq + 1
    const restarted: RootRun = { ...running, runId: `${running.runId}-next`, turnId: `${running.turnId}-${seq}`,
      userMessageId: `${running.userMessageId}-${seq}`, assistantMessageId: `${running.assistantMessageId}-${seq}`,
      seq, version: 1, createdAt: restartedAt, updatedAt: restartedAt, startedAt: restartedAt }
    runs.set(id, [terminal, restarted])
    histories.set(id, [...histories.get(id)!,
      { id: restarted.userMessageId, role: 'user', content: tasks[0].title, createdAt: restartedAt, conversationId: restarted.turnId, metadata: { rootRunId: restarted.runId } },
      { id: restarted.assistantMessageId, role: 'assistant', content: `HOME_RESTARTED:${id}`, createdAt: restartedAt, conversationId: restarted.turnId, metadata: { rootRunId: restarted.runId } },
    ])
    await expect(trigger).toBeVisible({ timeout: 30_000 })
    await expect.poll(async () => (await savedHome()).tasks.find(task => task.id === id)?.status).toBe('running')
    await expect(trigger).toHaveAttribute('aria-expanded', 'false'); await expect(dialog).toHaveCount(0)
    expect((await savedHome()).activeTaskId).toBeNull()
    await expect(home()).toBeVisible(); await expect(page.locator('.work-sidebar .work-run-list')).toHaveCount(0)
    await trigger.click(); await expect(dialog.locator('.work-run-list__item-main.is-active')).toHaveCount(0)
    await expect(dialog.locator('.work-run-list__item-main strong')).toHaveText([tasks[0].title])
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused()
    await trigger.click(); await dialog.locator('.work-run-list__item-main').click()
    await expect.poll(async () => (await savedHome()).activeTaskId).toBe(id)
    await expect(page.locator('.work-conversation')).toContainText(`HOME_RESTARTED:${id}`)
    await expect(page.locator('.work-run-list')).toHaveCount(0)
    await expect.poll(() => liveStreams.get(id)?.size ?? 0).toBeGreaterThan(0)
    expect(streamRequests).toContainEqual({ sessionId: id, lastEventId: streamCursor(restarted) })
    await page.locator('.work-sidebar').getByRole('button', { name: '新任务', exact: true }).click()
    await expect(home()).toBeVisible(); await expect(trigger).toBeVisible()
    await expect(trigger).toHaveAttribute('aria-expanded', 'false'); await expect(dialog).toHaveCount(0)
    expect(chats).toHaveLength(0)
  })

  test('Work 图标：导航语义、跨门户一致性与浅深主题', async ({}, info) => {
    const sidebar = page.getByRole('complementary', { name: '应用导航', exact: true })
    const navigation = [
      ['工作台', 'dashboard'], ['项目', 'folder-outline'], ['Agent', 'account-outline'],
      ['插件', 'puzzle'], ['浏览器', 'globe'], ['自动化', 'clock-outline'], ['引擎监控', 'activity'],
    ]
    await expect(sidebar.locator('.work-navigation > button')).toHaveCount(navigation.length)
    for (const [label, icon] of navigation) {
      const glyph = sidebar.getByTitle(label, { exact: true }).locator('svg[data-icon]')
      await expect(glyph).toHaveAttribute('data-icon', icon)
      await expect(glyph).toHaveAttribute('width', '18'); await expect(glyph).toHaveAttribute('height', '18')
    }
    await expect(sidebar.getByRole('button', { name: '新任务', exact: true }).locator('svg[data-icon="plus"]')).toHaveAttribute('width', '16')
    for (const appearance of ['light', 'dark'] as const) {
      await setAppearance(appearance)
      await expectOutlineIcons(sidebar, 9)
      await expectOutlineIcons(home(), 6)
      const screenshot = info.outputPath(`work-icons-navigation-${appearance}.png`)
      await sidebar.screenshot({ path: screenshot, animations: 'disabled' })
      await info.attach(`work-icons-navigation-${appearance}`, { path: screenshot, contentType: 'image/png' })
      await page.screenshot({ path: info.outputPath(`work-icons-surface-${appearance}.png`), animations: 'disabled' })
      await home().locator('.work-composer-workspace__trigger').click()
      const picker = page.getByRole('dialog', { name: '选择工作区', exact: true })
      await expect(picker).toBeVisible(); await settleLayout()
      expect(await picker.evaluate(element => element.closest('.work-view') === null)).toBe(true)
      await expectOutlineIcons(picker)
      const portalScreenshot = info.outputPath(`work-icons-portal-${appearance}.png`)
      await picker.screenshot({ path: portalScreenshot, animations: 'disabled' })
      await page.keyboard.press('Escape'); await expect(picker).toHaveCount(0)
      await sidebar.getByRole('button', { name: '设置', exact: true }).click()
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await expect(settings).toBeVisible(); await settleLayout()
      expect(await settings.evaluate(element => element.closest('.work-view') === null)).toBe(true)
      await expectOutlineIcons(settings, 8)
      await settings.getByRole('button', { name: '关闭', exact: true }).click(); await expect(settings).toHaveCount(0)
      await expect(page.locator('.modal-overlay')).toHaveCount(0)
      await settleLayout()
    }
    await setAppearance('light')
    await expect(home()).toBeVisible(); await expectOutlineIcons(sidebar, 9)
  })

  test('Work 图标：全目录路径边界与浅深色图谱', async ({}, info) => {
    const entries = Object.entries(OUTLINE_ICON_PATHS)
    expect(entries.length).toBeGreaterThan(80)
    expect(entries.some(([name]) => name === 'vscode')).toBe(false)
    await setWindow(1440, 1200)
    try {
      for (const appearance of ['light', 'dark'] as const) {
        await setAppearance(appearance)
        await page.evaluate(entries => {
          const sheet = document.createElement('div')
          sheet.id = 'work-icon-contact-sheet'
          sheet.style.cssText = 'position:fixed;left:24px;top:24px;width:calc(100vw - 48px);z-index:2147483647;box-sizing:border-box;padding:24px;display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:16px 8px;background:var(--bg-panel);color:var(--fg);font-family:var(--font-ui);border:1px solid var(--border);border-radius:12px'
          for (const [name, geometry] of entries) {
            const tile = document.createElement('div')
            tile.style.cssText = 'display:flex;min-width:0;min-height:64px;align-items:center;justify-content:flex-start;flex-direction:column;gap:8px;text-align:center'
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
            svg.setAttribute('width', '24'); svg.setAttribute('height', '24'); svg.setAttribute('viewBox', '0 0 24 24')
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
            path.setAttribute('d', geometry); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor')
            path.setAttribute('stroke-width', '1.5'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round')
            path.dataset.icon = name; svg.appendChild(path)
            const label = document.createElement('span')
            label.style.cssText = 'font-size:11px;line-height:14px;overflow-wrap:anywhere'
            label.textContent = name; tile.append(svg, label); sheet.appendChild(tile)
          }
          document.body.appendChild(sheet)
        }, entries)
        const sheet = page.locator('#work-icon-contact-sheet')
        try {
          const geometry = await sheet.locator('path').evaluateAll(paths => paths.map(path => {
            const svgPath = path as SVGPathElement, box = svgPath.getBBox()
            return { name: path.getAttribute('data-icon'), length: svgPath.getTotalLength(), x: box.x, y: box.y, right: box.x + box.width, bottom: box.y + box.height }
          }))
          expect(geometry).toHaveLength(entries.length)
          for (const glyph of geometry) {
            expect(glyph.length, `${glyph.name} must draw a non-empty SVG path`).toBeGreaterThan(0)
            expect(glyph.x, `${glyph.name} left edge`).toBeGreaterThanOrEqual(-0.1)
            expect(glyph.y, `${glyph.name} top edge`).toBeGreaterThanOrEqual(-0.1)
            expect(glyph.right, `${glyph.name} right edge`).toBeLessThanOrEqual(24.1)
            expect(glyph.bottom, `${glyph.name} bottom edge`).toBeLessThanOrEqual(24.1)
          }
          const screenshot = info.outputPath(`work-icon-catalogue-${appearance}.png`)
          await sheet.screenshot({ path: screenshot, animations: 'disabled' })
          await info.attach(`work-icon-catalogue-${appearance}`, { path: screenshot, contentType: 'image/png' })
        } finally { await sheet.evaluate(element => element.remove()) }
      }
    } finally { await setWindow(1440); await setAppearance('light') }
  })

  test('模板追加到最新草稿，引用和附件在切页及重载后保留', async () => {
    const initial = `请保留已有说明 @${attachments[0].path}`
    const mention = { source: 'file' as const, origin: 'attachment' as const, displayText: '附件1', path: attachments[0].path,
      attachmentId: attachments[0].attachmentId, textOffset: '请保留已有说明 '.length }
    await seed({ homeDraft: initial, homeAttachments: attachments, homeMentions: [mention] })
    await expect(home().locator('.attach-chip')).toHaveCount(0)
    await expect(composer().locator('.mention-chip--attachment .mention-chip__label')).toHaveText(attachments.map(file => file.name))
    await composer().press('Control+End'); await composer().press('Shift+Enter'); await composer().pressSequentially('补充要求')
    expect(chats).toHaveLength(0)
    await home().getByRole('button', { name: '分析资料', exact: true }).click()
    await expect(composer()).toBeFocused()
    let saved = await savedHome()
    expect(saved.homeDraft).toContain(initial); expect(saved.homeDraft).toContain('补充要求')
    expect(saved.homeDraft).toContain('请分析我提供的资料')
    expect(saved.homeAttachments).toEqual(attachments.map(file => ({ ...file, inlineReference: true })))
    expect(saved.homeMentions).toContainEqual({ ...mention, displayText: attachments[0].name })
    const draft = saved.homeDraft
    await page.locator('.work-sidebar').getByRole('button', { name: '项目', exact: true }).click()
    await expect(home()).toHaveCount(0)
    await page.locator('.work-sidebar').getByRole('button', { name: /^工作台/ }).click()
    await expect(composer()).toContainText('补充要求')
    await page.reload(); await expect(composer()).toBeVisible()
    saved = await savedHome()
    expect(saved.homeDraft).toBe(draft); expect(saved.homeAttachments).toEqual(attachments.map(file => ({ ...file, inlineReference: true })))
    expect(saved.homeMentions).toContainEqual({ ...mention, displayText: attachments[0].name }); expect(chats).toHaveLength(0)
  })

  test('分页前后切换保留焦点，筛选搜索覆盖全量任务并重置页码', async ({}, info) => {
    await expect(taskRows()).toHaveCount(5)
    await expect(taskRows().first()).toContainText(tasks[0].title)
    await expect(taskRows().filter({ hasText: '已归档的首页任务不可见' })).toHaveCount(0)
    const pagination = recent().getByRole('navigation', { name: '最近任务分页', exact: true })
    const pageNumber = pagination.getByRole('status')
    const next = pagination.getByRole('button', { name: '下一页任务', exact: true })
    const previous = pagination.getByRole('button', { name: '上一页任务', exact: true })
    const rowIds = (): Promise<Array<string | null>> => taskRows().evaluateAll(rows => rows.map(row => row.getAttribute('data-task-id')))
    await expect(previous).toBeDisabled()
    await expect(pageNumber).toHaveText('第 1 / 11 页')
    await expect.poll(rowIds).toEqual(tasks.slice(0, 5).map(task => task.id))
    await next.focus(); await next.press('Enter')
    await expect.poll(rowIds).toEqual(tasks.slice(5, 10).map(task => task.id))
    await expect(pageNumber).toHaveText('第 2 / 11 页')
    await expect(next).toBeFocused(); await expect(previous).toBeEnabled()
    await settleLayout()
    const secondPagePath = info.outputPath('home-page-2.png')
    await page.screenshot({ path: secondPagePath }); await info.attach('home-page-2', { path: secondPagePath, contentType: 'image/png' })
    await previous.focus(); await previous.press('Enter')
    await expect.poll(rowIds).toEqual(tasks.slice(0, 5).map(task => task.id))
    await expect(previous).toBeDisabled()
    await expect(next).toBeFocused(); await expect(pageNumber).toHaveText('第 1 / 11 页')
    await taskSearch().focus()
    await taskRows().filter({ hasText: longTitle }).hover()
    const tooltip = page.getByRole('tooltip', { name: '任务详情', exact: true })
    await expect(tooltip).toBeVisible(); await expect(tooltip).toContainText(longTitle); await expect(tooltip).toContainText(workspaceRoot)
    await taskSearch().hover(); await expect(tooltip).toHaveCount(0)
    const filters = recent().locator('.work-filters')
    await settleLayout()
    const firstPageHeight = await recent().locator('.work-task-list').evaluate(element => element.getBoundingClientRect().height)
    await next.focus()
    for (let current = 2; current <= 11; current++) {
      await next.press('Enter'); await expect(pageNumber).toHaveText(`第 ${current} / 11 页`)
    }
    await expect.poll(rowIds).toEqual(tasks.slice(50, 52).map(task => task.id))
    await expect(next).toBeDisabled(); await expect(previous).toBeFocused()
    expect(Math.abs(await recent().locator('.work-task-list').evaluate(element => element.getBoundingClientRect().height) - firstPageHeight)).toBeLessThanOrEqual(1)
    await page.mouse.move(5, 5); await settleLayout()
    const lastPagePath = info.outputPath('home-last-page.png')
    await page.screenshot({ path: lastPagePath }); await info.attach('home-last-page', { path: lastPagePath, contentType: 'image/png' })
    await previous.press('Enter'); await expect(pageNumber).toHaveText('第 10 / 11 页'); await expect(previous).toBeFocused()
    await filters.getByRole('button', { name: '进行中', exact: true }).click(); await expect(taskRows()).toHaveCount(1)
    await expect(taskRows()).toContainText(tasks[0].title)
    await expect(pagination).toHaveCount(0)
    await filters.getByRole('button', { name: /^需要处理/ }).click(); await expect(taskRows()).toHaveCount(1)
    await expect(taskRows()).toContainText(tasks[1].title)
    await filters.getByRole('button', { name: '已完成', exact: true }).click(); await expect(taskRows()).toHaveCount(5)
    await expect(taskRows().first()).toContainText(longTitle)
    await expect(pageNumber).toHaveText('第 1 / 10 页')
    await next.click(); await expect.poll(rowIds).toEqual(tasks.slice(9, 14).map(task => task.id))
    await taskSearch().fill('验收搜索关键词'); await expect(taskRows()).toHaveCount(1)
    await expect(taskRows()).toContainText(tasks[51].title)
    await expect(pagination).toHaveCount(0)
    await taskSearch().fill(''); await expect(pageNumber).toHaveText('第 1 / 10 页')
    await expect.poll(rowIds).toEqual(tasks.slice(4, 9).map(task => task.id))
    await taskSearch().fill('不存在的任务'); await expect(taskRows()).toHaveCount(0)
    await filters.getByRole('button', { name: '全部', exact: true }).click()
    await taskSearch().fill('验收搜索关键词'); await taskRows().click()
    await expect(home()).toHaveCount(0)
    await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').activeTaskId, storageKey)).toBe(tasks[51].id)
    await expect(page.locator('.work-conversation')).toContainText(`HOME_OPENED:${tasks[51].id}`)
    expect(chats).toHaveLength(0)
  })

  test('实际添加资料后 Enter 只发送一次，资料字节及草稿会话保持一致', async () => {
    const contents = '真实上传资料\r\n需要保留中文、换行和末尾空格。  \r\n'
    const path = join(fixture, '首页上传资料.txt'); writeFileSync(path, contents)
    await expect(home().getByRole('button', { name: '添加资料', exact: true })).toBeEnabled()
    await home().locator('input[type="file"]').setInputFiles(path)
    await expect.poll(() => uploads.length).toBe(1)
    expect(uploads[0].sessionId).toBe(homeId); expect(uploads[0].bytes.equals(Buffer.from(contents))).toBe(true)
    await expect(home().locator('.attach-chip')).toHaveCount(0)
    await expect(composer().locator('.mention-chip--attachment .mention-chip__label')).toHaveText('首页上传资料.txt')
    await composer().focus(); await composer().press('Control+End'); await composer().pressSequentially('请整理这份资料')
    await composer().press('Shift+Enter'); await composer().pressSequentially('保留关键结论')
    expect(chats).toHaveLength(0)
    const pending = await savedHome()
    await expect(home().getByRole('button', { name: '开始任务', exact: true })).toBeEnabled()
    await composer().press('Enter')
    await expect.poll(() => chats.length).toBe(1)
    expect(chats[0].sessionId).toBe(homeId); expect(String(chats[0].message)).toContain('请整理这份资料\n保留关键结论')
    expect(chats[0].attachments).toEqual(expect.arrayContaining([expect.objectContaining({ name: uploads[0].path })]))
    await expect(page.locator('.work-conversation')).toContainText('HOME_SEND_OK')
    await expect.poll(async () => (await savedHome()).tasks.find(task => task.id === homeId)?.sources.map(file => file.path))
      .toEqual(expect.arrayContaining(pending.homeAttachments.map(file => file.path)))
    const state = await savedHome(), created = state.tasks.find(task => task.id === homeId)
    expect(state.activeTaskId).toBe(homeId); expect(created?.workspacePath).toBe(workspaceRoot)
    expect(created?.sources.map(file => file.path)).toEqual(expect.arrayContaining(pending.homeAttachments.map(file => file.path)))
    expect(state.homeDraft).toBe(''); expect(state.homeAttachments).toEqual([]); expect(chats).toHaveLength(1)
  })

  test('卡片外的工作区菜单隔离来源，切换和清除保留草稿并使用正确目录发送', async ({}, info) => {
    const initial = '请保留这份工作目标，再到选定目录整理资料。'
    const history = [otherWorkspace, workspaceRoot, ...Array.from({ length: 5 }, (_, index) => `/remote/home-ui/history-${index}`)]
      .map((path, index) => ({ path, updatedAt: now + 10_000 - index }))
    await seed({ homeDraft: initial }, history)
    const trigger = home().locator('.work-composer-workspace__trigger')
    const picker = page.getByRole('dialog', { name: '选择工作区', exact: true })
    const choose = (path: string): Locator => picker.getByRole('button', { name: `使用工作区：${path}`, exact: true })
    await expect(home().locator('.input-composer .work-composer-workspace')).toHaveCount(0)
    await expect(trigger).toHaveAttribute('aria-label', `当前工作区：${workspaceRoot}`)
    await composer().press('Control+End'); await composer().press('Shift+Enter'); await composer().pressSequentially('保留补充说明')
    const draft = (await savedHome()).homeDraft
    await trigger.focus(); await trigger.press('Enter'); await expect(picker).toBeVisible()
    await expect(choose(workspaceRoot)).toHaveAttribute('aria-pressed', 'true')
    await expect(choose(otherWorkspace)).toContainText(otherWorkspace)
    await expect(picker.getByRole('button', { name: `使用工作区：${foreignWorkspace}`, exact: true })).toHaveCount(0)
    const search = picker.getByRole('searchbox', { name: '搜索工作区', exact: true })
    await expect(search).toBeFocused()
    await search.fill('客户研究项目'); await expect(choose(otherWorkspace)).toBeVisible(); await expect(choose(workspaceRoot)).toHaveCount(0)
    await search.fill(''); await settleLayout()
    const menuPath = info.outputPath('home-workspace-menu.png')
    await page.screenshot({ path: menuPath }); await info.attach('home-workspace-menu', { path: menuPath, contentType: 'image/png' })
    await page.keyboard.press('Escape'); await expect(picker).toHaveCount(0); await expect(trigger).toBeFocused()
    await setWindow(540, 600); await settleLayout()
    await trigger.press('Enter'); await expect(search).toBeFocused()
    await picker.getByRole('button', { name: '输入工作区路径…', exact: true }).click()
    const pathInput = picker.getByRole('textbox', { name: '远端工作区路径', exact: true })
    await expect(pathInput).toBeFocused(); await pathInput.fill(otherWorkspace)
    const applyPath = picker.getByRole('button', { name: '使用此工作区', exact: true })
    await applyPath.scrollIntoViewIfNeeded(); await expect(applyPath).toBeInViewport()
    const pickerFits = await picker.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight })
    expect(pickerFits).toBe(true); await settleLayout()
    const smallMenuPath = info.outputPath('home-workspace-small.png')
    await page.screenshot({ path: smallMenuPath }); await info.attach('home-workspace-small', { path: smallMenuPath, contentType: 'image/png' })
    await page.keyboard.press('Escape'); await expect(picker).toHaveCount(0); await expect(trigger).toBeFocused()
    await setWindow(1440); await settleLayout()
    await trigger.press('Enter'); await expect(search).toBeFocused()
    await choose(otherWorkspace).click(); await expect(picker).toHaveCount(0)
    await expect.poll(() => bindings.get(homeId)).toBe(otherWorkspace)
    let saved = await savedHome()
    expect(saved.homeWorkspacePath).toBe(otherWorkspace); expect(saved.homeDraft).toBe(draft); expect(saved.homeSessionId).toBe(homeId)
    expect(saved.homeAttachments).toEqual([]); expect(saved.homeMentions).toEqual([])
    await page.reload(); await expect(trigger).toHaveAttribute('aria-label', `当前工作区：${otherWorkspace}`)
    await trigger.click(); await expect(choose(otherWorkspace)).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Escape'); await expect(picker).toHaveCount(0)
    await home().getByRole('button', { name: '清除工作区选择，使用默认工作区', exact: true }).click()
    await expect.poll(async () => (await savedHome()).homeWorkspacePath).toBeNull()
    await expect.poll(() => bindings.get(homeId)).toBe(workspaceRoot)
    await trigger.click(); await expect(picker.getByRole('button', { name: '使用默认工作区', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await choose(otherWorkspace).click(); await expect(picker).toHaveCount(0)
    await expect.poll(() => bindings.get(homeId)).toBe(otherWorkspace)
    saved = await savedHome()
    expect(saved.homeDraft).toBe(draft); expect(saved.homeSessionId).toBe(homeId)
    expect(bindingEvents.filter(event => event.sessionId === homeId).map(event => event.workspaceRoot)).toEqual([otherWorkspace, workspaceRoot, otherWorkspace])
    const storedHistory = await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '[]') as WorkspaceHistoryEntry[], workspaceHistoryKey)
    expect(storedHistory[0].path).toBe(otherWorkspace); expect(storedHistory.some(entry => entry.path === foreignWorkspace)).toBe(false)

    const contents = '切换工作区后上传的真实资料。\r\n', path = join(fixture, '选定目录资料.txt')
    writeFileSync(path, contents); await home().locator('input[type="file"]').setInputFiles(path)
    await expect.poll(() => uploads.length).toBe(1)
    expect(uploads[0].sessionId).toBe(homeId); expect(uploads[0].bytes.equals(Buffer.from(contents))).toBe(true)
    expect(bindings.get(homeId)).toBe(otherWorkspace)
    await expect(home().getByRole('button', { name: '开始任务', exact: true })).toBeEnabled()
    await composer().press('Enter'); await expect.poll(() => chats.length).toBe(1)
    expect(chats[0].sessionId).toBe(homeId)
    // New remote Work runs send no client roots; their prior explicit bind is authoritative.
    expect(chats[0].workspacePaths).toEqual([])
    expect(chatWorkspaces).toEqual([{ sessionId: homeId, root: otherWorkspace }])
    expect(latest(homeId)?.workspacePaths).toEqual([otherWorkspace])
    expect(String(chats[0].message)).toContain(draft)
    await expect(page.locator('.work-conversation')).toContainText('HOME_SEND_OK')
    saved = await savedHome()
    expect(saved.tasks.find(task => task.id === homeId)?.workspacePath).toBe(otherWorkspace)
    expect(saved.tasks.filter(task => task.id !== homeId).every(task => task.workspacePath === workspaceRoot)).toBe(true)
    const startedTrigger = page.locator('.work-conversation .work-composer-workspace__trigger')
    await expect(startedTrigger).toHaveAttribute('aria-label', `当前工作区：${otherWorkspace}`)
    const bindingCount = bindingEvents.length
    await startedTrigger.click()
    const readonly = page.getByRole('dialog', { name: '当前工作区', exact: true })
    await expect(readonly).toContainText(otherWorkspace)
    await expect(readonly.getByRole('button', { name: /^使用工作区：/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '清除工作区选择，使用默认工作区', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape'); await expect(readonly).toHaveCount(0)
    expect(bindingEvents).toHaveLength(bindingCount)
  })

  test('有资料和引用的草稿锁定工作区，菜单查看不改变附件、引用或会话', async ({}, info) => {
    const draft = `请保留已有说明 @${attachments[0].path}`
    const mention = { source: 'file' as const, origin: 'attachment' as const, displayText: '附件1', path: attachments[0].path,
      attachmentId: attachments[0].attachmentId, textOffset: '请保留已有说明 '.length }
    await seed({ homeDraft: draft, homeAttachments: [attachments[0]], homeSources: [attachments[1]], homeMentions: [mention] },
      [{ path: otherWorkspace, updatedAt: now + 10_000 }])
    await expect(composer().locator('[data-mention-key]')).toHaveCount(1)
    await home().locator('.work-composer-workspace__trigger').click()
    const picker = page.getByRole('dialog', { name: '选择工作区', exact: true })
    await expect(picker).toContainText('移除草稿中的资料或文件引用后可切换')
    await expect(picker.getByRole('button', { name: `使用工作区：${otherWorkspace}`, exact: true })).toBeDisabled()
    await expect(picker.getByRole('button', { name: '使用默认工作区', exact: true })).toBeDisabled()
    await expect(home().getByRole('button', { name: '清除工作区选择，使用默认工作区', exact: true })).toBeDisabled()
    await settleLayout()
    const lockedPath = info.outputPath('home-workspace-locked.png')
    await page.screenshot({ path: lockedPath }); await info.attach('home-workspace-locked', { path: lockedPath, contentType: 'image/png' })
    await page.keyboard.press('Escape'); await expect(picker).toHaveCount(0)
    await page.reload(); await expect(composer().locator('[data-mention-key]')).toHaveCount(1)
    const saved = await savedHome()
    expect(saved.homeWorkspacePath).toBe(workspaceRoot); expect(saved.homeDraft).toBe(draft); expect(saved.homeSessionId).toBe(homeId)
    expect(saved.homeAttachments).toEqual([{ ...attachments[0], inlineReference: true }]); expect(saved.homeSources).toEqual([attachments[1]])
    expect(saved.homeMentions).toEqual([{ ...mention, displayText: attachments[0].name }])
    expect(bindingEvents.filter(event => event.sessionId === homeId)).toEqual([]); expect(chats).toEqual([])
  })

  test('未配置默认目录时清除工作区创建独立沙箱会话，不沿用旧绑定', async () => {
    await setDefaultWorkspace('')
    try {
      const draft = '清除目录后请在独立工作区执行这个新任务。'
      await seed({ homeDraft: draft }, [{ path: otherWorkspace, updatedAt: now + 10_000 }])
      const trigger = home().locator('.work-composer-workspace__trigger')
      await trigger.click()
      const picker = page.getByRole('dialog', { name: '选择工作区', exact: true })
      await picker.getByRole('button', { name: `使用工作区：${otherWorkspace}`, exact: true }).click()
      await expect.poll(() => bindings.get(homeId)).toBe(otherWorkspace)
      const bindingCount = bindingEvents.length
      await home().getByRole('button', { name: '清除工作区选择，使用默认工作区', exact: true }).click()
      await expect.poll(async () => (await savedHome()).homeSessionId).not.toBe(homeId)
      const saved = await savedHome(), scratchId = saved.homeSessionId!
      expect(scratchId).toMatch(/^work-home-[a-f\d-]{36}$/i)
      expect(saved.homeWorkspacePath).toBeNull(); expect(saved.homeDraft).toBe(draft)
      expect(saved.homeAttachments).toEqual([]); expect(saved.homeMentions).toEqual([])
      expect(bindings.get(homeId)).toBe(otherWorkspace); expect(bindings.has(scratchId)).toBe(false)
      expect(bindingEvents).toHaveLength(bindingCount)
      await expect(trigger).toHaveAttribute('aria-label', '当前工作区：默认工作区')
      await trigger.click(); await expect(picker.getByRole('button', { name: '使用默认工作区', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await page.keyboard.press('Escape'); await expect(picker).toHaveCount(0)
      await expect(home().getByRole('button', { name: '开始任务', exact: true })).toBeEnabled()
      await composer().press('Enter'); await expect.poll(() => chats.length).toBe(1)
      expect(chats[0].sessionId).toBe(scratchId); expect(chats[0].workspacePaths).toEqual([])
      expect(chatWorkspaces).toEqual([{ sessionId: scratchId, root: `/remote/home-ui/scratch/${scratchId}` }])
      await expect(page.locator('.work-conversation')).toContainText('HOME_SEND_OK')
      const started = (await savedHome()).tasks.find(task => task.id === scratchId)
      expect(started?.workspacePath).toBeNull(); expect(bindings.has(scratchId)).toBe(false)
      expect(latest(scratchId)?.workspacePaths).toEqual([`/remote/home-ui/scratch/${scratchId}`])
      await expect(page.locator('.work-conversation .work-composer-workspace__trigger'))
        .toHaveAttribute('aria-label', `当前工作区：/remote/home-ui/scratch/${scratchId}`)
      expect(bindings.get(homeId)).toBe(otherWorkspace)
    } finally {
      await setDefaultWorkspace(workspaceRoot)
    }
  })

  test('绑定读取失败时回滚目录，空默认且回滚失败时隔离旧会话', async () => {
    const draft = '工作区请求失败后仍需保留的任务正文。'
    await seed({ homeDraft: draft }, [{ path: otherWorkspace, updatedAt: now + 10_000 }])
    bindingFault = { sessionId: homeId, targetRoot: otherWorkspace, previousRoot: workspaceRoot, rollbackFails: false, stage: 'armed' }
    const trigger = home().locator('.work-composer-workspace__trigger')
    const picker = page.getByRole('dialog', { name: '选择工作区', exact: true })
    await trigger.click(); await picker.getByRole('button', { name: `使用工作区：${otherWorkspace}`, exact: true }).click()
    await expect.poll(() => bindingFault?.stage).toBe('complete')
    await expect(picker.getByRole('alert')).toContainText('未能切换工作区')
    expect(bindings.get(homeId)).toBe(workspaceRoot)
    let saved = await savedHome()
    expect(saved.homeWorkspacePath).toBe(workspaceRoot); expect(saved.homeSessionId).toBe(homeId); expect(saved.homeDraft).toBe(draft)
    expect(bindingEvents.filter(event => event.sessionId === homeId).map(event => event.workspaceRoot)).toEqual([otherWorkspace, workspaceRoot])
    await page.keyboard.press('Escape'); await expect(picker).toHaveCount(0)

    await setDefaultWorkspace('')
    try {
      await seed({ homeDraft: draft, homeWorkspacePath: null }, [{ path: otherWorkspace, updatedAt: now + 10_000 }])
      const previousRoot = workspaceFor(homeId)
      bindingFault = { sessionId: homeId, targetRoot: otherWorkspace, previousRoot, rollbackFails: true, stage: 'armed' }
      await trigger.click(); await picker.getByRole('button', { name: `使用工作区：${otherWorkspace}`, exact: true }).click()
      await expect.poll(() => bindingFault?.stage).toBe('complete')
      await expect.poll(async () => (await savedHome()).homeSessionId).not.toBe(homeId)
      saved = await savedHome()
      const safeSessionId = saved.homeSessionId!
      expect(safeSessionId).toMatch(/^work-home-[a-f\d-]{36}$/i)
      expect(saved.homeWorkspacePath).toBeNull(); expect(saved.homeDraft).toBe(draft); expect(saved.homeModelId).toBe(modelId)
      expect(saved.homeAttachments).toEqual([]); expect(saved.homeSources).toEqual([]); expect(saved.homeMentions).toEqual([])
      expect(bindings.get(homeId)).toBe(otherWorkspace); expect(bindings.has(safeSessionId)).toBe(false)
      await expect(home().getByRole('button', { name: '开始任务', exact: true })).toBeEnabled()
      await composer().press('Enter'); await expect.poll(() => chats.length).toBe(1)
      expect(chats[0].sessionId).toBe(safeSessionId); expect(chats[0].workspacePaths).toEqual([]); expect(chats[0].message).toBe(draft)
      expect(chatWorkspaces).toEqual([{ sessionId: safeSessionId, root: `/remote/home-ui/scratch/${safeSessionId}` }])
      await expect(page.locator('.work-conversation')).toContainText('HOME_SEND_OK')
      expect(latest(safeSessionId)?.workspacePaths).toEqual([`/remote/home-ui/scratch/${safeSessionId}`])
      expect(bindings.get(homeId)).toBe(otherWorkspace)
    } finally {
      await setDefaultWorkspace(workspaceRoot)
    }
  })

  test('长内容和多附件在浅深主题及窄窗中保持布局，近期工具栏固定', async ({}, info) => {
    await seed({ homeDraft: '请基于所附资料整理项目介绍，说明关键功能、交付物与后续计划。', homeAttachments: attachments })
    await expect(home().locator('.model-picker')).toContainText(modelName)
    for (const appearance of ['light', 'dark'] as const) {
      await setAppearance(appearance)
      for (const width of [1440, 760, 540]) {
        await setWindow(width)
        await page.mouse.move(5, 5)
        await settleLayout()
        await home().evaluate(element => { element.scrollTop = 0 })
        await expect(composer()).toBeVisible(); await expect(home().locator('.attach-chip')).toHaveCount(0)
        await expect(composer().locator('.mention-chip--attachment .mention-chip__label')).toHaveText(attachments.map(file => file.name))
        await expect(taskRows()).toHaveCount(5)
        await expect(home().locator('.input-composer .work-composer-workspace')).toHaveCount(0)
        const footerGeometry = await home().evaluate(element => {
          const card = element.querySelector('.input-composer')!.getBoundingClientRect()
          const footer = element.querySelector('.input-composer__followup')!.getBoundingClientRect()
          const workspace = element.querySelector('.work-composer-workspace')!.getBoundingClientRect()
          return { footerOutside: footer.top >= card.bottom - 1, workspaceOutside: workspace.top >= card.bottom - 1 }
        })
        expect(footerGeometry).toEqual({ footerOutside: true, workspaceOutside: true })
        const geometry = await home().evaluate(element => {
          const bounds = element.getBoundingClientRect()
          return { overflow: element.scrollWidth - element.clientWidth, pageOverflow: document.documentElement.scrollWidth - innerWidth,
            outside: Array.from(element.querySelectorAll('.work-composer-wrap, .work-recent, .work-task-row')).filter(item => {
              const rect = item.getBoundingClientRect(); return rect.left < bounds.left - 1 || rect.right > bounds.right + 1
            }).length }
        })
        expect(geometry).toEqual({ overflow: 0, pageOverflow: 0, outside: 0 })
        const topPath = info.outputPath(`home-${appearance}-${width}.png`)
        await page.screenshot({ path: topPath }); await info.attach(`home-${appearance}-${width}`, { path: topPath, contentType: 'image/png' })
        const toolbar = recent().locator('.work-recent__toolbar')
        const toolbarTop = await toolbar.evaluate(element => element.getBoundingClientRect().top)
        await home().evaluate(element => { element.scrollTop = element.scrollHeight })
        await expect.poll(() => toolbar.evaluate((element, initialTop) => {
          const rect = element.getBoundingClientRect(), viewport = element.closest('.work-home')!.getBoundingClientRect()
          const scroller = element.closest('.work-home')!, expectedTop = Math.max(viewport.top, initialTop - scroller.scrollTop)
          return Math.abs(scroller.scrollTop - (scroller.scrollHeight - scroller.clientHeight)) <= 1 &&
            Math.abs(rect.top - expectedTop) <= 1 && rect.bottom < viewport.bottom
        }, toolbarTop)).toBe(true)
        await expect(taskSearch()).toBeVisible()
        await expect(recent().locator('.work-filters')).toBeVisible()
        await expect(recent().getByRole('navigation', { name: '最近任务分页', exact: true })).toBeInViewport()
        const visibleTime = await taskRows().locator('time').evaluateAll(elements => elements.some(element => {
          const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
          return style.display !== 'none' && rect.width > 0 && rect.top >= 0 && rect.bottom <= innerHeight
        }))
        expect(visibleTime).toBe(true)
        const scrolledPath = info.outputPath(`home-scrolled-${appearance}-${width}.png`)
        await page.screenshot({ path: scrolledPath }); await info.attach(`home-scrolled-${appearance}-${width}`, { path: scrolledPath, contentType: 'image/png' })
      }
    }
  })
})
