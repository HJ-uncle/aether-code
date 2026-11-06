/** Real Electron + controlled HTTP/SSE: explicit process-file entries preserve
 * exact review IDs, conflicts and session guards. The default results workspace
 * does not promote receipts to deliveries; current-file and historical review
 * stay available, including image/PDF/Office previews and rollback side effects. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { EngineFileChange } from '../src/shared/ipc'
import type { RootRun } from '../src/shared/root-run'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'
import JSZip from 'jszip'
import { Workbook } from 'exceljs'
import pptxgen from 'pptxgenjs'
import { PDFDocument, StandardFonts } from 'pdf-lib'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'work-change-review-fixture-token', model = 'work-change-review-model'
type Session = { id: string; title: string; workspaceRoot: string; run: RootRun; eventSeq: number; changes: EngineFileChange[]; files: Map<string, string>; readers: Set<ServerResponse> }
type Call = { method: string; path: string; sessionId: string; body: Record<string, unknown> }
const sessions = new Map<string, Session>(), calls: Call[] = [], errors: string[] = [], conflicts = new Set<string>()
const fileReads: Array<{ sessionId: string; path: string }> = []
const delayedChanges = new Set<string>()
const netExcludedChanges = new Set<string>()
const binaryFiles = new Map<string, Buffer>()
let app: ElectronApplication | undefined, page: Page, health: ElectronHealthMonitor | undefined
let fixture = '', source = '', scenario = 0
let revertResponseGate: Promise<void> | undefined, revertResponses = 0
let releaseRevertResponse = (): void => {}
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const active = (session?: Session): boolean => session?.run.status === 'running'
const idsOf = (change: EngineFileChange): string[] => change.changeIds ?? [change.id]
function history(session?: Session): EngineHistoryRow[] {
  if (!session) return []
  // Later cases append ledger-only versions; these four original writes are
  // the durable process entries used to enter review throughout the suite.
  const operations: EngineHistoryRow[] = session.changes.slice(0, 4).flatMap((change, index) => [
    { id: index === 0 ? session.run.assistantMessageId : `assistant-${change.id}`, role: 'assistant',
      content: index === 0 ? '正在整理文件改动。' : '', conversationId: session.run.turnId,
      createdAt: session.run.createdAt + index * 2 + 1, metadata: { rootRunId: session.run.runId },
      toolCall: { id: `write-${change.id}`, name: 'write_file', args: { path: change.path, content: change.newContent ?? '' } } },
    { id: `receipt-${change.id}`, role: 'tool', toolCallId: `write-${change.id}`, content: `已处理 ${basename(change.path)}`,
      conversationId: session.run.turnId, createdAt: session.run.createdAt + index * 2 + 2,
      metadata: { rootRunId: session.run.runId, success: true, changes: [structuredClone(change)] } }
  ])
  return [
    { id: session.run.userMessageId, role: 'user', content: `检查 ${session.title} 的文件改动`, conversationId: session.run.turnId,
      createdAt: session.run.createdAt, metadata: { rootRunId: session.run.runId } },
    ...operations,
    { id: `completion-${session.id}`, role: 'assistant', content: `${session.title} 的改动已生成，请确认。`, conversationId: session.run.turnId,
      createdAt: session.run.createdAt + operations.length + 1, metadata: { rootRunId: session.run.runId } }
  ]
}
function snapshot(id: string) {
  const session = sessions.get(id)
  return { schemaVersion: 1, sessionId: id, source: active(session) ? 'live' : 'persisted', finished: !active(session),
    eventId: session ? `${session.run.runId}:${session.eventSeq}` : null, run: session?.run,
    runs: session ? [session.run] : [], history: history(session), projection: [], todos: [], changes: [], commandJobs: [] }
}
function finish(session: Session): void {
  // Root sequence identifies its order in the session; only the transport
  // cursor and observation version advance when that same root completes.
  session.eventSeq++
  session.run = { ...session.run, status: 'succeeded', version: session.run.version + 1,
    updatedAt: Date.now(), finishedAt: Date.now() }
  for (const response of session.readers) {
    response.write(`id: ${session.run.runId}:${session.eventSeq}\ndata: ${JSON.stringify({ run: session.run })}\n\n`)
    response.end('data: [DONE]\n\n')
  }
}
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, method = request.method ?? 'GET'
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) { response.writeHead(401).end(); return }
    let raw = ''; for await (const chunk of request) raw += String(chunk)
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    const id = String(body.sessionId ?? url.searchParams.get('sessionId') ?? ''), session = sessions.get(id)
    if (method !== 'GET') calls.push({ method, path, sessionId: id, body: structuredClone(body) })
    if (path === '/api/v1/chat' && method === 'POST') throw new Error('Reviewing seeded changes must not start a new task')
    if (path === '/api/v1/chat/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (session && active(session)) {
        response.write(': connected\n\n'); session.readers.add(response)
        response.on('close', () => session.readers.delete(response))
      } else response.end('data: [DONE]\n\n')
      return
    }
    response.setHeader('content-type', 'application/json')
    if (path === '/api/v1/conversation/display') {
      const rows = history(session), users = rows.filter(row => row.role === 'user')
      response.end(envelope({ schemaVersion: 1, grouping: 'root',
        turns: users.map(row => ({ userMessageId: row.id, conversationId: row.conversationId, preview: String(row.content), createdAt: row.createdAt })),
        messages: rows, loadedTurnIds: users.map(row => row.id), revision: `${id}:review`,
        mutationRevision: `${id}:unchanged`, backend: 'jsonl', completeness: 'complete' })); return
    }
    if (path === '/api/v1/chat/admission/context') {
      response.end(envelope({ protocolVersion: 1, tenantId: 'fixture', sessionId: id,
        namespace: { id: 'work-change-review-db', generation: 'one' },
        transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'general' ? 'general' : 'code', runLifetime: 'durable', subagentProtocol: 2 },
        root: null, predecessor: null })); return
    }
    if (path === '/api/v1/workspace/file/content' || path === '/api/v1/workspace/file/info') {
      const relative = url.searchParams.get('path') ?? '', content = session?.files.get(relative)
      const binary = binaryFiles.get(`${id}:${relative}`)
      if (path.endsWith('/content')) fileReads.push({ sessionId: id, path: relative })
      if (content === undefined && !binary) { response.writeHead(404).end(JSON.stringify({ code: 404, message: '测试文件不存在' })); return }
      const size = binary?.length ?? Buffer.byteLength(content ?? '')
      response.end(envelope(path.endsWith('/content') ? { content: binary ? binary.toString('base64') : content, isBinary: Boolean(binary), totalSize: size }
        : { workspacePath: `${session?.workspaceRoot ?? '/remote/review'}/${relative}`, size, isDirectory: false, mtimeMs: 1 }))
      return
    }
    if ((path === '/api/v1/changes/keep-many' || path === '/api/v1/changes/revert-batch') && method === 'POST') {
      if (!session || !Array.isArray(body.ids) || body.ids.some(value => typeof value !== 'string')) throw new Error('Review request must contain a session and exact receipt IDs')
      const ids = body.ids as string[]
      if (new Set(ids).size !== ids.length) throw new Error('Review request contained duplicate IDs')
      const selected = ids.map(id => {
        const change = session.changes.find(change => idsOf(change).includes(id))
        if (!change) throw new Error(`Review request crossed the session boundary: ${id}`)
        return { id, change, initialStatus: change.status }
      })
      if (path === '/api/v1/changes/keep-many') {
        if (selected.some(({ change }) => change.status !== 'pending')) throw new Error('Keep request included an already handled receipt')
        for (const { change } of selected) change.status = 'kept'
        response.end(envelope({ kept: ids.length })); return
      }
      if (body.scope !== 'pending' && body.scope !== 'all') throw new Error('Revert request omitted its explicit scope')
      const results = selected.map(({ id, change, initialStatus }) => {
        if (conflicts.has(id)) return { id, path: change.path, status: 'conflict', message: '检测到后续手动修改，保留当前文件。' }
        const status = initialStatus === 'reverted' ? 'already_reverted' : 'reverted'
        change.status = 'reverted'
        if (status === 'reverted') {
          if (change.oldContent === null) session.files.delete(basename(change.path))
          else if (typeof change.oldContent === 'string') session.files.set(basename(change.path), change.oldContent)
        }
        return { id, path: change.path, status }
      })
      await revertResponseGate
      response.end(envelope({ results, total: ids.length, reverted: results.filter(item => item.status === 'reverted').length,
        conflicts: results.filter(item => item.status === 'conflict').length, unavailable: 0, failed: 0 }))
      revertResponses++
      return
    }
    if (path === '/api/v1/subagent/capabilities') { response.end(envelope({ schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true })); return }
    if (path === '/api/v1/subagent/runs') { response.end(envelope({ schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'fixture' })); return }
    if (path === '/api/v1/cron/capabilities') { response.writeHead(404).end(); return }
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: 'sha256:' + 'b'.repeat(64), protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'work-change-review' }
      : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '文件确认测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
      : path === '/api/v1/chat/snapshot' ? snapshot(id)
      : path === '/api/v1/chat/status' ? { run: session?.run, running: active(session), finished: !active(session) }
      : path === '/api/v1/chat/runs' ? { runs: session ? [session.run] : [] }
      : path === '/api/v1/conversation/history' ? history(session)
      : path === '/api/v1/conversation/sessions' ? [...sessions.values()].map(value => ({ sessionId: value.id, title: value.title, lastAt: value.run.updatedAt, messageCount: 2 }))
      : path === '/api/v1/changes' ? (session?.changes ?? []).filter(change => !delayedChanges.has(change.id) &&
        (url.searchParams.get('view') !== 'net' || !netExcludedChanges.has(change.id)) && (!url.searchParams.has('status') || change.status === url.searchParams.get('status')))
      : path === '/api/v1/command-jobs' ? { jobs: [] }
      : path === '/api/v1/security/mode' ? { sessionId: id, mode: 'standard' }
      : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, durableQueueReceipts: false, receiptPagination: false,
        runtimeCommunication: false, mailboxConsumer: false, userControllerMutation: false, rootUserControllerMutation: false }
      : path === '/api/v1/workspace/directory' ? { root: session?.workspaceRoot ?? '/remote/review', entries: [] }
      : []
    response.end(envelope(data))
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})

const work = () => page.locator('.work-view')
const panel = () => work().getByRole('region', { name: '本会话成果与改动', exact: true })
const batch = () => panel().getByRole('group', { name: '待确认改动操作', exact: true })
const detail = () => panel().locator('.work-session-artifacts__detail')
const files = () => panel().getByRole('treeitem').filter({ has: page.locator('.tree-row__name').filter({ hasText: /\.md$/ }) })
async function selectFile(name: string, view: 'pending' | 'history' | 'current' = 'history'): Promise<Locator> {
  await panel().getByRole('treeitem').filter({ has: page.getByText(name, { exact: true }) }).click()
  await selectView(view)
  await expect(detail().locator('.work-session-artifacts__file-header strong')).toHaveText(name)
  return detail()
}
async function selectView(view: 'pending' | 'history' | 'current'): Promise<void> {
  await panel().getByRole('button', { name: '差异范围', exact: true }).click()
  const label = view === 'pending' ? '待确认改动' : view === 'history' ? '修改记录' : '当前内容'
  await page.getByRole('menu', { name: '差异范围', exact: true }).getByRole('menuitem', { name: new RegExp(`^${label}`) }).click()
}
const reviewCalls = () => calls.filter(call => call.path.startsWith('/api/v1/changes/') || call.path === '/api/v1/chat')
const statusOf = (session: Session) => Object.fromEntries(session.changes.map(change => [change.id, change.status]))
async function settleDialog(accept = true): Promise<void> {
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await (accept ? dialog.locator('.btn--primary') : dialog.getByRole('button', { name: '取消', exact: true })).click()
  await expect(dialog).toHaveCount(0)
}
async function clickReview(target: Locator, name: string, accept = true): Promise<void> {
  await openReview(target, name)
  await settleDialog(accept)
}
async function openReview(target: Locator, name: string): Promise<void> {
  const menu = target.getByRole('button', { name: '批量改动操作', exact: true })
  if (await menu.count()) {
    await menu.click()
    await page.getByRole('menuitem', { name, exact: true }).click()
  } else await target.getByRole('button', { name, exact: true }).click()
}
function createSession(running = false, workspaceRoot = '/remote/review'): Session {
  const number = ++scenario, id = `work-change-review-${number}`, title = `文件确认任务 ${number}`, now = Date.now() - 5_000
  const run: RootRun = { schemaVersion: 1, runId: `run-${id}`, sessionId: id, turnId: `turn-${id}`,
    userMessageId: `user-${id}`, assistantMessageId: `assistant-${id}`, status: running ? 'running' : 'succeeded',
    seq: 1, version: 1, modelId: model, pending: [], workspacePaths: [], createdAt: now, updatedAt: now,
    ...(running ? {} : { finishedAt: now + 100 }) }
  const change = (name: string, status: EngineFileChange['status'], index: number): EngineFileChange => ({
    id: `${id}-${name}`, sessionId: id, runId: run.runId, turnId: run.turnId, path: `${workspaceRoot}/${name}.md`,
    kind: 'write', status, oldContent: `before ${name}\n`, newContent: `after ${name}\n`,
    oldHash: `old-${name}`, newHash: `new-${name}`, truncated: false, createdAt: now + index, seq: index
  })
  const draft = change('draft', 'pending', 1)
  draft.changeIds = [`${id}-draft-first`, draft.id]
  const session: Session = { id, title, workspaceRoot, run, eventSeq: 1, readers: new Set(), files: new Map(), changes: [draft,
    change('summary', 'pending', 2), change('accepted', 'kept', 3), change('restored', 'reverted', 4)] }
  for (const change of session.changes) session.files.set(basename(change.path), `CURRENT_FILE_${id}_${basename(change.path)}\n`)
  sessions.set(id, session)
  return session
}
function addBinary(session: Session, name: string, content: Buffer | null, patch: Partial<EngineFileChange> = {}): void {
  const change: EngineFileChange = { id: `${session.id}-${name}`, sessionId: session.id, turnId: session.run.turnId,
    path: `/remote/review/${name}`, kind: 'write', status: 'pending', oldContent: null, newContent: null,
    oldHash: 'missing', newHash: `binary-${name}`, isNew: true, truncated: true, createdAt: Date.now(), ...patch }
  session.changes.push(change)
  netExcludedChanges.add(change.id)
  if (content) binaryFiles.set(`${session.id}:${name}`, content)
}

async function officeFixtures(): Promise<Map<string, Buffer>> {
  const docx = new JSZip()
  docx.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  docx.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  docx.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>ArtifactWordMarker</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>')
  const workbook = new Workbook()
  workbook.addWorksheet('成果表格').addRow(['ArtifactSheetMarker', 42])
  const slides = new pptxgen()
  slides.layout = 'LAYOUT_WIDE'
  slides.addSlide().addText('ArtifactSlideMarker', { x: 1, y: 1, w: 7, h: 1, fontSize: 28 })
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage([612, 792]).drawText('ArtifactPdfMarker', { x: 48, y: 720, size: 20, font })
  return new Map([
    ['report.docx', await docx.generateAsync({ type: 'nodebuffer' })],
    ['budget.xlsx', Buffer.from(await workbook.xlsx.writeBuffer())],
    ['slides.pptx', Buffer.from(await slides.write({ outputType: 'nodebuffer' }) as Buffer)],
    ['report.pdf', Buffer.from(await pdf.save())]
  ])
}
async function openChanges(scope: 'session' | 'turn' = 'session'): Promise<void> {
  const message = work().locator('.work-message--assistant').first()
  const disclosure = message.locator('.work-message__process-toggle')
  if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click()
  const receipts = message.locator('.work-file-change-row')
  await expect(receipts).toHaveCount(4)
  await receipts.first().click()
  await expect(panel()).toBeVisible()
  if (scope === 'session') {
    // Existing review cases deliberately cover whole-session batches. The
    // explicit process receipt starts at its own turn, so choose that wider
    // scope explicitly instead of silently changing their review semantics.
    await panel().getByRole('button', { name: '文件改动轮次', exact: true }).click()
    await page.getByRole('menu', { name: '文件改动轮次', exact: true }).getByRole('menuitem', { name: /^整个会话/ }).click()
  }
  await expect(panel()).toHaveAttribute('aria-busy', 'false')
  await expect(files()).toHaveCount(4)
  await expect(work().getByRole('tab', { name: '改动', exact: true })).toHaveCount(0)
}
async function installScenario(running = false, workspaceRoot?: string): Promise<{ current: Session; other: Session }> {
  const current = createSession(running, workspaceRoot), other = createSession()
  const tasks = [current, other].map(session => ({ id: session.id, title: session.title, status: active(session) ? 'running' : 'done',
    draft: '保留未发送的草稿', createdAt: session.run.createdAt, updatedAt: session.run.updatedAt,
    workspacePath: null, modelId: model, attachments: [], sources: [] }))
  await page.evaluate(({ key, tasks, activeTaskId }) => localStorage.setItem(key, JSON.stringify({ tasks, activeTaskId })),
    { key: 'aether.work.state.v1:' + encodeURIComponent(source), tasks, activeTaskId: current.id })
  await page.reload()
  await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
  await expect(work().getByRole('heading', { name: current.title, exact: true })).toBeVisible()
  await expect(work().locator(`[data-message-id="${current.run.userMessageId}"]`)).toBeVisible()
  await expect(work().getByRole('region', { name: '最终交付物', exact: true })).toHaveCount(0)
  await openChanges()
  return { current, other }
}

test.describe('Work 文件改动确认', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`; source = engineStorageKey({ mode: 'remote', baseUrl: origin })
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'work-change-review-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin,
      autoStartEngine: true, lastModelId: model, appearance: 'light' }))
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', '--user-data-dir=' + fixture], cwd: root,
      env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    health = await monitorElectronHealth(app, 'work-change-review', [token])
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  })
  test.beforeEach(() => { calls.length = 0; errors.length = 0; fileReads.length = 0; conflicts.clear(); delayedChanges.clear(); netExcludedChanges.clear(); binaryFiles.clear(); revertResponseGate = undefined; revertResponses = 0 })
  test.afterEach(async () => {
    releaseRevertResponse()
    if (await page.getByRole('dialog').count()) await page.keyboard.press('Escape')
    for (const session of sessions.values()) {
      if (active(session)) finish(session)
      for (const response of session.readers) response.destroy()
    }
    health?.assertHealthy(); expect(errors).toEqual([])
  })
  test.afterAll(async ({}, info) => {
    try { if (health) await health.closeAndAssert(info); else await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('work-change-review-')) throw new Error(`Unsafe cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('成果树以服务端默认 Windows 工作区为根且保留工作区内部文件', async () => {
    const workspaceRoot = 'D:/dev/ai-agent-engine/.tmp/aether-code-dev/20261105/dist/workspace/default/work-home-artifact-root'
    const { current } = await installScenario(false, workspaceRoot)
    const tree = panel().getByRole('tree', { name: '本会话文件树', exact: true })
    await expect(tree.getByRole('treeitem')).toHaveCount(4)
    await expect(tree.locator('[role="treeitem"][aria-level="1"]')).toHaveCount(4)
    await expect(tree.locator('[role="treeitem"][aria-expanded]')).toHaveCount(0)
    await selectFile('draft.md')
    await expect(detail().locator('.work-session-artifacts__file-header > div > span')).toHaveText('draft.md')
    await selectView('current')
    await expect.poll(() => fileReads.some(read => read.sessionId === current.id && read.path === 'draft.md')).toBe(true)

    const relative = '.ae/tmp/file-writes/proof.md'
    current.changes.push({ ...current.changes[0], id: `${current.id}-internal-proof`, changeIds: undefined,
      path: `${workspaceRoot}/${relative}`, seq: 5 })
    current.files.set(relative, 'INTERNAL_WORKSPACE_FILE\n')
    await panel().getByRole('button', { name: '刷新', exact: true }).click()
    const internal = tree.getByRole('treeitem').filter({ has: page.locator('.tree-row__name').getByText('proof.md', { exact: true }) })
    await expect(internal).toBeVisible()
    await expect(internal).toHaveAttribute('aria-level', '4')
    await internal.click()
    await expect(detail().locator('.work-session-artifacts__file-header > div > span')).toHaveText(relative)
    await expect(tree.locator('.tree-row__name').getByText('D:', { exact: true })).toHaveCount(0)
    expect(calls.filter(call => call.path === '/api/v1/workspace/bind')).toEqual([])
  })

  test('取消不写入，单项保留发送本会话完整改动链并刷新状态', async () => {
    const { current, other } = await installScenario(), originalOther = statusOf(other)
    await clickReview((await selectFile('draft.md')), '保留此改动', false)
    expect(reviewCalls()).toEqual([])
    await (await selectFile('draft.md')).getByRole('button', { name: '保留此改动', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('1 个文件的 2 处改动')
    await expect(page.getByRole('dialog')).toContainText('/remote/review/draft.md')
    await settleDialog()
    await expect.poll(() => reviewCalls()).toEqual([{ method: 'POST', path: '/api/v1/changes/keep-many', sessionId: current.id,
      body: { sessionId: current.id, ids: [`${current.id}-draft-first`, `${current.id}-draft`] } }])
    await expect((await selectFile('draft.md')).getByRole('button', { name: '保留此改动', exact: true })).toHaveCount(0)
    await expect((await selectFile('draft.md')).getByRole('button', { name: '撤回此改动', exact: true })).toBeEnabled()
    await expect(batch()).toContainText('1 条修改待确认')
    expect(statusOf(current)).toEqual({ [`${current.id}-draft`]: 'kept', [`${current.id}-summary`]: 'pending',
      [`${current.id}-accepted`]: 'kept', [`${current.id}-restored`]: 'reverted' })
    expect(statusOf(other)).toEqual(originalOther)
    await page.reload(); await openChanges()
    await expect((await selectFile('draft.md')).getByRole('button', { name: '保留此改动', exact: true })).toHaveCount(0)
  })

  test('批量保留只发送待确认IDs，已保留和已撤回记录仍可查看', async () => {
    const { current } = await installScenario()
    await expect(batch()).toContainText('3 条修改待确认')
    await clickReview(batch(), '保留待确认改动')
    await expect.poll(() => reviewCalls().length).toBe(1)
    const call = reviewCalls()[0]
    expect(call).toMatchObject({ method: 'POST', path: '/api/v1/changes/keep-many', sessionId: current.id })
    expect(call.body).toEqual({ sessionId: current.id, ids: expect.arrayContaining([`${current.id}-draft-first`, `${current.id}-draft`, `${current.id}-summary`]) })
    expect(call.body.ids).toHaveLength(3)
    await expect(batch().getByRole('button', { name: '批量改动操作', exact: true })).toHaveCount(0)
    await expect(files()).toHaveCount(4)
    await expect((await selectFile('accepted.md')).getByRole('button', { name: '撤回此改动', exact: true })).toBeEnabled()
    await expect((await selectFile('restored.md')).getByRole('button', { name: '撤回此改动', exact: true })).toHaveCount(0)
    expect(current.changes.map(change => change.status)).toEqual(['kept', 'kept', 'kept', 'reverted'])
  })

  test('批量撤回显示部分冲突的逐文件结果，未恢复文件仍待确认', async ({}, info) => {
    const { current, other } = await installScenario(), originalOther = statusOf(other)
    conflicts.add(`${current.id}-summary`)
    await clickReview(batch(), '撤回待确认改动')
    await expect.poll(() => reviewCalls().length).toBe(1)
    expect(reviewCalls()[0]).toMatchObject({ method: 'POST', path: '/api/v1/changes/revert-batch', sessionId: current.id,
      body: { sessionId: current.id, scope: 'pending' } })
    expect(reviewCalls()[0].body.ids).toEqual(expect.arrayContaining([`${current.id}-draft-first`, `${current.id}-draft`, `${current.id}-summary`]))
    expect(reviewCalls()[0].body.ids).toHaveLength(3)
    const report = panel().getByRole('region', { name: '文件回退结果', exact: true })
    await expect(report).toContainText('已撤回 1 个文件（2 处改动）；版本冲突 1 处')
    await expect(report).toContainText('部分改动未恢复，文件和对话历史已保留')
    await expect(report.locator('details')).toHaveAttribute('open', '')
    await expect(report).toContainText('/remote/review/draft.md')
    await expect(report).toContainText('/remote/review/summary.md')
    await expect(report).toContainText('检测到后续手动修改，保留当前文件。')
    await expect(batch()).toContainText('1 条修改待确认')
    await expect((await selectFile('summary.md')).getByRole('button', { name: '保留此改动', exact: true })).toBeEnabled()
    await expect((await selectFile('draft.md')).getByRole('button', { name: '撤回此改动', exact: true })).toHaveCount(0)
    expect(current.changes.map(change => change.status)).toEqual(['reverted', 'pending', 'kept', 'reverted'])
    expect(statusOf(other)).toEqual(originalOther)
    await page.screenshot({ path: info.outputPath('work-review-partial-conflict.png'), animations: 'disabled' })
    await report.getByRole('button', { name: '关闭结果', exact: true }).click()
    await expect(report).toHaveCount(0)
  })

  test('已保留记录可单项显式撤回，scope all 不扩展到其他记录', async () => {
    const { current } = await installScenario()
    await clickReview((await selectFile('accepted.md')), '撤回此改动')
    await expect.poll(() => reviewCalls()).toEqual([{ method: 'POST', path: '/api/v1/changes/revert-batch', sessionId: current.id,
      body: { sessionId: current.id, ids: [`${current.id}-accepted`], scope: 'all' } }])
    await expect((await selectFile('accepted.md')).getByRole('button', { name: '撤回此改动', exact: true })).toHaveCount(0)
    await expect(batch()).toContainText('3 条修改待确认')
    expect(current.changes.map(change => change.status)).toEqual(['pending', 'pending', 'reverted', 'reverted'])
  })

  test('撤回响应期间切换任务，返回原任务仍可查看完整冲突报告', async () => {
    const { current, other } = await installScenario(), originalOther = statusOf(other)
    conflicts.add(`${current.id}-summary`)
    revertResponseGate = new Promise<void>(resolve => { releaseRevertResponse = resolve })
    await clickReview(batch(), '撤回待确认改动')
    await expect.poll(() => reviewCalls().length).toBe(1)
    expect(revertResponses).toBe(0)
    await work().locator('.work-sidebar__task').filter({ hasText: other.title }).click()
    await expect(work().getByRole('heading', { name: other.title, exact: true })).toBeVisible()
    await openChanges()
    const report = panel().getByRole('region', { name: '文件回退结果', exact: true })
    await expect(report).toHaveCount(0)
    releaseRevertResponse()
    await expect.poll(() => revertResponses).toBe(1)
    await expect(report).toHaveCount(0)
    expect(statusOf(other)).toEqual(originalOther)
    await work().locator('.work-sidebar__task').filter({ hasText: current.title }).click()
    await expect(work().getByRole('heading', { name: current.title, exact: true })).toBeVisible()
    await openChanges()
    await expect(report).toContainText('已撤回 1 个文件（2 处改动）；版本冲突 1 处')
    await expect(report).toContainText('/remote/review/draft.md')
    await expect(report).toContainText('/remote/review/summary.md')
    await expect(report).toContainText('检测到后续手动修改，保留当前文件。')
    await expect(report.locator('details')).toHaveAttribute('open', '')
    await expect(batch()).toContainText('1 条修改待确认')
    expect(current.changes.map(change => change.status)).toEqual(['reverted', 'pending', 'kept', 'reverted'])
    expect(reviewCalls()).toHaveLength(1)
    expect(reviewCalls()[0]).toMatchObject({ method: 'POST', path: '/api/v1/changes/revert-batch',
      sessionId: current.id, body: { sessionId: current.id, scope: 'pending' } })
  })

  test('任务运行中所有保留和撤回按钮禁用，完成后恢复操作', async () => {
    const { current } = await installScenario(true)
    await expect(work().locator('.work-task-heading').getByRole('button', { name: '停止任务', exact: true })).toBeVisible()
    await expect(batch().getByRole('button', { name: '批量改动操作', exact: true })).toBeDisabled()
    for (const name of ['draft.md', 'summary.md', 'accepted.md']) {
      const file = await selectFile(name)
      const buttons = file.getByRole('button', { name: /^(保留|撤回)此改动$/ })
      await expect(buttons).toHaveCount(name === 'accepted.md' ? 1 : 2)
      for (const button of await buttons.all()) await expect(button).toBeDisabled()
    }
    await expect(panel()).toContainText('任务结束后可确认')
    expect(reviewCalls()).toEqual([])
    await expect.poll(() => current.readers.size).toBeGreaterThan(0)
    finish(current)
    await expect(work().getByRole('button', { name: '停止任务', exact: true })).toHaveCount(0)
    await expect(batch().getByRole('button', { name: '批量改动操作', exact: true })).toBeEnabled()
    await clickReview((await selectFile('summary.md')), '保留此改动')
    await expect.poll(() => reviewCalls().map(call => call.body)).toEqual([{ sessionId: current.id, ids: [`${current.id}-summary`] }])
  })

  test('确认弹窗未关闭时切换会话，旧确认不能修改任一会话', async () => {
    for (const action of ['保留待确认改动', '撤回待确认改动']) {
      const { current, other } = await installScenario(), beforeCurrent = statusOf(current), beforeOther = statusOf(other)
      const count = reviewCalls().length
      await openReview(batch(), action)
      await expect(page.getByRole('dialog')).toBeVisible()
      // Simulate navigation delivered while a confirmation is outstanding. The
      // real sidebar handler runs without dismissing the modal through its scrim.
      await work().locator('.work-sidebar__task').filter({ hasText: other.title }).dispatchEvent('click')
      await expect(work().getByRole('heading', { name: other.title, exact: true })).toBeVisible()
      await settleDialog()
      await openChanges()
      await expect(batch().getByRole('button', { name: '批量改动操作', exact: true })).toBeEnabled()
      expect(reviewCalls()).toHaveLength(count)
      expect(statusOf(current)).toEqual(beforeCurrent); expect(statusOf(other)).toEqual(beforeOther)
      // A succeeding operation proves the stale request has settled and cannot
      // later sneak into the destination session or leave its controls locked.
      await clickReview((await selectFile('summary.md')), '保留此改动')
      await expect.poll(() => reviewCalls().length).toBe(count + 1)
      expect(reviewCalls().at(-1)?.body).toEqual({ sessionId: other.id, ids: [`${other.id}-summary`] })
      expect(statusOf(current)).toEqual(beforeCurrent)
    }
  })

  test('过程文件入口恢复所属轮次并清除搜索，旧会话默认成果恢复持久文件记录', async () => {
    const { current } = await installScenario()
    await expect(panel().locator('.work-session-artifacts__turn')).toHaveAttribute('data-turn-scope', 'session')
    const search = panel().getByRole('searchbox', { name: '搜索当前范围文件', exact: true })
    await search.fill('summary.md')
    await expect(files()).toHaveCount(1)
    await openChanges('turn')
    await expect(search).toHaveValue('')
    await expect(panel().locator('.work-session-artifacts__turn')).toHaveAttribute('data-turn-scope', `turn:${current.run.turnId}`)
    await work().getByRole('button', { name: '更多工作区', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: '改动', exact: true })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: '成果', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.evaluate(() => localStorage.setItem('aether.work.view.v1', JSON.stringify({
      page: 'artifacts', workspace: true, tab: 'changes', pane: 'workspace', ratio: 56
    })))
    await page.reload()
    const navigation = work().locator('.work-navigation')
    await expect(navigation.getByRole('button', { name: '成果', exact: true })).toHaveCount(0)
    await expect(navigation.getByRole('button', { name: '工作台', exact: true })).toHaveAttribute('aria-current', 'page')
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('aether.work.view.v1') || '{}').page)).toBe('home')
    await expect(work().getByRole('tab', { name: '成果', exact: true })).toHaveAttribute('aria-selected', 'true')
    const results = work().getByRole('region', { name: '本会话成果', exact: true })
    await expect(results).toBeVisible()
    await expect(results).toHaveAttribute('data-final-result-fallback', 'changes')
    await expect(results.getByRole('region', { name: '交付物预览', exact: true })).toHaveCount(0)
    await expect(panel()).toBeVisible()
    await expect(files()).toHaveCount(4)
    await expect(work().getByRole('tab', { name: '改动', exact: true })).toHaveCount(0)
    await openChanges()
    await expect(files()).toHaveCount(4)
    expect(reviewCalls()).toEqual([])
  })

  test('过程文件当前内容读真实文件，复制与显式刷新不使用历史快照', async ({}, info) => {
    const { current, other } = await installScenario()
    await selectFile('draft.md', 'current')
    const preview = panel().locator('[data-artifact-view="current"]')
    const original = current.files.get('draft.md')!
    await expect(preview).toContainText(original.trim())
    await expect(preview).not.toContainText('after draft')
    await expect(detail().getByRole('button', { name: '保留此改动', exact: true })).toHaveCount(0)
    await expect(detail().getByRole('button', { name: '撤回此改动', exact: true })).toHaveCount(0)
    await preview.getByRole('button', { name: '复制', exact: true }).click()
    await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText().replace(/\r\n/g, '\n'))).toBe(original)
    const savedPath = join(fixture, 'preview-copy.md')
    await app!.evaluate(({ session }, path) => {
      session.defaultSession.once('will-download', (_event, item) => item.setSavePath(path))
    }, savedPath)
    await preview.getByRole('button', { name: '保存副本', exact: true }).click()
    await expect.poll(() => existsSync(savedPath) ? readFileSync(savedPath, 'utf8') : null).toBe(original)
    current.files.set('draft.md', 'CURRENT_FILE_AFTER_MANUAL_EDIT\n')
    await preview.getByRole('button', { name: '刷新成果预览', exact: true }).click()
    await expect(preview).toContainText('CURRENT_FILE_AFTER_MANUAL_EDIT')
    await expect(preview).not.toContainText(original.trim())
    expect(fileReads.filter(read => read.path === 'draft.md')).toEqual([
      { sessionId: current.id, path: 'draft.md' }, { sessionId: current.id, path: 'draft.md' }
    ])
    expect(fileReads.some(read => read.sessionId === other.id)).toBe(false)
    await preview.getByRole('button', { name: '添加到对话', exact: true }).click()
    await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toContainText('draft.md')
    for (const appearance of ['light', 'dark'] as const) {
      await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await settings.getByRole('tab', { name: '外观', exact: true }).click()
      await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
      await settings.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(page.locator('.work-settings-dialog')).toHaveCount(0)
      for (const width of [1440, 680]) {
        await app!.evaluate(({ BrowserWindow }, width) => {
          const window = BrowserWindow.getAllWindows()[0]
          window.setMinimumSize(600, 600)
          window.setSize(width, 1000)
        }, width)
        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(width)
        const workspaceTab = work().locator('.work-mobile-tabs').getByRole('button', { name: /^工作区/ })
        if (await workspaceTab.isVisible()) await workspaceTab.click()
        const toolbar = preview.getByRole('group', { name: '文件预览操作', exact: true })
        await expect(toolbar).toBeVisible()
        await expect.poll(() => toolbar.evaluate(element => {
          const bounds = element.getBoundingClientRect()
          return { overflow: element.scrollWidth > element.clientWidth + 1, compact: bounds.height <= 40,
            contained: [...element.querySelectorAll('button')].every(button => {
              const rect = button.getBoundingClientRect()
              return rect.left >= bounds.left && rect.right <= bounds.right + 1
                && rect.top >= bounds.top && rect.bottom <= bounds.bottom + 1
            }) }
        }), { message: `预览工具栏 ${appearance}/${width} 保持单行且操作均可见` }).toEqual({ overflow: false, compact: true, contained: true })
        await preview.screenshot({ path: info.outputPath(`preview-toolbar-${appearance}-${width}.png`), animations: 'disabled' })
      }
    }
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000))
    await page.screenshot({ path: info.outputPath('unified-artifacts-current.png'), animations: 'disabled' })
    await selectView('history')
    await expect(detail().locator('.work-session-artifacts__diff')).toContainText('after draft')
    await expect(detail()).not.toContainText('CURRENT_FILE_AFTER_MANUAL_EDIT')
    expect(reviewCalls()).toEqual([])
    await page.screenshot({ path: info.outputPath('unified-artifacts-history.png'), animations: 'disabled' })
  })

  for (const destination of ['其他文件', '当前内容', '其他会话'] as const) test(`撤回较早记录时切到${destination}，原文件缓存仍更新且当前选择不被抢回`, async () => {
    const { current, other } = await installScenario()
    const otherBefore = { changes: statusOf(other), files: [...other.files] }
    const original = current.changes[0]
    const latest: EngineFileChange = { ...original, id: `${current.id}-draft-latest`, changeIds: undefined,
      status: 'reverted', seq: 5, createdAt: original.createdAt + 100, newHash: 'stable-latest-hash' }
    const latestBefore = structuredClone(latest)
    current.changes.push(latest)
    await panel().getByRole('button', { name: '刷新', exact: true }).click()
    await expect(panel()).toHaveAttribute('aria-busy', 'false')
    await selectFile('draft.md', 'current')
    const preview = panel().locator('[data-artifact-view="current"]')
    await expect(preview).toContainText(current.files.get('draft.md')!.trim())
    await selectView('history')
    await expect(detail().locator('.work-session-artifacts__diff')).toHaveAttribute('data-change-id', latest.id)
    await panel().getByRole('button', { name: '选择单次修改', exact: true }).click()
    await page.getByRole('menu', { name: '选择单次修改', exact: true }).getByRole('menuitem').filter({ hasText: '待确认' }).click()
    await expect(detail().locator('.work-session-artifacts__diff')).toHaveAttribute('data-change-id', original.id)
    revertResponseGate = new Promise<void>(resolve => { releaseRevertResponse = resolve })
    await clickReview(detail(), '撤回此改动')
    await expect.poll(() => reviewCalls().length).toBe(1)
    expect(revertResponses).toBe(0)
    if (destination === '其他文件') await selectFile('summary.md')
    else if (destination === '当前内容') await selectView('current')
    else {
      await work().locator('.work-sidebar__task').filter({ hasText: other.title }).click()
      await expect(work().getByRole('heading', { name: other.title, exact: true })).toBeVisible()
      await openChanges()
    }
    releaseRevertResponse()
    await expect.poll(() => revertResponses).toBe(1)
    if (destination === '其他文件') await expect(detail().locator('.work-session-artifacts__file-header strong')).toHaveText('summary.md')
    else if (destination === '其他会话') {
      await expect(work().getByRole('heading', { name: other.title, exact: true })).toBeVisible()
      await work().locator('.work-sidebar__task').filter({ hasText: current.title }).click()
      await expect(work().getByRole('heading', { name: current.title, exact: true })).toBeVisible()
      await openChanges()
    }
    if (destination !== '当前内容') await selectFile('draft.md', 'current')
    await expect(preview).toBeVisible()
    await expect(preview).toContainText('before draft')
    expect(current.changes.at(-1)).toEqual(latestBefore)
    expect(fileReads.filter(read => read.path === 'draft.md' && read.sessionId === current.id).length).toBeGreaterThanOrEqual(2)
    // Entering the other task may preview its first, already kept file. The
    // outstanding rollback must never reread or modify its same-named draft.
    expect(fileReads.filter(read => read.sessionId === other.id && read.path === 'draft.md')).toEqual([])
    expect({ changes: statusOf(other), files: [...other.files] }).toEqual(otherBefore)
    expect(reviewCalls()).toEqual([{ method: 'POST', path: '/api/v1/changes/revert-batch', sessionId: current.id,
      body: { sessionId: current.id, ids: [`${current.id}-draft-first`, original.id], scope: 'all' } }])
  })

  test('资源文件可回到已保留的修改记录，入口保持当前会话身份', async () => {
    const { current, other } = await installScenario()
    current.files.set('draft.md', `[检查已保留文件](/api/v1/workspace/file/download?sessionId=${current.id}&path=accepted.md)\n`)
    await selectFile('draft.md', 'current')
    await panel().locator('[data-artifact-view="current"]').getByRole('link', { name: '检查已保留文件', exact: true }).click()
    const resource = work().locator('.work-resource-file:visible')
    await expect(resource).toContainText(current.files.get('accepted.md')!.trim())
    await resource.getByRole('button', { name: '在成果中查看改动', exact: true }).click()
    const diff = panel().locator('.work-session-artifacts__diff')
    await expect(panel()).toBeVisible()
    await expect(diff).toHaveAttribute('data-change-id', `${current.id}-accepted`)
    await expect(diff).toHaveAttribute('data-diff-scope', 'operation')
    await expect(diff).toContainText('after accepted')
    await expect(detail().getByRole('button', { name: '撤回此改动', exact: true })).toBeEnabled()
    await expect(detail().getByRole('button', { name: '保留此改动', exact: true })).toHaveCount(0)
    expect(fileReads).toContainEqual({ sessionId: current.id, path: 'accepted.md' })
    expect(fileReads.some(read => read.sessionId === other.id)).toBe(false)
    expect(reviewCalls()).toEqual([])
  })

  test('搜索仍匹配当前文件及重复点击保留已选历史版本，换文件才恢复默认视图', async () => {
    const { current } = await installScenario()
    const original = current.changes[0]
    const latest = { ...original, id: `${current.id}-draft-latest`, changeIds: undefined, seq: 20, status: 'kept' as const, createdAt: Date.now() }
    current.changes.push(latest)
    await panel().getByRole('button', { name: '刷新', exact: true }).click()
    await selectFile('draft.md', 'history')
    await panel().getByRole('button', { name: '选择单次修改', exact: true }).click()
    await page.getByRole('menu', { name: '选择单次修改', exact: true }).getByRole('menuitem').filter({ hasText: '待确认' }).click()
    const diff = detail().locator('.work-session-artifacts__diff')
    await expect(diff).toHaveAttribute('data-change-id', original.id)
    await panel().getByRole('treeitem').filter({ has: page.getByText('draft.md', { exact: true }) }).click()
    await expect(diff).toHaveAttribute('data-change-id', original.id)
    const search = panel().getByRole('searchbox', { name: '搜索当前范围文件', exact: true })
    await search.fill('draft')
    await expect(diff).toHaveAttribute('data-change-id', original.id)
    await expect(diff).toHaveAttribute('data-diff-scope', 'operation')
    await search.fill('summary')
    await expect(detail().locator('.work-session-artifacts__file-header strong')).toHaveText('summary.md')
    await expect(diff).toHaveAttribute('data-diff-scope', 'net')
  })

  test('范围内新增后删除抵消，较早轮次创建的文件在本轮删除仍显示 D', async () => {
    const { current } = await installScenario()
    addBinary(current, 'temporary.png', null, { id: `${current.id}-temporary-create`, turnId: `${current.run.turnId}-earlier`, newHash: 'temporary-version', seq: 100 })
    addBinary(current, 'temporary.png', null, { id: `${current.id}-temporary-delete`, kind: 'delete', isNew: false, oldHash: 'temporary-version', newHash: 'missing', seq: 101 })
    addBinary(current, 'same-turn-temp.png', null, { id: `${current.id}-same-turn-create`, newHash: 'same-turn-version', seq: 103 })
    addBinary(current, 'same-turn-temp.png', null, { id: `${current.id}-same-turn-delete`, kind: 'delete', isNew: false, oldHash: 'same-turn-version', newHash: 'missing', seq: 104 })
    current.changes.push({ ...current.changes[0], id: `${current.id}-existing-delete`, path: '/remote/review/existing.md',
      kind: 'delete', changeIds: undefined, oldContent: 'Existing text\n', newContent: null, oldHash: 'existing-version', newHash: 'missing', seq: 102 })
    await panel().getByRole('button', { name: '刷新', exact: true }).click()
    const temporary = panel().getByRole('treeitem').filter({ has: page.getByText('temporary.png', { exact: true }) })
    const sameTurn = panel().getByRole('treeitem').filter({ has: page.getByText('same-turn-temp.png', { exact: true }) })
    const existing = panel().getByRole('treeitem').filter({ has: page.getByText('existing.md', { exact: true }) })
    await expect(existing.locator('[data-file-status]')).toHaveText('D')
    await expect(existing.locator('.work-session-artifacts__count')).toHaveCount(0)
    await expect(temporary).toHaveCount(0)
    await expect(sameTurn).toHaveCount(0)
    await expect(panel().locator('.work-session-artifacts__header')).toContainText('5 个涉及文件')
    await panel().getByRole('button', { name: '文件改动轮次', exact: true }).click()
    await page.getByRole('menu', { name: '文件改动轮次', exact: true }).getByRole('menuitem').filter({ hasText: current.title }).click()
    await expect(temporary).toBeVisible()
    await expect(temporary.locator('[data-file-status]')).toHaveText('D')
    await expect(sameTurn).toHaveCount(0)
    await expect(panel().locator('.work-session-artifacts__header')).toContainText('6 个涉及文件')
    await temporary.click()
    await expect(detail().locator('.work-session-artifacts__deleted')).toContainText('已删除')
    expect(fileReads.filter(read => read.path === 'temporary.png')).toEqual([])
  })

  test('图片显示 U M D，切换文件清除文本差异模式且历史预览明确读取当前版本', async () => {
    const { current, other } = await installScenario()
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64')
    addBinary(current, 'new-image.png', png)
    addBinary(current, 'changed-image.png', png, { isNew: false, oldHash: 'previous-image' })
    addBinary(current, 'deleted-image.png', null, { kind: 'delete', isNew: false, oldHash: 'deleted-image', newHash: 'missing' })
    await panel().getByRole('button', { name: '刷新', exact: true }).click()
    for (const [name, code] of [['new-image.png', 'U'], ['changed-image.png', 'M'], ['deleted-image.png', 'D']]) {
      const row = panel().getByRole('treeitem').filter({ has: page.getByText(name, { exact: true }) })
      await expect(row.locator('[data-file-status]')).toHaveText(code)
      await expect(row).not.toContainText('无法计算')
    }
    await selectFile('draft.md', 'pending')
    await panel().getByRole('treeitem').filter({ has: page.getByText('new-image.png', { exact: true }) }).click()
    await expect(panel().getByRole('button', { name: '差异范围', exact: true })).toContainText('当前内容')
    const preview = detail().locator('[data-artifact-view="current"]')
    const image = preview.getByRole('img', { name: 'new-image.png', exact: true })
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1)
    const zoom = preview.locator('.preview__zoom-value')
    const previousZoom = await zoom.textContent()
    await preview.getByRole('button', { name: '放大', exact: true }).click()
    await expect(zoom).not.toHaveText(previousZoom!)
    await selectView('history')
    await expect(detail()).toContainText('下方预览当前文件，不代表所选历史版本')
    await expect(preview).toHaveAttribute('data-preview-context', 'history')
    await expect(image).toBeVisible()
    await expect(detail().getByRole('button', { name: '保留此改动', exact: true })).toBeEnabled()
    await selectFile('deleted-image.png', 'history')
    await expect(detail().locator('.work-session-artifacts__deleted')).toContainText('已删除')
    await expect(preview).toHaveCount(0)
    await expect(detail().getByRole('button', { name: '打开当前文件', exact: true })).toHaveCount(0)
    expect(fileReads.filter(read => read.path === 'deleted-image.png')).toEqual([])
    await panel().getByRole('treeitem').filter({ has: page.getByText('draft.md', { exact: true }) }).click()
    await expect(panel().getByRole('button', { name: '差异范围', exact: true })).toContainText('待确认改动')
    await expect(detail().locator('.work-session-artifacts__diff')).toContainText('after draft')
    expect(fileReads).toContainEqual({ sessionId: current.id, path: 'new-image.png' })
    expect(fileReads.some(read => read.sessionId === other.id)).toBe(false)
    expect(reviewCalls()).toEqual([])
  })

  test('过程文件审核直接预览 PDF Word Excel PowerPoint，不需要切换到资源标签', async () => {
    test.setTimeout(120_000)
    const { current } = await installScenario()
    for (const [name, bytes] of await officeFixtures()) addBinary(current, name, bytes)
    await panel().getByRole('button', { name: '刷新', exact: true }).click()
    const preview = detail().locator('[data-artifact-view="current"]')
    for (const [name, kind, marker] of [
      ['report.docx', 'docx', 'ArtifactWordMarker'],
      ['budget.xlsx', 'xlsx', 'ArtifactSheetMarker'],
      ['slides.pptx', 'pptx', 'ArtifactSlideMarker'],
      ['report.pdf', 'pdf', 'ArtifactPdfMarker']
    ]) {
      await panel().getByRole('treeitem').filter({ has: page.getByText(name, { exact: true }) }).click()
      await expect(panel().getByRole('button', { name: '差异范围', exact: true })).toContainText('当前内容')
      const document = preview.locator(`[data-document-preview="${kind}"]`)
      await expect(document).toBeVisible()
      if (kind === 'pdf') await expect(document.locator('canvas').first()).toHaveAttribute('data-rendered-page', '1', { timeout: 30_000 })
      else if (kind === 'docx' || kind === 'pptx') await expect(document.frameLocator('iframe').first().locator('body')).toContainText(marker, { timeout: 30_000 })
      else await expect(document).toContainText(marker, { timeout: 30_000 })
      await expect(document.getByRole('alert')).toHaveCount(0)
      await expect(preview.getByRole('button', { name: '保存原文件', exact: true })).toBeEnabled()
      expect(fileReads).toContainEqual({ sessionId: current.id, path: name })
    }
    expect(reviewCalls()).toEqual([])
  })

  test('精确修改入口等待持久记录同步，不借用同文件其他版本', async () => {
    const { current } = await installScenario()
    delayedChanges.add(`${current.id}-summary`)
    const process = work().locator('.work-message--assistant').first()
    await process.locator(`.work-file-change-row[data-change-id="${current.id}-summary"]`).click()
    await expect(panel()).toContainText('正在同步请求的文件与修改记录')
    await expect(panel().locator('.work-session-artifacts__diff')).toHaveCount(0)
    delayedChanges.delete(`${current.id}-summary`)
    await expect(panel().locator('.work-session-artifacts__diff')).toHaveAttribute('data-change-id', `${current.id}-summary`)
    await expect(panel().locator('.work-session-artifacts__diff')).toHaveAttribute('data-diff-scope', 'operation')
    await expect(panel()).not.toContainText('未找到请求的文件或修改记录')
    expect(reviewCalls()).toEqual([])
  })
})
