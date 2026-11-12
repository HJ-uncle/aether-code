/** Real Electron + authenticated HTTP: long paste becomes byte-preserving TXT;
 * the editor's prose limit excludes references and does not limit send payloads.
 * Build first and run this spec with --workers=1 --timeout=120000. This spec
 * owns one profile/window/port; never run it alongside another Electron spec. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import { userMessageDraft } from '../src/renderer/src/features/conversation/shared/mention-context'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'composer-paste-token', model = 'composer-paste-model'
const taskA = 'work-paste-a', taskB = 'work-paste-b', previousInputLimit = 100_000
const titles = new Map([[taskA, '粘贴资料任务 A'], [taskB, '粘贴资料任务 B']])
const roots = new Map([[taskA, '/remote/paste/task-a'], [taskB, '/remote/paste/task-b']])
const ownedSessions = new Set([taskA, taskB])
const errors: string[] = [], chats: Record<string, unknown>[] = [], bindings: Record<string, unknown>[] = []
const reads: Array<{ sessionId: string; path: string }> = []
interface UploadedFile { sessionId: string; path: string; bytes: Buffer; type: string }
interface SavedSource { path: string; name: string; type: string; size: number; attachmentId?: string }
interface SavedTask { id: string; draft: string; mentions: Array<Record<string, unknown>>; sources: SavedSource[]; attachments: SavedSource[] }
interface SavedHome { homeSessionId: string; homeDraft: string; homeMentions: Array<Record<string, unknown>>; homeSources: SavedSource[]; homeAttachments: SavedSource[] }
const uploads: UploadedFile[] = [], files = new Map<string, UploadedFile>()
const histories = new Map<string, EngineHistoryRow[]>(), runs = new Map<string, RootRun[]>()
const chatReceipts = new Map<Record<string, unknown>, { receivedAt: number; run: RootRun }>()
const admissions = new Map<string, { admission: Record<string, unknown>; run: RootRun }>()
let uploadMode: 'normal' | 'hold' | 'reject' = 'normal'
let held: { response: ServerResponse; file: UploadedFile } | undefined
let app: ElectronApplication | undefined, page: Page, fixture = '', storageKey = '', historyGeneration = 0
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const fileKey = (sessionId: string, path: string): string => JSON.stringify([sessionId, path])
const latestRun = (sessionId: string): RootRun | undefined => runs.get(sessionId)?.at(-1)

function finishUpload(response: ServerResponse, file: UploadedFile): void {
  files.set(fileKey(file.sessionId, file.path), file)
  response.end(envelope({ path: file.path, size: file.bytes.length }))
}
function releaseUpload(): void {
  uploadMode = 'normal'
  if (held) finishUpload(held.response, held.file)
  held = undefined
}
function resetHistory(): void {
  histories.clear(); runs.clear(); admissions.clear()
  historyGeneration++
  for (const [id, title] of titles) {
    const now = Date.now() - 10_000
    const run: RootRun = { schemaVersion: 1, runId: `paste-root-${id}-${historyGeneration}`, sessionId: id, turnId: `paste-turn-${id}-${historyGeneration}`,
      userMessageId: `paste-user-${id}-${historyGeneration}`, assistantMessageId: `paste-assistant-${id}-${historyGeneration}`, seq: 1, version: 2,
      status: 'succeeded', modelId: model, pending: [], workspacePaths: [roots.get(id)!],
      createdAt: now, updatedAt: now, startedAt: now - 10, finishedAt: now }
    runs.set(id, [run])
    histories.set(id, [
      { id: run.userMessageId, role: 'user', content: title, createdAt: now - 10, conversationId: run.turnId, metadata: { rootRunId: run.runId } },
      { id: run.assistantMessageId, role: 'assistant', content: 'READY_FOR_PASTE：可继续补充资料。', createdAt: now, conversationId: run.turnId, metadata: { rootRunId: run.runId } }
    ])
  }
}

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
  const sessionId = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const bytes = Buffer.concat(chunks)
  if (path === '/api/v1/workspace/upload' && request.method === 'POST') {
    // Decode the actual multipart body, not its text representation: CRLF,
    // Unicode and trailing whitespace must survive the complete IPC/upload path.
    const form = await new Request('http://fixture/upload', { method: 'POST',
      headers: { 'content-type': String(request.headers['content-type']) }, body: Uint8Array.from(bytes) }).formData()
    const blob = form.get('file'), owner = form.get('sessionId'), relative = form.get('path')
    if (!blob || typeof blob === 'string' || typeof owner !== 'string' || typeof relative !== 'string') throw new Error('Malformed upload')
    if (!ownedSessions.has(owner)) throw new Error(`Upload crossed task ownership or preceded workspace binding: ${owner}`)
    const file: UploadedFile = { sessionId: owner, path: relative, bytes: Buffer.from(await blob.arrayBuffer()), type: blob.type }
    uploads.push(file)
    if (uploadMode === 'reject') {
      uploadMode = 'normal'
      response.writeHead(503).end(JSON.stringify({ code: 503, message: 'PASTE_UPLOAD_REJECTED：测试上传失败，原草稿应保留', data: null })); return
    }
    if (uploadMode === 'hold') {
      if (held) throw new Error('A second upload started while the first was held')
      held = { response, file }; return
    }
    finishUpload(response, file); return
  }
  const parsed: unknown = bytes.length ? JSON.parse(bytes.toString('utf8')) : {}, input = isRecord(parsed) ? parsed : {}
  const current = latestRun(sessionId), rows = histories.get(sessionId) ?? []
  if (path === '/api/v1/workspace/file/info' || path === '/api/v1/workspace/file/content') {
    const relative = url.searchParams.get('path') ?? '', file = files.get(fileKey(sessionId, relative))
    if (!file) throw new Error(`Read crossed task ownership or missing file: ${sessionId}/${relative}`)
    if (path.endsWith('/info')) response.end(envelope({ workspacePath: `${roots.get(sessionId)}/${relative}`, size: file.bytes.length, isDirectory: false }))
    else {
      reads.push({ sessionId, path: relative })
      const image = file.type.startsWith('image/')
      response.end(envelope({ content: file.bytes.toString(image ? 'base64' : 'utf8'), isBinary: image, totalSize: file.bytes.length,
        root: roots.get(sessionId), bindingEpoch: `binding-${sessionId}` }))
    }
    return
  }
  if (path === '/api/v1/chat/admission/context') {
    const matching = current ? { ...current, attemptId: `attempt-${current.runId}` } : null
    response.end(envelope({ protocolVersion: 1, tenantId: 'paste-tenant', sessionId,
      namespace: { id: 'paste-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general',
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
    const owner = String(input.sessionId)
    if (!ownedSessions.has(owner) || typeof input.message !== 'string') throw new Error('Unexpected chat owner or body')
    chats.push(input)
    const now = Date.now(), ordinal = (runs.get(owner)?.length ?? 0) + 1
    const run: RootRun = { schemaVersion: 1, runId: `paste-root-${owner}-${historyGeneration}-${ordinal}`, sessionId: owner, turnId: `paste-turn-${owner}-${historyGeneration}-${ordinal}`,
      userMessageId: `paste-user-${owner}-${historyGeneration}-${ordinal}`, assistantMessageId: `paste-assistant-${owner}-${historyGeneration}-${ordinal}`, seq: ordinal, version: 1,
      status: 'running', modelId: model, pending: [], workspacePaths: [roots.get(owner)!], createdAt: now, updatedAt: now, startedAt: now }
    chatReceipts.set(input, { receivedAt: now, run })
    const attachments = Array.isArray(input.attachments) ? input.attachments.flatMap(file => isRecord(file) && typeof file.name === 'string'
      ? [{ name: file.name, type: typeof file.type === 'string' ? file.type : 'application/octet-stream',
        displayName: typeof file.displayName === 'string' ? file.displayName : undefined,
        size: typeof file.size === 'number' ? file.size : undefined,
        attachmentId: typeof file.attachmentId === 'string' ? file.attachmentId : undefined,
        referenceLabel: typeof file.referenceLabel === 'string' ? file.referenceLabel : undefined }] : []) : []
    const user: EngineHistoryRow = { id: run.userMessageId, role: 'user', content: input.message, createdAt: now,
      conversationId: run.turnId, metadata: { rootRunId: run.runId, attachments } }
    const assistant: EngineHistoryRow = { id: run.assistantMessageId, role: 'assistant', content: 'PASTE_SENT_OK：已收到本次资料引用。',
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
  if (path === '/api/v1/workspace/bind') {
    const owner = String(input.sessionId), workspaceRoot = String(input.workspaceRoot)
    // Home binds its selected project before upload; registering it only when
    // bytes arrive misclassifies this legitimate first bind as Code bootstrap.
    if (!ownedSessions.has(owner) && /^work-(?:home-)?[a-f\d-]{36}$/i.test(owner) && workspaceRoot === '/remote/paste/home') {
      ownedSessions.add(owner); roots.set(owner, workspaceRoot)
    }
    if (ownedSessions.has(owner) && roots.get(owner) !== workspaceRoot) throw new Error('Work bound the wrong workspace')
    if (!ownedSessions.has(owner) && workspaceRoot !== '/remote/configured-default') throw new Error('Unexpected Code bootstrap bind')
    bindings.push(input); response.end(envelope({ workspaceRoot })); return
  }
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows,
      loadedTurnIds: users.map(row => row.id), revision: `${sessionId}-${rows.length}`, mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (['/api/v1/cron/capabilities', '/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET') throw new Error(`Unexpected mutation: ${request.method} ${path}`)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'b'.repeat(64)}`, protocolVersion: 1,
      toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'composer-paste' }
    : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '粘贴测试模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', eventId: null, finished: true,
      history: rows, projection: [], run: current, runs: runs.get(sessionId) ?? [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: current, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: runs.get(sessionId) ?? [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [...titles].map(([id, title]) => ({ sessionId: id, title, lastAt: Date.now(), messageCount: histories.get(id)?.length ?? 0 }))
    : path === '/api/v1/workspace/directory' ? { root: roots.get(sessionId) ?? '/remote/configured-default', bindingEpoch: `binding-${sessionId}`,
      entries: [...files.values()].filter(file => file.sessionId === sessionId && !file.path.includes('/'))
        .map(file => ({ name: file.path, path: file.path, isDirectory: false, size: file.bytes.length, mtimeMs: 1 })) }
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
const sourcePanel = (): Locator => work().getByRole('tabpanel', { name: '资料', exact: true })
async function selectTask(id: string): Promise<void> {
  await work().locator('.work-sidebar__task').filter({ hasText: titles.get(id)! }).click()
  await expect(work().getByRole('heading', { name: titles.get(id)!, exact: true })).toBeVisible()
  await expect(work().getByRole('button', { name: '发送', exact: true })).toBeVisible()
}
async function savedTask(id = taskA): Promise<SavedTask> {
  return page.evaluate(({ key, id }) => {
    // Blur flushes the actual draft persistence scheduler before inspecting the
    // durable copy. Tests never mutate React's editor state or invoke its hooks.
    window.dispatchEvent(new Event('blur'))
    const state = JSON.parse(localStorage.getItem(key) ?? '{}') as { tasks: SavedTask[] }
    const task = state.tasks.find(item => item.id === id)
    if (!task) throw new Error(`Missing saved task ${id}`)
    return task
  }, { key: storageKey, id })
}
async function savedHome(): Promise<SavedHome> {
  return page.evaluate(key => {
    window.dispatchEvent(new Event('blur'))
    return JSON.parse(localStorage.getItem(key) ?? '{}') as SavedHome
  }, storageKey)
}
async function seed(draft = '', options: { home?: boolean; mentions?: Array<Record<string, unknown>>; attachments?: SavedSource[]; sources?: SavedSource[] } = {}): Promise<void> {
  resetHistory()
  const tasks = [...titles].map(([id, title]) => ({ id, title, status: 'done', draft: id === taskA ? draft : '',
    mentions: id === taskA ? options.mentions ?? [] : [], createdAt: Date.now(), updatedAt: Date.now(), workspacePath: roots.get(id), modelId: model,
    attachments: id === taskA ? options.attachments ?? [] : [], sources: id === taskA ? options.sources ?? [] : [] }))
  await page.evaluate(({ key, tasks, activeTaskId, homeDraft, homeWorkspacePath, homeMentions }) => {
    window.dispatchEvent(new Event('blur'))
    localStorage.setItem(key, JSON.stringify({ tasks, activeTaskId, homeWorkspacePath, homeDraft, homeMentions, homeSources: [], homeAttachments: [] }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 56 }))
  }, { key: storageKey, tasks, activeTaskId: options.home ? null : taskA, homeDraft: options.home ? draft : '',
    homeWorkspacePath: options.home ? '/remote/paste/home' : null, homeMentions: options.home ? options.mentions ?? [] : [] })
  await page.reload()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  await expect(options.home ? work().getByRole('textbox', { name: '任务目标', exact: true }) : composer()).toBeVisible()
  if (!options.home) await expect(work().getByRole('heading', { name: titles.get(taskA)!, exact: true })).toBeVisible()
}
async function selectText(start: number, end = start): Promise<void> {
  await composer().evaluate((element, offsets) => {
    ;(element as HTMLElement).focus()
    // Existing browser edits can split a text node; retain their live ranges.
    const nodes: Text[] = [], walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      if (!node.parentElement?.closest('[data-mention-key]')) nodes.push(node as Text)
    }
    const locate = (offset: number): { node: Node; offset: number } => {
      if (!Number.isInteger(offset) || offset < 0) throw new Error(`Invalid text offset ${offset}`)
      let remaining = offset
      for (const text of nodes) {
        if (remaining <= text.length) return { node: text, offset: remaining }
        remaining -= text.length
      }
      if (offset === 0 && !nodes.length) return { node: element, offset: 0 }
      throw new Error(`Text offset ${offset} exceeds composer length`)
    }
    const from = locate(offsets.start), to = locate(offsets.end), range = document.createRange()
    range.setStart(from.node, from.offset); range.setEnd(to.node, to.offset)
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
  }, { start, end })
}
async function nativePaste(text: string, input = composer()): Promise<void> {
  await app!.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)
  await input.focus(); await page.keyboard.press('Control+V')
}
async function exactPaste(text: string, input = composer()): Promise<void> {
  // Windows clipboard may normalize newlines before Chromium sees them. This
  // dispatch tests preservation of the exact text/plain supplied by Chromium;
  // separate native-paste cases cover the real OS keyboard path.
  await input.evaluate((element, text) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text)
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
  }, text)
}
async function adjacentToChip(chip: Locator, direction: 'before' | 'after'): Promise<void> {
  await chip.evaluate((chip, direction) => {
    const box = chip.closest<HTMLElement>('[role="textbox"]'); box?.focus()
    const range = document.createRange()
    if (direction === 'before') range.setStartBefore(chip); else range.setStartAfter(chip)
    range.collapse(true)
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
  }, direction)
}
async function send(button = work().getByRole('button', { name: '发送', exact: true })): Promise<Record<string, unknown>> {
  const before = chats.length
  await expect(button).toBeEnabled()
  const startedAt = Date.now()
  await button.click()
  await expect.poll(() => chats.length).toBe(before + 1)
  const request = chats[before], receipt = chatReceipts.get(request)
  if (!receipt) throw new Error('Missing accepted chat receipt')
  let renderedAt: number | null = null
  try {
    // Waiting on this response excludes the previous turn and avoids repeatedly
    // extracting the entire >100k-character conversation while it lays out.
    await expect(work().locator(`[data-message-id="${receipt.run.assistantMessageId}"]`))
      .toContainText('PASTE_SENT_OK', { timeout: 30_000 })
    renderedAt = Date.now()
  } finally {
    await test.info().attach('paste-response-timing', { contentType: 'application/json', body: JSON.stringify({
      sessionId: receipt.run.sessionId, runId: receipt.run.runId, messageLength: String(request.message).length,
      sendToReceiptMs: receipt.receivedAt - startedAt,
      sendToRenderMs: renderedAt === null ? null : renderedAt - startedAt,
      receiptToRenderMs: renderedAt === null ? null : renderedAt - receipt.receivedAt,
      elapsedMs: Date.now() - startedAt
    }) })
  }
  return request
}

test.describe.serial('Work 长文本资料与纯正文输入上限', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    storageKey = 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin }))
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'composer-paste-profile-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin,
      remoteWorkspaceRoot: '/remote/configured-default', autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: model, appearance: 'light', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY',
      'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900); window.show(); window.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  })
  test.beforeEach(async () => { releaseUpload(); await seed() })
  test.afterEach(async ({}, info) => {
    releaseUpload()
    if (info.status !== info.expectedStatus && page && !page.isClosed()) {
      const path = info.outputPath('composer-paste-failure.png')
      await page.screenshot({ path }); await info.attach('失败时页面', { path, contentType: 'image/png' })
      await info.attach('composer-dom', { body: await work().locator('.work-chat__input:visible').evaluateAll(elements => elements.map(element => element.outerHTML).join('\n')), contentType: 'text/html' })
    }
    await info.attach('paste-http-receipts', { body: JSON.stringify({ errors, chats, bindings, reads,
      uploads: uploads.map(({ bytes, ...file }) => ({ ...file, bytes: bytes.length, base64: bytes.toString('base64') })) }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([])
  })
  test.afterAll(async () => {
    releaseUpload()
    try { await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('composer-paste-profile-')) throw new Error(`Unsafe cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('短粘贴替换选区，1000 个 Unicode 字符为正文，1001 个转为资料', async () => {
    const before = uploads.length
    await composer().fill('左侧待替换右侧'); await selectText(2, 5); await nativePaste('新的')
    await expect(composer()).toHaveText('左侧新的右侧')
    const boundary = '😀'.repeat(500) + '中'.repeat(500)
    await composer().fill(''); await nativePaste(boundary)
    await expect(composer()).toHaveText(boundary); await expect(chips()).toHaveCount(0)
    expect((await savedTask()).draft).toBe(boundary); expect(uploads).toHaveLength(before)
    await composer().fill(''); await nativePaste(`${boundary}终`)
    await expect(chips()).toHaveCount(1); await expect.poll(() => uploads.length).toBe(before + 1)
    expect(uploads[before].bytes.equals(Buffer.from(`${boundary}终`, 'utf8'))).toBe(true)
    const saved = await savedTask()
    expect(saved.sources).toHaveLength(1); expect(saved.attachments).toEqual([]); expect(saved.mentions).toHaveLength(1)
    expect(saved.draft.includes(boundary)).toBe(false)
    const request = await send()
    expect(String(request.message).includes(boundary)).toBe(false)
    expect(request.attachments).toEqual([expect.objectContaining({ name: uploads[before].path, size: uploads[before].bytes.length })])
    expect(uploads).toHaveLength(before + 1)
  })

  test('超过十万字符粘贴保留全部 TXT 字节和原草稿，引用可预览并只发送一次', async ({}, info) => {
    const original = `  精确原文_START\r\n${'中文🙂\t空格  '.repeat(15_000)}\r\n原文_END\r\n \t`
    const before = uploads.length
    await seed('左侧 右侧'); await selectText(3); await exactPaste(original)
    await expect(chips()).toHaveCount(1); await expect.poll(() => uploads.length).toBe(before + 1)
    const file = uploads[before], stored = await savedTask(), source = stored.sources[0]
    expect(file.sessionId).toBe(taskA); expect(file.bytes.equals(Buffer.from(original, 'utf8'))).toBe(true)
    expect(Array.from(original).length).toBeGreaterThan(previousInputLimit)
    expect(await composer().evaluate(element => {
      const chip = element.querySelector('[data-mention-key]')!, left = document.createRange(), right = document.createRange()
      left.selectNodeContents(element); left.setEndBefore(chip); right.selectNodeContents(element); right.setStartAfter(chip)
      return { left: left.toString(), right: right.toString() }
    })).toEqual({ left: '左侧 ', right: expect.stringMatching(/^\s*右侧$/) })
    expect(stored.attachments).toEqual([]); expect(stored.mentions).toHaveLength(1)
    expect(stored.draft.includes('原文_END')).toBe(false)
    await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
    await expect(chips()).toHaveCount(1); expect((await savedTask()).draft).toBe(stored.draft)
    const label = '查看引用：粘贴文本 · 精确原文_START'
    await composer().getByRole('button', { name: label, exact: true }).click()
    await expect(sourcePanel()).toBeVisible()
    const previewLines = original.split('\r\n')
    await expect.poll(async () => JSON.stringify(await sourcePanel().getByRole('gridcell').allTextContents()) === JSON.stringify(previewLines)).toBe(true)
    await expect.poll(() => reads.some(read => read.sessionId === taskA && read.path === file.path)).toBe(true)
    const request = await send(), message = String(request.message)
    expect(request.sessionId).toBe(taskA)
    expect(request.attachments).toEqual([{ name: file.path, type: file.type, displayName: source.name,
      size: file.bytes.length, attachmentId: source.attachmentId, referenceLabel: '粘贴文本 · 精确原文_START' }])
    expect(message.includes(original)).toBe(false); expect(message.includes('原文_END')).toBe(false)
    expect(userMessageDraft(message).text).toBe(stored.draft)
    const userMessage = work().locator(`[data-message-id="${latestRun(taskA)!.userMessageId}"]`)
    const sentReference = userMessage.getByRole('button', { name: label, exact: true })
    await expect(sentReference).toHaveCount(1); await expect(userMessage.locator('.work-message__attachments')).toHaveCount(0)
    await work().getByRole('button', { name: '关闭资料', exact: true }).click()
    await expect(sourcePanel()).not.toBeVisible(); await sentReference.click(); await expect(sourcePanel()).toBeVisible()
    await expect.poll(async () => JSON.stringify(await sourcePanel().getByRole('gridcell').allTextContents()) === JSON.stringify(previewLines)).toBe(true)
    const screenshot = info.outputPath('long-paste-reference-preview.png')
    await page.screenshot({ path: screenshot, animations: 'disabled' })
    await info.attach('超过十万字符的原文资料预览', { path: screenshot, contentType: 'image/png' })
    expect(uploads).toHaveLength(before + 1)
  })

  test('图片和文件引用旁长粘贴生成新资料，保留原引用身份与短正文', async () => {
    const imageBytes = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 12; canvas.height = 12
      const context = canvas.getContext('2d')!; context.fillStyle = '#c43d4c'; context.fillRect(0, 0, 12, 12)
      return canvas.toDataURL('image/png').split(',')[1]
    }), 'base64')
    const attachments: SavedSource[] = [
      { path: '.ae/attachments/existing-image.png', name: 'existing-image.png', type: 'image/png', size: imageBytes.length, attachmentId: 'existing-image' },
      { path: '.ae/attachments/existing-notes.txt', name: 'existing-notes.txt', type: 'text/plain', size: 14, attachmentId: 'existing-file' }
    ]
    files.set(fileKey(taskA, attachments[0].path), { sessionId: taskA, path: attachments[0].path, type: 'image/png', bytes: imageBytes })
    files.set(fileKey(taskA, attachments[1].path), { sessionId: taskA, path: attachments[1].path, type: 'text/plain', bytes: Buffer.from('EXISTING_NOTES') })
    const draft = `开始 @${attachments[0].path} 中段 @${attachments[1].path} 结束`
    await seed(draft, { attachments, mentions: attachments.map((file, index) => ({ source: 'file', origin: 'attachment',
      path: file.path, attachmentId: file.attachmentId, displayText: index === 0 ? '图1' : '附件1', textOffset: draft.indexOf(`@${file.path}`) })) })
    const before = uploads.length
    const imageChip = composer().locator('[data-attachment-id="existing-image"]'), fileChip = composer().locator('[data-attachment-id="existing-file"]')
    await expect(chips()).toHaveCount(2)
    const imageText = `图片旁资料\n${'图片旁🙂'.repeat(26_000)}\nIMAGE_SIDE_END `
    await adjacentToChip(imageChip, 'before'); await exactPaste(imageText)
    await expect(chips()).toHaveCount(3); await expect.poll(() => uploads.length).toBe(before + 1)
    expect(uploads[before].bytes.equals(Buffer.from(imageText))).toBe(true)
    const source = (await savedTask()).sources[0]
    const fileText = `\nFILE_SIDE_START\n${'文件旁😀'.repeat(100)}\nFILE_SIDE_END `
    await adjacentToChip(fileChip, 'after'); await exactPaste(fileText)
    const saved = await savedTask()
    expect(saved.draft.startsWith('开始 ')).toBe(true); expect(saved.draft).toContain(' 中段 ')
    expect(saved.draft).toContain(fileText); expect(saved.draft.endsWith(' 结束')).toBe(true)
    expect(saved.draft.includes(imageText)).toBe(false)
    expect(saved.mentions.map(mention => mention.attachmentId)).toEqual([source.attachmentId, 'existing-image', 'existing-file'])
    await expect(chips()).toHaveCount(3)
    await expect(imageChip.locator('.mention-chip__label')).toHaveText('图1')
    await expect(fileChip.locator('.mention-chip__label')).toHaveText('existing-notes.txt')
    const request = await send()
    expect(String(request.message).includes(imageText)).toBe(false)
    expect(userMessageDraft(String(request.message)).text).toBe(saved.draft)
    expect(userMessageDraft(String(request.message)).mentions.map(mention => mention.attachmentId)).toEqual([source.attachmentId, 'existing-image', 'existing-file'])
    expect(request.attachments).toHaveLength(3)
    expect(request.attachments).toEqual(expect.arrayContaining(attachments.map((file, index) => ({ name: file.path, displayName: file.name, type: file.type,
      size: file.size, attachmentId: file.attachmentId, referenceLabel: index === 0 ? '图1' : '附件1' }))))
    expect(request.attachments).toEqual(expect.arrayContaining([expect.objectContaining({ name: source.path, attachmentId: source.attachmentId,
      referenceLabel: '粘贴文本 · 图片旁资料', size: uploads[before].bytes.length })]))
    expect(uploads).toHaveLength(before + 1)
  })

  test('上传失败保留已有文字和选区内容，重试完整保存长资料', async () => {
    const draft = '失败前 保留选中的内容 失败后', original = 'FAILED_UPLOAD_RETRY_'.repeat(6_000), before = uploads.length
    await composer().fill(draft); await selectText(4, 12)
    uploadMode = 'reject'; await exactPaste(original)
    await expect.poll(() => uploads.length).toBe(before + 1)
    await expect(page.getByText(/PASTE_UPLOAD_REJECTED/).first()).toBeVisible()
    await expect(composer()).toHaveText(draft); await expect(chips()).toHaveCount(0)
    expect((await savedTask()).sources).toEqual([]); expect((await savedTask()).draft).toBe(draft)
    await selectText(4, 12); await exactPaste(original)
    await expect(chips()).toHaveCount(1); expect((await savedTask()).sources).toHaveLength(1)
    expect(uploads).toHaveLength(before + 2)
    expect(uploads[before + 1].bytes.equals(Buffer.from(original))).toBe(true)
  })

  test('延迟上传保留原插入位置和当前选区，原选区被改写时只保留资料', async () => {
    const before = uploads.length, chatsBefore = chats.length
    const original = 'ASYNC_ORIGINAL_CARET_'.repeat(6_000)
    await composer().fill('左侧 右侧'); await selectText(3)
    uploadMode = 'hold'; await exactPaste(original)
    await expect.poll(() => Boolean(held)).toBe(true)
    await page.keyboard.press('Control+End'); await page.keyboard.insertText(' 继续输入')
    await expect(composer()).toHaveText('左侧 右侧 继续输入')
    await selectText(6, 10)
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('继续输入')
    releaseUpload(); await expect(chips()).toHaveCount(1)
    expect(await composer().evaluate(element => {
      const chip = element.querySelector('[data-mention-key]')!, left = document.createRange(), right = document.createRange()
      left.selectNodeContents(element); left.setEndBefore(chip); right.selectNodeContents(element); right.setStartAfter(chip)
      return { left: left.toString(), right: right.toString(), selected: window.getSelection()?.toString(), focused: document.activeElement === element }
    })).toEqual({ left: '左侧 ', right: expect.stringMatching(/^\s*右侧 继续输入$/), selected: '继续输入', focused: true })
    await page.keyboard.insertText('继续保留')
    await expect(composer()).toContainText('右侧 继续保留'); await expect(chips()).toHaveCount(1)
    expect(uploads[before].bytes.equals(Buffer.from(original))).toBe(true)
    const changedSelection = 'ASYNC_CHANGED_SELECTION_'.repeat(80)
    await composer().fill('选区前 旧选区 选区后'); await selectText(4, 7)
    uploadMode = 'hold'; await exactPaste(changedSelection)
    await expect.poll(() => Boolean(held)).toBe(true)
    await page.keyboard.insertText('改写的新选区')
    await expect(composer()).toHaveText('选区前 改写的新选区 选区后')
    releaseUpload()
    await expect.poll(async () => (await savedTask()).sources.length).toBe(2)
    await expect(page.getByText('原文已保存到任务资料，草稿已变化，可从资料中重新引用。', { exact: true })).toBeVisible()
    await expect(composer()).toHaveText('选区前 改写的新选区 选区后'); await expect(chips()).toHaveCount(0)
    const saved = await savedTask()
    expect(saved.mentions).toEqual([])
    expect(saved.sources.map(source => source.path)).toEqual([uploads[before].path, uploads[before + 1].path])
    expect(uploads[before + 1].bytes.equals(Buffer.from(changedSelection))).toBe(true)
    expect(chats).toHaveLength(chatsBefore)
  })

  test('上传中切换任务，迟到资料只归原任务且不向另一任务光标插入引用', async () => {
    const draftA = '任务 A 保留原草稿', draftB = '任务 B 独立草稿', original = 'HELD_UPLOAD_FOR_A_'.repeat(6_000), before = uploads.length
    await composer().fill(draftA); await selectText(5); uploadMode = 'hold'; await exactPaste(original)
    await expect.poll(() => Boolean(held)).toBe(true)
    await selectTask(taskB); await composer().fill(draftB)
    releaseUpload()
    await expect.poll(async () => (await savedTask(taskA)).sources.length).toBe(1)
    await expect(composer()).toHaveText(draftB); await expect(chips()).toHaveCount(0)
    const savedB = await savedTask(taskB)
    expect(savedB.sources).toEqual([]); expect(savedB.attachments).toEqual([]); expect(savedB.mentions).toEqual([])
    expect(uploads[before].sessionId).toBe(taskA); expect(uploads[before].bytes.equals(Buffer.from(original))).toBe(true)
    await selectTask(taskA); await expect(composer()).toHaveText(draftA); await expect(chips()).toHaveCount(0)
    expect((await savedTask()).sources[0].path).toBe(uploads[before].path)
  })

  test('十万纯正文限制只约束编辑，满额仍可粘贴超十万附件并完整发送', async () => {
    const before = uploads.length, original = 'a '.repeat(49_998) + 'TAIL'
    const full = await test.step('输入十万正文，拒绝扩增并允许替换和删除', async () => {
      expect(original.length).toBe(previousInputLimit)
      await composer().fill(original); await selectText(original.length); await page.keyboard.type('x')
      await expect.poll(async () => (await savedTask()).draft === original).toBe(true)
      await expect(page.getByText(/输入框正文最多 100,000/).first()).toBeVisible()
      const start = original.length - 4
      await selectText(start, original.length); await page.keyboard.insertText('EDIT')
      const replaced = original.slice(0, start) + 'EDIT'
      await expect.poll(async () => (await savedTask()).draft === replaced).toBe(true)
      await selectText(replaced.length - 1, replaced.length); await page.keyboard.press('Backspace')
      await expect.poll(async () => (await savedTask()).draft === replaced.slice(0, -1)).toBe(true)
      await page.keyboard.insertText('R')
      const full = replaced.slice(0, -1) + 'R'
      await expect.poll(async () => (await savedTask()).draft === full).toBe(true)
      return full
    })
    const { file, saved, source } = await test.step('满额正文在原光标接收超十万字符资料', async () => {
      const attachmentText = `满额正文的资料\r\n${'附件完整 '.repeat(20_001)}\r\nFULL_ATTACHMENT_END`, caret = 200
      await selectText(caret); await exactPaste(attachmentText)
      await expect(chips()).toHaveCount(1); await expect.poll(() => uploads.length).toBe(before + 1)
      const file = uploads[before], saved = await savedTask(), source = saved.sources[0]
      expect(file.bytes.equals(Buffer.from(attachmentText))).toBe(true)
      expect(Array.from(attachmentText).length).toBeGreaterThan(previousInputLimit)
      expect(await composer().evaluate((element, { full, caret }) => {
        const chip = element.querySelector('[data-mention-key]')!, left = document.createRange(), right = document.createRange()
        left.selectNodeContents(element); left.setEndBefore(chip); right.selectNodeContents(element); right.setStartAfter(chip)
        return left.toString() === full.slice(0, caret) &&
          [full.slice(caret), ' ' + full.slice(caret)].includes(right.toString())
      }, { full, caret })).toBe(true)
      return { file, saved, source }
    })
    await test.step('刷新后正文与资料均完整发送', async () => {
      await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
      await expect(chips()).toHaveCount(1); expect((await savedTask()).draft === saved.draft).toBe(true)
      const request = await send()
      expect(userMessageDraft(String(request.message)).text === saved.draft).toBe(true)
      expect(request.attachments).toEqual([{ name: file.path, type: file.type, displayName: source.name,
        size: file.bytes.length, attachmentId: source.attachmentId, referenceLabel: '粘贴文本 · 满额正文的资料' }])
      expect((await savedTask()).draft).toBe(''); expect(uploads).toHaveLength(before + 1)
    })
  })

  test('引用的一个光标分隔空格不抢正文额度，满额也可删除引用并继续编辑', async () => {
    const original = 'a '.repeat(49_999) + '尾'
    expect(Array.from(original)).toHaveLength(99_999)
    const before = uploads.length, attachmentText = '边界资料\n' + '附件完整内容'.repeat(200)
    const source = await test.step('99999 正文末尾插入长资料引用', async () => {
      await composer().fill(original); await selectText(original.length); await exactPaste(attachmentText)
      await expect(chips()).toHaveCount(1); await expect.poll(() => uploads.length).toBe(before + 1)
      expect(uploads[before].bytes.equals(Buffer.from(attachmentText))).toBe(true)
      return (await savedTask()).sources[0]
    })
    await test.step('第100000字可输入，第100001字被拒绝', async () => {
      await composer().focus(); await page.keyboard.press('Control+End'); await page.keyboard.type('x')
      const full = original + `@${source.path} x`
      await expect.poll(async () => (await savedTask()).draft === full).toBe(true)
      await page.keyboard.type('y')
      await expect.poll(async () => (await savedTask()).draft === full).toBe(true)
      await expect(page.getByText(/输入框正文最多 100,000/).first()).toBeVisible()
    })
    await test.step('满额删除引用保留正文，缩短后可继续编辑', async () => {
      const reference = composer().locator(`[data-attachment-id="${source.attachmentId}"]`)
      await adjacentToChip(reference, 'before'); await page.keyboard.press('Delete')
      await expect(chips()).toHaveCount(0)
      await expect.poll(async () => (await savedTask()).draft === original + ' x').toBe(true)
      expect((await savedTask()).sources.map(file => file.path)).toEqual([source.path])
      await composer().fill('短正文'); await page.keyboard.press('Control+End'); await page.keyboard.type('ok')
      await expect(composer()).toHaveText('短正文ok'); expect((await savedTask()).draft).toBe('短正文ok')
    })
  })

  test('历史超额草稿不截断，可缩短且发送不校验组装消息长度', async () => {
    const original = 'history '.repeat(12_501) + 'LEGACY_EXTRA'
    await seed(original)
    await expect.poll(async () => (await savedTask()).draft === original).toBe(true)
    await selectText(original.length); await page.keyboard.type('x')
    await expect.poll(async () => (await savedTask()).draft === original).toBe(true)
    const start = original.indexOf('LEGACY_EXTRA')
    await selectText(start, original.length); await page.keyboard.insertText('余')
    const shortened = original.slice(0, start) + '余'
    await expect.poll(async () => (await savedTask()).draft === shortened).toBe(true)
    expect(Array.from(shortened).length).toBeGreaterThan(previousInputLimit)
    const request = await send()
    expect(request.message === shortened).toBe(true); expect(request.attachments ?? []).toEqual([])
  })

  test('既有粘贴资料仍可打开全文，删除引用后不随新正文发送', async () => {
    const original = '既有资料\n' + 'PERSISTED_SOURCE_CONTENT_'.repeat(80), path = '.ae/attachments/persisted-paste.txt'
    const source: SavedSource = { path, name: '粘贴的文本-既有资料.txt', type: 'text/plain', size: Buffer.byteLength(original), attachmentId: 'persisted-paste' }
    files.set(fileKey(taskA, path), { sessionId: taskA, path, type: source.type, bytes: Buffer.from(original) })
    await seed(`请查看 @${path}`, { sources: [source], mentions: [{ source: 'file', origin: 'attachment', path,
      attachmentId: source.attachmentId, displayText: '附件1', textOffset: 4 }] })
    const before = uploads.length, reference = composer().getByRole('button', { name: '查看引用：粘贴文本 · 既有资料', exact: true })
    await reference.click(); await expect(sourcePanel()).toBeVisible()
    await expect.poll(() => sourcePanel().getByRole('gridcell').allTextContents()).toEqual(original.split('\n'))
    await adjacentToChip(reference, 'after'); await page.keyboard.press('Backspace')
    await expect(chips()).toHaveCount(0); expect((await savedTask()).sources).toEqual([source])
    const request = await send()
    expect(request.attachments ?? []).toEqual([]); expect(String(request.message)).not.toContain(path)
    expect(uploads).toHaveLength(before)
  })

  test('工作区来源的文件引用仍打开对应工作区预览', async () => {
    const path = 'README-paste.txt', content = 'WORKSPACE_REFERENCE_TARGET：这是工作区文件，不是上传资料。'
    files.set(fileKey(taskA, path), { sessionId: taskA, path, bytes: Buffer.from(content), type: 'text/plain' })
    await seed(`请查看 @${path}`, { mentions: [{ source: 'file', origin: 'workspace', path, displayText: path, textOffset: 4 }] })
    const chip = composer().getByRole('button', { name: `查看引用：${path}`, exact: true })
    await expect(chip).toBeVisible(); await chip.focus(); await page.keyboard.press('Enter')
    const panel = work().getByRole('tabpanel', { name: '工作区', exact: true })
    await expect(panel).toBeVisible(); await expect(panel).toContainText('WORKSPACE_REFERENCE_TARGET')
    expect((await savedTask()).sources).toEqual([])
  })

  test('首页超十万原生粘贴作为资料保留，刷新可预览并随新任务发送一次', async ({}, info) => {
    const path = 'README-home.txt', initial = `首页说明 @${path} 接着说明 `
    await seed(initial, { home: true, mentions: [{ source: 'file', origin: 'workspace', path, displayText: path, textOffset: 5 }] })
    const home = work().getByRole('textbox', { name: '任务目标', exact: true }), before = uploads.length
    const original = 'HOME_SOURCE_PRESERVED_'.repeat(6_000) + 'HOME_PASTE_TAIL'
    await home.focus(); await page.keyboard.press('Control+End'); await nativePaste(original, home)
    await expect(home.locator('[data-mention-key]')).toHaveCount(2)
    await expect.poll(() => uploads.length).toBe(before + 1)
    const file = uploads[before]
    expect(file.bytes.equals(Buffer.from(original))).toBe(true)
    const state = await savedHome()
    const source = state.homeSources[0]
    expect(state.homeSessionId).toBe(file.sessionId); expect(state.homeSources.map(source => source.path)).toEqual([file.path])
    expect(state.homeAttachments).toEqual([])
    expect(state.homeDraft.startsWith(initial)).toBe(true); expect(state.homeDraft.includes(original)).toBe(false)
    expect(state.homeMentions).toEqual([expect.objectContaining({ path, source: 'file', origin: 'workspace' }),
      expect.objectContaining({ path: file.path, source: 'file', origin: 'attachment', attachmentId: source.attachmentId })])
    await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
    await expect(home.locator('[data-mention-key]')).toHaveCount(2)
    expect((await savedHome()).homeDraft).toBe(state.homeDraft)
    const library = page.getByRole('dialog', { name: '任务资料', exact: true })
    const preview = page.getByRole('dialog', { name: source.name, exact: true })
    await work().getByRole('button', { name: '资料 · 1', exact: true }).click()
    await expect(library).toBeVisible(); await library.getByRole('button', { name: source.name, exact: true }).click()
    await expect.poll(async () => await preview.getByRole('gridcell').textContent() === original).toBe(true)
    await expect.poll(() => reads.some(read => read.sessionId === file.sessionId && read.path === file.path)).toBe(true)
    const screenshot = info.outputPath('home-long-paste-material-preview.png')
    await page.screenshot({ path: screenshot, animations: 'disabled' })
    await info.attach('首页长资料原文预览', { path: screenshot, contentType: 'image/png' })
    await preview.getByRole('button', { name: '关闭', exact: true }).click(); await expect(preview).toHaveCount(0)
    await library.getByRole('button', { name: '关闭', exact: true }).click(); await expect(library).toHaveCount(0)
    const request = await send(work().getByRole('button', { name: '开始任务', exact: true }))
    expect(request.sessionId).toBe(state.homeSessionId)
    const sentDraft = userMessageDraft(String(request.message))
    // buildMentionMessage trims the editor's leading/trailing whitespace while
    // retaining both reference origins and their original identities.
    expect(sentDraft.text).toBe(state.homeDraft.trim())
    expect(sentDraft.mentions).toEqual([
      expect.objectContaining({ source: 'file', origin: 'workspace', path, displayText: path }),
      expect.objectContaining({ source: 'file', origin: 'attachment', path: source.path, attachmentId: source.attachmentId })
    ])
    expect(String(request.message).includes(original)).toBe(false)
    expect(request.attachments).toEqual([{ name: file.path, type: file.type, displayName: source.name,
      size: file.bytes.length, attachmentId: source.attachmentId, referenceLabel: expect.stringMatching(/^粘贴文本/) }])
    expect(uploads).toHaveLength(before + 1)
    const task = await savedTask(state.homeSessionId)
    expect(task.sources.map(source => source.path)).toEqual([file.path]); expect(task.attachments).toEqual([])
    const cleared = await savedHome()
    expect(cleared.homeDraft).toBe(''); expect(cleared.homeMentions).toEqual([]); expect(cleared.homeSources).toEqual([])
  })
})
