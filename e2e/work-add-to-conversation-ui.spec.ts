/** Real Electron + authenticated HTTP: resource-tree mixed references, chat-menu
 * references, native Work code menus, exact selection snapshots and workspace
 * file/search switching with retained drafts/tree state. Build first;
 * this suite owns one profile/window/server and must run alone. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { ChatSsePayload } from '../src/shared/ipc'
import { parseConversationLink } from '../src/shared/conversation-link'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'add-to-conversation-token', model = 'add-to-conversation-model'
const taskA = 'work-add-a', taskB = 'work-add-b'
const titles = new Map([[taskA, '当前设计任务'], [taskB, '可引用的既有方案']])
const roots = new Map([[taskA, '/remote/add/task-a'], [taskB, '/remote/add/task-b']])
const errors: string[] = [], chats: Record<string, unknown>[] = [], mutations: string[] = []
const reads: Array<{ path: string; sessionId: string; limit: string | null }> = []
const histories = new Map<string, EngineHistoryRow[]>(), runs = new Map<string, RootRun[]>()
const admissions = new Map<string, { admission: Record<string, unknown>; run: RootRun }>()
interface SavedTask { id: string; draft: string; mentions: Array<Record<string, unknown>> }
let app: ElectronApplication | undefined, page: Page, fixture = '', storageKey = '', source = '', generation = 0
let displayMode: 'normal' | 'hold' | 'unsupported' | 'unavailable' = 'normal'
let held: { response: ServerResponse; data: unknown } | undefined
let launchEnv: Record<string, string> = {}
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const latestRun = (id: string): RootRun | undefined => runs.get(id)?.at(-1)


const codeLines = ["const before = 'OUTSIDE_BEFORE'", 'const alpha = 1', 'const beta = alpha + 2', 'console.log(beta) // OUTSIDE_AFTER']
const code = codeLines.join('\n') + '\n'
const selectedCode = codeLines.slice(1, 3).join('\n') + '\n'
const files = new Map([['demo.ts', code], ['notes.txt', 'The project notes.\n'], ['docs/guide.md', '# Guide\n']])
const fileReads: Array<{ sessionId: string; path: string; operation: string }> = []
const workspaceSearches: Record<string, unknown>[] = []
let holdStat = false
let heldStat: { response: ServerResponse; data: unknown } | undefined
function releaseStat(): void {
  holdStat = false
  if (heldStat && !heldStat.response.destroyed) heldStat.response.end(envelope(heldStat.data))
  heldStat = undefined
}
function relativePath(path: string, sessionId: string): string {
  const owner = roots.get(sessionId) ?? '/remote/configured-default'
  return path === owner || path === '.' ? '' : owner && path.startsWith(owner + '/') ? path.slice(owner.length + 1) : path
}
function directoryEntries(path: string): Array<{ name: string; path: string; isDirectory: boolean; size: number; mtimeMs: number }> {
  if (!path || path === '.') return [
    { name: 'docs', path: 'docs', isDirectory: true, size: 0, mtimeMs: 1 },
    ...['demo.ts', 'notes.txt'].map(name => ({ name, path: name, isDirectory: false, size: Buffer.byteLength(files.get(name)!), mtimeMs: 1 }))
  ]
  return path === 'docs' ? [{ name: 'guide.md', path: 'docs/guide.md', isDirectory: false, size: Buffer.byteLength(files.get('docs/guide.md')!), mtimeMs: 1 }] : []
}

function releaseDisplay(): void {
  displayMode = 'normal'
  if (held && !held.response.destroyed) held.response.end(envelope(held.data))
  held = undefined
}
function resetHistory(): void {
  histories.clear(); runs.clear(); admissions.clear(); generation++
  for (const [id, title] of titles) {
    const now = Date.now() - 10_000
    const run: RootRun = { schemaVersion: 1, runId: `reference-root-${id}-${generation}`, sessionId: id,
      turnId: `reference-turn-${id}-${generation}`, userMessageId: `reference-user-${id}-${generation}`,
      assistantMessageId: `reference-assistant-${id}-${generation}`, seq: 1, version: 2, status: 'succeeded',
      modelId: model, pending: [], workspacePaths: [roots.get(id)!], createdAt: now, updatedAt: now, startedAt: now - 10, finishedAt: now }
    runs.set(id, [run])
    histories.set(id, [
      { id: run.userMessageId, role: 'user', content: `REQUEST_${id}：${title}`, createdAt: now - 10,
        conversationId: run.turnId, metadata: { rootRunId: run.runId } },
      { id: `reference-tool-call-${id}`, role: 'assistant', content: '', reasoningContent: 'PRIVATE_REASONING_MUST_NOT_BE_REFERENCED',
        toolCall: { id: `tool-${id}`, name: 'read_file', args: { path: 'notes.txt' } }, createdAt: now - 5,
        conversationId: run.turnId, metadata: { rootRunId: run.runId } },
      { id: `reference-tool-output-${id}`, role: 'tool', content: 'PROCESS_LOG_MUST_NOT_BE_REFERENCED', toolCallId: `tool-${id}`,
        createdAt: now - 3, conversationId: run.turnId, metadata: { rootRunId: run.runId } },
      { id: run.assistantMessageId, role: 'assistant', content: `FINAL_RESULT_${id}：已确认的最终方案。`, createdAt: now,
        conversationId: run.turnId, metadata: { rootRunId: run.runId } }
    ])
  }
}

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, sessionId = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const bytes = Buffer.concat(chunks), parsed: unknown = bytes.length ? JSON.parse(bytes.toString('utf8')) : {}, input = isRecord(parsed) ? parsed : {}
  const current = latestRun(sessionId), rows = histories.get(sessionId) ?? []
  if (request.method !== 'GET') mutations.push(`${request.method} ${path}`)

  if (path === '/api/v1/workspace/search' && request.method === 'POST') {
    if (input.sessionId !== taskA || input.expectedRoot !== roots.get(taskA) || input.bindingEpoch !== `binding-${taskA}`
      || typeof input.requestId !== 'string' || !input.requestId || input.query !== 'Guide' || !isRecord(input.options)
      || input.options.include !== '*.md' || input.options.exclude !== 'ignored/**') throw new Error('Workspace search lost its session, root or saved filters')
    workspaceSearches.push(input)
    const text = files.get('docs/guide.md')!.split('\n')[0]
    response.end(envelope({ root: roots.get(taskA), bindingEpoch: `binding-${taskA}`, strategy: 'scan', truncated: false,
      hits: [{ path: 'docs/guide.md', line: 1, column: text.indexOf('Guide') + 1, length: 5, text }] })); return
  }
  if (path === '/api/v1/workspace/search/cancel' && request.method === 'POST') {
    if (input.sessionId !== taskA || typeof input.requestId !== 'string'
      || !workspaceSearches.some(search => search.requestId === input.requestId)) throw new Error('Workspace search cancellation escaped its session')
    response.end(envelope({ cancelled: true })); return
  }

  if (path === '/api/v1/workspace/file/info' || path === '/api/v1/workspace/file/content') {
    const codeSession = Boolean(sessionId && !sessionId.startsWith('work-'))
    if (!titles.has(sessionId) && !codeSession) throw new Error(`File request escaped its owner: ${sessionId}`)
    const ownerRoot = roots.get(sessionId) ?? '/remote/configured-default'
    const relative = relativePath(url.searchParams.get('path') ?? '', sessionId)
    const isDirectory = !relative || relative === 'docs', content = files.get(relative)
    if (!isDirectory && content === undefined) throw new Error(`Missing fixture file: ${relative}`)
    fileReads.push({ sessionId, path: relative, operation: path })
    const data = path.endsWith('/info') ? { workspacePath: `${ownerRoot}/${relative}`, isDirectory, size: Buffer.byteLength(content ?? ''), mtimeMs: 1 }
      : { content, isBinary: false, totalSize: Buffer.byteLength(content ?? ''), root: ownerRoot, bindingEpoch: `binding-${sessionId}` }
    if (holdStat && path.endsWith('/info') && sessionId === taskA && relative === 'docs') { heldStat = { response, data }; return }
    response.end(envelope(data)); return
  }

  if (path === '/api/v1/chat/admission/context') {
    const matching = current ? { ...current, attemptId: `attempt-${current.runId}` } : null
    response.end(envelope({ protocolVersion: 1, tenantId: 'reference-tenant', sessionId,
      namespace: { id: 'reference-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 },
      root: matching, predecessor: matching ? { runId: matching.runId, attemptId: matching.attemptId, version: matching.version } : null })); return
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
    if (!titles.has(owner) || typeof input.message !== 'string') throw new Error('Unexpected chat owner or body')
    chats.push(input)
    const now = Date.now(), seq = (runs.get(owner)?.length ?? 0) + 1
    const run: RootRun = { schemaVersion: 1, runId: `reference-root-${owner}-${generation}-${seq}`, sessionId: owner,
      turnId: `reference-turn-${owner}-${generation}-${seq}`, userMessageId: `reference-user-${owner}-${generation}-${seq}`,
      assistantMessageId: `reference-assistant-${owner}-${generation}-${seq}`, seq, version: 1, status: 'running', modelId: model,
      pending: [], workspacePaths: [roots.get(owner)!], createdAt: now, updatedAt: now, startedAt: now }
    const user: EngineHistoryRow = { id: run.userMessageId, role: 'user', content: input.message, createdAt: now,
      conversationId: run.turnId, metadata: { rootRunId: run.runId } }
    const assistant: EngineHistoryRow = { id: run.assistantMessageId, role: 'assistant', content: 'REFERENCE_SENT_OK：已收到这份会话资料。',
      createdAt: now + 1, conversationId: run.turnId, metadata: { rootRunId: run.runId } }
    const terminal: RootRun = { ...run, version: 2, status: 'succeeded', updatedAt: now + 2, finishedAt: now + 2 }
    runs.set(owner, [...(runs.get(owner) ?? []), terminal]); histories.set(owner, [...(histories.get(owner) ?? []), user, assistant])
    if (isRecord(input.admission)) admissions.set(String(input.admission.requestKey), { admission: input.admission, run: terminal })
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const events: ChatSsePayload[] = [{ run }, { userMessage: user }, { content: String(assistant.content) }, { run: terminal }]
    events.forEach((payload, index) => response.write(`id: ${run.runId}:${index + 1}\ndata: ${JSON.stringify(payload)}\n\n`))
    response.end('data: [DONE]\n\n'); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  if (path === '/api/v1/workspace/bind') { response.end(envelope({ workspaceRoot: input.workspaceRoot })); return }
  if (path === '/api/v1/conversation/display') {
    reads.push({ path, sessionId, limit: url.searchParams.get('limit') })
    const users = rows.filter(row => row.role === 'user')
    const data = { schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows,
      loadedTurnIds: users.map(row => row.id), revision: `${sessionId}-${rows.length}`, mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' }
    if (sessionId === taskB && url.searchParams.get('limit') === '10') {
      if (displayMode === 'hold') { held = { response, data }; return }
      if (displayMode === 'unsupported') { response.writeHead(404).end(JSON.stringify({ code: 404, message: 'unsupported', data: null })); return }
      if (displayMode === 'unavailable') { response.writeHead(503).end(JSON.stringify({ code: 503, message: 'REFERENCE_TEMPORARILY_UNAVAILABLE', data: null })); return }
    }
    response.end(envelope(data)); return
  }
  if (path === '/api/v1/chat/snapshot') reads.push({ path, sessionId, limit: null })
  if (['/api/v1/cron/capabilities', '/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET') throw new Error(`Unexpected mutation: ${request.method} ${path}`)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'c'.repeat(64)}`, protocolVersion: 1,
      toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'add-to-conversation' }
    : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '会话引用测试模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', eventId: null, finished: true,
      history: rows, projection: [], run: current, runs: runs.get(sessionId) ?? [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: current, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: runs.get(sessionId) ?? [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [...titles].map(([id, title]) => ({ sessionId: id, title, lastAt: Date.now(), messageCount: histories.get(id)?.length ?? 0 }))
    : path === '/api/v1/workspace/directory' ? { root: roots.get(sessionId) ?? '/remote/configured-default', bindingEpoch: `binding-${sessionId}`, entries: titles.has(sessionId) || Boolean(sessionId && !sessionId.startsWith('work-')) ? directoryEntries(relativePath(url.searchParams.get('path') ?? '', sessionId)) : [] }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const work = (): Locator => page.locator('.work-view')
const composer = (): Locator => work().getByRole('textbox', { name: '继续对话', exact: true })
const chips = (): Locator => composer().locator('[data-mention-key]')

async function launch(): Promise<void> {
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env: launchEnv })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900); window.show(); window.focus() })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
}
async function savedTask(id = taskA): Promise<SavedTask> {
  return page.evaluate(({ key, id }) => {
    window.dispatchEvent(new Event('blur'))
    const state = JSON.parse(localStorage.getItem(key) ?? '{}') as { tasks: SavedTask[] }
    const task = state.tasks.find(item => item.id === id)
    if (!task) throw new Error(`Missing saved task ${id}`)
    return task
  }, { key: storageKey, id })
}
async function seed(): Promise<void> {
  resetHistory()
  const tasks = [...titles].map(([id, title]) => ({ id, title, status: 'done', draft: '', mentions: [], createdAt: Date.now(), updatedAt: Date.now(),
    workspacePath: roots.get(id), modelId: model, attachments: [], sources: [] }))
  await page.evaluate(({ key, tasks, activeTaskId }) => {
    window.dispatchEvent(new Event('blur'))
    localStorage.setItem(key, JSON.stringify({ tasks, activeTaskId, homeSources: [] }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'workspace', pane: 'conversation', ratio: 56 }))
  }, { key: storageKey, tasks, activeTaskId: taskA })
  await page.reload(); await expect(composer()).toBeVisible()
  await expect(work().getByRole('heading', { name: titles.get(taskA)!, exact: true })).toBeVisible()
  await expect(work()).toContainText(`FINAL_RESULT_${taskA}`)
}
async function selectTask(id: string): Promise<void> {
  await work().locator(`.work-sidebar__task-row[data-task-id="${id}"] .work-sidebar__task`).click()
  await expect(work().getByRole('heading', { name: titles.get(id)!, exact: true })).toBeVisible()
  await expect(composer()).toBeVisible()
}
async function send(): Promise<Record<string, unknown>> {
  const before = chats.length, button = work().getByRole('button', { name: '发送', exact: true })
  await expect(button).toBeEnabled(); await button.click()
  await expect.poll(() => chats.length).toBe(before + 1); await expect(work()).toContainText('REFERENCE_SENT_OK')
  return chats[before]
}


const tree = (): Locator => work().getByRole('region', { name: '工作区文件', exact: true })
const exactRow = (relative: string, owner = taskA): Locator => tree().locator(`[role="treeitem"][data-path="${roots.get(owner)}${relative ? '/' + relative : ''}"]`)
const codePreview = (): Locator => work().getByRole('region', { name: 'demo.ts 代码预览', exact: true })
async function openWorkspace(): Promise<void> {
  const trigger = work().getByRole('button', { name: '打开工作区', exact: true })
  if (await trigger.isVisible()) await trigger.click()
  const tab = work().getByRole('tab', { name: '工作区', exact: true })
  if (await tab.isVisible()) await tab.click()
  else {
    await work().getByRole('button', { name: '更多工作区', exact: true }).click()
    await page.getByRole('menuitem', { name: '工作区', exact: true }).click()
  }
  await expect(tree()).toBeVisible()
  await expect(exactRow('demo.ts')).toBeVisible()
}
async function openTaskMenu(id: string): Promise<void> {
  await work().locator(`.work-sidebar__task-row[data-task-id="${id}"] .work-sidebar__task`).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: '添加到对话', exact: true })).toBeVisible()
  await expect(page.locator('.context-menu:not(.context-menu--submenu):not([aria-hidden="true"])')).toHaveAttribute('data-motion-state', 'open')
}
async function waitMentions(count: number, id = taskA): Promise<SavedTask> {
  await expect.poll(async () => (await savedTask(id)).mentions.length).toBe(count)
  return savedTask(id)
}
async function openCode(): Promise<void> {
  await openWorkspace()
  await exactRow('demo.ts').click()
  await expect(codePreview().locator('.monaco-editor')).toBeVisible()
  await expect(codePreview()).toContainText('OUTSIDE_BEFORE')
}
async function selectCode(): Promise<void> {
  await codePreview().locator('.view-line').first().click({ position: { x: 30, y: 8 } })
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Home')
  await page.keyboard.down('Shift')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.up('Shift')
}
async function codeContext(): Promise<void> {
  await codePreview().locator('.view-line').nth(1).click({ button: 'right', position: { x: 35, y: 8 } })
  await expect(page.getByRole('menuitem', { name: /^添加选区到对话/ })).toBeVisible()
}

test.describe.serial('Work 资源添加到对话', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    source = engineStorageKey({ mode: 'remote', baseUrl: origin }); storageKey = 'aether.work.state.v1:' + encodeURIComponent(source)
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'add-to-conversation-profile-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin,
      remoteWorkspaceRoot: '/remote/configured-default', autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: model, appearance: 'light', thinkingMode: 'off' }))
    launchEnv = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(launchEnv)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY',
      'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete launchEnv[key]
    launchEnv.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; launchEnv.AETHER_GLOBAL_DIR = join(fixture, 'global')
    await launch()
  })
  test.beforeEach(async () => { releaseDisplay(); releaseStat(); await seed() })
  test.afterEach(async ({}, info) => {
    releaseDisplay(); releaseStat()
    if (info.status !== info.expectedStatus && page && !page.isClosed()) {
      const path = info.outputPath('add-to-conversation-failure.png')
      await page.screenshot({ path }); await info.attach('失败时页面', { path, contentType: 'image/png' })
    }
    await info.attach('add-to-conversation-http', { body: JSON.stringify({ errors, chats, mutations, reads, fileReads, workspaceSearches }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([])
  })
  test.afterAll(async () => {
    releaseDisplay(); releaseStat()
    try { await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('add-to-conversation-profile-')) throw new Error(`Unsafe cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('文件和目录多选追加为标签，会话菜单也直接添加到当前对话且保持正文基线', async ({}, info) => {
    const initial = '已有说明 ', before = chats.length
    await composer().fill(initial)
    await openWorkspace()
    await exactRow('demo.ts').click()
    await exactRow('docs').click({ modifiers: ['Control'] })
    await exactRow('docs').click({ button: 'right' })
    await page.getByRole('menuitem', { name: '添加 2 项到对话', exact: true }).click()
    const mixed = await waitMentions(2)
    expect(mixed.draft.startsWith(initial)).toBe(true)
    expect(mixed.mentions.map(item => ({ source: item.source, origin: item.origin, path: item.path }))).toEqual([
      { source: 'file', origin: 'workspace', path: 'demo.ts' },
      { source: 'dir', origin: 'workspace', path: 'docs' }
    ])
    await expect(composer()).toBeFocused()
    await openTaskMenu(taskB)
    await page.getByRole('menuitem', { name: '添加到对话', exact: true }).click()
    const draft = await waitMentions(3)
    const conversation = draft.mentions.find(item => item.source === 'conversation')!
    expect(parseConversationLink(conversation.path)).toEqual({ sessionId: taskB, mode: 'work', source })
    expect(conversation.content).toContain(`FINAL_RESULT_${taskB}`)
    await expect(work().getByRole('heading', { name: titles.get(taskA)!, exact: true })).toBeVisible()
    await expect(composer()).toBeFocused()
    await page.keyboard.press('End'); await page.keyboard.type(' 后续说明')
    expect(chats).toHaveLength(before)
    expect((await savedTask(taskB)).mentions).toEqual([])
    const metrics = await composer().evaluate(element => {
      const text = Array.from(element.childNodes).find(node => node.nodeType === Node.TEXT_NODE && node.textContent?.includes('已有说明'))!
      const range = document.createRange(); range.selectNodeContents(text)
      const textRect = range.getBoundingClientRect(), style = getComputedStyle(element)
      return [...element.querySelectorAll<HTMLElement>('[data-mention-key]')].map(chip => {
        const label = chip.querySelector('.mention-chip__label')!
        const labelRange = document.createRange(); labelRange.selectNodeContents(label)
        const rect = labelRange.getBoundingClientRect(), chipStyle = getComputedStyle(chip), labelStyle = getComputedStyle(label)
        const underline = getComputedStyle(chip, '::after'), chipRect = chip.getBoundingClientRect()
        const iconRect = chip.querySelector('.mention-chip__icon')?.getBoundingClientRect()
        return { topDelta: Math.abs(rect.top - textRect.top), bottomDelta: Math.abs(rect.bottom - textRect.bottom),
          fontSize: labelStyle.fontSize, inputFont: style.fontSize, lineHeight: chipStyle.lineHeight, inputLineHeight: style.lineHeight,
          background: chipStyle.backgroundColor, padding: chipStyle.padding,
          borders: [chipStyle.borderTopWidth, chipStyle.borderRightWidth, chipStyle.borderBottomWidth, chipStyle.borderLeftWidth],
          decoration: labelStyle.textDecorationLine, underlinePosition: underline.position,
          underlineLeft: Number.parseFloat(underline.left), underlineRight: Number.parseFloat(underline.right),
          underlineWidth: Number.parseFloat(underline.width), chipWidth: chipRect.width,
          underlineHeight: Number.parseFloat(underline.height), underlineColor: underline.backgroundColor,
          iconLeft: iconRect ? iconRect.left - chipRect.left : null, iconRight: iconRect ? iconRect.right - chipRect.left : null,
          color: labelStyle.color, inputColor: style.color }
      })
    })
    expect(metrics).toHaveLength(3)
    for (const metric of metrics) {
      expect(metric.fontSize).toBe(metric.inputFont)
      expect(metric.lineHeight).toBe(metric.inputLineHeight)
      expect(metric.topDelta).toBeLessThanOrEqual(1)
      expect(metric.bottomDelta).toBeLessThanOrEqual(1)
      expect(metric.background).toBe('rgba(0, 0, 0, 0)')
      expect(metric.padding).toBe('0px')
      expect(metric.borders).toEqual(['0px', '0px', '0px', '0px'])
      expect(metric.decoration).toBe('none')
      expect(metric.underlinePosition).toBe('absolute')
      expect(metric.underlineLeft).toBe(0)
      expect(metric.underlineRight).toBe(0)
      expect(Math.abs(metric.underlineWidth - metric.chipWidth)).toBeLessThanOrEqual(1)
      expect(metric.underlineHeight).toBeGreaterThan(0)
      expect(metric.underlineHeight).toBeLessThanOrEqual(1.5)
      expect(metric.underlineColor).not.toBe('rgba(0, 0, 0, 0)')
      if (metric.iconLeft !== null && metric.iconRight !== null) {
        expect(metric.iconLeft).toBeGreaterThanOrEqual(metric.underlineLeft)
        expect(metric.iconRight).toBeLessThanOrEqual(metric.underlineLeft + metric.underlineWidth + 1)
      }
      expect(metric.color).not.toBe(metric.inputColor)
    }
    expect(metrics[0].color).not.toBe(metrics[1].color)
    await expect(chips().filter({ has: page.locator('.mention-chip__icon') })).toHaveCount(1)
    await page.evaluate(() => { document.documentElement.dataset.appearance = 'dark' })
    await composer().screenshot({ path: info.outputPath('mixed-inline-reference-baseline.png'), animations: 'disabled' })
    await page.evaluate(() => { document.documentElement.dataset.appearance = 'light' })
  })

  test('根目录和目录内文件都能引用，父目录不会吞掉多选子文件', async ({}, info) => {
    const before = chats.length
    const theme = await page.evaluate(() => ({ appearance: document.documentElement.getAttribute('data-appearance'), accent: document.documentElement.getAttribute('data-accent') }))
    const capture = async (state: string, appearances: Array<'light' | 'dark'> = ['light', 'dark']): Promise<void> => {
      for (const appearance of appearances) {
        await page.evaluate(value => { document.documentElement.dataset.appearance = value; document.documentElement.dataset.accent = 'purple' }, appearance)
        await page.mouse.move(2, 2)
        const path = info.outputPath(`workspace-tree-${state}-${appearance}-purple.png`)
        await tree().screenshot({ path, animations: 'disabled' })
        await info.attach(`文件树 ${state} ${appearance}-purple`, { path, contentType: 'image/png' })
      }
    }
    try {
      await composer().fill('根目录说明 ')
      await openWorkspace()
      await exactRow('').click({ button: 'right' })
      await page.getByRole('menuitem', { name: '添加到对话', exact: true }).click()
      const rootDraft = await waitMentions(1)
      expect(rootDraft.mentions[0]).toMatchObject({ source: 'dir', origin: 'workspace', path: roots.get(taskA) })
      await exactRow('docs').click()
      await expect(exactRow('docs/guide.md')).toBeVisible()
      await capture('pointer-single')
      await exactRow('docs/guide.md').click({ modifiers: ['Control'] })
      await capture('pointer-multiple')
      await exactRow('docs').click({ button: 'right' })
      await page.getByRole('menuitem', { name: '添加 2 项到对话', exact: true }).click()
      const draft = await waitMentions(3)
      expect(draft.mentions.slice(1).map(item => [item.source, item.path])).toEqual([['dir', 'docs'], ['file', 'docs/guide.md']])
      expect(chats).toHaveLength(before)
      // Capture keyboard and inactive treatments only after the reference
      // assertions, so these visual states cannot alter the tested payload.
      await tree().getByRole('tree').focus(); await page.keyboard.press('Home')
      await capture('keyboard-current', ['light'])
      await composer().focus()
      await capture('unfocused', ['light'])
    } finally {
      await page.evaluate(value => {
        for (const [name, setting] of Object.entries(value)) {
          if (setting === null) document.documentElement.removeAttribute('data-' + name)
          else document.documentElement.setAttribute('data-' + name, setting)
        }
      }, theme)
    }
  })

  test('读取资源类型时切换任务，迟到回执不会向新会话插入标签', async () => {
    const before = chats.length
    await composer().fill('A 草稿不变')
    await openWorkspace()
    // Tree selection is intentionally persisted across reloads; start this
    // single-reference race independently of the previous multiselect case.
    await exactRow('docs').click()
    holdStat = true
    await exactRow('docs').click({ button: 'right' })
    await page.getByRole('menuitem', { name: '添加到对话', exact: true }).click()
    await expect.poll(() => Boolean(heldStat)).toBe(true)
    await selectTask(taskB); await composer().fill('B 独立草稿')
    releaseStat()
    await expect(composer()).toHaveText('B 独立草稿')
    await expect(chips()).toHaveCount(0)
    expect((await savedTask(taskB)).mentions).toEqual([])
    await selectTask(taskA)
    await expect(composer()).toHaveText('A 草稿不变')
    await expect(chips()).toHaveCount(0)
    expect(chats).toHaveLength(before)
  })

  test('会话引用读取期间切换任务，不会把引用写入新任务或发起执行', async () => {
    const before = chats.length
    await composer().fill('A 会话引用草稿')
    displayMode = 'hold'
    await openTaskMenu(taskB)
    await page.getByRole('menuitem', { name: '添加到对话', exact: true }).click()
    await expect.poll(() => Boolean(held)).toBe(true)
    await selectTask(taskB); await composer().fill('B 会话引用草稿')
    releaseDisplay()
    await expect(composer()).toHaveText('B 会话引用草稿')
    await expect(chips()).toHaveCount(0)
    expect((await savedTask(taskB)).mentions).toEqual([])
    await selectTask(taskA)
    await expect(composer()).toHaveText('A 会话引用草稿')
    await expect(chips()).toHaveCount(0)
    expect(chats).toHaveLength(before)
  })

  test('原生代码菜单复制和添加选区，发送只带准确代码快照及行列信息', async ({}, info) => {
    const before = chats.length
    await composer().fill('请检查 ')
    await openCode(); await selectCode()
    await app!.evaluate(({ clipboard }) => clipboard.writeText('COPY_CODE_SENTINEL'))
    await codeContext()
    await expect(page.getByRole('menuitem', { name: /^查找/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /^全选/ })).toBeVisible()
    // Monaco ignores mouseup during its first 100 ms to avoid executing the
    // opening right-click. Keep a real press through that activation window.
    await page.getByRole('menuitem', { name: /^(?:复制|Copy)(?:\s|$)/ }).click({ delay: 150 })
    await expect(page.getByRole('menuitem', { name: /^(?:复制|Copy)(?:\s|$)/ })).toBeHidden()
    // Windows CF_UNICODETEXT normalizes line endings; the reference payload
    // below still must preserve the model's exact LF bytes.
    await expect.poll(async () => (await app!.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n')).toBe(selectedCode)
    await codeContext()
    await page.screenshot({ path: info.outputPath('work-code-add-to-chat-menu.png'), animations: 'disabled' })
    await page.getByRole('menuitem', { name: /^添加选区到对话/ }).click({ delay: 150 })
    const draft = await waitMentions(1)
    expect(draft.mentions[0]).toMatchObject({ source: 'code', origin: 'workspace', path: `${roots.get(taskA)}/demo.ts`, startLine: 2, endLine: 3,
      startColumn: 1, endColumn: codeLines[2].length + 1, content: selectedCode })
    expect(draft.draft).toContain('请检查')
    expect(draft.draft).not.toContain('const alpha')
    await expect(composer()).toBeFocused()
    expect(chats).toHaveLength(before)
    const request = await send(), message = String(request.message)
    expect(request.sessionId).toBe(taskA)
    expect(message).toContain('<reference type="code"')
    expect(message).toContain('lines="2-3"')
    expect(message).toContain(selectedCode)
    expect(message).not.toContain('OUTSIDE_BEFORE')
    expect(message).not.toContain('OUTSIDE_AFTER')
    expect(request.attachments ?? []).toEqual([])
    expect(request.collaborators ?? []).toEqual([])
  })

  test('代码菜单查找和全选可用，整文件添加保留现有草稿且不会自动发送', async () => {
    const before = chats.length
    await composer().fill('完整文件说明 ')
    await openCode()
    await codePreview().locator('.view-line').nth(1).click({ button: 'right', position: { x: 35, y: 8 } })
    await page.getByRole('menuitem', { name: /^查找/ }).click({ delay: 150 })
    await expect(codePreview().locator('.find-widget.visible')).toBeVisible()
    await page.keyboard.press('Escape')
    await codePreview().locator('.view-line').nth(1).click({ button: 'right', position: { x: 35, y: 8 } })
    await page.getByRole('menuitem', { name: /^全选/ }).click({ delay: 150 })
    // Monaco schedules its mouse action with setTimeout(0). Wait for the
    // command and focus restoration before sending the next keyboard command.
    await expect(page.getByRole('menuitem', { name: /^全选/ })).toBeHidden()
    await expect.poll(() => codePreview().locator('.monaco-editor').evaluate(element => element.contains(document.activeElement))).toBe(true)
    await app!.evaluate(({ clipboard }) => clipboard.writeText('ALL_CODE_SENTINEL'))
    await page.keyboard.press('Control+C')
    await expect.poll(async () => (await app!.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n')).toBe(code)
    await codeContext()
    await page.getByRole('menuitem', { name: /^添加到对话(?:\s|$)/ }).click({ delay: 150 })
    const draft = await waitMentions(1)
    expect(draft.mentions[0]).toMatchObject({ source: 'file', origin: 'workspace', path: 'demo.ts' })
    expect(draft.mentions[0].content).toBeUndefined()
    expect(draft.draft.startsWith('完整文件说明 ')).toBe(true)
    await expect(composer()).toBeFocused()
    expect(chats).toHaveLength(before)
    await selectCode()
    await page.keyboard.press('Control+L')
    const withSelection = await waitMentions(2)
    expect(withSelection.mentions[1]).toMatchObject({ source: 'code', origin: 'workspace',
      path: `${roots.get(taskA)}/demo.ts`, content: selectedCode, startLine: 2, endLine: 3 })
    await expect(composer()).toBeFocused()
    expect(chats).toHaveLength(before)
  })


  test('工作区搜索图标双向切换，保留搜索条件、文件筛选与目录展开', async ({}, info) => {
    await openWorkspace()
    const toggle = tree().getByRole('button', { name: '搜索工作区内容', exact: true })
    const fileFilter = tree().getByRole('textbox', { name: '筛选文件', exact: true })
    const docs = exactRow('docs'), wasExpanded = await docs.getAttribute('aria-expanded') === 'true'
    if (!wasExpanded) await docs.click()
    await expect(exactRow('docs/guide.md')).toBeVisible()
    await fileFilter.fill('guide')
    await expect(exactRow('demo.ts')).toHaveCount(0)
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(toggle).toHaveAttribute('title', '搜索工作区内容')
    await expect(toggle.locator('svg')).toBeVisible()
    const searchGlyph = await toggle.locator('svg').boundingBox()
    const createGlyph = await tree().getByRole('button', { name: '新建文件', exact: true }).locator('svg').boundingBox()
    expect(searchGlyph).not.toBeNull(); expect(createGlyph).not.toBeNull()
    // Rendered geometry catches flex shrinking from later shared button CSS;
    // the SVG's width attribute alone can still claim 15 while painting at 10.
    expect(searchGlyph!.width).toBeGreaterThanOrEqual(14)
    expect(searchGlyph!.height).toBeGreaterThanOrEqual(14)
    expect(Math.abs(searchGlyph!.width - createGlyph!.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(searchGlyph!.height - createGlyph!.height)).toBeLessThanOrEqual(1)

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(toggle).toHaveAttribute('title', '返回文件列表')
    const query = tree().getByRole('textbox', { name: '搜索内容', exact: true })
    await expect(query).toBeFocused(); await expect(fileFilter).toBeHidden()
    await tree().getByRole('button', { name: '切换文件过滤', exact: true }).click()
    await tree().getByRole('textbox', { name: '包含', exact: true }).fill('*.md')
    await tree().getByRole('textbox', { name: '排除', exact: true }).fill('ignored/**')
    const beforeSearch = workspaceSearches.length
    await query.fill('Guide')
    await expect(tree().locator('.search-view__summary')).toContainText('1 个文件 1 处命中')
    await expect.poll(() => workspaceSearches.length).toBeGreaterThan(beforeSearch)
    await expect(tree().locator('.search-view__hit')).toContainText('Guide')
    await tree().screenshot({ path: info.outputPath('workspace-search-icon-active.png'), animations: 'disabled' })

    await toggle.press('Space')
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(toggle).toHaveAttribute('title', '搜索工作区内容')
    await expect(fileFilter).toHaveValue('guide'); await expect(query).toBeHidden()
    await expect(docs).toHaveAttribute('aria-expanded', 'true')
    await expect(exactRow('docs/guide.md')).toBeVisible(); await expect(exactRow('demo.ts')).toHaveCount(0)

    await toggle.press('Enter')
    await expect(query).toHaveValue('Guide')
    await expect(tree().getByRole('textbox', { name: '包含', exact: true })).toHaveValue('*.md')
    await expect(tree().getByRole('textbox', { name: '排除', exact: true })).toHaveValue('ignored/**')
    await expect(tree().locator('.search-view__summary')).toContainText('1 个文件 1 处命中')
    for (const search of workspaceSearches.slice(beforeSearch)) expect(search).toMatchObject({ sessionId: taskA, expectedRoot: roots.get(taskA),
      bindingEpoch: `binding-${taskA}`, query: 'Guide', options: { include: '*.md', exclude: 'ignored/**' } })
    await toggle.click()
    await expect(fileFilter).toHaveValue('guide')
    await tree().screenshot({ path: info.outputPath('workspace-search-icon-files.png'), animations: 'disabled' })
    await page.mouse.move(2, 2)
    const defaultShot = info.outputPath('workspace-search-icon-default.png')
    await tree().screenshot({ path: defaultShot, animations: 'disabled' })
    await info.attach('工作区放大镜默认状态', { path: defaultShot, contentType: 'image/png' })
    // File-tree memory survives reloads, so restore only this case's changes.
    await fileFilter.fill('')
    if (!wasExpanded) await docs.click()
  })
})
