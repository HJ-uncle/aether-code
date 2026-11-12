/** Real Electron Work terminal: one-click running logs, cursor/owner isolation,
 * hidden polling, stop/restart, workspace/keyboard navigation and native PTYs.
 * The embedded HTTP proxy supplies deterministic engine records; PTY creation,
 * IPC, shell input and xterm attachment still use the production implementation.
 * Build first, then run with playwright.work-terminal.config.ts.
 * AETHER_E2E_APP_ENTRY can select an independently built application snapshot. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { CommandJobSnapshot, CommandOutputEntry } from '../src/shared/command-job'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const fixtureToken = 'work-terminal-fixture-token', model = 'work-terminal-model', now = Date.now() - 10_000
const taskA = 'work-terminal-task-a', taskB = 'work-terminal-task-b', codeSession = 'work-terminal-code-session'
const jobA = 'terminal-job-a', idleJobA = 'terminal-job-a-unselected', jobB = 'terminal-job-b'
const titles = new Map([[taskA, '终端验收任务 A'], [taskB, '终端验收任务 B'], [codeSession, 'Code 终端对照会话']])
const manifest = { version: '2.0.0', buildId: `sha256:${'b'.repeat(64)}`, protocolVersion: 1,
  toolProfiles: ['general', 'code'], subagentSchemaVersion: 1 }
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
type OutputRead = { sessionId: string; jobId: string; cursor: number; maxBytes: number }
type ActionReceipt = { action: 'cancel' | 'restart'; sessionId: string; jobId: string; nextId?: string }
type TerminalReceipt = { input: { cwd?: string; sessionId?: string; cols: number; rows: number }; id?: string; error?: string }
const errors: string[] = [], unexpectedWrites: string[] = [], probes: string[] = []
const outputReads: OutputRead[] = [], actions: ActionReceipt[] = []
const navGeometry: Array<{ state: string; scrollOffset: number; slotWidth: number; contentLeft: number; runningRight: number }> = []
const composerGeometry: Array<Record<string, string | number | boolean>> = []
const outputObservers = new Set<(read: OutputRead) => void>()
const jobs = new Map<string, CommandJobSnapshot>(), logs = new Map<string, CommandOutputEntry[]>()
const roots = new Map<string, RootRun>()
let app: ElectronApplication | undefined, page: Page, fixture = '', cwdA = '', cwdB = '', codeCwd = ''
let held: { jobId: string; response?: ServerResponse; body?: string } | undefined, restartCount = 0

function workspacePath(sessionId: string): string { return sessionId === taskA ? cwdA : sessionId === taskB ? cwdB : codeCwd }
function append(jobId: string, stream: CommandOutputEntry['stream'], text: string): void {
  const job = jobs.get(jobId), entries = logs.get(jobId)
  if (!job || !entries) throw new Error(`Unknown fixture job: ${jobId}`)
  entries.push({ seq: entries.length + 1, stream, text })
  jobs.set(jobId, { ...job, version: job.version + 1, cursor: entries.length, updatedAt: Date.now() })
}
function expectedOutput(jobId: string): string { return (logs.get(jobId) ?? []).map(entry => entry.text).join('') }
function addJob(jobId: string, sessionId: string, name: string, createdAt: number): void {
  jobs.set(jobId, { schemaVersion: 1, jobId, sessionId, ownerSessionId: sessionId,
    runId: `root-${sessionId}`, turnId: `turn-${sessionId}`, toolCallId: `call-${jobId}`, version: 1,
    status: 'running', command: 'node', args: [name], cwd: workspacePath(sessionId), background: true,
    createdAt, updatedAt: createdAt, exitCode: null, signal: null, cursor: 0, earliestCursor: 0 })
  logs.set(jobId, [])
}
function history(sessionId: string): EngineHistoryRow[] {
  const run = roots.get(sessionId)
  if (!run) return []
  const rows: EngineHistoryRow[] = [{ id: run.userMessageId, role: 'user', content: titles.get(sessionId), conversationId: run.turnId, createdAt: now,
    metadata: { rootRunId: run.runId } }, { id: run.assistantMessageId, role: 'assistant', content: `后台运行已启动：${titles.get(sessionId)}`,
    conversationId: run.turnId, createdAt: now + 1, metadata: { rootRunId: run.runId } }]
  if (sessionId === taskB) rows.push(
    { id: `${run.userMessageId}-second`, role: 'user', content: '继续查看任务 B 的第二轮结果', conversationId: `${run.turnId}-second`, createdAt: now + 2 },
    { id: `${run.assistantMessageId}-second`, role: 'assistant', content: '任务 B 第二轮已完成，后台运行保持当前任务归属。', conversationId: `${run.turnId}-second`, createdAt: now + 3 }
  )
  return rows
}
function releaseOutput(): void { held?.response?.end(held.body); held = undefined }

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
  response.setHeader('content-type', 'application/json')
  if (request.headers['x-aether-instance-token'] !== fixtureToken) throw new Error(`Unauthenticated fixture request: ${path}`)
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const payload: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
  const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
  const id = url.searchParams.get('sessionId') ?? (typeof body.sessionId === 'string' ? body.sessionId : '')
  const rows = history(id), current = roots.get(id)
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/browser/hosts', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    probes.push(`${request.method} ${path}`)
    response.writeHead(404).end(JSON.stringify({ code: 404, message: 'Capability unavailable in terminal fixture', data: null })); return
  }
  // This fixture is embedded: a terminal HTTP request would reveal a routing
  // regression that silently substituted a remote terminal for the real PTY.
  if (path.startsWith('/api/v1/terminal/')) throw new Error(`Native PTY unexpectedly used HTTP: ${path}`)
  const command = path.match(/^\/api\/v1\/command-jobs\/([^/]+)(?:\/(output|cancel|restart))?$/)
  if (command) {
    const jobId = decodeURIComponent(command[1]), job = jobs.get(jobId), action = command[2]
    if (!job || job.sessionId !== id) throw new Error(`Crossed command owner: ${id}/${jobId}`)
    if (request.method === 'GET' && action === 'output') {
      const cursor = Number(url.searchParams.get('cursor') ?? 0), maxBytes = Number(url.searchParams.get('maxBytes') ?? 0)
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > job.cursor || maxBytes <= 0) throw new Error('Invalid output cursor')
      const read = { sessionId: id, jobId, cursor, maxBytes }
      outputReads.push(read); for (const observer of outputObservers) observer(read)
      // Small pages force the consumer to advance its sequence cursor and
      // make repeating the whole buffer observable as duplicate DOM entries.
      const entries = (logs.get(jobId) ?? []).filter(entry => entry.seq > cursor).slice(0, 2)
      const nextCursor = entries.at(-1)?.seq ?? cursor
      const value = envelope({ job, entries, nextCursor, earliestCursor: 0, truncated: false, hasMore: nextCursor < job.cursor })
      if (held?.jobId === jobId && !held.response) { held.response = response; held.body = value; return }
      response.end(value); return
    }
    if (request.method === 'POST' && action === 'cancel') {
      if (job.status !== 'running') throw new Error('Only a running fixture command can be cancelled')
      append(jobId, 'stderr', `STOP_TAIL_${jobId}\n`)
      const stopped = { ...jobs.get(jobId)!, version: jobs.get(jobId)!.version + 1, status: 'cancelled' as const,
        finishedAt: Date.now(), updatedAt: Date.now(), exitCode: 0, error: { code: 'COMMAND_CANCELLED', message: 'Cancelled by user' } }
      jobs.set(jobId, stopped); actions.push({ action, sessionId: id, jobId }); response.end(envelope(stopped)); return
    }
    if (request.method === 'POST' && action === 'restart') {
      if (job.status !== 'cancelled') throw new Error('Restart must follow a confirmed stop')
      const nextId = `${jobId}-restart-${++restartCount}`
      addJob(nextId, id, job.args[0], Date.now())
      append(nextId, 'stdout', `RESTARTED_${nextId}\n`)
      actions.push({ action, sessionId: id, jobId, nextId }); response.end(envelope(jobs.get(nextId))); return
    }
    if (request.method === 'GET' && !action) { response.end(envelope(job)); return }
    throw new Error(`Unsupported command operation: ${request.method} ${path}`)
  }
  if (request.method !== 'GET' && !['/api/v1/workspace/bind', '/api/v1/chat/admission/receipt'].includes(path)) {
    unexpectedWrites.push(`${request.method} ${path}`)
    response.writeHead(404).end(JSON.stringify({ code: 404, message: 'Unsupported fixture operation', data: null })); return
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows,
      loadedTurnIds: users.map(row => row.id), revision: `${id}-stable`, mutationRevision: `${id}-stable`, backend: 'jsonl', completeness: 'complete' })); return
  }
  const ownJobs = [...jobs.values()].filter(job => job.sessionId === id)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { ...manifest, instanceId: 'work-terminal-fixture' }
    : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '终端测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: rows, projection: [], run: current, runs: current ? [current] : [], subagentRuns: [], todos: [], changes: [], commandJobs: ownJobs }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: current, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: current ? [current] : [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [...titles].map(([sessionId, title]) => ({ sessionId, title, lastAt: now, messageCount: 2 }))
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'terminal-fixture', sessionId: id,
      namespace: { id: 'terminal-fixture-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, durableQueueReceipts: false, receiptPagination: false, runtimeCommunication: false, mailboxConsumer: false, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: workspacePath(id), bindingEpoch: 'one', entries: [] }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: workspacePath(id) }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: ownJobs } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const work = (): Locator => page.locator('.work-view')
const workspace = (): Locator => work().getByRole('region', { name: '任务工作区', exact: true })
const panel = (): Locator => workspace().getByRole('region', { name: '任务终端', exact: true })
const detail = (): Locator => panel().locator('.work-terminal-panel__detail')
const output = (): Locator => panel().locator('.work-terminal-panel__output')
const terminal = (): Locator => panel().locator('.terminal-view')
async function settleMotion(target: Locator): Promise<void> {
  await target.evaluate(async element => {
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
    await Promise.all(element.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map(animation => animation.finished.catch(() => undefined)))
  })
}
async function openRunning(): Promise<void> {
  // The rail remains the existing user's entry point; its product label can
  // change without turning this into a test of the former popover component.
  await work().locator('.work-service-tray--rail').getByRole('button').click()
  await expect(panel()).toBeVisible()
  await expect(panel().getByRole('tab', { name: /^后台运行/ })).toHaveAttribute('aria-selected', 'true')
}
async function openTerminalFromMenu(): Promise<void> {
  if (!(await workspace().isVisible())) await work().getByRole('button', { name: '打开工作区', exact: true }).click()
  await workspace().getByRole('button', { name: '更多工作区', exact: true }).click()
  await page.getByRole('menuitem', { name: '终端', exact: true }).click()
  await expect(panel()).toBeVisible()
}
async function selectTask(id: string): Promise<void> {
  await work().locator('.work-sidebar__task').filter({ hasText: titles.get(id)! }).click()
  await expect(work().getByRole('heading', { name: titles.get(id), exact: true })).toBeVisible()
}
async function assertOutput(jobId: string): Promise<void> {
  await expect(detail()).toHaveAttribute('data-job-id', jobId)
  await expect.poll(() => output().textContent()).toBe(expectedOutput(jobId))
  const entries = logs.get(jobId) ?? []
  await expect(output().locator('[data-output-seq]')).toHaveCount(entries.length)
  expect(await output().locator('[data-output-seq]').evaluateAll(elements => elements.map(element => element.getAttribute('data-output-seq'))))
    .toEqual(entries.map(entry => String(entry.seq)))
}
async function assertOutputQuiet(sessionId: string): Promise<void> {
  // This is an observation interval, not a readiness delay: one complete
  // polling period must pass without any new read for the hidden session.
  await new Promise<void>((done, reject) => {
    const finish = (error?: Error): void => { clearTimeout(timer); outputObservers.delete(observer); error ? reject(error) : done() }
    const observer = (read: OutputRead): void => { if (read.sessionId === sessionId) finish(new Error(`Hidden output still polled: ${JSON.stringify(read)}`)) }
    const timer = setTimeout(() => finish(), 1400)
    outputObservers.add(observer)
  })
}
async function assertNavigationSpace(state: string, turns: number): Promise<void> {
  const body = work().locator('.work-conversation__body')
  await expect(body.locator('.work-conversation-turn')).toHaveCount(turns)
  await expect(body.locator('.work-message-nav')).toHaveCount(turns >= 2 ? 1 : 0)
  await expect(body.locator('.work-message-nav-slot')).toBeVisible()
  const measured = await body.evaluate(element => {
    const origin = element.getBoundingClientRect().left
    const content = element.querySelector<HTMLElement>('.work-conversation__content')!
    const running = element.querySelector<HTMLElement>('.work-service-tray__button')!
    const badge = running.querySelector('b')
    return {
      scrollOffset: element.querySelector('.work-conversation__scroll')!.getBoundingClientRect().left - origin,
      slotWidth: element.querySelector('.work-message-nav-slot')!.getBoundingClientRect().width,
      contentLeft: content.getBoundingClientRect().left + parseFloat(getComputedStyle(content).paddingLeft) - origin,
      runningRight: Math.max(running.getBoundingClientRect().right, badge?.getBoundingClientRect().right ?? 0) - origin
    }
  })
  navGeometry.push({ state, ...measured })
  expect(Math.abs(measured.slotWidth - 36)).toBeLessThanOrEqual(1)
  expect(Math.abs(measured.scrollOffset - navGeometry[0].scrollOffset), 'navigation visibility must not move the message column').toBeLessThanOrEqual(1)
  expect(measured.runningRight, 'running button and badge must stay outside the text inset').toBeLessThanOrEqual(measured.contentLeft)
}
async function terminalReceipts(): Promise<TerminalReceipt[]> {
  return app ? app.evaluate(() => (globalThis as typeof globalThis & { __workTerminalCreates?: TerminalReceipt[] }).__workTerminalCreates ?? []) : []
}
async function copyTerminal(view: Locator): Promise<string> {
  // Clipboard writes complete asynchronously; an earlier copy must never
  // satisfy the assertion for the newly selected terminal.
  const sentinel = `work-terminal-copy-${randomUUID()}`
  await app!.evaluate(({ clipboard }, text) => clipboard.writeText(text), sentinel)
  await view.locator('.terminal-view__item.is-active').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '复制全部输出', exact: true }).click()
  let copied = sentinel
  await expect.poll(async () => {
    copied = await app!.evaluate(({ clipboard }) => clipboard.readText().replace(/\r\n/g, '\n'))
    return copied
  }).not.toBe(sentinel)
  return copied
}
async function logAnchor(): Promise<{ seq: string; offset: number; top: number }> {
  return output().evaluate(element => {
    const top = element.getBoundingClientRect().top
    const anchor = Array.from(element.querySelectorAll('[data-output-seq]')).find(entry => entry.getBoundingClientRect().bottom > top)
    if (!anchor) throw new Error('No visible log entry to remember')
    return { seq: anchor.getAttribute('data-output-seq')!, offset: anchor.getBoundingClientRect().top - top, top: element.scrollTop }
  })
}
async function setAppearance(appearance: 'light' | 'dark'): Promise<void> {
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  await settings.getByRole('radio', { name: appearance === 'dark' ? '深色' : '浅色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.locator('.modal-overlay:has([role="dialog"][aria-label="设置"])')).toHaveCount(0)
}
async function setWindow(width: number, height: number): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(size.width, size.height); window.show(); window.focus()
  }, { width, height })
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height })
}
const psQuote = (text: string): string => `'${text.replace(/'/g, "''")}'`

test.describe.serial('Work 终端与后台运行', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'work-terminal-profile-'))
    cwdA = join(fixture, 'task-a'); cwdB = join(fixture, 'task-b'); codeCwd = join(fixture, 'code-project')
    for (const directory of [cwdA, cwdB, codeCwd]) mkdirSync(directory, { recursive: true })
    for (const sessionId of titles.keys()) roots.set(sessionId, { schemaVersion: 1, runId: `root-${sessionId}`, sessionId,
      turnId: `turn-${sessionId}`, userMessageId: `user-${sessionId}`, assistantMessageId: `assistant-${sessionId}`,
      seq: 1, version: 2, status: 'succeeded', modelId: model, pending: [], workspacePaths: [workspacePath(sessionId)],
      createdAt: now, updatedAt: now, finishedAt: now })
    addJob(idleJobA, taskA, 'unselected-a.js', now + 1); append(idleJobA, 'stdout', 'UNSELECTED_A\n')
    addJob(jobB, taskB, 'service-b.js', now + 2); append(jobB, 'stdout', 'B_STDOUT_ONLY\n'); append(jobB, 'stderr', 'B_STDERR_ONLY\n')
    addJob(jobA, taskA, 'service-a.js', now + 3); append(jobA, 'stdout', 'A_STDOUT_INITIAL\n'); append(jobA, 'stderr', 'A_STDERR_INITIAL\n'); append(jobA, 'stdout', 'A_PAGE_TWO\n')
    // Stable ordering makes the active service the default selection even if
    // the system clock advances while the fixture is being initialized.
    jobs.set(jobA, { ...jobs.get(jobA)!, updatedAt: now + 3000 })
    jobs.set(idleJobA, { ...jobs.get(idleJobA)!, updatedAt: now + 1000 })
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture server port')
    const runtime = join(fixture, 'runtime-fixture'), entry = join(runtime, 'entry.cjs')
    mkdirSync(join(runtime, 'runtime'), { recursive: true })
    writeFileSync(join(runtime, 'runtime', 'build-manifest.json'), JSON.stringify(manifest))
    // Only the engine HTTP boundary is substituted. Embedded mode is essential
    // so native terminal IPC still reaches pty-service and the actual OS shell.
    writeFileSync(entry, `const http = require('node:http');
const upstream = ${JSON.stringify(`http://127.0.0.1:${address.port}`)};
const token = ${JSON.stringify(fixtureToken)};
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/') && req.headers['x-aether-instance-token'] !== process.env.AETHER_INSTANCE_TOKEN) {
    res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({code:401,message:'Invalid or missing instance token'})); return;
  }
  const forwarded = http.request(upstream + req.url, { method: req.method, headers: { ...req.headers, 'x-aether-instance-token': token } }, remote => {
    res.writeHead(remote.statusCode || 500, remote.headers); remote.pipe(res);
  });
  forwarded.on('error', error => { if (!res.headersSent) res.writeHead(502); res.end(error.message); });
  req.pipe(forwarded);
});
server.listen(Number(process.env.AETHER_ENGINE_PORT), '127.0.0.1');
`)
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'embedded', autoStartEngine: true,
      preferredPort: 12531, lastSessionId: codeSession, lastModelId: model, appearance: 'light', lastFolder: codeCwd, thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const name of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'WORKSPACE_ROOT'].includes(name.toUpperCase())) delete env[name]
    env.AETHER_IDE_ENGINE_ENTRY = entry; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    // A transparent test spy records the real IPC input/result. It delegates
    // unchanged to the production handler and never substitutes PTY behavior.
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<{ id: string }>> })._invokeHandlers
      const original = handlers.get('terminal:create')
      if (!original) throw new Error('Missing production terminal:create handler')
      const receipts: TerminalReceipt[] = []
      ;(globalThis as typeof globalThis & { __workTerminalCreates: TerminalReceipt[] }).__workTerminalCreates = receipts
      ipcMain.removeHandler('terminal:create')
      ipcMain.handle('terminal:create', async (event, input: TerminalReceipt['input']) => {
        const receipt: TerminalReceipt = { input: { ...input } }; receipts.push(receipt)
        try { const result = await original(event, input); receipt.id = result.id; return result }
        catch (error) { receipt.error = error instanceof Error ? error.message : String(error); throw error }
      })
    })
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900); window.show(); window.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const tasks = [taskA, taskB].map(id => ({ id, title: titles.get(id), status: 'done', draft: '', createdAt: now, updatedAt: now,
      workspacePath: workspacePath(id), modelId: model, attachments: [], sources: [] }))
    await page.evaluate(({ tasks, taskA }) => {
      localStorage.setItem('aether.work.state.v1', JSON.stringify({ tasks, activeTaskId: taskA }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
    }, { tasks, taskA })
    await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
    await expect(work().getByRole('heading', { name: titles.get(taskA), exact: true })).toBeVisible()
  })
  test.afterEach(async ({}, info) => {
    releaseOutput()
    await info.attach('work-terminal-receipts', { body: JSON.stringify({ outputReads, actions, terminalCreates: await terminalReceipts(), navGeometry, composerGeometry, probes, unexpectedWrites, errors }, null, 2), contentType: 'application/json' })
    if (info.status !== info.expectedStatus && page && !page.isClosed()) {
      const path = info.outputPath('work-terminal-failure.png'); await page.screenshot({ path }); await info.attach('失败时页面', { path, contentType: 'image/png' })
    }
    expect(errors).toEqual([]); expect(unexpectedWrites).toEqual([])
  })
  test.afterAll(async () => {
    releaseOutput()
    try { await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('work-terminal-profile-')) throw new Error(`Unsafe cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('左侧运行入口一次打开工作区日志，stdout/stderr按游标追加且未选中任务不轮询', async ({}, info) => {
    await expect(workspace()).toBeHidden()
    const readStart = outputReads.length
    await openRunning()
    await expect(panel()).toHaveAttribute('data-session-id', taskA)
    await expect(page.locator('.work-service-tray__popover')).toHaveCount(0)
    await expect(workspace().getByRole('tablist', { name: '已打开的工作区', exact: true }).getByRole('tab', { name: '终端', exact: true })).toHaveAttribute('aria-selected', 'true')
    await assertOutput(jobA)
    await assertNavigationSpace('single-turn-a', 1)
    expect(outputReads.slice(readStart).filter(read => read.jobId === jobA).map(read => read.cursor)).toEqual(expect.arrayContaining([0, 2]))
    await expect(output().locator('[data-stream="stderr"]')).toHaveText(['A_STDERR_INITIAL\n'])
    append(jobA, 'stdout', 'A_LIVE_STDOUT\n'); append(jobA, 'stderr', 'A_LIVE_STDERR\n')
    await assertOutput(jobA)
    expect(outputReads.slice(readStart).some(read => read.jobId === idleJobA || read.jobId === jobB)).toBe(false)
    expect((await terminalReceipts()).filter(receipt => receipt.input.sessionId === taskA)).toEqual([])
    const path = info.outputPath('work-running-output.png'); await page.screenshot({ path }); await info.attach('后台实时输出', { path, contentType: 'image/png' })
  })

  test('隐藏工作区停止日志请求，重开补齐输出，旧会话晚到响应不能串入新任务', async () => {
    await workspace().getByRole('button', { name: '关闭终端', exact: true }).click()
    await expect(panel()).toBeHidden(); await settleMotion(work())
    append(jobA, 'stdout', 'A_WHILE_HIDDEN\n')
    await assertOutputQuiet(taskA)
    await openRunning(); await assertOutput(jobA)
    held = { jobId: jobA }
    const delayedMarker = 'A_DELAYED_OWNER_ONLY'
    append(jobA, 'stderr', `${delayedMarker}\n`)
    await expect.poll(() => Boolean(held?.response)).toBe(true)
    expect(held?.body).toContain(delayedMarker)
    await selectTask(taskB); await openRunning()
    await expect(panel()).toHaveAttribute('data-session-id', taskB)
    await assertOutput(jobB)
    await assertNavigationSpace('multiple-turns-b', 2)
    releaseOutput()
    await expect(output()).not.toContainText('A_STDOUT_INITIAL')
    await assertOutputQuiet(taskA)
    await assertOutput(jobB)
    await expect(output()).not.toContainText(delayedMarker)
    append(jobB, 'stderr', 'B_AFTER_SWITCH\n'); await assertOutput(jobB)
    await selectTask(taskA); await openRunning(); await assertOutput(jobA)
  })

  test('停止读取最后日志，重启选择新job并保留旧历史', async () => {
    await assertOutput(jobA)
    const actionStart = actions.length
    await detail().getByRole('button', { name: '停止命令', exact: true }).click()
    await expect(detail()).toHaveAttribute('data-status', 'cancelled')
    await assertOutput(jobA)
    expect(actions.slice(actionStart)).toEqual([{ action: 'cancel', sessionId: taskA, jobId: jobA }])
    await expect(output()).toContainText(`STOP_TAIL_${jobA}`)
    await detail().getByRole('button', { name: '重启服务', exact: true }).click()
    await expect.poll(() => actions.at(-1)?.action).toBe('restart')
    const restarted = actions.at(-1)!.nextId!
    expect(restarted).not.toBe(jobA)
    await assertOutput(restarted)
    await expect(detail()).toHaveAttribute('data-status', 'running')
    await expect(panel().locator(`.work-terminal-panel__job[data-job-id="${jobA}"]`)).toHaveAttribute('data-status', 'cancelled')
    await expect(output()).not.toContainText('A_STDOUT_INITIAL')
  })

  test('更多工作区与快捷键打开同款终端，真实PTY保留任务目录归属和关闭重开后的原输出', async ({}, info) => {
    await workspace().getByRole('button', { name: '关闭终端', exact: true }).click()
    await expect(panel()).toBeHidden()
    await openTerminalFromMenu()
    await expect(workspace().getByRole('tablist', { name: '已打开的工作区', exact: true }).getByRole('tab', { name: '终端', exact: true })).toHaveAttribute('aria-selected', 'true')
    await workspace().getByRole('button', { name: '关闭终端', exact: true }).click()
    await expect(panel()).toBeHidden()
    await page.keyboard.press('Control+Backquote')
    await expect(panel()).toBeVisible()
    await panel().getByRole('tablist', { name: '终端视图', exact: true }).getByRole('tab', { name: '终端', exact: true }).click()
    await expect(terminal()).toBeVisible()
    const capability = await Promise.race([
      terminal().locator('.xterm-helper-textarea').waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'ready' as const),
      terminal().getByRole('alert').waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'unavailable' as const)
    ])
    const receipts = await terminalReceipts(), workCreate = receipts.findLast(receipt => receipt.input.sessionId === taskA)
    expect(workCreate?.input).toMatchObject({ cwd: cwdA, sessionId: taskA })
    if (capability === 'unavailable') {
      await expect(terminal().getByRole('alert')).toContainText('终端启动失败')
      await expect(terminal().locator('.terminal-view__error-detail')).toContainText(/Cannot launch conpty|ConPTY|spawn|EPERM|EACCES/i)
      await expect(terminal().getByRole('button', { name: '重试', exact: true })).toBeEnabled()
      expect(workCreate?.error).toMatch(/Cannot launch conpty|ConPTY|spawn|EPERM|EACCES/i)
      info.annotations.push({ type: 'environment-capability', description: '本机PTY不可用，已验证创建归属与可见失败/重试；真实输入和挂载保持不适用于此环境。' })
      return
    }
    expect(workCreate?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    const cwdProof = join(cwdA, 'actual-terminal-cwd.txt'), marker = 'WORK_PTY_READY_A'
    await terminal().locator('.xterm-helper-textarea').focus()
    await page.keyboard.type(`[IO.File]::WriteAllText(${psQuote(cwdProof)}, (Get-Location).Path); [Console]::WriteLine('WORK_'+'PTY_READY_A')`)
    await page.keyboard.press('Enter')
    await expect.poll(() => existsSync(cwdProof) ? resolve(readFileSync(cwdProof, 'utf8').trim()).toLowerCase() : '').toBe(resolve(cwdA).toLowerCase())
    await expect.poll(() => copyTerminal(terminal())).toContain(marker)
    await terminal().locator('.xterm').evaluate(element => { element.setAttribute('data-e2e-terminal-identity', 'work-original') })
    const createdCount = (await terminalReceipts()).filter(receipt => receipt.input.sessionId === taskA).length
    await workspace().getByRole('button', { name: '关闭终端', exact: true }).click()
    await expect(panel()).toBeHidden()
    await openTerminalFromMenu()
    await panel().getByRole('tablist', { name: '终端视图', exact: true }).getByRole('tab', { name: '终端', exact: true }).click()
    await expect(terminal().locator('.xterm[data-e2e-terminal-identity="work-original"]')).toBeVisible()
    expect((await terminalReceipts()).filter(receipt => receipt.input.sessionId === taskA)).toHaveLength(createdCount)
    expect(await copyTerminal(terminal())).toContain(marker)
    await expect(terminal().locator('.xterm[data-e2e-terminal-identity="work-original"]')).toBeVisible()
    expect(await copyTerminal(terminal())).toContain(marker)
    const path = info.outputPath('work-native-terminal.png'); await page.screenshot({ path }); await info.attach('真实任务终端', { path, contentType: 'image/png' })
  })

  test('收起整个工作区后菜单恢复所选记录和旧日志位置，深浅主题宽窄布局可读', async ({}, info) => {
    await setWindow(1440, 900)
    await panel().getByRole('tab', { name: /^后台运行/ }).click()
    // Independent entries require multiple cursor pages on a remount, exposing
    // restoration that accidentally follows a partially loaded tail.
    for (let index = 1; index <= 80; index++) append(idleJobA, index % 9 === 0 ? 'stderr' : 'stdout', `SAVED_RECORD_LINE_${String(index).padStart(3, '0')}\n`)
    const selectedRow = panel().locator(`.work-terminal-panel__job[data-job-id="${idleJobA}"]`)
    await selectedRow.click()
    await assertOutput(idleJobA)
    await expect(selectedRow).toHaveAttribute('aria-current', 'true')
    const maximum = await output().evaluate(element => element.scrollHeight - element.clientHeight)
    expect(maximum).toBeGreaterThan(300)
    const target = Math.round(maximum * 0.4)
    await output().hover()
    await page.mouse.wheel(0, target - maximum)
    await expect.poll(async () => Math.abs(await output().evaluate(element => element.scrollTop) - target)).toBeLessThanOrEqual(2)
    await expect(panel().getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
    const remembered = await logAnchor()
    expect(Number(remembered.seq)).toBeGreaterThan(1)
    expect(Number(remembered.seq)).toBeLessThan(logs.get(idleJobA)!.length - 5)

    await work().getByRole('button', { name: '收起工作区', exact: true }).click()
    // A hidden-but-mounted panel would not exercise the saved reading state.
    await expect(work().locator('.work-workspace')).toHaveCount(0)
    append(idleJobA, 'stdout', 'SAVED_RECORD_WHILE_WORKSPACE_CLOSED\n')
    await assertOutputQuiet(taskA)
    await openTerminalFromMenu()
    await expect(panel().getByRole('tab', { name: /^后台运行/ })).toHaveAttribute('aria-selected', 'true')
    await assertOutput(idleJobA)
    await expect(selectedRow).toHaveAttribute('aria-current', 'true')
    await expect(panel().getByRole('button', { name: '回到最新', exact: true })).toBeVisible()
    await expect.poll(async () => (await logAnchor()).seq).toBe(remembered.seq)
    await expect.poll(async () => Math.abs((await logAnchor()).offset - remembered.offset)).toBeLessThanOrEqual(2)
    await expect.poll(async () => Math.abs((await logAnchor()).top - remembered.top)).toBeLessThanOrEqual(2)

    for (const appearance of ['light', 'dark'] as const) for (const width of [1440, 980]) {
      await setWindow(width, 900)
      await setAppearance(appearance)
      await expect(detail()).toHaveAttribute('data-job-id', idleJobA)
      await expect(output()).toBeVisible()
      await expect(selectedRow).toHaveAttribute('aria-current', 'true')
      await settleMotion(work())
      await selectedRow.focus(); await settleMotion(work())
      const focusedFill = await selectedRow.evaluate(element => getComputedStyle(element).backgroundColor)
      await output().focus(); await page.mouse.move(0, 0); await settleMotion(work())
      const restingFill = await selectedRow.evaluate(element => getComputedStyle(element).backgroundColor)
      const channels = restingFill.match(/[\d.]+/g)?.map(Number)
      expect(channels, 'An inactive selected record must retain a subtle neutral fill').toHaveLength(4)
      expect(Math.max(...channels!.slice(0, 3)) - Math.min(...channels!.slice(0, 3))).toBeLessThanOrEqual(3)
      expect(channels![3]).toBeGreaterThan(0)
      expect(channels![3]).toBeLessThanOrEqual(0.25)
      expect(focusedFill, 'Keyboard focus must be distinguishable from the inactive selection').not.toBe(restingFill)
      const dimensions = await output().evaluate(element => ({ width: element.clientWidth, height: element.clientHeight, overflow: element.scrollWidth - element.clientWidth }))
      expect(dimensions.width).toBeGreaterThan(120)
      expect(dimensions.height).toBeGreaterThan(100)
      expect(dimensions.overflow).toBeLessThanOrEqual(2)
      const path = info.outputPath(`work-terminal-${appearance}-${width}.png`)
      await page.screenshot({ path })
      await info.attach(`任务终端 ${appearance} ${width}px`, { path, contentType: 'image/png' })
    }
  })

  test('单轮与多轮正文和输入框左右对齐，主栏及工作区在宽窄窗口和深浅主题下保持一致', async ({}, info) => {
    const conversation = work().getByRole('region', { name: '协作对话', exact: true })
    const measure = () => conversation.evaluate(element => {
      const conversationBox = element.getBoundingClientRect()
      const content = element.querySelector<HTMLElement>('.work-conversation__content')!
      const contentBox = content.getBoundingClientRect(), style = getComputedStyle(content)
      const composer = element.querySelector('.work-composer')!.getBoundingClientRect()
      const scroll = element.querySelector('.work-conversation__scroll')!
      const contentLeft = contentBox.left + parseFloat(style.paddingLeft)
      const contentRight = contentBox.right - parseFloat(style.paddingRight)
      return {
        conversationLeft: conversationBox.left, conversationRight: conversationBox.right,
        contentLeft, contentRight,
        composerLeft: composer.left, composerRight: composer.right,
        contentMarginLeft: contentLeft - conversationBox.left, contentMarginRight: conversationBox.right - contentRight,
        composerMarginLeft: composer.left - conversationBox.left, composerMarginRight: conversationBox.right - composer.right,
        contentWidth: contentBox.width, scrollWidth: scroll.clientWidth
      }
    })
    for (const id of [taskA, taskB]) {
      // The narrow sidebar deliberately hides its task list; selecting at the
      // desktop width exercises the same task without using hidden controls.
      await setWindow(1440, 900)
      await selectTask(id)
      for (const appearance of ['light', 'dark'] as const) {
        await setAppearance(appearance)
        for (const width of [1440, 2000, 980]) {
          await setWindow(width, 900)
          // Wait for the task surface after resize before reading the toggle's
          // intent. A one-shot visibility probe can skip closing the workspace
          // when the control is temporarily absent.
          await expect(work().getByRole('heading', { name: titles.get(id), exact: true })).toBeVisible()
          const workspaceToggle = work().getByRole('button', { name: /^(?:打开|收起)工作区$/ })
          await expect(workspaceToggle).toBeVisible()
          await expect(workspaceToggle).toHaveAttribute('aria-pressed', /^(?:true|false)$/)
          if (await workspaceToggle.getAttribute('aria-pressed') === 'true') await workspaceToggle.click()
          await expect(workspaceToggle).toHaveAttribute('aria-pressed', 'false')
          await expect(work().locator('.work-workspace')).toHaveCount(0)
          await expect(work().locator('.work-task-body')).toHaveAttribute('data-pane', 'conversation')
          for (const workspaceOpen of [false, true]) {
            if (workspaceOpen) {
              await workspaceToggle.click()
              await expect(workspaceToggle).toHaveAttribute('aria-pressed', 'true')
              await expect(work().locator('.work-workspace')).toHaveCount(1)
              await expect(work().locator('.work-task-body')).toHaveAttribute('data-workspace', 'true')
              // At 980px Work intentionally shows one pane at a time. Keep the
              // workspace open and return to conversation before measuring.
              if (width <= 990) {
                const conversationTab = work().locator('.work-mobile-tabs').getByRole('button', { name: '协作对话', exact: true })
                await expect(conversationTab).toBeVisible(); await conversationTab.click()
                await expect(conversationTab).toHaveAttribute('aria-pressed', 'true')
                await expect(work().locator('.work-task-body')).toHaveAttribute('data-pane', 'conversation')
              } else await expect(workspace()).toBeVisible()
            }
            await expect(conversation).toBeVisible()
            await expect(conversation.locator('.work-conversation-turn')).toHaveCount(id === taskA ? 1 : 2)
            await expect(conversation.locator('.work-composer')).toBeVisible()
            await settleMotion(work())
            const state = `${id}/${appearance}/${width}/${workspaceOpen ? 'workspace' : 'full'}`
            let geometry = await measure()
            composerGeometry.push({ state, workspaceOpen, ...geometry })
            await expect.poll(async () => {
              geometry = await measure()
              composerGeometry[composerGeometry.length - 1] = { state, workspaceOpen, ...geometry }
              return Math.max(
                Math.abs(geometry.contentLeft - geometry.composerLeft), Math.abs(geometry.contentRight - geometry.composerRight),
                Math.abs(geometry.contentMarginLeft - geometry.contentMarginRight),
                Math.abs(geometry.composerMarginLeft - geometry.composerMarginRight)
              )
            }, { message: `${state}: message and prompt edges must align with equal outer margins inside the conversation` }).toBeLessThanOrEqual(1)
            if (width === 2000 && !workspaceOpen) {
              expect(Math.abs(geometry.contentWidth - 880)).toBeLessThanOrEqual(1)
              expect(geometry.scrollWidth - geometry.contentWidth).toBeGreaterThan(100)
            }
            if (id === taskA && appearance === 'light' && width === 2000 && !workspaceOpen ||
              id === taskB && appearance === 'dark' && width === 1440 && workspaceOpen) {
              const path = info.outputPath(`work-composer-alignment-${appearance}-${width}-${workspaceOpen ? 'split' : 'full'}.png`)
              await page.screenshot({ path })
              await info.attach(`正文与输入框对齐 ${state}`, { path, contentType: 'image/png' })
            }
          }
        }
      }
    }
    expect(composerGeometry).toHaveLength(24)
  })
})
