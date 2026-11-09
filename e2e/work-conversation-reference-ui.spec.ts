/** Real Electron + authenticated HTTP: conversation-copy menus, inline snapshot
 * references, persistence, source isolation and the OS protocol inbox. Build
 * first; this suite owns its own profile/window/server and must run alone. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { ChatSsePayload } from '../src/shared/ipc'
import { buildConversationLink, parseConversationLink } from '../src/shared/conversation-link'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'conversation-reference-token', model = 'conversation-reference-model'
const taskA = 'work-reference-a', taskB = 'work-reference-b'
const titles = new Map([[taskA, '当前设计任务'], [taskB, '可引用的既有方案']])
const roots = new Map([[taskA, '/remote/reference/task-a'], [taskB, '/remote/reference/task-b']])
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
const link = (id = taskB, owner = source): string => buildConversationLink({ sessionId: id, mode: 'work', source: owner })

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
      toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'conversation-reference' }
    : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '会话引用测试模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', eventId: null, finished: true,
      history: rows, projection: [], run: current, runs: runs.get(sessionId) ?? [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: current, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: runs.get(sessionId) ?? [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [...titles].map(([id, title]) => ({ sessionId: id, title, lastAt: Date.now(), messageCount: histories.get(id)?.length ?? 0 }))
    : path === '/api/v1/workspace/directory' ? { root: roots.get(sessionId) ?? '/remote/configured-default', bindingEpoch: `binding-${sessionId}`, entries: [] }
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
const reference = (id = taskB, scope = composer()): Locator => scope.getByRole('button', { name: `查看引用：${titles.get(id)!}`, exact: true })
const readsOf = (id: string, path?: string): typeof reads => reads.filter(read => read.sessionId === id && (!path || read.path === path))

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
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 56 }))
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
async function nativePaste(text: string): Promise<void> {
  await app!.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)
  await composer().focus(); await page.keyboard.press('Control+V')
}
async function selectText(offset: number): Promise<void> {
  await composer().evaluate((element, offset) => {
    ;(element as HTMLElement).focus()
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), range = document.createRange()
    let node: Node | null, remaining = offset
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest('[data-mention-key]')) continue
      if (remaining <= (node.textContent?.length ?? 0)) {
        range.setStart(node, remaining); range.collapse(true)
        const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); return
      }
      remaining -= node.textContent?.length ?? 0
    }
    throw new Error(`Text offset ${offset} exceeds composer contents`)
  }, offset)
}
async function copyMenu(id: string, label: string, viaContext = false): Promise<string> {
  await app!.evaluate(({ clipboard }) => clipboard.writeText('COPY_SENTINEL'))
  const row = work().locator(`.work-sidebar__task-row[data-task-id="${id}"]`)
  if (viaContext) await row.locator('.work-sidebar__task').click({ button: 'right' })
  else { await row.locator('.work-sidebar__task').focus(); await page.keyboard.press('Shift+F10') }
  const copy = page.getByRole('menuitem', { name: '复制', exact: true })
  if (viaContext) {
    await copy.hover()
    await expect(page.getByRole('menuitem', { name: label, exact: true })).toBeVisible()
    await expect(page.locator('.context-menu--submenu')).toHaveAttribute('data-motion-state', 'open')
    await page.screenshot({ path: join(fixtureRoot, 'work-conversation-reference-menu.png'), animations: 'disabled' })
    await page.getByRole('menuitem', { name: label, exact: true }).click()
  } else {
    await copy.focus(); await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('menuitem', { name: '复制会话链接', exact: true })).toBeFocused()
    const index = ['复制会话链接', '复制为 Markdown', '复制工作目录'].indexOf(label)
    if (index < 0) throw new Error(`Unknown copy menu item ${label}`)
    for (let step = 0; step < index; step++) await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('menuitem', { name: label, exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
  }
  await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText())).not.toBe('COPY_SENTINEL')
  return app!.evaluate(({ clipboard }) => clipboard.readText())
}
async function send(): Promise<Record<string, unknown>> {
  const before = chats.length, button = work().getByRole('button', { name: '发送', exact: true })
  await expect(button).toBeEnabled(); await button.click()
  await expect.poll(() => chats.length).toBe(before + 1); await expect(work()).toContainText('REFERENCE_SENT_OK')
  return chats[before]
}

test.describe.serial('Work 会话链接与引用', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    source = engineStorageKey({ mode: 'remote', baseUrl: origin }); storageKey = 'aether.work.state.v1:' + encodeURIComponent(source)
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'conversation-reference-profile-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin,
      remoteWorkspaceRoot: '/remote/configured-default', autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: model, appearance: 'light', thinkingMode: 'off' }))
    launchEnv = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(launchEnv)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY',
      'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete launchEnv[key]
    launchEnv.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; launchEnv.AETHER_GLOBAL_DIR = join(fixture, 'global')
    await launch()
  })
  test.beforeEach(async () => { releaseDisplay(); await seed() })
  test.afterEach(async ({}, info) => {
    releaseDisplay()
    if (info.status !== info.expectedStatus && page && !page.isClosed()) {
      const path = info.outputPath('conversation-reference-failure.png')
      await page.screenshot({ path }); await info.attach('失败时页面', { path, contentType: 'image/png' })
    }
    await info.attach('conversation-reference-http', { body: JSON.stringify({ errors, chats, mutations, reads }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([])
  })
  test.afterAll(async () => {
    releaseDisplay()
    try { await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('conversation-reference-profile-')) throw new Error(`Unsafe cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('右键与更多菜单复制真实链接、Markdown 和所属工作目录', async () => {
    const copied = await copyMenu(taskB, '复制会话链接', true)
    expect(parseConversationLink(copied)).toEqual({ sessionId: taskB, mode: 'work', source })
    expect(copied).not.toContain(token); expect(copied).not.toContain(titles.get(taskB)!)
    const markdown = await copyMenu(taskB, '复制为 Markdown')
    expect(markdown).toContain(`REQUEST_${taskB}`); expect(markdown).toContain(`FINAL_RESULT_${taskB}`)
    expect(await copyMenu(taskB, '复制工作目录')).toBe(roots.get(taskB))
    await expect(work().getByRole('heading', { name: titles.get(taskA)!, exact: true })).toBeVisible()
  })

  test('原光标插入标题引用，发送携带最终结果，重启后仍可打开原会话', async ({}, info) => {
    const copied = await copyMenu(taskB, '复制会话链接'), before = readsOf(taskB).length
    await composer().fill('左侧 右侧'); await selectText(3); await nativePaste(copied)
    await expect(reference()).toBeVisible(); await expect(chips()).toHaveCount(1)
    await expect(reference().locator('svg')).toBeVisible()
    await expect(reference()).toHaveAttribute('title', '打开会话')
    const assertAlignedIcon = async (chip: Locator): Promise<void> => {
      const layout = await chip.evaluate(element => {
        const icon = element.querySelector('svg')!.getBoundingClientRect()
        const label = element.querySelector('.mention-chip__label')!.getBoundingClientRect()
        return { centerDelta: Math.abs(icon.y + icon.height / 2 - label.y - label.height / 2), gap: label.left - icon.right, width: icon.width }
      })
      expect(layout.centerDelta).toBeLessThanOrEqual(1)
      expect(layout.gap).toBeGreaterThanOrEqual(3)
      expect(layout.width).toBeGreaterThanOrEqual(13)
    }
    await assertAlignedIcon(reference())
    expect(await composer().evaluate(element => {
      const chip = element.querySelector('[data-mention-key]')!, left = document.createRange(), right = document.createRange()
      left.selectNodeContents(element); left.setEndBefore(chip); right.selectNodeContents(element); right.setStartAfter(chip)
      return { left: left.toString(), right: right.toString() }
    })).toEqual({ left: '左侧 ', right: expect.stringMatching(/^\s*右侧$/) })
    expect(readsOf(taskB).slice(before)).toContainEqual({ path: '/api/v1/conversation/display', sessionId: taskB, limit: '10' })
    expect(readsOf(taskB).slice(before)).toContainEqual({ path: '/api/v1/chat/snapshot', sessionId: taskB, limit: null })
    // Copying the atomic chip must preserve navigation identity outside this
    // editor; its friendly title alone cannot be pasted into another task.
    await app!.evaluate(({ clipboard }) => clipboard.writeText('CHIP_COPY_SENTINEL'))
    await reference().evaluate(chip => {
      chip.closest<HTMLElement>('[role="textbox"]')?.focus()
      const range = document.createRange(); range.selectNode(chip)
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
    })
    await page.keyboard.press('Control+C')
    await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(copied)
    const saved = await savedTask()
    expect(saved.mentions).toHaveLength(1); expect(saved.mentions[0]).toMatchObject({ source: 'conversation', path: copied, displayText: titles.get(taskB) })
    await page.screenshot({ path: info.outputPath('conversation-reference-chip.png'), animations: 'disabled' })
    const request = await send(), message = String(request.message)
    expect(request.sessionId).toBe(taskA); expect(message).toContain('<reference type="conversation"')
    expect(message).toContain(`REQUEST_${taskB}`); expect(message).toContain(`FINAL_RESULT_${taskB}`)
    expect(message).not.toContain('PRIVATE_REASONING_MUST_NOT_BE_REFERENCED'); expect(message).not.toContain('PROCESS_LOG_MUST_NOT_BE_REFERENCED')
    expect(request.attachments ?? []).toEqual([]); expect(request.collaborators ?? []).toEqual([])
    expect(mutations.filter(path => /collaboration|subagent/.test(path))).toEqual([])
    const userId = latestRun(taskA)!.userMessageId
    await savedTask(); await app!.close(); app = undefined; await launch()
    const sent = work().locator(`[data-message-id="${userId}"]`)
    await expect(reference(taskB, sent)).toBeVisible()
    await expect(reference(taskB, sent).locator('svg')).toBeVisible()
    await expect(reference(taskB, sent)).toHaveAttribute('title', '打开会话')
    await assertAlignedIcon(reference(taskB, sent))
    await page.evaluate(() => { document.documentElement.dataset.appearance = 'dark' })
    await sent.screenshot({ path: info.outputPath('conversation-reference-sent-dark.png'), animations: 'disabled' })
    await page.evaluate(() => { document.documentElement.dataset.appearance = 'light' })
    await reference(taskB, sent).focus(); await page.keyboard.press('Enter')
    await expect(work().getByRole('heading', { name: titles.get(taskB)!, exact: true })).toBeVisible()
    await expect(work()).toContainText(`FINAL_RESULT_${taskB}`)
    const path = info.outputPath('conversation-reference-opens-source.png')
    await page.screenshot({ path, animations: 'disabled' }); await info.attach('会话引用打开原任务', { path, contentType: 'image/png' })
  })

  test('草稿刷新后保留可点击引用，同会话引用只导航且不发起执行', async () => {
    const before = chats.length
    await composer().fill('继续补充 '); await page.keyboard.press('Control+End'); await nativePaste(link(taskA))
    await expect(reference(taskA)).toBeVisible(); const saved = await savedTask()
    await page.reload(); await expect(reference(taskA)).toBeVisible()
    await reference(taskA).click()
    await expect(work().getByRole('heading', { name: titles.get(taskA)!, exact: true })).toBeVisible()
    await expect(reference(taskA)).toBeVisible(); expect((await savedTask()).draft).toBe(saved.draft)
    expect(chats).toHaveLength(before)
  })

  test('其他来源链接与已删除会话拒绝读取，并保留用户草稿', async () => {
    const draft = '已有草稿必须保留', before = readsOf(taskB).length
    await composer().fill(draft); await page.keyboard.press('Control+End')
    await nativePaste(link(taskB, 'remote:https://other-engine.example'))
    await expect(page.getByText(/(?:来源|引擎|账号).*(?:不同|不一致|不属于)|(?:不同|其他).*(?:来源|引擎|账号)/).first()).toBeVisible()
    await expect(composer()).toHaveText(draft); await expect(chips()).toHaveCount(0)
    expect(readsOf(taskB)).toHaveLength(before)
    const missing = 'work-reference-deleted', missingBefore = readsOf(missing).length
    await composer().focus(); await page.keyboard.press('Control+End'); await nativePaste(link(missing))
    await expect(page.getByText(/(?:会话|任务).*(?:不存在|已删除|未找到)|(?:找不到|未找到).*(?:会话|任务)/).first()).toBeVisible()
    await expect(composer()).toHaveText(draft); expect(readsOf(missing)).toHaveLength(missingBefore)
    expect((await savedTask()).mentions).toEqual([])
  })

  test('引用读取中切换任务，迟到响应不会修改新任务草稿', async () => {
    const draftA = '任务 A 的原草稿', draftB = '任务 B 的独立草稿'
    await composer().fill(draftA); await page.keyboard.press('Control+End'); displayMode = 'hold'; await nativePaste(link())
    await expect.poll(() => Boolean(held)).toBe(true)
    await selectTask(taskB); await composer().fill(draftB); releaseDisplay()
    await expect(composer()).toHaveText(draftB); await expect(chips()).toHaveCount(0)
    expect((await savedTask(taskB)).mentions).toEqual([])
    await selectTask(taskA); await expect(composer()).toContainText(draftA)
    await selectTask(taskB); await expect(composer()).toHaveText(draftB); await expect(chips()).toHaveCount(0)
  })

  test('旧引擎不支持 display 时回退 snapshot，临时故障不回退也不吞掉草稿', async () => {
    displayMode = 'unsupported'; const fallbackBefore = readsOf(taskB, '/api/v1/chat/snapshot').length
    await nativePaste(link()); await expect(reference()).toBeVisible()
    expect(readsOf(taskB, '/api/v1/chat/snapshot')).toHaveLength(fallbackBefore + 1)
    const stored = await savedTask()
    expect(String(stored.mentions[0].content)).toContain(`FINAL_RESULT_${taskB}`)
    expect(String(stored.mentions[0].content)).not.toContain('PROCESS_LOG_MUST_NOT_BE_REFERENCED')
    await seed(); displayMode = 'unavailable'
    const noFallbackBefore = readsOf(taskB, '/api/v1/chat/snapshot').length, draft = '服务暂不可用时保留'
    await composer().fill(draft); await page.keyboard.press('Control+End'); await nativePaste(link())
    await expect(page.getByText(/REFERENCE_TEMPORARILY_UNAVAILABLE/).first()).toBeVisible()
    await expect(composer()).toHaveText(draft); await expect(chips()).toHaveCount(0)
    expect(readsOf(taskB, '/api/v1/chat/snapshot')).toHaveLength(noFallbackBefore)
  })

  test('操作系统深链通过主进程导航，重复打开当前会话保留草稿且不触发执行', async () => {
    const before = chats.length
    await app!.evaluate(({ app }, value) => app.emit('second-instance', {}, ['Aether.exe', value], '.'), link())
    await expect(work().getByRole('heading', { name: titles.get(taskB)!, exact: true })).toBeVisible()
    await composer().fill('深链导航后保留的草稿')
    await app!.evaluate(({ app }, value) => app.emit('second-instance', {}, ['Aether.exe', value], '.'), link())
    await expect(composer()).toHaveText('深链导航后保留的草稿')
    expect(chats).toHaveLength(before); expect(mutations.filter(path => /collaboration|subagent/.test(path))).toEqual([])
  })
})
