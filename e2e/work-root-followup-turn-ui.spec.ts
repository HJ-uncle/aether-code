/** Real Electron + authenticated SSE: controller supplements stay inside their
 * original Work turn and one process disclosure, survive history reload, and
 * do not duplicate usage or absorb the next independent turn. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { RootRun } from '../src/shared/root-run'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'work-root-followup-turn-fixture', model = 'work-root-followup-turn-model'
const sessionId = 'work-root-followup-turn', title = '本轮补充归并验收'
const prompt = '完成报告，并保留所有检查过程。', finalText = 'FOLLOWUP_FINAL：报告已按本轮补充要求完成。'
const followupText = '请补充核验以下内容：' + '保留原任务目标，检查引用来源、数据范围和结论。'.repeat(8) + '\nFOLLOWUP_FULL_BODY_END'
const originalAttachment = { name: '.ae/attachments/original.txt', type: 'text/plain', size: 128 }
const followupAttachment = { name: '.ae/attachments/followup.txt', type: 'text/plain', size: 128 }
const now = Date.now() - 10_000
let run: RootRun = { schemaVersion: 1, runId: 'followup-root-run', sessionId, turnId: 'followup-root-turn',
  userMessageId: 'followup-original-user', assistantMessageId: 'followup-final-assistant', version: 1, seq: 1,
  status: 'running', modelId: model, pending: [], workspacePaths: [], createdAt: now, updatedAt: now }
const metadata = () => ({ rootRunId: run.runId, turnId: run.turnId })
const history: EngineHistoryRow[] = [{ id: run.userMessageId, role: 'user', content: prompt, conversationId: run.turnId,
  createdAt: now, metadata: { ...metadata(), attachments: [originalAttachment] } }]
const projection: ChatSsePayload[] = [], runs: RootRun[] = [run]
const errors: string[] = [], displayGrouping: Array<string | null> = []
let sequence = 1, stream: ServerResponse | undefined
let fixture = '', app: ElectronApplication | undefined, health: ElectronHealthMonitor | undefined, page: Page
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })

function emit(payload: ChatSsePayload): void {
  if (!stream || stream.destroyed || stream.writableEnded) throw new Error('No active followup SSE subscriber')
  projection.push(payload)
  stream.write(`id: ${run.runId}:${++sequence}\ndata: ${JSON.stringify(payload)}\n\n`)
}
function step(id: string, content: string, time: number, usage: { promptTokens: number; completionTokens: number; totalTokens: number }): void {
  history.push({ id: `${id}-assistant`, role: 'assistant', content, conversationId: run.turnId, createdAt: time,
    modelId: model, metadata: metadata(), usage, toolCall: { id, name: 'read_file', args: { path: `${id}.md` } } },
  { id: `${id}-result`, role: 'tool', content: `${id} checked`, toolCallId: id, conversationId: run.turnId, createdAt: time + 1, metadata: { success: true } })
  emit({ content }); emit({ toolStart: { id, name: 'read_file', args: { path: `${id}.md` } } })
  emit({ toolEnd: { id, name: 'read_file', output: `${id} checked`, success: true } })
}
function display(url: URL) {
  displayGrouping.push(url.searchParams.get('groupRootFollowups'))
  const users = history.filter(row => runs.some(owner => owner.userMessageId === row.id))
  return { schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id, conversationId: row.conversationId,
    preview: String(row.content), createdAt: row.createdAt })), messages: history, loadedTurnIds: users.map(row => row.id),
    revision: `followup:${sequence}:${history.length}`, mutationRevision: 'followup:unchanged', backend: 'jsonl', completeness: 'complete' }
}
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated fixture request: ${path}`)
    for await (const _chunk of request) { /* Drain request bodies; this read-only fixture never calls a model. */ }
    const requested = url.searchParams.get('sessionId') ?? '', own = requested === sessionId, live = own && run.status === 'running'
    if (path === '/api/v1/chat' && request.method === 'POST') throw new Error('Unexpected model request')
    if (path === '/api/v1/chat/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); response.flushHeaders()
      if (live) { stream = response; return }
      response.end('data: [DONE]\n\n'); return
    }
    if (path === '/api/v1/cron/capabilities' || path === '/api/v1/workbench/clients') {
      response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 404, message: 'Unsupported fixture capability' })); return
    }
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: 'sha256:' + 'f'.repeat(64), protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'work-root-followup-turn' }
      : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '补充归并测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
      : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: requested, source: live ? 'live' : 'persisted', finished: !live,
        eventId: live ? `${run.runId}:${sequence}` : null, projection: live ? projection : [], history: own ? history : [],
        run: own ? run : undefined, runs: own ? runs : [], todos: [], changes: [], commandJobs: [], subagentRuns: [] }
      : path === '/api/v1/chat/status' ? { running: live, finished: own && !live, run: own ? run : undefined }
      : path === '/api/v1/chat/runs' ? { runs: own ? runs : [] }
      : path === '/api/v1/conversation/history' ? own ? history : []
      : path === '/api/v1/conversation/display' ? display(url)
      : path === '/api/v1/conversation/sessions' ? [{ sessionId, title, lastAt: now, messageCount: history.length }]
      : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'followup-fixture', sessionId: requested,
        namespace: { id: 'followup-db', generation: 'one' }, transport: { toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 },
        root: own ? { ...run, attemptId: 'followup-attempt' } : null, predecessor: own ? { runId: run.runId, attemptId: 'followup-attempt', version: run.version } : null }
      : path === '/api/v1/security/mode' ? { sessionId: requested, mode: 'standard' }
      : path === '/api/v1/memory/settings' ? { sessionId: requested, memoryScope: 'session', effectiveScope: 'session', enabled: false }
      : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
      : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'followup' }
      : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, durableQueueReceipts: false, receiptPagination: false, runtimeCommunication: false, mailboxConsumer: false, userControllerMutation: false, rootUserControllerMutation: false }
      : path === '/api/v1/command-jobs' ? { jobs: [] }
      : path === '/api/v1/workspace/directory' ? { root: '/remote/followup-turn', entries: [] }
      : /^\/api\/v1\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
      : []
    response.setHeader('content-type', 'application/json'); response.end(envelope(data))
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(envelope(null)) })
})

