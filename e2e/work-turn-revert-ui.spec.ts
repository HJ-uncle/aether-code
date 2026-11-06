/** Real Electron + authenticated HTTP/SSE: the turn-result card requires a
 * second confirmation, reverts exact original receipts (including kept and
 * off-card files), preserves other turns/history, and reports disk conflicts. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AetherIdeApi } from '../src/preload'
import type { EngineFileChange } from '../src/shared/ipc'
import type { RootRun } from '../src/shared/root-run'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

declare global { interface Window { aether: AetherIdeApi } }

const root = resolve(__dirname, '..'), fixtureParent = join(root, '.e2e-tmp')
const token = 'turn-revert-fixture-token', model = 'turn-revert-fixture-model'
type Session = { id: string; title: string; diskRoot: string; workspaceRoot: string; runs: RootRun[]; streamSequence: number;
  changes: EngineFileChange[]; history: EngineHistoryRow[]; readers: Set<ServerResponse> }
type Call = { method: string; path: string; sessionId: string; body: Record<string, unknown> }
const sessions = new Map<string, Session>(), calls: Call[] = [], errors: string[] = []
const incompleteReceipts = new Set<string>()
let fixture = '', source = '', serial = 0, app: ElectronApplication | undefined, page: Page, health: ElectronHealthMonitor | undefined
let responseGate: Promise<void> | undefined, releaseResponse = (): void => {}
const isRunning = (session?: Session) => session?.runs.some(run => run.status === 'running') ?? false
const envelope = (data: unknown) => JSON.stringify({ code: 200, message: 'ok', data })
const turnRecords = (session: Session, turn: number) => session.changes.filter(change => change.turnId === session.runs[turn].turnId)
function diskPath(session: Session, path: string): string {
  const prefix = session.workspaceRoot + '/', relativePath = path.startsWith(prefix) ? path.slice(prefix.length) : path
  const target = resolve(session.diskRoot, relativePath), rel = relative(session.diskRoot, target)
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Fixture file escaped its session root')
  return target
}
const diskContent = (session: Session, path: string): string | null => {
  const target = diskPath(session, path)
  return existsSync(target) ? readFileSync(target, 'utf8') : null
}
const diskState = (session: Session, turn: number) => Object.fromEntries(turnRecords(session, turn).map(change => [change.path, diskContent(session, change.path)]))
function createSession(running = false): Session {
  const id = `work-turn-revert-${++serial}`, now = Date.now() - 20_000
  const session: Session = { id, title: `按轮撤回验收 ${serial}`, diskRoot: join(fixture, 'files', id), workspaceRoot: `/remote/turn-revert/${id}`,
    runs: [], streamSequence: 1, changes: [], history: [], readers: new Set() }
  for (const turn of [0, 1]) {
    const letter = turn === 0 ? 'a' : 'b', time = now + turn * 1_000
    const run: RootRun = { schemaVersion: 1, sessionId: id, runId: `${id}-run-${letter}`, turnId: `${id}-turn-${letter}`,
      userMessageId: `${id}-user-${letter}`, assistantMessageId: `${id}-assistant-${letter}`, status: running && turn === 1 ? 'running' : 'succeeded',
      version: 1, seq: turn + 1, pending: [], modelId: model, workspacePaths: [], createdAt: time, updatedAt: time + 100,
      ...(running && turn === 1 ? {} : { finishedAt: time + 100 }) }
    session.runs.push(run)
    session.history.push(
      { id: run.userMessageId, role: 'user', content: `第 ${turn + 1} 轮：整理五个文件。`, conversationId: run.turnId, createdAt: time, metadata: { rootRunId: run.runId } },
      { id: run.assistantMessageId, role: 'assistant', content: `TURN_${letter.toUpperCase()}_HISTORY_PRESERVED：已处理本轮文件。`, conversationId: run.turnId, createdAt: time + 100, metadata: { rootRunId: run.runId } }
    )
    const add = (name: string, before: string | null, after: string | null, status: EngineFileChange['status'] = 'pending') => {
      const index = session.changes.length + 1, path = `${session.workspaceRoot}/round-${letter}/${name}.md`
      const change: EngineFileChange = { id: `${id}-${letter}-record-${index}`, sessionId: id, runId: run.runId, turnId: run.turnId, path,
        kind: after === null ? 'delete' : 'write', isNew: before === null, oldContent: before, newContent: after,
        oldHash: before === null ? 'missing' : `before-${index}`, newHash: after === null ? 'missing' : `after-${index}`,
        truncated: false, status, createdAt: time + index, seq: index }
      session.changes.push(change)
      const disk = diskPath(session, path); mkdirSync(dirname(disk), { recursive: true })
      if (after === null) { if (existsSync(disk)) rmSync(disk) } else writeFileSync(disk, after)
      return change
    }
    add('created', null, `created ${letter}\n`)
    add('edited', `original ${letter}\n`, `intermediate ${letter}\n`)
    add('kept', `kept-before ${letter}\n`, `kept-after ${letter}\n`, 'kept')
    add('deleted', `deleted-before ${letter}\n`, null)
    add('fifth-file', `fifth-before ${letter}\n`, `fifth-after ${letter}\n`)
    add('edited', `intermediate ${letter}\n`, `final ${letter}\n`)
  }
  // Net-segment aliases are deliberately hostile to a turn action. Only each
  // original record.id is authorized, even if changeIds names another turn.
  const first = turnRecords(session, 0), second = turnRecords(session, 1)
  first[0].changeIds = [second[0].id, first[0].id]
  second[0].changeIds = [first[0].id, second[0].id]
  sessions.set(id, session)
  return session
}
function finish(session: Session): void {
  const run = session.runs[1]
  // A root's sequence orders turns and remains stable throughout its lifetime;
  // only the stream watermark and root version advance on a status update.
  Object.assign(run, { status: 'succeeded', version: run.version + 1, updatedAt: Date.now(), finishedAt: Date.now() })
  session.streamSequence++
  for (const response of session.readers) {
    response.write(`id: ${run.runId}:${session.streamSequence}\ndata: ${JSON.stringify({ run })}\n\n`)
    response.end('data: [DONE]\n\n')
  }
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, method = request.method ?? 'GET'
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated fixture request: ${path}`)
    let raw = ''; for await (const chunk of request) raw += String(chunk)
    const body: Record<string, unknown> = raw ? JSON.parse(raw) : {}, id = String(body.sessionId ?? url.searchParams.get('sessionId') ?? '')
    const session = sessions.get(id), lastRun = session?.runs.at(-1)
    if (method !== 'GET') calls.push({ method, path, sessionId: id, body: structuredClone(body) })
    if (path === '/api/v1/chat' || path === '/api/v1/conversation/truncate' || path === '/api/v1/conversation/history' && method !== 'GET') {
      throw new Error('Turn file withdrawal must not generate messages or mutate conversation history')
    }
    if (path === '/api/v1/chat/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (session && isRunning(session)) {
        response.write(': connected\n\n'); session.readers.add(response); response.on('close', () => session.readers.delete(response))
      } else response.end('data: [DONE]\n\n')
      return
    }
    const send = (data: unknown) => { response.setHeader('content-type', 'application/json'); response.end(envelope(data)) }
    if (path === '/api/v1/workbench/clients' || path === '/api/v1/cron/capabilities') { response.writeHead(404).end(); return }
    if (path === '/api/v1/chat/admission/context') {
      send({ protocolVersion: 1, tenantId: 'turn-revert', sessionId: id, namespace: { id: 'turn-revert-db', generation: 'one' },
        transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'general' ? 'general' : 'code', runLifetime: 'durable', subagentProtocol: 2 },
        root: lastRun ? { ...lastRun, attemptId: `${lastRun.runId}-attempt` } : null,
        predecessor: lastRun ? { runId: lastRun.runId, attemptId: `${lastRun.runId}-attempt`, version: lastRun.version } : null }); return
    }
    if (path === '/api/v1/chat/admission/receipt') { send({ protocolVersion: 1, status: 'absent', namespace: body.namespace, sessionId: id, requestKey: body.requestKey }); return }
    if (path === '/api/v1/conversation/display') {
      const history = session?.history ?? [], users = history.filter(row => row.role === 'user'), anchor = url.searchParams.get('anchorMessageId')
      const limit = Number(url.searchParams.get('limit') ?? 2), start = anchor ? users.findIndex(row => row.id === anchor) : Math.max(0, users.length - limit)
      const selected = users.slice(start, start + limit), selectedTurns = new Set(selected.map(row => row.conversationId))
      send({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id, conversationId: row.conversationId, preview: String(row.content), createdAt: row.createdAt })),
        messages: history.filter(row => selectedTurns.has(row.conversationId)), loadedTurnIds: selected.map(row => row.id), revision: `${id}:original`,
        mutationRevision: `${id}:unchanged`, backend: 'jsonl', completeness: 'complete' }); return
    }
    if (path === '/api/v1/changes/revert-batch') {
      if (!session || method !== 'POST' || body.scope !== 'all' || !Array.isArray(body.ids) || body.ids.some(item => typeof item !== 'string')) throw new Error('Revert requires explicit session, original IDs and all scope')
      const ids = body.ids as string[]
      if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Invalid original receipt selection')
      const selected = ids.map(id => {
        const change = session.changes.find(item => item.id === id)
        if (!change) throw new Error(`Unknown original receipt ${id}`)
        return change
      }).sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
      await responseGate
      const results = selected.map(change => {
        if (change.status === 'reverted') return { id: change.id, path: change.path, status: 'already_reverted' }
        const disk = diskPath(session, change.path), actual = diskContent(session, change.path)
        if (actual !== change.newContent) return { id: change.id, path: change.path, status: 'conflict', message: '检测到后续手动修改，保留当前文件。' }
        if (change.oldContent === null) { if (existsSync(disk)) rmSync(disk) }
        else writeFileSync(disk, change.oldContent)
        change.status = 'reverted'
        return { id: change.id, path: change.path, status: 'reverted' }
      })
      // A partial acknowledgement must not turn an otherwise successful batch
      // into a complete receipt. Its original total remains authoritative.
      const acknowledged = incompleteReceipts.has(id) ? results.filter(item => !item.path.endsWith('/kept.md')) : results
      send({ results: acknowledged, total: ids.length, reverted: acknowledged.filter(item => item.status === 'reverted').length,
        conflicts: acknowledged.filter(item => item.status === 'conflict').length, unavailable: 0, failed: 0 }); return
    }
    if (path === '/api/v1/workspace/file/content' || path === '/api/v1/workspace/file/info') {
      const candidate = url.searchParams.get('path') ?? '', content = session ? diskContent(session, candidate) : null
      if (content === null) { response.writeHead(404).end(JSON.stringify({ code: 404, message: '文件不存在' })); return }
      send(path.endsWith('/content') ? { content, isBinary: false, totalSize: Buffer.byteLength(content), truncated: false }
        : { isDirectory: false, size: Buffer.byteLength(content), mtimeMs: 1 }); return
    }
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'6'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'turn-revert-fixture' }
      : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '本轮撤回验收模型', isEnabled: true, capabilities: { toolCalling: true } }]
      : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: isRunning(session) ? 'live' : 'persisted', finished: !isRunning(session),
        eventId: lastRun ? `${lastRun.runId}:${session!.streamSequence}` : null, run: lastRun, runs: session?.runs ?? [], history: session?.history ?? [], projection: [], todos: [], changes: [], commandJobs: [] }
      : path === '/api/v1/chat/status' ? { run: lastRun, running: isRunning(session), finished: !isRunning(session) }
      : path === '/api/v1/chat/runs' ? { runs: session?.runs ?? [] }
      : path === '/api/v1/conversation/history' ? session?.history ?? []
      : path === '/api/v1/conversation/sessions' ? [...sessions.values()].map(item => ({ sessionId: item.id, title: item.title, lastAt: item.runs.at(-1)!.updatedAt, messageCount: item.history.length }))
      : path === '/api/v1/changes' ? (session?.changes ?? []).filter(change => !url.searchParams.has('status') || change.status === url.searchParams.get('status'))
      : path === '/api/v1/command-jobs' ? { jobs: [] }
      : path === '/api/v1/security/mode' ? { sessionId: id, mode: 'standard' }
      : path === '/api/v1/memory/settings' ? { sessionId: id, memoryScope: 'session', effectiveScope: 'session', enabled: true }
      : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
      : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'fixture' }
      : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, durableQueueReceipts: false, receiptPagination: false,
        runtimeCommunication: false, mailboxConsumer: false, userControllerMutation: false, rootUserControllerMutation: false }
      : path === '/api/v1/workspace/directory' ? { root: session?.workspaceRoot ?? '/remote/turn-revert', entries: [] }
      : []
    send(data)
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end('Fixture request failed') })
})

const work = () => page.locator('.work-view')
const card = (session: Session, turn: number): Locator => work().locator('.work-conversation-turn')
  .filter({ has: page.locator(`[data-message-id="${session.runs[turn].userMessageId}"]`) })
  .getByRole('region', { name: '本轮成果摘要', exact: true })
const withdraw = (session: Session, turn: number): Locator => card(session, turn).getByRole('button', { name: '撤回本轮成果', exact: true })
const dialog = () => page.getByRole('dialog', { name: '撤回本轮成果', exact: true })
const mutations = () => calls.filter(call => call.path.startsWith('/api/v1/changes/') || call.path.startsWith('/api/v1/conversation/') || call.path === '/api/v1/chat')
const revertCalls = () => calls.filter(call => call.path === '/api/v1/changes/revert-batch')
async function installScenario(running = false): Promise<Session> {
  const session = createSession(running)
  await page.evaluate(({ key, session, model }) => {
    const now = Date.now()
    localStorage.setItem(key, JSON.stringify({ activeTaskId: session.id, tasks: [{ id: session.id, title: session.title, status: 'done', draft: '', createdAt: now,
      updatedAt: now, workspacePath: null, modelId: model, attachments: [], sources: [] }] }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', workspace: false }))
  }, { key: `aether.work.state.v1:${encodeURIComponent(source)}`, session: { id: session.id, title: session.title }, model })
  await page.reload()
  await expect(work().getByRole('heading', { name: session.title, exact: true })).toBeVisible()
  for (const turn of [0, 1]) await expect(card(session, turn)).toContainText('5 个文件')
  const alerts = work().getByRole('region', { name: '协作对话', exact: true }).getByRole('alert')
  await expect(alerts).toHaveCount(0)
  return session
}
async function openConfirmation(session: Session, turn: number): Promise<void> {
  await withdraw(session, turn).click()
  await expect(dialog()).toBeVisible()
  await expect(dialog().getByRole('button', { name: '确认撤回', exact: true })).toBeEnabled()
  await expect(dialog()).toContainText('5 个文件')
  await expect(dialog()).toContainText('6 处改动')
  await expect(dialog()).toContainText('仅撤回本轮')
  await expect(dialog()).toContainText('含已保留的改动')
  await expect(dialog()).toContainText('本轮新增的文件将删除，修改或删除的文件将恢复到本轮之前')
  await expect(dialog()).toContainText('对话历史保持不变')
  for (const path of new Set(turnRecords(session, turn).map(change => change.path))) await expect(dialog()).not.toContainText(path)
  await expect(dialog()).not.toContainText(`round-${turn === 0 ? 'b' : 'a'}/`)
}
async function confirm(): Promise<void> {
  await dialog().getByRole('button', { name: '确认撤回', exact: true }).click()
  await expect(dialog()).toHaveCount(0)
}
async function assertHistory(session: Session): Promise<void> {
  for (const [turn, letter] of [[0, 'A'], [1, 'B']] as const) {
    await expect(work().locator(`[data-message-id="${session.runs[turn].userMessageId}"]`)).toBeAttached()
    await expect(work().locator(`[data-message-id="${session.runs[turn].assistantMessageId}"]`)).toContainText(`TURN_${letter}_HISTORY_PRESERVED`)
  }
  expect(mutations().filter(call => call.path !== '/api/v1/changes/revert-batch')).toEqual([])
}
function assertRestored(session: Session, turn: number): void {
  const oldest = new Map<string, EngineFileChange>()
  for (const change of turnRecords(session, turn)) if (!oldest.has(change.path)) oldest.set(change.path, change)
  for (const change of oldest.values()) expect(diskContent(session, change.path), change.path).toBe(change.oldContent)
  expect(turnRecords(session, turn).map(change => change.status)).toEqual(Array(6).fill('reverted'))
}

test.describe.serial('Work 本轮成果撤回', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureParent, { recursive: true }); fixture = mkdtempSync(join(fixtureParent, 'work-turn-revert-'))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`; source = engineStorageKey({ mode: 'remote', baseUrl: origin })
    const profile = join(fixture, 'profile'); mkdirSync(profile)
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: false, lastModelId: model, appearance: 'light' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token,
      AETHER_GLOBAL_DIR: join(fixture, 'global') }).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_MAIN || process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${profile}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'work-turn-revert', [token])
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.workbench')).toBeVisible()
    const snapshot = await page.evaluate(() => window.aether.engine.start())
    expect(snapshot, JSON.stringify(snapshot)).toMatchObject({ phase: 'ready', mode: 'remote' })
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(600, 600); window.setSize(1440, 1000) })
  })
  test.beforeEach(async () => {
    calls.length = 0; errors.length = 0; responseGate = undefined; incompleteReceipts.clear()
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000))
  })
  test.afterEach(async () => {
    releaseResponse()
    if (await dialog().count()) await page.keyboard.press('Escape')
    for (const session of sessions.values()) { if (isRunning(session)) finish(session); for (const response of session.readers) response.destroy() }
    expect(errors).toEqual([]); health?.assertHealthy()
  })
  test.afterAll(async ({}, info) => {
    try { if (health) await health.closeAndAssert(info); else await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      const owned = resolve(fixture)
      if (dirname(owned) !== fixtureParent || !basename(owned).startsWith('work-turn-revert-')) throw new Error(`Unsafe turn-revert cleanup: ${owned}`)
      rmSync(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test('卡片右上撤回需二次确认，取消和 Escape 不写盘，深浅与窄宽布局可用', async ({}, info) => {
    const session = await installScenario(), before = [diskState(session, 0), diskState(session, 1)]
    for (const appearance of ['light', 'dark'] as const) {
      await page.evaluate(value => { document.documentElement.dataset.appearance = value }, appearance)
      for (const width of [1440, 680]) {
        const actual = await app!.evaluate(({ BrowserWindow }, width) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(width, 1000); return window.getContentSize()[0] }, width)
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(actual)
        const mobile = work().locator('.work-mobile-tabs').getByRole('button', { name: '协作对话', exact: true })
        if (await mobile.isVisible()) await mobile.click()
        await withdraw(session, 0).scrollIntoViewIfNeeded()
        await expect(withdraw(session, 0)).toHaveText('撤回')
        await expect(card(session, 0).getByRole('button', { name: /保留/ })).toHaveCount(0)
        await expect.poll(() => card(session, 0).evaluate(element => {
          const bounds = element.getBoundingClientRect(), action = element.querySelector('[aria-label="撤回本轮成果"]')!.getBoundingClientRect()
          return bounds.left >= 0 && bounds.right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1 && action.right <= bounds.right && action.left > bounds.left + bounds.width / 2
        })).toBe(true)
        await card(session, 0).screenshot({ path: info.outputPath(`turn-revert-card-${appearance}-${width}.png`), animations: 'disabled' })
        await openConfirmation(session, 0)
        await expect(withdraw(session, 1)).toBeDisabled()
        await expect.poll(() => dialog().evaluate(element => { const bounds = element.getBoundingClientRect(); return bounds.left >= 0 && bounds.right <= innerWidth + 1 && bounds.top >= 0 && bounds.bottom <= innerHeight + 1 })).toBe(true)
        await dialog().screenshot({ path: info.outputPath(`turn-revert-confirm-${appearance}-${width}.png`), animations: 'disabled' })
        if (width === 1440) await dialog().getByRole('button', { name: '取消', exact: true }).click()
        else await page.keyboard.press('Escape')
        await expect(dialog()).toHaveCount(0)
        await expect(withdraw(session, 0)).toBeEnabled()
        expect(mutations()).toEqual([])
        expect([diskState(session, 0), diskState(session, 1)]).toEqual(before)
      }
    }
  })

  test('确认覆盖卡片省略的全部文件和已保留记录，仅发本轮原始 ID，轮次互不影响', async () => {
    const session = await installScenario(), originalHistory = structuredClone(session.history), untouched = diskState(session, 1)
    const first = card(session, 0), toggle = first.locator('.work-progress-panel__changes-toggle')
    await toggle.click(); await expect(first.locator('.work-progress-panel__file')).toHaveCount(3)
    await expect(first).toContainText('还有 2 个文件')
    responseGate = new Promise<void>(done => { releaseResponse = done })
    await openConfirmation(session, 0); await confirm()
    await expect.poll(() => revertCalls().length).toBe(1)
    await expect(withdraw(session, 1)).toBeDisabled()
    expect(revertCalls()[0].body).toEqual({ sessionId: session.id, scope: 'all', ids: expect.any(Array) })
    expect([...(revertCalls()[0].body.ids as string[])].sort()).toEqual(turnRecords(session, 0).map(change => change.id).sort())
    releaseResponse(); responseGate = undefined
    await expect.poll(() => turnRecords(session, 0).every(change => change.status === 'reverted')).toBe(true)
    assertRestored(session, 0)
    expect(diskState(session, 1)).toEqual(untouched)
    expect(turnRecords(session, 1).map(change => change.status)).toEqual(['pending', 'pending', 'kept', 'pending', 'pending', 'pending'])
    await expect(withdraw(session, 1)).toBeEnabled()
    await assertHistory(session)
    await openConfirmation(session, 1); await confirm()
    await expect.poll(() => revertCalls().length).toBe(2)
    expect([...(revertCalls()[1].body.ids as string[])].sort()).toEqual(turnRecords(session, 1).map(change => change.id).sort())
    expect(revertCalls()[1].body.scope).toBe('all')
    await expect.poll(() => turnRecords(session, 1).every(change => change.status === 'reverted')).toBe(true)
    assertRestored(session, 0); assertRestored(session, 1)
    expect(session.history).toEqual(originalHistory)
    await assertHistory(session)
  })

  test('磁盘后续修改产生逐文件冲突报告，保留冲突文件和对话，不伪报全部成功', async ({}, info) => {
    const session = await installScenario(), untouched = diskState(session, 1)
    const conflicted = turnRecords(session, 0).find(change => change.path.endsWith('/fifth-file.md'))!
    writeFileSync(diskPath(session, conflicted.path), 'MANUAL_EDIT_MUST_SURVIVE\n')
    await openConfirmation(session, 0); await confirm()
    const report = card(session, 0).getByRole('region', { name: '文件回退结果', exact: true })
    await expect(report).toContainText('已撤回 4 个文件（5 处改动）；版本冲突 1 处')
    await expect(report).toContainText('部分改动未恢复')
    await expect(report).toContainText(conflicted.path)
    await expect(report).toContainText('检测到后续手动修改，保留当前文件。')
    await expect(report.locator('details')).toHaveAttribute('open', '')
    await expect(card(session, 1).getByRole('region', { name: '文件回退结果', exact: true })).toHaveCount(0)
    await expect(page.getByText('本轮文件改动已撤回', { exact: true })).toHaveCount(0)
    expect(diskContent(session, conflicted.path)).toBe('MANUAL_EDIT_MUST_SURVIVE\n')
    expect(conflicted.status).toBe('pending')
    expect(turnRecords(session, 0).filter(change => change.id !== conflicted.id).every(change => change.status === 'reverted')).toBe(true)
    expect(diskState(session, 1)).toEqual(untouched)
    await assertHistory(session)
    await report.screenshot({ path: info.outputPath('turn-revert-conflict-report.png'), animations: 'disabled' })
  })

  test('会话运行时两轮撤回入口禁用，收到结束帧后恢复且未提前请求', async () => {
    const session = await installScenario(true), before = [diskState(session, 0), diskState(session, 1)]
    await expect.poll(() => session.readers.size).toBeGreaterThan(0)
    for (const turn of [0, 1]) {
      await expect(withdraw(session, turn)).toBeDisabled()
      await withdraw(session, turn).evaluate(button => (button as HTMLButtonElement).click())
    }
    await expect(dialog()).toHaveCount(0)
    expect(mutations()).toEqual([])
    expect([diskState(session, 0), diskState(session, 1)]).toEqual(before)
    finish(session)
    for (const turn of [0, 1]) await expect(withdraw(session, turn)).toBeEnabled()
    await openConfirmation(session, 1)
    await page.keyboard.press('Escape'); await expect(dialog()).toHaveCount(0)
    expect(mutations()).toEqual([])
  })

  test('确认期间记录被其他操作撤回，旧确认失效且不会继续修改剩余文件', async () => {
    const session = await installScenario()
    await openConfirmation(session, 0)
    const changed = turnRecords(session, 0).find(change => change.isNew)!
    // Simulate a separate review surface completing a withdrawal while the
    // dialog is open. The normal ledger refresh must invalidate its identity.
    changed.status = 'reverted'
    rmSync(diskPath(session, changed.path))
    const afterExternalChange = [diskState(session, 0), diskState(session, 1)]
    await expect(card(session, 0).locator('.work-progress-panel__count')).toHaveText('4 个文件')
    await confirm()
    await expect(card(session, 0).getByRole('alert')).toContainText('文件改动列表已更新，请重新检查后确认')
    expect(mutations()).toEqual([])
    expect([diskState(session, 0), diskState(session, 1)]).toEqual(afterExternalChange)
    await withdraw(session, 0).click()
    await expect(dialog()).toContainText('4 个文件的 5 处改动')
    await expect(dialog()).not.toContainText(changed.path)
    await page.keyboard.press('Escape'); await expect(dialog()).toHaveCount(0)
    await assertHistory(session)
  })

  test('不完整回执保留原请求总数，成功项离开卡片后仍报告且不提示全部完成', async () => {
    const session = await installScenario(), originalOther = diskState(session, 1)
    const created = turnRecords(session, 0).find(change => change.isNew)!
    incompleteReceipts.add(session.id)
    await openConfirmation(session, 0); await confirm()
    const report = card(session, 0).getByRole('region', { name: '文件回退结果', exact: true })
    await expect(card(session, 0).locator('.work-progress-panel__count')).toHaveText('4 个文件')
    await expect(report).toContainText('已撤回 4 个文件（5 处改动）')
    await expect(report).toContainText('部分改动未恢复')
    await expect(report).toContainText(created.path)
    await expect(report.locator('details')).toHaveAttribute('open', '')
    await expect(page.getByText('本轮文件改动已撤回', { exact: true })).toHaveCount(0)
    await expect(card(session, 1).getByRole('region', { name: '文件回退结果', exact: true })).toHaveCount(0)
    expect(revertCalls()).toHaveLength(1)
    expect((revertCalls()[0].body.ids as string[]).length).toBe(6)
    assertRestored(session, 0)
    expect(diskState(session, 1)).toEqual(originalOther)
    await assertHistory(session)
  })
})
