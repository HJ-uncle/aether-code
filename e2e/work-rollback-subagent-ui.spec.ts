/** Isolated Electron + authenticated HTTP/SSE regression: rolling back a turn
 * removes its cached children and usage, preserves earlier children, and keeps
 * the next send free of orphan cards/footers. No model or user data is touched. */
import { _electron as electron, expect, test, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { SubagentRun } from '../src/shared/subagent'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { toSubagentView } from '../src/renderer/src/core/engine/subagent-state'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtures = join(root, '.e2e-tmp')
const sessionId = 'work-rollback-children', title = '回退后重新发送与协作统计', modelId = 'rollback-child-model'
const token = 'rollback-child-token', workspaceRoot = '/remote/rollback-children', now = Date.now() - 900_000
const keptPrompt = '保留此前已完成的需求', removedPrompt = '回退这一轮并重新发送', newAnswer = '重发后的新结果'
const errors: string[] = [], writes: string[] = [], admissions = new Map<string, Record<string, unknown>>()
const roots: RootRun[] = [], children: SubagentRun[] = [], rows: EngineHistoryRow[] = [], projection: ChatSsePayload[] = []
let app: ElectronApplication | undefined, page: Page, fixture = '', stage = 0, activeStream: ServerResponse | undefined
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

function makeRoot(ordinal: number, startedAt: number, duration: number): RootRun {
  return { schemaVersion: 1, runId: `rollback-root-${ordinal}`, sessionId, turnId: `rollback-turn-${ordinal}`,
    userMessageId: `rollback-user-${ordinal}`, assistantMessageId: `rollback-answer-${ordinal}`, seq: ordinal, version: 2,
    status: 'succeeded', modelId, pending: [], workspacePaths: [workspaceRoot], createdAt: startedAt,
    startedAt, updatedAt: startedAt + duration, finishedAt: startedAt + duration }
}
function child(run: RootRun, suffix: string, tokens: number): SubagentRun {
  return { schemaVersion: 1, tenantId: 'rollback-tenant', runId: `child-${suffix}`, parentSessionId: sessionId,
    rootSessionId: sessionId, childSessionId: `child-session-${suffix}`, parentConversationId: run.turnId,
    parentMessageId: `call-${suffix}`, parentToolCallId: `tool-${suffix}`, status: 'succeeded',
    task: `CHILD_${suffix}`, description: '', modelId, agentName: '执行', lastSeq: 2,
    createdAt: run.createdAt, startedAt: run.startedAt, updatedAt: run.updatedAt, finishedAt: run.finishedAt,
    durationMs: run.finishedAt! - run.createdAt, usage: { totalTokens: tokens }, toolCalls: [], resultSummary: `RESULT_${suffix}` }
}
function appendTurn(run: RootRun, prompt: string, runs: SubagentRun[], parentTokens: number, answer: string): void {
  roots.push(run); children.push(...runs)
  const metadata = { rootRunId: run.runId, turnId: run.turnId }
  rows.push({ id: run.userMessageId, role: 'user', content: prompt, createdAt: run.createdAt,
    conversationId: run.turnId, metadata })
  for (const item of runs) {
    rows.push({ id: item.parentMessageId, role: 'assistant', content: '', createdAt: run.createdAt + 1,
      conversationId: run.turnId, metadata, toolCall: { id: item.parentToolCallId, name: 'subagent_start', args: { task: item.task } } },
    { id: `result-${item.runId}`, role: 'tool', content: item.resultSummary, createdAt: item.finishedAt,
      conversationId: run.turnId, toolCallId: item.parentToolCallId, success: true, metadata: { ...metadata, subagent: item } })
  }
  rows.push({ id: run.assistantMessageId, role: 'assistant', content: answer, modelId, createdAt: run.finishedAt,
    conversationId: run.turnId, usage: { totalTokens: parentTokens, promptTokens: parentTokens, completionTokens: 0 }, metadata })
}
const kept = makeRoot(1, now, 30_000), removed = makeRoot(2, now + 100_000, 297_365)
appendTurn(kept, keptPrompt, [child(kept, 'kept', 1000)], 200, '此前结果应继续保留。')
appendTurn(removed, removedPrompt, [child(removed, 'removed-a', 143847), child(removed, 'removed-b', 496410)], 0, '这一轮即将撤回。')
const current = (): RootRun | undefined => roots.at(-1)
function publish(payload: ChatSsePayload): void {
  projection.push(payload)
  activeStream?.write(`id: ${current()!.runId}:${projection.length}\ndata: ${JSON.stringify(payload)}\n\n`)
}
function completeNewTurn(): void {
  const running = current()!
  const done = { ...running, status: 'succeeded' as const, version: running.version + 1, updatedAt: Date.now(), finishedAt: Date.now() }
  const freshChild = child(done, 'fresh', 2000)
  roots.pop(); rows.splice(rows.findIndex(row => row.id === running.userMessageId))
  appendTurn(done, removedPrompt, [freshChild], 100, newAnswer)
  publish({ toolStart: { id: freshChild.parentToolCallId, name: 'subagent_start', args: { task: freshChild.task } } })
  publish({ toolEnd: { id: freshChild.parentToolCallId, name: 'subagent_start', output: freshChild.resultSummary, success: true, subagent: freshChild } })
  publish({ content: newAnswer }); publish({ usage: { totalTokens: 100, promptTokens: 100, completionTokens: 0 } })
  publish({ run: done }); activeStream?.end('data: [DONE]\n\n'); activeStream = undefined
}

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? url.searchParams.get('parentSessionId') ?? ''
  let raw = ''; for await (const chunk of request) raw += chunk.toString()
  const parsed: unknown = raw ? JSON.parse(raw) : {}, body = isRecord(parsed) ? parsed : {}
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  if (path === '/api/v1/changes/revert-preview' || path === '/api/v1/changes/revert-batch') {
    expect(body.sessionId).toBe(sessionId); expect(body.fromTurnId).toBe(removed.turnId)
    if (path.endsWith('revert-batch')) writes.push(path)
    response.end(envelope(path.endsWith('revert-preview') ? { total: 0, changes: [] }
      : { total: 0, reverted: 0, conflicts: 0, unavailable: 0, failed: 0, results: [] })); return
  }
  if (path === '/api/v1/conversation/truncate') {
    expect(body).toEqual({ sessionId, messageId: removed.userMessageId }); expect(writes).toEqual(['/api/v1/changes/revert-batch'])
    rows.splice(rows.findIndex(row => row.id === removed.userMessageId)); roots.splice(1)
    children.splice(0, children.length, ...children.filter(run => run.parentConversationId !== removed.turnId))
    stage = 1; writes.push(path); response.end(envelope({ success: true })); return
  }
  if (path === '/api/v1/chat/admission/context') {
    const run = id === sessionId ? current() : undefined
    const matching = run ? { ...run, attemptId: `attempt-${run.runId}` } : null
    response.end(envelope({ protocolVersion: 1, tenantId: 'rollback-tenant', sessionId: id,
      namespace: { id: 'rollback-child-db', generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 },
      root: matching, predecessor: matching ? { runId: matching.runId, attemptId: matching.attemptId, version: matching.version } : null })); return
  }
  if (path === '/api/v1/chat/admission/receipt') {
    const admission = admissions.get(String(body.requestKey)), run = current()!
    response.end(envelope(admission ? { protocolVersion: 1, status: 'accepted', receipt: { ...admission, sessionId,
      rootRunId: run.runId, turnId: run.turnId, userMessageId: run.userMessageId, assistantMessageId: run.assistantMessageId }, run,
      projection: { rootVersion: run.version, rootAttemptId: `attempt-${run.runId}`, user: { messageId: run.userMessageId, state: 'projected' },
        assistant: { anchorMessageId: run.assistantMessageId, state: 'persisted', messageId: run.assistantMessageId } } }
      : { protocolVersion: 1, status: 'absent', namespace: body.namespace, sessionId: body.sessionId, requestKey: body.requestKey })); return
  }
  if (path === '/api/v1/chat' && request.method === 'POST') {
    expect(stage).toBe(1); expect(body.message).toBe(removedPrompt); expect(body.sessionId).toBe(sessionId)
    const run = { ...makeRoot(3, Date.now(), 0), status: 'running' as const, version: 1, finishedAt: undefined }
    roots.push(run); stage = 2; writes.push(path)
    const user: EngineHistoryRow = { id: run.userMessageId, role: 'user', content: removedPrompt, createdAt: run.createdAt,
      conversationId: run.turnId, metadata: { rootRunId: run.runId, turnId: run.turnId } }
    rows.push(user)
    if (isRecord(body.admission)) admissions.set(String(body.admission.requestKey), body.admission)
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); activeStream = response
    response.once('close', () => { if (activeStream === response) activeStream = undefined })
    publish({ run }); publish({ userMessage: user }); return
  }
  if (path === '/api/v1/chat/stream') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    if (current()?.status === 'running') { activeStream = response; response.flushHeaders() }
    else response.end('data: [DONE]\n\n')
    return
  }
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  const matching = id === sessionId ? current() : undefined, history = matching ? rows : [], childRuns = matching ? children.map(toSubagentView) : []
  if (path === '/api/v1/conversation/display') {
    const users = history.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id, conversationId: row.conversationId,
      preview: row.content, createdAt: row.createdAt })), messages: history, loadedTurnIds: users.map(row => row.id),
      revision: `children-${stage}-${rows.length}`, mutationRevision: `children-${stage}`, backend: 'jsonl', completeness: 'complete' })); return
  }
  const parentTokens = history.reduce((sum, row) => sum + Number((row.usage as { totalTokens?: number } | undefined)?.totalTokens ?? 0), 0)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'b'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'rollback-child-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '回退测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: matching && projection.length ? 'live' : 'persisted',
      eventId: matching && projection.length ? `${matching.runId}:${projection.length}` : null, finished: matching?.status !== 'running',
      history, projection: matching ? projection : [], run: matching, runs: matching ? roots : [], subagentRuns: childRuns, todos: [], changes: [], commandJobs: [],
      sessionUsage: { totalTokens: parentTokens, promptTokens: parentTokens, completionTokens: 0 },
      sessionSubagentUsage: { totalTokens: childRuns.reduce((sum, run) => sum + (run.usage.totalTokens ?? 0), 0), count: childRuns.length, unknown: 0 } }
    : path === '/api/v1/chat/status' ? { running: matching?.status === 'running', finished: matching?.status !== 'running', run: matching,
      lastEventId: matching && projection.length ? `${matching.runId}:${projection.length}` : null }
    : path === '/api/v1/chat/runs' ? { runs: matching ? roots : [] }
    : path === '/api/v1/conversation/history' ? history
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: current()!.updatedAt, messageCount: rows.length }]
    // A bounded observation does not authorize deleting unlisted cached runs.
    // History mutation itself must retire them, before merging its snapshot.
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: childRuns, listComplete: false, hasMore: false, revision: `children-${stage}` }
    : path.startsWith('/api/v1/subagent/runs/') ? children.find(run => path.endsWith(`/${run.runId}`))
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: workspaceRoot, bindingEpoch: 'one', entries: [] }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const work = (): Locator => page.locator('.work-view')
const turn = (ordinal: number): Locator => work().locator(`.work-conversation-turn[data-turn-id="message:rollback-user-${ordinal}"]`)
test.beforeAll(async () => {
  mkdirSync(fixtures, { recursive: true }); fixture = mkdtempSync(join(fixtures, 'rollback-child-profile-'))
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  const origin = `http://127.0.0.1:${address.port}`
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true,
    remoteWorkspaceRoot: workspaceRoot, lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'light' }))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1400, 1050) })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await page.evaluate(({ key, sessionId, title, now, modelId }) => {
    localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'done', draft: '', createdAt: now,
      updatedAt: now, workspacePath: null, modelId, attachments: [], sources: [] }], activeTaskId: sessionId }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
  }, { key: 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin })), sessionId, title, now, modelId })
  await page.reload(); await expect(work().getByRole('heading', { name: title, exact: true })).toBeVisible()
})
test.afterEach(async ({}, info) => {
  if (page && !page.isClosed()) await page.screenshot({ path: info.outputPath('rollback-child-state.png'), animations: 'disabled' })
  if (info.status !== info.expectedStatus) writeFileSync(info.outputPath('rollback-child-diagnostics.json'), JSON.stringify({ errors, writes, stage, roots, children }, null, 2))
})
test.afterAll(async () => {
  activeStream?.end(); activeStream = undefined
  try { await app?.close() } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      if (dirname(resolve(fixture)) !== fixtures || !basename(fixture).startsWith('rollback-child-profile-')) throw new Error('Unsafe fixture cleanup')
      rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

test('rollback and resend remove old child cards and 640.3k usage without dropping retained/new children', async () => {
  await expect(work().locator('.work-conversation-turn')).toHaveCount(2)
  await expect(turn(1).locator('.turn-usage__value')).toHaveText('1.2k')
  await expect(turn(2).locator('.turn-usage__value')).toHaveText('640.3k')
  await expect(work().locator('.usage-meter__tokens')).toHaveText('641.5k')
  await expect(turn(2).locator('.turn-usage')).toContainText('4m57s')
  await turn(2).getByRole('button', { name: '回退文件', exact: true }).click()
  await page.getByRole('dialog', { name: '回退文件', exact: true }).getByRole('button', { name: '回退文件', exact: true }).click()
  await expect.poll(() => stage).toBe(1)
  await expect(work().locator('.work-conversation-turn')).toHaveCount(1)
  await expect(turn(1).locator('.turn-usage__value')).toHaveText('1.2k')
  await expect(work().locator('.usage-meter__tokens')).toHaveText('1.2k')
  await expect(work().locator('.turn-usage')).toHaveCount(1)
  await expect(work()).not.toContainText('640.3k')
  await expect(work()).not.toContainText('4m57s')
  await turn(1).locator('.work-message__process-toggle').click()
  await expect(turn(1).locator('[data-run-id="child-kept"]')).toBeVisible()
  await expect(work().locator('[data-work-tool-id="tool-removed-a"], [data-work-tool-id="tool-removed-b"]')).toHaveCount(0)
  const input = work().locator('[contenteditable="true"]').first()
  await expect(input).toContainText(removedPrompt); await input.press('Enter')
  await expect.poll(() => stage).toBe(2)
  await expect(turn(3)).toBeVisible()
  await expect(work().locator('.work-conversation-turn')).toHaveCount(2)
  await expect(turn(3).locator('.turn-usage')).toHaveCount(0)
  await expect(work()).not.toContainText('640.3k')
  completeNewTurn()
  await expect(turn(3)).toContainText(newAnswer)
  await expect(turn(3).locator('.turn-usage__value')).toHaveText('2.1k')
  await expect(work().locator('.usage-meter__tokens')).toHaveText('3.3k')
  await expect(work().locator('.turn-usage')).toHaveCount(2)
  await page.reload()
  await expect(work().locator('.work-conversation-turn')).toHaveCount(2)
  await expect(turn(1).locator('.turn-usage__value')).toHaveText('1.2k')
  await expect(turn(3).locator('.turn-usage__value')).toHaveText('2.1k')
  await expect(work().locator('.usage-meter__tokens')).toHaveText('3.3k')
  await expect(work()).not.toContainText('640.3k')
  expect(writes).toEqual(['/api/v1/changes/revert-batch', '/api/v1/conversation/truncate', '/api/v1/chat'])
  expect(errors).toEqual([])
})