const work = () => page.locator('.work-view')
const conversation = () => work().getByRole('region', { name: '协作对话', exact: true })
const turns = () => conversation().locator('section.work-conversation-turn[data-turn-id]')
const firstTurn = () => conversation().locator('section.work-conversation-turn[data-turn-id="message:followup-original-user"]')
const processToggle = () => firstTurn().locator('.work-message__process-toggle')
const followup = () => firstTurn().locator('.work-message__followup')
async function openProcess(): Promise<void> {
  await expect(processToggle()).toHaveCount(1)
  if (await processToggle().getAttribute('aria-expanded') !== 'true') await processToggle().click()
  await expect(followup()).toBeVisible()
}
async function expectFollowupContent(): Promise<void> {
  const bubble = followup().locator('.message__bubble')
  const originalBubble = firstTurn().locator('article[data-message-id="followup-original-user"] .message__bubble')
  await expect(bubble).toBeVisible()
  await expect(bubble).toHaveText(followupText)
  const appearance = (element: Element) => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, radius: style.borderRadius, fontSize: style.fontSize,
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft] }
  }
  expect(await bubble.evaluate(appearance)).toEqual(await originalBubble.evaluate(appearance))
  await expect.poll(async () => Math.abs(await bubble.evaluate(element => element.getBoundingClientRect().right)
    - await originalBubble.evaluate(element => element.getBoundingClientRect().right))).toBeLessThanOrEqual(1)
  const originalChip = firstTurn().locator('article[data-message-id="followup-original-user"] .attach-chip')
  const followupChip = followup().locator('.work-message__attachments .attach-chip')
  await expect(originalChip.locator('.attach-chip__name')).toHaveText('original.txt')
  await expect(followupChip.locator('.attach-chip__name')).toHaveText('followup.txt')
  await expect(followupChip.locator('.attach-chip__size')).toHaveText('128 B')
  await expect(followupChip.getByRole('button')).toHaveAttribute('title', '查看 followup.txt')
  expect(await followupChip.getAttribute('class')).toBe(await originalChip.getAttribute('class'))
}
async function expectOneTurn(): Promise<void> {
  await expect(turns()).toHaveCount(1)
  await expect(firstTurn().locator('article.work-message--user')).toHaveCount(1)
  await expect(firstTurn().locator('article.work-message--user')).toContainText(prompt)
  await expect(processToggle()).toHaveCount(1)
  await expect(firstTurn().locator('.turn-usage__value')).toHaveText('330')
  await expect(work().locator('.usage-meter__tokens')).toHaveText('330')
}

