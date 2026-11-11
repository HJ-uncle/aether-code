/** Real Electron: Code/Work attachment identity, native drag caret/ghost and
 * cancellation, long-text clipboard paste, durable drafts and model-facing receipts.
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
import { ATTACHMENT_CHIP_DRAG_TYPE } from '../src/renderer/src/contrib/chat/attachment-editor-transfer'
import { WORK_TOOLKITS } from '../src/shared/toolkits'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'attachment-reference-token', model = 'attachment-reference-model'
const workId = 'work-attachment-references', codeId = 'code-attachment-references', workspaceRoot = '/remote/attachment-references'
const selectionFile = 'selection-guide.txt'
const titles = new Map([[workId, '附件引用 Work 验证'], [codeId, '附件引用 Code 验证']])
type Mode = 'code' | 'work'
interface UploadedFile { sessionId: string; path: string; bytes: Buffer; type: string }
interface DraftFile { path: string; name: string; type: string; attachmentId: string; referenceLabel?: string }
interface SavedDraft { text?: string; draft?: string; mentions: Array<{ attachmentId?: string; path?: string; displayText: string; textOffset?: number }>; attachments?: DraftFile[] }
interface ClipboardSnapshot { text: string; html: string; rtf: string; image: string | null }
interface Point {
  x: number
  y: number
  boundary?: { mode: Mode; x: number; proseBefore: string; mentionKeys: string[] }
}
interface DragPresentation { caret: { x: number; y: number; width: number; height: number }; ghostOpacity: string | null }
interface DragSelection { text: string; collapsed: boolean; sourceChipSelected: boolean }
interface NativeDragEvent extends DragSelection { type: string; types: string[]; chipPayload: string; trusted: boolean; prevented: boolean; target: string }
interface NativeDragTrace {
  source: { text: string; chipKey: string | null }
  target: Point
  targetElement: string
  events: NativeDragEvent[]
  checkpoints: Array<DragSelection & { phase: string }>
  presentation?: DragPresentation
  ending: 'drop' | 'escape' | 'outside'
}
interface NativeDragProbe {
  source: NativeDragTrace['source']
  events: NativeDragEvent[]
  checkpoints: NativeDragTrace['checkpoints']
  snapshot: () => DragSelection
  dispose: () => void
}
const errors: string[] = [], chats: Record<string, unknown>[] = [], uploads: UploadedFile[] = []
const dragTraces: NativeDragTrace[] = []
const files = new Map<string, UploadedFile>(), histories = new Map<string, EngineHistoryRow[]>(), runs = new Map<string, RootRun[]>()
const admissions = new Map<string, { admission: Record<string, unknown>; run: RootRun }>()
const sessionToolkits = new Map<string, string[]>()
let toolkitDirectorySupported = true
const unavailableToolkits = new Set<string>()
let app: ElectronApplication | undefined, page: Page, fixture = '', storageKey = '', generation = 0
let redPng = Buffer.alloc(0), bluePng = Buffer.alloc(0)
let clipboardSnapshot: ClipboardSnapshot | undefined
let menuPreviewFiles: string[] = []
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const fileKey = (owner: string, path: string): string => JSON.stringify([owner, path])
const currentRun = (owner: string): RootRun | undefined => runs.get(owner)?.at(-1)

function resetHistory(): void {
  histories.clear(); runs.clear(); admissions.clear(); sessionToolkits.clear(); generation++
  for (const [sessionId, title] of titles) {
    files.set(fileKey(sessionId, selectionFile), { sessionId, path: selectionFile, bytes: Buffer.from('Workspace selection fixture'), type: 'text/plain' })
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
  const toolkitSession = /^\/api\/v1\/sessions\/([^/]+)\/toolkits$/.exec(path)
  if (path === '/api/v1/toolkits' && request.method === 'GET') {
    if (!toolkitDirectorySupported) { response.statusCode = 404; response.end(JSON.stringify({ code: 404, message: 'Not found' })); return }
    response.end(envelope({ toolkits: WORK_TOOLKITS.map(item => ({ ...item, toolNames: [`${item.id}_list`],
      available: !unavailableToolkits.has(item.id), ...(unavailableToolkits.has(item.id) ? { reason: '此 Agent 没有该工具包权限' } : {}) })) })); return
  }
  if (toolkitSession && request.method === 'GET') {
    response.end(envelope({ toolkits: sessionToolkits.get(decodeURIComponent(toolkitSession[1])) ?? [] })); return
  }
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
    if (Array.isArray(input.toolkits)) sessionToolkits.set(owner, input.toolkits.filter((id): id is string => typeof id === 'string'))
    const now = Date.now(), ordinal = (runs.get(owner)?.length ?? 0) + 1
    const run: RootRun = { schemaVersion: 1, runId: `refs-root-${owner}-${generation}-${ordinal}`, sessionId: owner, turnId: `refs-turn-${owner}-${generation}-${ordinal}`,
      userMessageId: `refs-user-${owner}-${generation}-${ordinal}`, assistantMessageId: `refs-assistant-${owner}-${generation}-${ordinal}`,
      seq: ordinal, version: 1, status: 'running', modelId: model, pending: [], workspacePaths: [workspaceRoot], createdAt: now, updatedAt: now, startedAt: now,
      ...(Array.isArray(input.toolkits) ? { requestConfig: { toolkits: sessionToolkits.get(owner) } } : {}) }
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
    : path === '/api/v1/workspace/directory' ? { root: workspaceRoot, entries: [selectionFile, ...menuPreviewFiles].map(name => ({ name, path: name, isDirectory: false, size: 27, mtimeMs: 1 })), bindingEpoch: 'refs-binding' }
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
    const history = surface(mode).getByRole('button', { name: '会话历史', exact: true })
    if (await history.getAttribute('aria-pressed') !== 'true') await history.click()
    await surface(mode).locator(`[data-session-id="${codeId}"]`).click()
  }
  await expect(composer(mode)).toBeVisible(); await expect(surface(mode)).toContainText('READY_FOR_REFERENCES')
}
async function insertReference(mode: Mode, label: string, keyboard = false): Promise<void> {
  await composer(mode).focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('@')
  const picker = page.locator('.mention-ref-picker:visible')
  await expect(picker.getByRole('group', { name: '当前附件', exact: true })).toBeVisible()
  if (keyboard) {
    await page.keyboard.insertText(label)
    await expect(picker.getByRole('option')).toHaveCount(1); await page.keyboard.press('Enter')
  } else await picker.getByRole('option').filter({ has: page.locator('strong', { hasText: new RegExp(`^${label}$`) }) }).click()
  await expect(picker).toHaveCount(0)
}
async function textPoint(mode: Mode, text: string, edge: 'start' | 'end' = 'start'): Promise<Point> {
  return composer(mode).evaluate((box, { mode, needle, edge }) => {
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest('[data-mention-key]')) continue
      const offset = (node.textContent ?? '').indexOf(needle)
      if (offset < 0) continue
      const position = edge === 'end' ? offset + needle.length - 1 : offset
      const range = document.createRange(); range.setStart(node, position); range.setEnd(node, position + 1)
      const rect = range.getBoundingClientRect(), before = document.createRange()
      before.selectNodeContents(box); before.setEnd(node, edge === 'end' ? position + 1 : position)
      const content = before.cloneContents()
      content.querySelectorAll('[data-mention-key]').forEach(chip => chip.remove())
      return { x: edge === 'end' ? rect.right - 0.5 : rect.left + 0.5, y: rect.top + rect.height / 2,
        boundary: { mode, x: edge === 'end' ? rect.right : rect.left,
          proseBefore: (content.textContent ?? '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim(),
          mentionKeys: [...box.querySelectorAll<HTMLElement>('[data-mention-key]')].map(chip => chip.dataset.mentionKey!) } }
    }
    throw new Error(`Missing visible text drop target: ${needle}`)
  }, { mode, needle: text, edge })
}
async function emptyLinePoint(mode: Mode, anchor: string): Promise<Point> {
  return composer(mode).evaluate((box, { mode, anchor }) => {
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest('[data-mention-key]')) continue
      const offset = (node.textContent ?? '').indexOf(anchor)
      if (offset < 0) continue
      const end = offset + anchor.length, character = document.createRange()
      character.setStart(node, end - 1); character.setEnd(node, end)
      const rect = character.getBoundingClientRect(), style = getComputedStyle(box), bounds = box.getBoundingClientRect()
      const lineHeight = Number.parseFloat(style.lineHeight)
      if (!Number.isFinite(lineHeight)) throw new Error('The empty-line fixture needs an explicit line height')
      const left = bounds.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft)
      const before = document.createRange(); before.selectNodeContents(box); before.setEnd(node, end)
      const content = before.cloneContents(); content.querySelectorAll('[data-mention-key]').forEach(chip => chip.remove())
      return { x: left + 0.5, y: rect.top + lineHeight + rect.height / 2,
        boundary: { mode, x: left,
          proseBefore: (content.textContent ?? '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim(),
          mentionKeys: [...box.querySelectorAll<HTMLElement>('[data-mention-key]')].map(chip => chip.dataset.mentionKey!) } }
    }
    throw new Error(`Missing empty-line anchor: ${anchor}`)
  }, { mode, anchor })
}
async function expectEmptyLineReference(mode: Mode, reference: Locator, trace: NativeDragTrace, path: string, anchor: string): Promise<void> {
  const box = await reference.boundingBox()
  if (!box) throw new Error('Dropped reference has no layout')
  expect(trace.target.y).toBeGreaterThanOrEqual(box.y - 3)
  expect(trace.target.y).toBeLessThanOrEqual(box.y + box.height + 3)
  await expect.poll(async () => {
    const draft = await savedDraft(mode), mention = draft.mentions.find(item => item.path === path)
    return typeof mention?.textOffset === 'number' ? (draft.text ?? draft.draft ?? '').slice(0, mention.textOffset).slice(-anchor.length - 2) : null
  }).toBe(` ${anchor}\n`)
}
async function nativeDrag(source: Locator, targetPoint: () => Promise<Point>, ending: NativeDragTrace['ending'] = 'drop'): Promise<NativeDragTrace> {
  await source.scrollIntoViewIfNeeded(); const box = await source.boundingBox()
  if (!box) throw new Error('Drag source has no layout')
  // Scrolling the source can move both the composer and its cards. Coordinates
  // captured before this scroll silently drag to the wrong element.
  const target = await targetPoint()
  await source.evaluate((element, chipMime) => {
    const state = window as Window & { __attachmentDragProbe?: NativeDragProbe }
    state.__attachmentDragProbe?.dispose()
    const root = document.getElementById('root')
    if (!root) throw new Error('Missing React delegation root')
    const chip = element.closest<HTMLElement>('[data-mention-key]')
    const events: NativeDragEvent[] = [], checkpoints: NativeDragTrace['checkpoints'] = []
    const snapshot = (): DragSelection => {
      const selection = window.getSelection()
      return { text: selection?.toString() ?? '', collapsed: selection?.isCollapsed ?? true,
        sourceChipSelected: Boolean(chip?.isConnected && selection && !selection.isCollapsed && selection.containsNode(chip, true)) }
    }
    const record = (event: Event): void => {
      if (!(event instanceof DragEvent) || events.length >= 100) return
      const target = event.target instanceof Element ? event.target : null
      events.push({ ...snapshot(), type: event.type, types: [...event.dataTransfer?.types ?? []],
        chipPayload: event.type === 'dragstart' || event.type === 'drop' ? event.dataTransfer?.getData(chipMime) ?? '' : '',
        trusted: event.isTrusted, prevented: event.defaultPrevented, target: target ? `${target.tagName}.${target.getAttribute('class') ?? ''}` : '' })
    }
    // React stops propagation at this root. A later listener on the same node
    // still observes the actual native event after the product sets its MIME.
    const types = ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend']
    types.forEach(type => root.addEventListener(type, record))
    state.__attachmentDragProbe = { source: { text: element.textContent ?? '', chipKey: chip?.dataset.mentionKey ?? null },
      events, checkpoints, snapshot, dispose: () => types.forEach(type => root.removeEventListener(type, record)) }
  }, ATTACHMENT_CHIP_DRAG_TYPE)
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  const checkpoint = async (phase: string): Promise<void> => page.evaluate(value => {
    const probe = (window as Window & { __attachmentDragProbe?: NativeDragProbe }).__attachmentDragProbe
    if (probe) probe.checkpoints.push({ phase: value, ...probe.snapshot() })
  }, phase)
  let pressed = false, trace: NativeDragTrace | undefined, presentation: DragPresentation | undefined
  try {
    await page.mouse.move(x, y); await page.mouse.down(); pressed = true
    await checkpoint('pointer-down')
    await page.mouse.move(x + 8, y + 3, { steps: 4 })
    await checkpoint('drag-started')
    await page.mouse.move(target.x, target.y, { steps: 18 }); await page.mouse.move(target.x, target.y)
    await checkpoint('before-drop')
    if (target.boundary) {
      const caret = page.locator('.mention-input-drop-caret')
      await expect(caret).toBeVisible()
      await expect(caret).toHaveAttribute('aria-hidden', 'true')
      await expect(caret).toHaveCSS('pointer-events', 'none')
      const caretBox = await caret.boundingBox()
      if (!caretBox) throw new Error('Visible drop caret has no layout')
      expect(caretBox.width).toBeGreaterThan(0); expect(caretBox.width).toBeLessThanOrEqual(4)
      expect(Math.abs(caretBox.x + caretBox.width / 2 - target.boundary.x)).toBeLessThanOrEqual(3)
      expect(target.y).toBeGreaterThanOrEqual(caretBox.y - 1)
      expect(target.y).toBeLessThanOrEqual(caretBox.y + caretBox.height + 1)
      const ghost = page.locator('.mention-chip-drag-preview')
      const internal = await source.evaluate(element => Boolean(element.closest('[data-mention-key]')))
      if (internal) {
        await expect(ghost).toHaveCount(1)
        await expect(ghost).toHaveCSS('opacity', '0.45')
        if (ending === 'drop' && !dragTraces.some(trace => trace.source.chipKey && trace.ending === 'drop' && trace.presentation)) {
          const clip = await composer(target.boundary.mode).boundingBox()
          if (clip) {
            const path = test.info().outputPath(`${target.boundary.mode}-drag-in-progress-${dragTraces.length + 1}.png`)
            await page.screenshot({ path, clip })
            await test.info().attach('引用拖拽进行中', { path, contentType: 'image/png' })
          }
        }
      }
      presentation = { caret: caretBox, ghostOpacity: internal ? await ghost.evaluate(element => getComputedStyle(element).opacity) : null }
    }
    if (ending === 'escape') await page.keyboard.press('Escape')
    if (ending === 'outside') await page.mouse.move(1, 1, { steps: 12 })
    if (ending !== 'drop') await expect(page.locator('.mention-input-drop-caret')).toBeHidden()
    await page.mouse.up(); pressed = false
  } finally {
    if (pressed) await page.mouse.up()
    trace = await page.evaluate(({ point, ending, presentation }) => {
      const state = window as Window & { __attachmentDragProbe?: NativeDragProbe }, probe = state.__attachmentDragProbe
      if (!probe) throw new Error('Native drag diagnostics were lost')
      const hit = document.elementFromPoint(point.x, point.y)
      const result: NativeDragTrace = { source: probe.source, target: point, targetElement: hit ? `${hit.tagName}.${hit.getAttribute('class') ?? ''}` : '',
        events: probe.events, checkpoints: [...probe.checkpoints, { phase: 'after-drop', ...probe.snapshot() }], ending, presentation }
      probe.dispose(); delete state.__attachmentDragProbe
      return result
    }, { point: target, ending, presentation })
    dragTraces.push(trace)
  }
  const starts = trace.events.filter(event => event.type === 'dragstart'), drops = trace.events.filter(event => event.type === 'drop')
  expect(starts, JSON.stringify(trace)).toHaveLength(1)
  expect(drops, JSON.stringify(trace)).toHaveLength(ending === 'drop' ? 1 : 0)
  expect(starts[0].trusted).toBe(true)
  expect(trace.events.some(event => event.type === 'dragend' && event.trusted), JSON.stringify(trace)).toBe(true)
  await expect(page.locator('.mention-input-drop-caret')).toBeHidden()
  await expect(page.locator('.mention-chip-drag-preview')).toHaveCount(0)
  if (ending === 'drop') expect(drops[0].trusted).toBe(true)
  if (trace.source.chipKey) {
    expect(starts[0].types).toContain(ATTACHMENT_CHIP_DRAG_TYPE)
    expect(JSON.parse(starts[0].chipPayload)).toMatchObject({ key: trace.source.chipKey })
    if (ending === 'drop') {
      expect(drops[0].types).toContain(ATTACHMENT_CHIP_DRAG_TYPE)
      expect(drops[0].prevented).toBe(true)
    }
    expect(trace.checkpoints.filter(value => value.phase !== 'after-drop').map(value => [value.phase, value.sourceChipSelected])).toEqual([
      ['pointer-down', false], ['drag-started', false], ['before-drop', false]
    ])
    expect(starts[0].sourceChipSelected).toBe(false)
  }
  if (target.boundary && ending === 'drop') {
    const { mode, mentionKeys, proseBefore } = target.boundary
    // Compare the committed document with the same visible boundary; a caret
    // painted at the pointer must not hide insertion at the previous selection.
    await expect.poll(() => composer(mode).evaluate((box, { key, previous }) => {
      const nodes = [...box.querySelectorAll<HTMLElement>('[data-mention-key]')]
      const chip = nodes.find(node => key ? node.dataset.mentionKey === key : !previous.includes(node.dataset.mentionKey!))
      if (!chip) return null
      const before = document.createRange(); before.selectNodeContents(box); before.setEndBefore(chip)
      const content = before.cloneContents(); content.querySelectorAll('[data-mention-key]').forEach(node => node.remove())
      return (content.textContent ?? '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim()
    }, { key: trace!.source.chipKey, previous: mentionKeys })).toBe(proseBefore)
  }
  return trace
}
async function beforeChip(chip: Locator): Promise<string> {
  return chip.evaluate(element => { const box = element.closest('[role="textbox"]')!, range = document.createRange(); range.selectNodeContents(box); range.setEndBefore(element); return range.toString().replace(/\u200b/g, '').trim() })
}
async function expectNoReferenceUnderline(reference: Locator): Promise<void> {
  const styles = await reference.evaluate(element => {
    const label = element.querySelector('.mention-chip__label')!, after = getComputedStyle(element, '::after')
    return { chip: getComputedStyle(element).textDecorationLine, label: getComputedStyle(label).textDecorationLine,
      drawnLine: !['none', 'normal'].includes(after.content) && after.display !== 'none' && Number.parseFloat(after.height) > 0 }
  })
  expect(styles.chip).not.toContain('underline'); expect(styles.label).not.toContain('underline')
  expect(styles.drawnLine).toBe(false)
}

async function expectCompactMentionRows(picker: Locator, descriptions: boolean): Promise<void> {
  const rows = await picker.getByRole('option').evaluateAll(elements => elements.map(element => {
    const row = element.getBoundingClientRect(), name = element.querySelector('strong')!, description = element.querySelector('small')!
    const nameBox = name.getBoundingClientRect(), descriptionBox = description.getBoundingClientRect()
    const icon = element.querySelector('.mention-ref-picker__icon, .attachment-ref-picker__preview')!
    return { height: row.height, nameHeight: nameBox.height, nameWhiteSpace: getComputedStyle(name).whiteSpace,
      descriptionVisible: description.getClientRects().length > 0, verticalOffset: Math.abs(nameBox.top - descriptionBox.top),
      descriptionRight: descriptionBox.right, rowRight: row.right, iconWidth: icon.getBoundingClientRect().width,
      title: element.getAttribute('title') }
  }))
  expect(rows.length).toBeGreaterThan(0)
  for (const row of rows) {
    expect(row.height).toBeGreaterThanOrEqual(28); expect(row.height).toBeLessThanOrEqual(30)
    expect(row.nameHeight).toBeLessThanOrEqual(18); expect(row.nameWhiteSpace).toBe('nowrap')
    expect(row.iconWidth).toBe(16); expect(row.title).toBeTruthy()
    expect(row.descriptionVisible).toBe(descriptions)
    if (descriptions) { expect(row.verticalOffset).toBeLessThanOrEqual(1); expect(row.descriptionRight).toBeLessThanOrEqual(row.rowRight) }
  }
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
    clipboardSnapshot = await app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(),
      image: clipboard.readImage().isEmpty() ? null : clipboard.readImage().toDataURL() }))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const pngs = await page.evaluate(() => ['#d74343', '#285cdd'].map(color => {
      const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 60
      const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Fixture canvas missing')
      ctx.fillStyle = color; ctx.fillRect(0, 0, 80, 60); return canvas.toDataURL('image/png').split(',')[1]
    }))
    redPng = Buffer.from(pngs[0], 'base64'); bluePng = Buffer.from(pngs[1], 'base64')
  })
  test.beforeEach(() => { dragTraces.length = 0 })
  test.afterEach(async ({}, info) => {
    if (page && !page.isClosed()) {
      const path = info.outputPath('attachment-references.png'); await page.screenshot({ path, animations: 'disabled' })
      await info.attach('附件引用运行界面', { path, contentType: 'image/png' })
      if (info.status !== info.expectedStatus) await info.attach('editor-dom', { body: await page.locator('[contenteditable="true"][role="textbox"]:visible').evaluateAll(elements => elements.map(element => element.outerHTML).join('\n')), contentType: 'text/html' })
    }
    await info.attach('native-drag-events', { body: JSON.stringify(dragTraces, null, 2), contentType: 'application/json' })
    await info.attach('attachment-http-receipts', { body: JSON.stringify({ errors, chats, uploads: uploads.map(({ bytes, ...file }) => ({ ...file, bytes: bytes.length })) }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([])
  })
  test.afterAll(async () => {
    try {
      if (app && clipboardSnapshot) await app.evaluate(({ clipboard, nativeImage }, saved) => clipboard.write({ text: saved.text, html: saved.html, rtf: saved.rtf,
        ...(saved.image ? { image: nativeImage.createFromDataURL(saved.image) } : {}) }), clipboardSnapshot)
      await app?.close()
    } finally {
      server.closeAllConnections(); if (server.listening) await new Promise<void>(done => server.close(() => done()))
      if (fixture) { const target = resolve(fixture); if (dirname(target) !== fixtureRoot || !basename(target).startsWith('attachment-references-profile-')) throw new Error(`Unsafe fixture cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    }
  })

  test('Work：@ 单列分组、工具包键盘选择、正文保留与会话恢复', async ({}, info) => {
    await seed('work')
    const input = composer('work'), picker = page.locator('.mention-ref-picker:visible')
    const toolkits = input.locator('.mention-chip--toolkit')
    const beforeChats = chats.length
    await input.locator('xpath=ancestor::*[contains(@class, "input-composer")][1]').locator('input[type="file"]').setInputFiles([
      { name: 'grouped-menu-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('GROUPED_MENU_ATTACHMENT') }
    ])
    await expect(cards('work')).toHaveCount(1)
    await input.fill('@')
    await expect(picker.getByRole('listbox', { name: '选择引用或工具包' })).toHaveAttribute('aria-busy', 'false')
    await expect(picker.getByRole('tab')).toHaveCount(0)
    await expect(picker.getByRole('group')).toHaveCount(4)
    await expect(input).toBeFocused()
    await expectCompactMentionRows(picker, true)
    await picker.screenshot({ path: info.outputPath('mention-menu-compact.png'), animations: 'disabled' })
    await info.attach('mention-menu-compact', { path: info.outputPath('mention-menu-compact.png'), contentType: 'image/png' })
    // Exercise the menu's own responsive container without changing the user's app or settings.
    await picker.evaluate(element => { (element as HTMLElement).style.maxWidth = '260px' })
    await expectCompactMentionRows(picker, false)
    await picker.screenshot({ path: info.outputPath('mention-menu-narrow-260px.png'), animations: 'disabled' })
    await info.attach('mention-menu-narrow-260px', { path: info.outputPath('mention-menu-narrow-260px.png'), contentType: 'image/png' })
    await picker.evaluate(element => { (element as HTMLElement).style.removeProperty('max-width') })
    await expectCompactMentionRows(picker, true)
    const active = picker.locator('[role="option"][aria-selected="true"]')
    await page.keyboard.press('Home')
    await expect(active).toHaveCount(1); await expect(active).toHaveAttribute('data-attachment-id', /.+/)
    await page.keyboard.press('ArrowDown'); await expect(active).toHaveAttribute('data-reference-kind', 'file')
    await page.keyboard.press('ArrowDown'); await expect(active).toHaveAttribute('data-reference-kind', 'agent')
    await expect(active).toContainText('调研')
    await page.keyboard.press('End'); await expect(active).toHaveAttribute('data-toolkit-id', 'automation')
    await input.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })))
    await expect(picker).toBeVisible(); await expect(toolkits).toHaveCount(0)
    await page.keyboard.press('Escape'); await expect(picker).toHaveCount(0); await expect(input).toHaveText('@')
    expect(chats).toHaveLength(beforeChats)

    await input.fill('@工具包')
    await expect(picker.locator('[data-toolkit-id]')).toHaveCount(4)
    await expectCompactMentionRows(picker, true)
    await picker.screenshot({ path: info.outputPath('toolkit-catalogue-four-packages.png'), animations: 'disabled' })
    await info.attach('toolkit-catalogue-four-packages', { path: info.outputPath('toolkit-catalogue-four-packages.png'), contentType: 'image/png' })

    await input.fill('@agent 调研')
    await expect(picker.getByRole('option')).toHaveCount(1)
    await page.keyboard.press('Tab')
    await expect(input.locator('.mention-chip--agent')).toHaveCount(1)
    await expect(input.locator('.mention-chip--agent')).toHaveText('调研')
    await expect(picker).toHaveCount(0)

    await input.fill('BEFORE ')
    await insertReference('work', '附件1', true)
    await input.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' MIDDLE @Agent 管理 AFTER')
    const draftBefore = await savedDraft('work')
    await input.evaluate(box => {
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        const at = (node.textContent ?? '').indexOf('@Agent 管理')
        if (at < 0) continue
        const range = document.createRange(); range.setStart(node, at + '@Agent 管理'.length); range.collapse(true)
        ;(box as HTMLElement).focus()
        const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
        return
      }
      throw new Error('Missing middle mention query')
    })
    await expect(picker.getByRole('group', { name: '工具包' })).toBeVisible()
    await page.keyboard.press('End'); await page.keyboard.press('Enter')
    await expect(picker).toHaveCount(0); await expect(toolkits).toHaveCount(1); await expect(input).toBeFocused()
    await expect(toolkits).toContainText('Agent 管理')
    await expect(surface('work').locator('.work-resource-strip')).toHaveCount(0)
    await expect(input.locator('.mention-chip--agent')).toHaveCount(0)
    await expect.poll(async () => (await savedDraft('work')).mentions.filter(item => item.source === 'toolkit').length).toBe(1)
    const inlineDraft = await savedDraft('work')
    expect(inlineDraft.draft).toContain('MIDDLE @toolkit:agent-management')
    expect(inlineDraft.draft).toContain(' AFTER')
    expect(inlineDraft.mentions.filter(item => item.source !== 'toolkit')).toEqual(draftBefore.mentions)
    await expect(chips('work')).toHaveCount(1)
    await expect(input.locator('.mention-chip')).toHaveCount(2)
    await input.locator('xpath=ancestor::*[contains(@class, "input-composer")][1]').screenshot({ path: info.outputPath('toolkit-inline-composer.png') })
    await page.reload(); await expect(input).toBeVisible(); await expect(toolkits).toHaveCount(1)
    await expect.poll(async () => (await savedDraft('work')).draft).toBe(inlineDraft.draft)
    expect((await savedDraft('work')).mentions).toEqual(inlineDraft.mentions)

    await input.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' @Agent 管理')
    await expect(picker.locator('[data-toolkit-id="agent-management"]')).toHaveAttribute('data-toolkit-selected', 'true')
    await page.keyboard.press('Enter'); await expect(toolkits).toHaveCount(1)
    expect((await savedDraft('work')).draft).not.toContain('@Agent 管理')
    await surface('work').getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => chats.length).toBe(beforeChats + 1)
    expect(chats[beforeChats].toolkits).toEqual(['agent-management'])
    expect(chats[beforeChats].collaborators ?? []).toEqual([])
    expect(parseMentionContent(String(chats[beforeChats].message)).refs.filter(ref => ref.t === 'agent')).toEqual([])
    expect(parseMentionContent(String(chats[beforeChats].message)).refs.filter(ref => ref.t === 'toolkit')).toHaveLength(1)
    await expect(surface('work')).toContainText('REFERENCES_SENT_OK')
    await expect(input).toBeEmpty()
    await expect(surface('work').locator('.message__bubble-content .mention-chip--toolkit')).toHaveCount(1)
    await input.fill('@Agent 管理')
    await expect(picker.locator('[data-toolkit-id="agent-management"]')).toBeVisible()
    await page.keyboard.press('Enter'); await expect(toolkits).toHaveCount(1)
    await input.fill('TOOLKIT_REMOVED')
    await expect(toolkits).toHaveCount(0)
    await surface('work').getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => chats.length).toBe(beforeChats + 2)
    expect(chats[beforeChats + 1].toolkits).toEqual([])
    await expect(input).toBeEmpty()
    await page.reload(); await expect(input).toBeVisible(); await expect(toolkits).toHaveCount(0)
    await input.fill('@Agent 管理')
    await expect(picker.locator('[data-toolkit-id="agent-management"]')).toHaveAttribute('data-toolkit-selected', 'false')
    await picker.screenshot({ path: info.outputPath('grouped-toolkit-menu.png'), animations: 'disabled' })
    await info.attach('grouped-toolkit-menu', { path: info.outputPath('grouped-toolkit-menu.png'), contentType: 'image/png' })
    await page.keyboard.press('Escape')

    await input.fill('')
    const toolkitMessage = surface('work').getByRole('article', { name: '用户消息', exact: true })
      .filter({ has: page.locator('.mention-chip--toolkit') }).first()
    await toolkitMessage.getByRole('button', { name: '添加到对话', exact: true }).click()
    await expect(toolkits).toHaveCount(1)
    await input.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' 编辑旧消息 @Agent 管理')
    await expect(picker.locator('[data-toolkit-id="agent-management"]')).toHaveAttribute('data-toolkit-selected', 'false')
    // Re-selecting an existing historical chip is explicit opt-in, without duplicating the chip.
    await page.keyboard.press('Enter'); await expect(toolkits).toHaveCount(1)
    await surface('work').getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => chats.length).toBe(beforeChats + 3)
    expect(chats[beforeChats + 2].toolkits).toEqual(['agent-management'])
    expect(parseMentionContent(String(chats[beforeChats + 2].message)).refs.filter(ref => ref.t === 'toolkit')).toHaveLength(1)
  })

  test('Work：工具包目录继承多个选择，单项添加与移除保留其他包', async () => {
    await seed('work')
    sessionToolkits.set(workId, ['skill-management', 'knowledge-management'])
    await page.evaluate(({ key, workId }) => {
      const state = JSON.parse(localStorage.getItem(key)!)
      const task = state.tasks.find((item: { id: string }) => item.id === workId)
      if (task.resources) delete task.resources.toolkits
      localStorage.setItem(key, JSON.stringify(state))
    }, { key: storageKey, workId })
    await page.reload()
    const input = composer('work'), picker = page.locator('.mention-ref-picker:visible')
    await expect(input.locator('.mention-chip--toolkit')).toHaveCount(2)
    await input.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' @自动化')
    await expect(picker.locator('[data-toolkit-id="automation"]')).not.toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Enter')
    await expect(input.locator('.mention-chip--toolkit')).toHaveCount(3)
    await input.locator('.mention-chip--toolkit').filter({ hasText: '技能管理' }).evaluate(chip => {
      const range = document.createRange(); range.selectNode(chip)
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
    })
    await page.keyboard.press('Backspace')
    await expect(input.locator('.mention-chip--toolkit')).toHaveCount(2)
    const before = chats.length
    await surface('work').getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => chats.length).toBe(before + 1)
    expect(chats[before].toolkits).toEqual(['knowledge-management', 'automation'])
    expect(parseMentionContent(String(chats[before].message)).refs.filter(ref => ref.t === 'toolkit').map(ref => ref.p)).toEqual(['knowledge-management', 'automation'])
  })

  test('Work：工具包目录按引擎权限禁用，旧引擎不展示静态工具包', async () => {
    unavailableToolkits.add('skill-management')
    try {
      await seed('work')
      const input = composer('work'), picker = page.locator('.mention-ref-picker:visible')
      await input.fill('@技能管理')
      const option = picker.locator('[data-toolkit-id="skill-management"]')
      await expect(option).toHaveAttribute('aria-disabled', 'true')
      await expect(option).toHaveAttribute('title', /没有该工具包权限/)
      await page.keyboard.press('Enter')
      await expect(picker).toBeVisible()
      await expect(input.locator('.mention-chip--toolkit')).toHaveCount(0)
      await page.keyboard.press('Escape')
      toolkitDirectorySupported = false
      // A different engine has a new catalogue lifetime; do not reuse the still-closing popover's discovery.
      await page.reload(); await expect(input).toBeVisible()
      await input.fill('@工具包')
      await expect(picker.getByRole('listbox')).toHaveAttribute('aria-busy', 'false')
      await expect(picker.locator('[data-toolkit-id]')).toHaveCount(0)
      await expect(input.locator('.mention-chip--toolkit')).toHaveCount(0)
    } finally { unavailableToolkits.clear(); toolkitDirectorySupported = true }
  })

  test('Code：@ 单列分组使用同一键盘选择文件与 Agent', async () => {
    menuPreviewFiles = Array.from({ length: 4 }, (_, index) => `code-reference-preview-${index + 1}.txt`)
    try {
    await seed('code')
    const input = composer('code'), picker = page.locator('.mention-ref-picker:visible')
    await input.fill('@')
    await expect(picker.getByRole('listbox', { name: '选择引用或工具包' })).toHaveAttribute('aria-busy', 'false')
    await expect(picker.getByRole('tab')).toHaveCount(0)
    await expect(picker.getByRole('group', { name: '文件与目录' }).getByRole('option')).toHaveCount(3)
    await expect(picker.getByText('输入名称查找更多文件', { exact: true })).toBeVisible()
    await page.keyboard.press('Home'); await expect(picker.locator('[aria-selected="true"]')).toHaveAttribute('data-reference-kind', 'file')
    await page.keyboard.press('Enter'); await expect(input.locator('.mention-chip--file')).toHaveText(selectionFile)
    await input.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' @code-reference-preview-4')
    await expect(picker.getByRole('option')).toHaveCount(1)
    await page.keyboard.press('Enter'); await expect(input.locator('.mention-chip--file')).toHaveCount(2)
    await input.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' @agent 执行')
    await expect(picker.getByRole('option')).toHaveCount(1)
    await page.keyboard.press('Enter'); await expect(input.locator('.mention-chip--agent')).toHaveText('执行')
    await expect(input.locator('.mention-chip--file')).toHaveCount(2)
    await expect(picker).toHaveCount(0)
    } finally { menuPreviewFiles = [] }
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
    await expectNoReferenceUnderline(chips(mode, redId).first())
    await byId(redId).hover()
    await expect(byId(redId).locator('.attach-chip__reference')).toHaveCSS('opacity', '0')
    await page.mouse.move(0, 0)
    await expect(byId(redId).locator('.attach-chip__reference')).toHaveCSS('opacity', '1')
    await nativeDrag(byId(redId).locator('.attach-chip__image-btn'), async () => {
      const target = await byId(blueId).boundingBox(); if (!target) throw new Error('Missing second card')
      return { x: target.x + target.width - 3, y: target.y + 12 }
    })
    await expect.poll(() => cards(mode).evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.attachmentId))).toEqual([blueId, redId, textId])
    await expect(chips(mode, redId).locator('.mention-chip__label')).toHaveText(['图2', '图2'])
    await nativeDrag(byId(blueId).locator('.attach-chip__image-btn'), () => textPoint(mode, '中段'))
    await expect(chips(mode, blueId)).toHaveCount(1); await expect.poll(() => beforeChip(chips(mode, blueId))).toBe('开头')
    await expect(cards(mode)).toHaveCount(3); expect(uploads).toHaveLength(beforeUploads + 3)
    await nativeDrag(chips(mode, redId).first().locator('.mention-chip__label'), () => textPoint(mode, '开头'))
    await expect.poll(() => chips(mode).evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.attachmentId))).toEqual([redId, blueId, redId])
    await composer(mode).focus(); await page.keyboard.press('Control+Z')
    await expect.poll(() => chips(mode).evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.attachmentId))).toEqual([blueId, redId, redId])
    await page.keyboard.press('Control+Y')
    await expect.poll(() => chips(mode).evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.attachmentId))).toEqual([redId, blueId, redId])
    await nativeDrag(chips(mode, blueId).locator('.mention-chip__label'), () => textPoint(mode, '结尾'))
    await expect(chips(mode)).toHaveCount(3); await expect.poll(() => beforeChip(chips(mode, blueId))).toContain('中段')
    // Delete removes the focused occurrence without removing its underlying
    // attachment or other copies.
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
    await nativeDrag(cards(mode).locator('.attach-chip__image-btn'), () => textPoint(mode, '末尾'))
    await expect(chips(mode)).toHaveCount(1)
    await insertReference(mode, '图1')
    await expect(chips(mode)).toHaveCount(2)
    await cards(mode).getByRole('button', { name: '移除附件 single-reference.png', exact: true }).click()
    await expect(chips(mode)).toHaveCount(0); await expect(cards(mode)).toHaveCount(0)
    await expect(composer(mode)).toContainText('保留正文')
    await composer(mode).focus(); await page.keyboard.press('Control+z')
    await expect(chips(mode)).toHaveCount(0)
  })

  test('code：原生长文本转附件并插入原光标，完整字节与既有引用随发送保留', async () => {
    await seed('code')
    const input = composer('code'), label = '附件1'
    const longText = `CODE_PASTED_TEXT\n${Array.from({ length: 90 }, (_, index) => `第${index + 1}行：完整正文🙂，保留 Unicode 和空格。`).join('\n')}\nCODE_PASTED_TEXT_END`
    expect(Array.from(longText).length).toBeGreaterThan(1000)
    const beforeUploads = uploads.length, beforeChats = chats.length
    await input.locator('xpath=ancestor::*[contains(@class, "input-composer")][1]').locator('input[type="file"]').setInputFiles([
      { name: 'existing-paste-reference.txt', mimeType: 'text/plain', buffer: Buffer.from('EXISTING_ATTACHMENT_CONTENT') }
    ])
    await expect(cards('code')).toHaveCount(1)
    await expect.poll(() => uploads.length).toBe(beforeUploads + 1)
    await expect.poll(async () => (await savedDraft('code')).attachments?.length ?? 0).toBe(1)
    const file = (await savedDraft('code')).attachments![0]
    await input.fill('CODE_BEFORE_REFERENCE '); await insertReference('code', label)
    const reference = chips('code', file.attachmentId), suffix = ' CODE_PASTE_RIGHT'
    await input.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(` CODE_PASTE_LEFT ${suffix}`)
    await expect.poll(async () => (await savedDraft('code')).text?.endsWith(suffix)).toBe(true)
    const beforePaste = await savedDraft('code'), beforeText = beforePaste.text!
    expect(beforeText.endsWith(suffix)).toBe(true)
    expect(beforePaste.mentions.map(mention => [mention.attachmentId, mention.path, mention.displayText])).toEqual([[file.attachmentId, file.path, label]])
    // The right marker remains after the caret. Pasting at the end instead
    // would still show the whole text but lose the user's intended placement.
    for (let index = 0; index < suffix.length; index++) await page.keyboard.press('ArrowLeft')
    await app!.evaluate(({ clipboard }, text) => clipboard.writeText(text), longText)
    await page.keyboard.press('Control+V')
    await expect(cards('code')).toHaveCount(2); await expect(reference).toHaveCount(1)
    await expect(chips('code')).toHaveCount(2)
    await expect.poll(() => uploads.length).toBe(beforeUploads + 2)
    const uploaded = uploads[beforeUploads + 1]
    expect(uploaded.bytes.equals(Buffer.from(longText))).toBe(true)
    expect(uploaded.sessionId).toBe(codeId)
    await expect.poll(async () => (await savedDraft('code')).text?.includes(`@${uploaded.path}`)).toBe(true)
    const afterPaste = await savedDraft('code'), pasted = afterPaste.attachments!.find(item => item.path === uploaded.path)!
    expect(pasted).toBeDefined()
    const pastedLabel = '粘贴文本 · CODE_PASTED_TEXT', pastedReference = chips('code', pasted.attachmentId)
    await expect(pastedReference.locator('.mention-chip__label')).toHaveText(pastedLabel)
    const parts = afterPaste.text!.split(`@${pasted.path}`)
    expect(parts).toHaveLength(2); expect(parts[0]).toBe(beforeText.slice(0, -suffix.length))
    expect([suffix, ' ' + suffix]).toContain(parts[1])
    expect(afterPaste.text!.includes(longText)).toBe(false)
    expect(afterPaste.mentions.map(mention => [mention.attachmentId, mention.path, mention.displayText]))
      .toEqual([[file.attachmentId, file.path, label], [pasted.attachmentId, pasted.path, pastedLabel]])
    expect(chats).toHaveLength(beforeChats)
    // Ordinary edits around the new reference retain the complete attachment
    // identity through browser history, persistence and request serialization.
    await input.focus(); await page.keyboard.press('Control+End')
    await page.keyboard.press('Shift+Enter')
    // serializeNodes omits the empty trailing line until it contains prose.
    const beforeEdit = afterPaste.text!
    await expect.poll(async () => (await savedDraft('code')).text).toBe(beforeEdit)
    await page.keyboard.insertText('CODE_EDITED_IN_PLACE')
    const editedText = beforeEdit + '\nCODE_EDITED_IN_PLACE'
    await expect.poll(async () => (await savedDraft('code')).text).toBe(editedText)
    await page.keyboard.press('Control+Z')
    await expect.poll(async () => (await savedDraft('code')).text).toBe(beforeEdit)
    expect((await savedDraft('code')).mentions).toEqual(afterPaste.mentions)
    await page.keyboard.press('Control+Y')
    await expect.poll(async () => (await savedDraft('code')).text).toBe(editedText)
    await expect(reference.locator('.mention-chip__label')).toHaveText(label)

    await page.reload(); await expect(input).toBeVisible()
    await expect.poll(async () => (await savedDraft('code')).text).toBe(editedText)
    await expect(input).toContainText('CODE_EDITED_IN_PLACE')
    await expect(reference.locator('.mention-chip__label')).toHaveText(label)
    expect((await savedDraft('code')).mentions).toEqual(afterPaste.mentions)
    await expect(cards('code')).toHaveCount(2); await expect(pastedReference.locator('.mention-chip__label')).toHaveText(pastedLabel)
    const send = surface('code').getByRole('button', { name: '发送', exact: true })
    await expect(send).toBeEnabled(); await send.click()
    await expect.poll(() => chats.length).toBe(beforeChats + 1)
    await expect(surface('code').locator(`[data-message-id="${currentRun(codeId)!.assistantMessageId}"]`)).toContainText('REFERENCES_SENT_OK')
    const request = chats[beforeChats], sent = parseMentionContent(String(request.message))
    expect(request.sessionId).toBe(codeId)
    expect(String(request.message).includes(longText)).toBe(false)
    expect(sent.body).toContain('CODE_EDITED_IN_PLACE')
    expect(sent.body.startsWith('CODE_BEFORE_REFERENCE ')).toBe(true)
    expect(request.attachments).toEqual([expect.objectContaining({ name: file.path, type: file.type,
      attachmentId: file.attachmentId, displayName: file.name, referenceLabel: label }),
      expect.objectContaining({ name: pasted.path, type: uploaded.type, size: uploaded.bytes.length,
        attachmentId: pasted.attachmentId, displayName: pasted.name, referenceLabel: pastedLabel })])
    expect(sent.refs.map(ref => [ref.a, ref.p, ref.d])).toEqual([[file.attachmentId, file.path, label], [pasted.attachmentId, pasted.path, pastedLabel]])
    await expect(surface('code').locator('.message--user').getByRole('button', { name: `查看引用：${label}`, exact: true })).toHaveCount(1)
    await expect(input).toBeEmpty(); await expect(cards('code')).toHaveCount(0)
    await expect(surface('code').locator('.message--user').getByRole('button', { name: `查看引用：${pastedLabel}`, exact: true })).toHaveCount(1)
    expect(uploads).toHaveLength(beforeUploads + 2)
  })

  for (const mode of ['work', 'code'] as const) test(`${mode}：原生拖拽落点与取消清理，跨 Agent 和文件的正文仍可复制`, async () => {
    await seed(mode)
    const input = composer(mode), references = input.locator('[data-mention-key]')
    const picker = page.locator('.mention-ref-picker:visible')
    await input.fill('COPY_START ')
    await page.keyboard.press('Control+End'); await page.keyboard.insertText('@agent')
    await expect(picker.getByRole('group', { name: '协作 Agent', exact: true })).toBeVisible()
    await picker.getByRole('option').filter({ has: page.locator('strong', { hasText: /^执行$/ }) }).click()
    await expect(picker).toHaveCount(0)
    await input.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' BETWEEN @selection-guide')
    await expect(picker).toBeVisible()
    await expect(picker.getByRole('group', { name: '文件与目录', exact: true })).toBeVisible()
    await expect(picker.getByRole('option')).toHaveCount(1)
    await picker.getByRole('option').click()
    await expect(picker).toHaveCount(0)
    await input.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' COPY_END DROP_TARGET')
    await expect(references).toHaveCount(2)
    const agent = input.locator('.mention-chip--agent'), file = input.locator('.mention-chip--file')
    await expect(agent.locator('.mention-chip__label')).toHaveText('执行')
    await expect(file.locator('.mention-chip__label')).toHaveText(selectionFile)
    await expect(input.locator('.mention-chip--attachment')).toHaveCount(0)
    await expect.poll(async () => (await savedDraft(mode)).mentions.length).toBe(2)
    const original = (await savedDraft(mode)).mentions
    expect(original[0].path).toMatch(/^builtin-agent:executor:/)
    expect(original[1].path).toBe(selectionFile)
    const keys = await references.evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.mentionKey!))
    await expectNoReferenceUnderline(agent)
    await file.hover(); await expectNoReferenceUnderline(file)

    // Start from ordinary prose, not a chip. Native selection and clipboard
    // must keep both labels; permanently disabling chip selection loses them.
    await input.scrollIntoViewIfNeeded()
    const start = await textPoint(mode, 'COPY_START'), end = await textPoint(mode, 'COPY_END', 'end')
    await page.mouse.move(start.x, start.y); await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 20 }); await page.mouse.up()
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '')
    for (const text of ['COPY_START', '执行', 'BETWEEN', selectionFile, 'COPY_END']) expect(selected).toContain(text)
    await app!.evaluate(({ clipboard }) => clipboard.writeText('COPY_NOT_HANDLED'))
    await page.keyboard.press('Control+c')
    // Windows clipboard uses CRLF even when the browser Selection exposes LF.
    // Normalize only line endings so missing labels or whitespace still fail.
    await expect.poll(async () => (await app!.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n'))
      .toBe(selected.replace(/\r\n/g, '\n'))
    // Collapse this intentional range before starting the next pointer gesture.
    await page.keyboard.press('ArrowRight')
    const beforeCancelledDrag = await input.innerText()
    await nativeDrag(agent.locator('.mention-chip__label'), () => textPoint(mode, 'DROP_TARGET', 'end'), 'escape')
    await nativeDrag(file.locator('.mention-chip__label'), () => textPoint(mode, 'COPY_START'), 'outside')
    expect(await input.innerText()).toBe(beforeCancelledDrag)
    expect(await references.evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.mentionKey!))).toEqual(keys)
    expect((await savedDraft(mode)).mentions).toEqual(original)
    const movedAgent = await nativeDrag(agent.locator('.mention-chip__label'), () => textPoint(mode, 'DROP_TARGET', 'end'))
    expect(movedAgent.source.chipKey).toBe(keys[0])
    await expect.poll(() => references.evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.mentionKey!))).toEqual([keys[1], keys[0]])
    await expect.poll(async () => (await savedDraft(mode)).mentions.map(mention => mention.path)).toEqual([original[1].path, original[0].path])
    await expect(references).toHaveCount(2)
    expect((await input.innerText()).match(/执行/g)).toHaveLength(1)

    await input.focus(); await page.keyboard.press('Control+Z')
    await expect.poll(async () => (await savedDraft(mode)).mentions.map(mention => mention.path)).toEqual(original.map(mention => mention.path))
    await page.keyboard.press('Control+Y')
    await expect.poll(async () => (await savedDraft(mode)).mentions.map(mention => mention.path)).toEqual([original[1].path, original[0].path])
    // Undo/redo rebuilds DOM keys, so retain the new key when testing a file.
    const fileKeyBeforeDrag = await file.getAttribute('data-mention-key')
    const movedFile = await nativeDrag(file.locator('.mention-chip__label'), () => textPoint(mode, 'COPY_START'))
    expect(movedFile.source.chipKey).toBe(fileKeyBeforeDrag)
    await expect.poll(() => beforeChip(file)).toBe('')
    await expect(references).toHaveCount(2)
    expect((await input.innerText()).split(selectionFile)).toHaveLength(2)
    await expect.poll(async () => (await savedDraft(mode)).mentions.map(mention => mention.path).sort()).toEqual(original.map(mention => mention.path).sort())

    await input.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' EMPTY_LINE_ANCHOR')
    await page.keyboard.press('Shift+Enter'); await page.keyboard.press('Shift+Enter')
    const emptyLineFileKey = await file.getAttribute('data-mention-key')
    const emptyLineDrag = await nativeDrag(file.locator('.mention-chip__label'), () => emptyLinePoint(mode, 'EMPTY_LINE_ANCHOR'))
    await expect(file).toHaveAttribute('data-mention-key', emptyLineFileKey!)
    await expect(references).toHaveCount(2)
    await expectEmptyLineReference(mode, file, emptyLineDrag, selectionFile, 'EMPTY_LINE_ANCHOR')

    await input.locator('xpath=ancestor::*[contains(@class, "input-composer")][1]').locator('input[type="file"]').setInputFiles([
      { name: 'empty-line-reference.png', mimeType: 'image/png', buffer: redPng }
    ])
    await expect(cards(mode)).toHaveCount(1)
    await expect.poll(async () => (await savedDraft(mode)).attachments?.length ?? 0).toBe(1)
    const image = (await savedDraft(mode)).attachments![0]
    await input.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' CARD_EMPTY_LINE_ANCHOR')
    await page.keyboard.press('Shift+Enter'); await page.keyboard.press('Shift+Enter')
    const cardLineDrag = await nativeDrag(cards(mode).locator('.attach-chip__image-btn'), () => emptyLinePoint(mode, 'CARD_EMPTY_LINE_ANCHOR'))
    const imageReference = chips(mode, image.attachmentId)
    await expect(imageReference).toHaveCount(1); await expect(references).toHaveCount(3)
    await expectEmptyLineReference(mode, imageReference, cardLineDrag, image.path, 'CARD_EMPTY_LINE_ANCHOR')
  })
})
