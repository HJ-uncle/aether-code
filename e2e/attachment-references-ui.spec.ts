/** Real Electron: Code/Work attachment identity, all three native mouse drag
 * paths, reference deletion, durable drafts and model-facing send receipts.
 * Build first; run serially with playwright.attachment-references.config.ts. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import { parseMentionContent } from '../src/renderer/src/contrib/chat/mention-context'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'attachment-reference-token', model = 'attachment-reference-model'
const workId = 'work-attachment-references', codeId = 'code-attachment-references', workspaceRoot = '/remote/attachment-references'
const titles = new Map([[workId, '附件引用 Work 验证'], [codeId, '附件引用 Code 验证']])
type Mode = 'code' | 'work'
interface UploadedFile { sessionId: string; path: string; bytes: Buffer; type: string }
interface DraftFile { path: string; name: string; type: string; attachmentId: string; referenceLabel?: string }
interface SavedDraft { text?: string; draft?: string; mentions: Array<{ attachmentId?: string; path?: string; displayText: string }>; attachments?: DraftFile[] }
const errors: string[] = [], chats: Record<string, unknown>[] = [], uploads: UploadedFile[] = []
const files = new Map<string, UploadedFile>(), histories = new Map<string, EngineHistoryRow[]>(), runs = new Map<string, RootRun[]>()
const admissions = new Map<string, { admission: Record<string, unknown>; run: RootRun }>()
let app: ElectronApplication | undefined, page: Page, fixture = '', storageKey = '', generation = 0
let redPng = Buffer.alloc(0), bluePng = Buffer.alloc(0)
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const fileKey = (owner: string, path: string): string => JSON.stringify([owner, path])
const currentRun = (owner: string): RootRun | undefined => runs.get(owner)?.at(-1)

function resetHistory(): void {
  histories.clear(); runs.clear(); admissions.clear(); generation++
  for (const [sessionId, title] of titles) {
    const now = Date.now() - 10_000
    const run: RootRun = { schemaVersion: 1, runId: `refs-root-${sessionId}-${generation}`, sessionId, turnId: `refs-turn-${sessionId}-${generation}`,
      userMessageId: `refs-user-${sessionId}-${generation}`, assistantMessageId: `refs-assistant-${sessionId}-${generation}`,
      seq: 1, version: 2, status: 'succeeded', modelId: model, pending: [], workspacePaths: [workspaceRoot],
      createdAt: now, updatedAt: now, startedAt: now - 10, finishedAt: now }
    runs.set(sessionId, [run]); histories.set(sessionId, [
      { id: run.userMessageId, role: 'user', content: title, createdAt: now - 10, conversationId: run.turnId, metadata: { rootRunId: run.runId } },
      { id: run.assistantMessageId, role: 'assistant', content: 'READY_FOR_REFERENCES：可添加附件。', createdAt: now, conversationId: run.turnId, metadata: { rootRunId: run.runId } }
    ])
  }
}

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, sessionId = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const bytes = Buffer.concat(chunks)
  if (path === '/api/v1/workspace/upload' && request.method === 'POST') {
    const form = await new Request('http://fixture/upload', { method: 'POST', headers: { 'content-type': String(request.headers['content-type']) }, body: Uint8Array.from(bytes) }).formData()
    const blob = form.get('file'), owner = form.get('sessionId'), relative = form.get('path')
    if (!blob || typeof blob === 'string' || typeof owner !== 'string' || !titles.has(owner) || typeof relative !== 'string') throw new Error('Upload crossed reference session ownership')
    const file: UploadedFile = { sessionId: owner, path: relative, bytes: Buffer.from(await blob.arrayBuffer()), type: blob.type }
    uploads.push(file); files.set(fileKey(owner, relative), file)
    response.end(envelope({ path: relative, size: file.bytes.length })); return
  }
  const parsed: unknown = bytes.length ? JSON.parse(bytes.toString('utf8')) : {}, input = isRecord(parsed) ? parsed : {}
  const current = currentRun(sessionId), rows = histories.get(sessionId) ?? []
  if (path === '/api/v1/workspace/file/info' || path === '/api/v1/workspace/file/content') {
    const relative = (url.searchParams.get('path') ?? '').replace(`${workspaceRoot}/`, ''), file = files.get(fileKey(sessionId, relative))
    if (!file) throw new Error(`Missing or cross-session reference read: ${sessionId}/${relative}`)
    const image = file.type.startsWith('image/')
    response.end(envelope(path.endsWith('/info') ? { workspacePath: `${workspaceRoot}/${relative}`, size: file.bytes.length, isDirectory: false }
      : { content: file.bytes.toString(image ? 'base64' : 'utf8'), isBinary: image, totalSize: file.bytes.length, root: workspaceRoot, bindingEpoch: 'refs-binding' })); return
  }
  if (path === '/api/v1/chat/admission/context') {
    const matching = current ? { ...current, attemptId: `attempt-${current.runId}` } : null
    response.end(envelope({ protocolVersion: 1, tenantId: 'refs-tenant', sessionId, namespace: { id: 'refs-db', generation: 'one' },
      transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 },
      root: matching, predecessor: matching ? { runId: matching.runId, attemptId: matching.attemptId, version: matching.version } : null })); return
  }
  if (path === '/api/v1/chat/admission/receipt') {
    const accepted = admissions.get(String(input.requestKey))
    response.end(envelope(accepted ? { protocolVersion: 1, status: 'accepted', receipt: { ...accepted.admission, sessionId: accepted.run.sessionId,
      rootRunId: accepted.run.runId, turnId: accepted.run.turnId, userMessageId: accepted.run.userMessageId, assistantMessageId: accepted.run.assistantMessageId }, run: accepted.run,
      projection: { rootVersion: accepted.run.version, rootAttemptId: `attempt-${accepted.run.runId}`, user: { messageId: accepted.run.userMessageId, state: 'projected' },
        assistant: { anchorMessageId: accepted.run.assistantMessageId, state: 'persisted', messageId: accepted.run.assistantMessageId } } }
      : { protocolVersion: 1, status: 'absent', namespace: input.namespace, sessionId: input.sessionId, requestKey: input.requestKey })); return
  }
  if (path === '/api/v1/chat' && request.method === 'POST') {
    const owner = String(input.sessionId)
    if (!titles.has(owner) || typeof input.message !== 'string') throw new Error('Unexpected chat owner or body')
    chats.push(input)
    const now = Date.now(), ordinal = (runs.get(owner)?.length ?? 0) + 1
    const run: RootRun = { schemaVersion: 1, runId: `refs-root-${owner}-${generation}-${ordinal}`, sessionId: owner, turnId: `refs-turn-${owner}-${generation}-${ordinal}`,
      userMessageId: `refs-user-${owner}-${generation}-${ordinal}`, assistantMessageId: `refs-assistant-${owner}-${generation}-${ordinal}`,
      seq: ordinal, version: 1, status: 'running', modelId: model, pending: [], workspacePaths: [workspaceRoot], createdAt: now, updatedAt: now, startedAt: now }
    const user: EngineHistoryRow = { id: run.userMessageId, role: 'user', content: input.message, createdAt: now, conversationId: run.turnId,
      metadata: { rootRunId: run.runId, attachments: Array.isArray(input.attachments) ? input.attachments : [] } }
    const assistant: EngineHistoryRow = { id: run.assistantMessageId, role: 'assistant', content: 'REFERENCES_SENT_OK：已收到附件映射。',
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
  if (path === '/api/v1/workspace/bind') { response.end(envelope({ workspaceRoot: String(input.workspaceRoot) })); return }
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id, conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })),
      messages: rows, loadedTurnIds: users.map(row => row.id), revision: `${sessionId}-${rows.length}`, mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (['/api/v1/cron/capabilities', '/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET') throw new Error(`Unexpected mutation: ${request.method} ${path}`)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'c'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'attachment-references' }
    : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '附件测试模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: 'persisted', eventId: null, finished: true, history: rows, projection: [], run: current,
      runs: runs.get(sessionId) ?? [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: current, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: runs.get(sessionId) ?? [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [...titles].map(([id, title]) => ({ sessionId: id, title, lastAt: Date.now(), messageCount: histories.get(id)?.length ?? 0 }))
    : path === '/api/v1/workspace/directory' ? { root: workspaceRoot, entries: [], bindingEpoch: 'refs-binding' }
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

const surface = (mode: Mode): Locator => page.locator(`#mode-${mode}`)
const composer = (mode: Mode): Locator => mode === 'work' ? surface(mode).getByRole('textbox', { name: '继续对话', exact: true }) : surface(mode).locator('.chat__input.mention-input:visible')
const cards = (mode: Mode): Locator => surface(mode).locator('.attachment-strip__item')
const chips = (mode: Mode, id?: string): Locator => composer(mode).locator(`.mention-chip--attachment${id ? `[data-attachment-id="${id}"]` : ''}`)
async function savedDraft(mode: Mode): Promise<SavedDraft> {
  return page.evaluate(({ mode, key, workId, codeId }) => {
    window.dispatchEvent(new Event('blur'))
    if (mode === 'work') {
      const state = JSON.parse(localStorage.getItem(key) ?? '{}') as { tasks?: Array<SavedDraft & { id: string }> }
      return state.tasks?.find(task => task.id === workId) ?? { mentions: [], attachments: [] }
    }
    for (const name of Object.keys(localStorage).filter(name => name.startsWith('aether:chatDrafts'))) {
      const state = JSON.parse(localStorage.getItem(name) ?? '{}') as Record<string, SavedDraft>
      if (state[codeId]) return state[codeId]
    }
    return { mentions: [], attachments: [] }
  }, { mode, key: storageKey, workId, codeId })
}
async function seed(mode: Mode): Promise<void> {
  resetHistory()
  await page.evaluate(({ mode, key, workId, title, model, workspaceRoot }) => {
    window.dispatchEvent(new Event('blur'))
    for (const name of Object.keys(localStorage).filter(name => name.startsWith('aether:chatDrafts'))) localStorage.removeItem(name)
    localStorage.setItem(key, JSON.stringify({ tasks: [{ id: workId, title, status: 'done', draft: '', mentions: [], createdAt: Date.now(), updatedAt: Date.now(),
      workspacePath: workspaceRoot, modelId: model, attachments: [], sources: [] }], activeTaskId: workId, homeDraft: '' }))
    localStorage.setItem('aether.app.mode', mode)
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 60 }))
  }, { mode, key: storageKey, workId, title: titles.get(workId)!, model, workspaceRoot })
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  if (mode === 'code') {
    await surface(mode).getByRole('button', { name: '会话历史', exact: true }).click()
    await surface(mode).locator(`[data-session-id="${codeId}"]`).click()
  }
  await expect(composer(mode)).toBeVisible(); await expect(surface(mode)).toContainText('READY_FOR_REFERENCES')
}
async function insertReference(mode: Mode, label: string, keyboard = false): Promise<void> {
  await composer(mode).focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('@')
  const picker = page.locator('.mention-ref-picker:visible')
  await expect(picker.getByRole('tab', { name: '当前附件', exact: true })).toHaveAttribute('aria-selected', 'true')
  if (keyboard) {
    await page.keyboard.insertText(label)
    await expect(picker.getByRole('option')).toHaveCount(1); await page.keyboard.press('Enter')
  } else await picker.getByRole('option').filter({ has: page.locator('strong', { hasText: new RegExp(`^${label}$`) }) }).click()
  await expect(picker).toHaveCount(0)
}
async function textPoint(mode: Mode, text: string): Promise<{ x: number; y: number }> {
  return composer(mode).evaluate((box, needle) => {
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest('[data-mention-key]')) continue
      const offset = (node.textContent ?? '').indexOf(needle)
      if (offset < 0) continue
      const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1)
      const rect = range.getBoundingClientRect(); return { x: rect.left + 1, y: rect.top + rect.height / 2 }
    }
    throw new Error(`Missing visible text drop target: ${needle}`)
  }, text)
}
async function nativeDrag(source: Locator, target: { x: number; y: number }): Promise<void> {
  await source.scrollIntoViewIfNeeded(); const box = await source.boundingBox()
  if (!box) throw new Error('Drag source has no layout')
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  await page.mouse.move(x, y); await page.mouse.down()
  await page.mouse.move(x + 8, y + 3, { steps: 4 })
  await page.mouse.move(target.x, target.y, { steps: 18 }); await page.mouse.move(target.x, target.y)
  await page.mouse.up()
}
async function beforeChip(chip: Locator): Promise<string> {
  return chip.evaluate(element => { const box = element.closest('[role="textbox"]')!, range = document.createRange(); range.selectNodeContents(box); range.setEndBefore(element); return range.toString().replace(/\u200b/g, '').trim() })
}

test.describe.serial('附件引用真实拖拽与往返', () => {
  test.beforeAll(async () => {
    resetHistory(); mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'attachment-references-profile-'))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    storageKey = 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin }))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, remoteWorkspaceRoot: workspaceRoot,
      autoStartEngine: true, lastSessionId: codeId, lastFolder: '', lastModelId: model, appearance: 'light', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 1000); window.show(); window.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const pngs = await page.evaluate(() => ['#d74343', '#285cdd'].map(color => {
      const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 60
      const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Fixture canvas missing')
      ctx.fillStyle = color; ctx.fillRect(0, 0, 80, 60); return canvas.toDataURL('image/png').split(',')[1]
    }))
    redPng = Buffer.from(pngs[0], 'base64'); bluePng = Buffer.from(pngs[1], 'base64')
  })
  test.afterEach(async ({}, info) => {
    if (page && !page.isClosed()) {
      const path = info.outputPath('attachment-references.png'); await page.screenshot({ path, animations: 'disabled' })
      await info.attach('附件引用运行界面', { path, contentType: 'image/png' })
      if (info.status !== info.expectedStatus) await info.attach('editor-dom', { body: await page.locator('.mention-input:visible').evaluateAll(elements => elements.map(element => element.outerHTML).join('\n')), contentType: 'text/html' })
    }
    await info.attach('attachment-http-receipts', { body: JSON.stringify({ errors, chats, uploads: uploads.map(({ bytes, ...file }) => ({ ...file, bytes: bytes.length })) }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([])
  })
  test.afterAll(async () => {
    try { await app?.close() } finally {
      server.closeAllConnections(); if (server.listening) await new Promise<void>(done => server.close(() => done()))
      if (fixture) { const target = resolve(fixture); if (dirname(target) !== fixtureRoot || !basename(target).startsWith('attachment-references-profile-')) throw new Error(`Unsafe fixture cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    }
  })

  for (const mode of ['work', 'code'] as const) test(`${mode}：三种真实拖拽、编号身份、删除、草稿刷新与发送映射`, async ({}, info) => {
    await seed(mode)
    const beforeUploads = uploads.length
    await composer(mode).locator('xpath=ancestor::*[contains(@class, "input-composer")][1]').locator('input[type="file"]').setInputFiles([
      { name: 'red-reference.png', mimeType: 'image/png', buffer: redPng },
      { name: 'blue-reference.png', mimeType: 'image/png', buffer: bluePng },
      { name: 'reference-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('ATTACHMENT_REFERENCE_NOTES') }
    ])
    await expect(cards(mode)).toHaveCount(3); await expect.poll(() => uploads.length).toBe(beforeUploads + 3)
    await expect(cards(mode).locator('img')).toHaveCount(2)
    const originalIds = await cards(mode).evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.attachmentId!))
    expect(new Set(originalIds).size).toBe(3)
    const [redId, blueId, textId] = originalIds
    const byId = (id: string): Locator => surface(mode).locator(`.attachment-strip__item[data-attachment-id="${id}"]`)
    await expect(cards(mode).locator('.attach-chip__reference')).toHaveCount(0)
    await composer(mode).fill('开头 中段 结尾 ')
    await insertReference(mode, '图1'); await insertReference(mode, '图1', true)
    await expect(chips(mode, redId)).toHaveCount(2); await expect(byId(redId).locator('.attach-chip__reference')).toHaveText('图1')
    await byId(redId).hover()
    await expect(byId(redId).locator('.attach-chip__reference')).toHaveCSS('opacity', '0')
    await page.mouse.move(0, 0)
    await expect(byId(redId).locator('.attach-chip__reference')).toHaveCSS('opacity', '1')
    const target = await byId(blueId).boundingBox(); if (!target) throw new Error('Missing second card')
    await nativeDrag(byId(redId).locator('.attach-chip__image-btn'), { x: target.x + target.width - 3, y: target.y + 12 })
    await expect.poll(() => cards(mode).evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.attachmentId))).toEqual([blueId, redId, textId])
    await expect(chips(mode, redId).locator('.mention-chip__label')).toHaveText(['图2', '图2'])
    await nativeDrag(byId(blueId).locator('.attach-chip__image-btn'), await textPoint(mode, '中段'))
    await expect(chips(mode, blueId)).toHaveCount(1); await expect.poll(() => beforeChip(chips(mode, blueId))).toBe('开头')
    await expect(cards(mode)).toHaveCount(3); expect(uploads).toHaveLength(beforeUploads + 3)
    await nativeDrag(chips(mode, redId).first().locator('.mention-chip__label'), await textPoint(mode, '开头'))
    await expect.poll(() => chips(mode).evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.attachmentId))).toEqual([redId, blueId, redId])
    await composer(mode).focus(); await page.keyboard.press('Control+Z')
    await expect.poll(() => chips(mode).evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.attachmentId))).toEqual([blueId, redId, redId])
    await page.keyboard.press('Control+Y')
    await expect.poll(() => chips(mode).evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.attachmentId))).toEqual([redId, blueId, redId])
    await nativeDrag(chips(mode, blueId).locator('.mention-chip__label'), await textPoint(mode, '结尾'))
    await expect(chips(mode)).toHaveCount(3); await expect.poll(() => beforeChip(chips(mode, blueId))).toContain('中段')
    // Inline references share the text underline; Delete removes the focused
    // occurrence without removing its underlying attachment or other copies.
    await chips(mode, blueId).focus(); await page.keyboard.press('Delete')
    await expect(chips(mode, blueId)).toHaveCount(0); await expect(byId(blueId).locator('.attach-chip__reference')).toHaveCount(0)
    await chips(mode, redId).first().focus(); await page.keyboard.press('Delete')
    await expect(chips(mode, redId)).toHaveCount(1); await expect(byId(redId).locator('.attach-chip__reference')).toHaveText('图2')
    await chips(mode, redId).focus(); await page.keyboard.press('Delete')
    await expect(chips(mode)).toHaveCount(0); await expect(cards(mode).locator('.attach-chip__reference')).toHaveCount(0)
    await insertReference(mode, '图2'); await insertReference(mode, '附件1')
    await expect(chips(mode)).toHaveCount(2); await expect(byId(textId).locator('.attach-chip__reference')).toHaveText('附件1')
    const labelPosition = await byId(textId).evaluate(element => ({ label: element.querySelector('.attach-chip__reference')!.getBoundingClientRect().right, name: element.querySelector('.attach-chip__name')!.getBoundingClientRect().left }))
    expect(labelPosition.label).toBeLessThanOrEqual(labelPosition.name)
    await expect.poll(async () => (await savedDraft(mode)).attachments?.length ?? 0).toBe(3)
    await expect.poll(async () => (await savedDraft(mode)).mentions.map(mention => [mention.attachmentId, mention.displayText]))
      .toEqual([[redId, '图2'], [textId, '附件1']])
    const saved = await savedDraft(mode)
    const savedAttachments = saved.attachments ?? []
    expect(savedAttachments.map(file => file.attachmentId)).toEqual([blueId, redId, textId])
    expect(saved.mentions.map(mention => [mention.attachmentId, mention.displayText])).toEqual([[redId, '图2'], [textId, '附件1']])
    const screenshot = info.outputPath(`${mode}-attachment-draft.png`); await page.mouse.move(0, 0); await page.screenshot({ path: screenshot, animations: 'disabled' })
    await info.attach(`${mode} 附件与正文标签`, { path: screenshot, contentType: 'image/png' })
    await page.reload(); await expect(composer(mode)).toBeVisible(); await expect(chips(mode)).toHaveCount(2)
    await expect.poll(() => cards(mode).evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.attachmentId))).toEqual([blueId, redId, textId])
    expect(((await savedDraft(mode)).attachments ?? []).map(file => [file.path, file.attachmentId])).toEqual(savedAttachments.map(file => [file.path, file.attachmentId]))
    const beforeChats = chats.length
    const send = surface(mode).getByRole('button', { name: '发送', exact: true }); await expect(send).toBeEnabled(); await send.click()
    await expect.poll(() => chats.length).toBe(beforeChats + 1); await expect(surface(mode)).toContainText('REFERENCES_SENT_OK')
    const request = chats[beforeChats]
    expect(request.sessionId).toBe(mode === 'work' ? workId : codeId)
    expect(request.attachments).toEqual(savedAttachments.map((file, index) => expect.objectContaining({ name: file.path, type: file.type,
      attachmentId: file.attachmentId, displayName: file.name, referenceLabel: ['图1', '图2', '附件1'][index] })))
    const refs = parseMentionContent(String(request.message)).refs.filter(ref => ref.o === 'attachment')
    expect(refs.map(ref => [ref.a, ref.p, ref.d])).toEqual(saved.mentions.map(mention => [mention.attachmentId, mention.path, mention.displayText]))
    expect(String(request.message)).toContain('图2'); expect(String(request.message)).toContain('附件1')
    await page.reload(); await expect(surface(mode)).toContainText('REFERENCES_SENT_OK')
    await expect(composer(mode)).toBeEmpty(); await expect(cards(mode)).toHaveCount(0)
    expect(uploads).toHaveLength(beforeUploads + 3)
    // A single card must still drag into prose. Removing it clears every
    // occurrence without deleting ordinary text or reviving a dangling undo.
    await composer(mode).locator('xpath=ancestor::*[contains(@class, "input-composer")][1]').locator('input[type="file"]').setInputFiles([
      { name: 'single-reference.png', mimeType: 'image/png', buffer: redPng }
    ])
    await expect(cards(mode)).toHaveCount(1)
    await composer(mode).fill('保留正文 末尾 ')
    await nativeDrag(cards(mode).locator('.attach-chip__image-btn'), await textPoint(mode, '末尾'))
    await expect(chips(mode)).toHaveCount(1)
    await insertReference(mode, '图1')
    await expect(chips(mode)).toHaveCount(2)
    await cards(mode).getByRole('button', { name: '移除附件 single-reference.png', exact: true }).click()
    await expect(chips(mode)).toHaveCount(0); await expect(cards(mode)).toHaveCount(0)
    await expect(composer(mode)).toContainText('保留正文')
    await composer(mode).focus(); await page.keyboard.press('Control+z')
    await expect(chips(mode)).toHaveCount(0)
  })
})