test.describe.serial('Work 本轮补充归入原过程', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing followup fixture port')
    const origin = `http://127.0.0.1:${address.port}`, source = engineStorageKey({ mode: 'remote', baseUrl: origin })
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'work-root-followup-turn-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true, lastModelId: model, appearance: 'light', lastFolder: '' }))
    const env = { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || process.env.AETHER_E2E_MAIN || '.', `--user-data-dir=${fixture}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'work-root-followup-turn', [token])
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 1000))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.evaluate(({ key, task }) => {
      localStorage.setItem(key, JSON.stringify({ tasks: [task], activeTaskId: task.id }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', workspace: false }))
    }, { key: 'aether.work.state.v1:' + encodeURIComponent(source), task: { id: sessionId, title, status: 'running', draft: '',
      createdAt: now, updatedAt: now, workspacePath: null, modelId: model, attachments: [], sources: [] } })
    await page.reload()
    await expect(work().getByRole('heading', { name: title, exact: true })).toBeVisible()
    await expect.poll(() => Boolean(stream && !stream.destroyed && !stream.writableEnded)).toBe(true)
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus) await page.screenshot({ path: info.outputPath('followup-failure.png') })
    health?.assertHealthy(); expect(errors).toEqual([])
    expect(displayGrouping.length).toBeGreaterThan(0); expect(displayGrouping.every(value => value === 'true')).toBe(true)
  })
  test.afterAll(async ({}, info) => {
    try { if (health) await health.closeAndAssert(info); else await app?.close() }
    finally {
      stream?.destroy(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const owned = resolve(fixture)
        if (dirname(owned) !== fixtureRoot || !basename(owned).startsWith('work-root-followup-turn-')) throw new Error(`Unsafe followup cleanup: ${owned}`)
        rmSync(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('真实SSE补充使用普通用户气泡并随原轮过程折叠，用量不重复且刷新保持', async ({}, info) => {
    step('before-followup', 'BEFORE_FOLLOWUP：正在检查原任务。', now + 10, { promptTokens: 100, completionTokens: 10, totalTokens: 110 })
    emit({ usage: { usageScope: 'turn', promptTokens: 100, completionTokens: 10, totalTokens: 110 } })
    await expect(firstTurn().locator('.turn-usage__value')).toHaveText('110')
    const row: EngineHistoryRow = { id: 'controller-followup-user', role: 'user', content: followupText, conversationId: run.turnId,
      createdAt: now + 20, metadata: { ...metadata(), attachments: [followupAttachment], collaborationDelivery: { version: 1, source: 'user-controller',
        messageId: 'controller-delivery-one', rootRunId: run.runId, recipientInvocationRunId: run.runId } } }
    history.push(row); emit({ userMessage: row })
    step('after-followup', 'AFTER_FOLLOWUP：正在核验补充要求。', now + 30, { promptTokens: 200, completionTokens: 20, totalTokens: 220 })
    history.push({ id: run.assistantMessageId, role: 'assistant', content: finalText, modelId: model, conversationId: run.turnId, createdAt: now + 40, metadata: metadata() })
    emit({ content: finalText }); emit({ usage: { usageScope: 'turn', promptTokens: 300, completionTokens: 30, totalTokens: 330 } })
    await expectOneTurn(); await openProcess()
    await expectFollowupContent()
    await expect(followup().locator('summary, details')).toHaveCount(0)
    await expect(work().getByRole('button', { name: /^补充记录/ })).toHaveCount(0)
    await expect(firstTurn().locator('[data-work-tool-id], .work-message__followup')).toHaveCount(3)
    expect(await firstTurn().locator('[data-work-tool-id], .work-message__followup').evaluateAll(items => items.map(item => item.getAttribute('data-work-tool-id') || item.getAttribute('data-message-id'))))
      .toEqual(['before-followup', 'controller-followup-user', 'after-followup'])
    await page.screenshot({ path: info.outputPath('live-followup-user-bubble.png'), animations: 'disabled' })
    await processToggle().click(); await expect(followup()).toBeHidden()
    await processToggle().press('Enter'); await expect(followup().locator('.message__bubble')).toBeVisible()
    await processToggle().press('Space'); await expect(followup()).toBeHidden()
    await expect(processToggle()).toHaveCount(1)
    run = { ...run, status: 'succeeded', version: 2, updatedAt: now + 50, finishedAt: now + 50 }; runs[0] = run
    emit({ run }); stream!.end('data: [DONE]\n\n')
    await page.reload(); await expectOneTurn()
    await expect(processToggle()).toHaveAttribute('aria-expanded', 'false')
    await expect(followup()).toBeHidden()
    await openProcess(); await expectFollowupContent()
    await expect(firstTurn()).toContainText(finalText)
    await expect(work().getByRole('button', { name: /^补充记录/ })).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('reloaded-followup-user-bubble.png'), animations: 'disabled' })
  })

  test('后续独立轮次保持新用户气泡与独立用量，不并入旧补充', async () => {
    const next: RootRun = { ...run, runId: 'followup-next-run', turnId: 'followup-next-turn', userMessageId: 'followup-next-user',
      assistantMessageId: 'followup-next-assistant', createdAt: now + 100, updatedAt: now + 110, finishedAt: now + 110 }
    runs.push(next); run = next
    history.push({ id: next.userMessageId, role: 'user', content: 'NEXT_TURN：另起一轮独立问题。', conversationId: next.turnId, createdAt: now + 100, metadata: metadata() },
      { id: next.assistantMessageId, role: 'assistant', content: 'NEXT_ANSWER：这是下一轮的结果。', conversationId: next.turnId,
        createdAt: now + 110, metadata: metadata(), modelId: model, usage: { promptTokens: 50, completionTokens: 5, totalTokens: 55 } })
    await page.reload()
    await expect(turns()).toHaveCount(2)
    await expect(conversation().locator('article.work-message--user')).toHaveCount(2)
    await expect(conversation().locator('.turn-usage__value')).toHaveText(['330', '55'])
    await expect(work().locator('.usage-meter__tokens')).toHaveText('385')
    await openProcess(); await expect(followup()).toHaveCount(1)
    await expect(conversation().locator('section.work-conversation-turn[data-turn-id="message:followup-next-user"]')).toContainText('NEXT_ANSWER')
    await expect(conversation().locator('section.work-conversation-turn[data-turn-id="message:followup-next-user"] .work-message__followup')).toHaveCount(0)
  })
})
