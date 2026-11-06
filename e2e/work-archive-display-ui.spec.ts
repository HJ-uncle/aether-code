/** Fresh archive-display acceptance in real Electron with an authenticated HTTP
 * fixture. Covers model compaction versus complete display history, a 135-tool
 * turn crossing the former 200-row boundary, whole-turn navigation, concurrent
 * SSE, late session responses and visible retry. No legacy suite or exports. */
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { RootRun } from '../src/shared/root-run'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'work-archive-display-fixture', model = 'work-archive-display-model'
const ids = ['long', 'index', 'live', 'late', 'retry', 'control'] as const
type Scenario = typeof ids[number]
const counts: Record<Scenario, number> = { long: 2, index: 4, live: 3, late: 3, retry: 3, control: 2 }
const titles: Record<Scenario, string> = { long: '完整的长工具对话', index: '全部轮次导航', live: '运行中读取完整记录', late: '迟到响应隔离', retry: '历史读取重试', control: '独立对照会话' }
const sessionId = (id: Scenario) => `work-archive-display-${id}`
const userId = (id: Scenario, index: number) => `${sessionId(id)}-user-${index}`
const turnId = (id: Scenario, index: number) => `${sessionId(id)}-turn-${index}`
const assistantId = (id: Scenario, index: number) => `${sessionId(id)}-assistant-${index}`
const prompt = (id: Scenario, index: number) => `${titles[id]} 第 ${index + 1} 轮：请保留完整问题和回复。`
const answer = (id: Scenario, index: number) => `ANSWER_${id}_${index}：这轮完整的收尾正文必须保留。`
const createdAt = Date.now() - 100_000
const histories = new Map<Scenario, EngineHistoryRow[]>()
for (const id of ids) {
  histories.set(id, Array.from({ length: counts[id] }, (_, index): EngineHistoryRow[] => {
    const common = { conversationId: turnId(id, index), createdAt: createdAt + index * 1000 }
    const rows: EngineHistoryRow[] = [{ ...common, id: userId(id, index), role: 'user', content: prompt(id, index) }]
    if (id === 'long' && index === 1) for (let step = 0; step < 135; step++) rows.push(
      { ...common, id: step === 0 ? assistantId(id, index) : `${sessionId(id)}-call-${step}`, role: 'assistant', content: '',
        toolCall: { id: `archive-tool-${step}`, name: 'read_file', args: { path: `retained-${step}.txt` } } },
      { ...common, id: `${sessionId(id)}-result-${step}`, role: 'tool', toolCallId: `archive-tool-${step}`,
        content: `ORIGINAL_TOOL_RESULT_${step}：归档中的原始结果没有被清除。`, success: true })
    rows.push({ ...common, id: id === 'long' && index === 1 ? `${sessionId(id)}-final` : assistantId(id, index),
      role: 'assistant', modelId: model, content: answer(id, index) + '\n\n' + Array.from({ length: 10 }, (_, paragraph) =>
        `保留段落 ${paragraph + 1}：完整记录与模型上下文分离，阅读旧问题时不会丢失当前回复。`).join('\n\n') })
    return rows
  }).flat())
}
const liveBase = String(histories.get('live')!.at(-1)!.content)
let liveRun: RootRun = { schemaVersion: 1, runId: 'archive-live-run', sessionId: sessionId('live'), turnId: turnId('live', 2),
  userMessageId: userId('live', 2), assistantMessageId: assistantId('live', 2), modelId: model,
  seq: 1, version: 1, status: 'running', pending: [], workspacePaths: [], createdAt, updatedAt: createdAt }
let liveStream: ServerResponse | undefined, sequence = 1, liveContent = liveBase
const errors: string[] = [], chatWrites: unknown[] = []
const reads: Array<{ sessionId: string; anchor: string | null; loadedTurnIds: string[]; rows: number }> = []
const holds = new Map<Scenario, { anchor: string | null; release?: () => void; pending: boolean }>()
const failNext = new Set<Scenario>()
let fixture = '', source = '', app: ElectronApplication | undefined, page: Page, health: ElectronHealthMonitor | undefined
const envelope = (data: unknown, code = 200, message = 'ok'): string => JSON.stringify({ code, message, data })

function snapshot(id: Scenario | undefined) {
  const history = id ? histories.get(id)! : [], isLive = id === 'live' && liveRun.status === 'running'
  const last = id ? counts[id] - 1 : 0
  const compact = !id || id === 'control' ? history : [
    { id: `summary-${id}`, role: 'system', content: '模型使用的压缩摘要，不应代替用户原文。', metadata: { isCompactSummary: true } },
    ...history.filter(row => row.conversationId === turnId(id ?? 'control', last)).slice(id === 'long' ? -1 : 0)
  ]
  return { schemaVersion: 1, sessionId: id ? sessionId(id) : '', source: isLive ? 'live' : 'persisted', finished: !isLive,
    eventId: isLive ? `${liveRun.runId}:${sequence}` : null, projection: isLive ? [{ content: liveContent }] : [],
    history: compact, historyCompacted: Boolean(id && id !== 'control'), run: id === 'live' ? liveRun : undefined,
    runs: id === 'live' ? [liveRun] : [], todos: [], changes: [], commandJobs: [], subagentRuns: [] }
}
function emit(payload: ChatSsePayload): void {
  if (!liveStream || liveStream.writableEnded || liveStream.destroyed) throw new Error('Missing live archive SSE')
  if (payload.content) liveContent += payload.content
  liveStream.write(`id: ${liveRun.runId}:${++sequence}\ndata: ${JSON.stringify(payload)}\n\n`)
}
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token)
      throw new Error(`Unauthenticated archive fixture request: ${path}`)
    let raw = ''; for await (const chunk of request) raw += String(chunk)
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    const requested = String(body.sessionId ?? url.searchParams.get('sessionId') ?? '')
    const id = ids.find(item => sessionId(item) === requested)
    if (path === '/api/v1/chat' && request.method === 'POST') {
      chatWrites.push(body); throw new Error('Reading an archive must never send a model request')
    }
    if (path === '/api/v1/chat/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.flushHeaders()
      if (id === 'live' && liveRun.status === 'running') { liveStream = response; return }
      response.end('data: [DONE]\n\n'); return
    }
    if (path === '/api/v1/cron/capabilities' || path === '/api/v1/workbench/clients') {
      response.writeHead(404, { 'content-type': 'application/json' }).end(envelope(null, 404, 'Unsupported fixture capability')); return
    }
    response.setHeader('content-type', 'application/json')
    if (path === '/api/v1/conversation/display') {
      if (!id) throw new Error('Display request needs a fixture session')
      const history = histories.get(id)!, users = history.filter(row => row.role === 'user')
      const anchor = url.searchParams.get('anchorMessageId')
      const limit = Number(url.searchParams.get('limit') ?? 2)
      const start = anchor ? users.findIndex(row => row.id === anchor) : Math.max(0, users.length - limit)
      if (start < 0 || limit < 1) throw new Error(`Invalid display selection ${anchor}`)
      const selected = users.slice(start, start + limit), loadedTurnIds = selected.map(row => row.id!)
      const selectedTurns = new Set(selected.map(row => row.conversationId))
      const messages = history.filter(row => selectedTurns.has(row.conversationId))
      reads.push({ sessionId: requested, anchor, loadedTurnIds, rows: messages.length })
      const data = { schemaVersion: 1, turns: users.map(row => ({ userMessageId: row.id, conversationId: row.conversationId,
        preview: String(row.content).slice(0, 100), createdAt: row.createdAt })), messages, loadedTurnIds,
        revision: `${requested}:${sequence}`, mutationRevision: `${requested}:unchanged`, backend: 'jsonl', completeness: 'complete' }
      const serialized = envelope(data)
      if (failNext.delete(id)) { response.writeHead(503).end(envelope(null, 503, '完整记录暂时不可读取，请重试')); return }
      const hold = holds.get(id)
      if (hold && hold.anchor === anchor && !hold.pending) {
        hold.pending = true
        await new Promise<void>(done => { hold.release = done })
        holds.delete(id)
      }
      response.end(serialized); return
    }
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: 'sha256:' + 'e'.repeat(64), protocolVersion: 1,
        toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'work-archive-display' }
      : path === '/api/v1/models' ? [{ id: model, modelId: model, displayName: '归档显示验收模型', provider: 'openai', isEnabled: true, capabilities: { toolCalling: true } }]
      : path === '/api/v1/chat/snapshot' ? { ...snapshot(id), sessionId: requested }
      : path === '/api/v1/chat/status' ? { running: id === 'live' && liveRun.status === 'running', finished: id !== 'live' || liveRun.status !== 'running', run: id === 'live' ? liveRun : undefined }
      : path === '/api/v1/chat/runs' ? { runs: id === 'live' ? [liveRun] : [] }
      : path === '/api/v1/conversation/history' ? snapshot(id).history
      : path === '/api/v1/conversation/sessions' ? ids.map(item => ({ sessionId: sessionId(item), title: titles[item], lastAt: createdAt, messageCount: histories.get(item)!.length }))
      : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'archive-display', sessionId: requested,
        namespace: { id: 'archive-display-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'general' ? 'general' : 'code', runLifetime: 'durable', subagentProtocol: 2 },
        root: id === 'live' ? { ...liveRun, attemptId: 'archive-live-attempt' } : null,
        predecessor: id === 'live' ? { runId: liveRun.runId, attemptId: 'archive-live-attempt', version: liveRun.version } : null }
      : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
      : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'archive-display' }
      : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, durableQueueReceipts: false, receiptPagination: false, runtimeCommunication: false, mailboxConsumer: false, userControllerMutation: false, rootUserControllerMutation: false }
      : path === '/api/v1/security/mode' ? { sessionId: requested, mode: 'standard' }
      : path === '/api/v1/memory/settings' ? { sessionId: requested, memoryScope: 'session', effectiveScope: 'session', enabled: true, globalEnabled: false, sessionDefaultEnabled: true, sessionOverride: null, sessionEnabled: true }
      : path === '/api/v1/workspace/directory' ? { root: '/remote/archive-display', entries: [] }
      : path === '/api/v1/command-jobs' ? { jobs: [] }
      : /^\/api\/v1\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
      : []
    response.end(envelope(data))
  })().catch(error => {
    errors.push(String(error))
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
    response.end(envelope(null, 500, String(error)))
  })
})

const work = () => page.locator('.work-view')
const conversation = () => work().getByRole('region', { name: '协作对话', exact: true })
const nav = () => conversation().getByRole('navigation', { name: '消息导航', exact: true })
const waves = () => nav().locator('button.chat__nav-wave')
const message = (id: Scenario, index: number) => conversation().locator(`[data-message-id="${userId(id, index)}"]`)
async function select(id: Scenario): Promise<void> {
  await page.mouse.move(1, 1)
  await work().locator('.work-sidebar__task').filter({ hasText: titles[id] }).click()
  await expect(work().getByRole('heading', { name: titles[id], exact: true })).toBeVisible()
}
async function ready(id: Scenario): Promise<void> {
  await expect(waves()).toHaveCount(counts[id])
  await expect(conversation().getByText('正在加载完整对话…', { exact: true })).toHaveCount(0)
  await expect(conversation().locator('.work-history-notice[role="alert"]')).toHaveCount(0)
}
async function navigate(id: Scenario, index: number): Promise<void> {
  await waves().nth(index).hover()
  await expect(nav().getByRole('tooltip')).toContainText(prompt(id, index))
  await waves().nth(index).click()
  await expect(message(id, index)).toBeInViewport()
}
async function capture(info: TestInfo, name: string): Promise<void> {
  const output = info.outputPath(name + '.png')
  await page.screenshot({ path: output, animations: 'disabled' })
  await info.attach(name, { path: output, contentType: 'image/png' })
}
async function draftsUnchanged(id: Scenario): Promise<void> {
  expect(await page.evaluate(key => {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}')
    return { activeTaskId: value.activeTaskId, drafts: value.tasks.map((task: { id: string; draft: string }) => [task.id, task.draft]).sort() }
  }, 'aether.work.state.v1:' + encodeURIComponent(source))).toEqual({ activeTaskId: sessionId(id), drafts: ids.map(item => [sessionId(item), `未发送草稿 ${item}`]).sort() })
}

test.describe.serial('Work 完整归档与导航（全新专项）', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing archive fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    source = engineStorageKey({ mode: 'remote', baseUrl: origin })
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'work-archive-display-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true,
      lastModelId: model, appearance: 'dark', lastFolder: '', lastSessionId: '' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'work-archive-display', [token])
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.evaluate(({ key, tasks }) => {
      localStorage.setItem(key, JSON.stringify({ tasks, activeTaskId: tasks[0].id }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', workspace: false }))
    }, { key: 'aether.work.state.v1:' + encodeURIComponent(source), tasks: ids.map(id => ({ id: sessionId(id), title: titles[id],
      draft: `未发送草稿 ${id}`, status: id === 'live' ? 'running' : 'done', createdAt, updatedAt: createdAt,
      workspacePath: null, modelId: model, attachments: [], sources: [] })) })
    await page.reload()
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus) {
      await capture(info, 'archive-display-failure')
      await info.attach('archive-fixture-reads', { body: JSON.stringify({ reads, errors, sequence, liveStatus: liveRun.status }, null, 2), contentType: 'application/json' })
    }
    health?.assertHealthy(); expect(errors).toEqual([]); expect(chatWrites).toEqual([])
  })
  test.afterAll(async ({}, info) => {
    for (const hold of holds.values()) hold.release?.()
    try { if (health) await health.closeAndAssert(info); else await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const owned = resolve(fixture)
        if (dirname(owned) !== fixtureRoot || !basename(owned).startsWith('work-archive-display-')) throw new Error(`Unsafe cleanup: ${owned}`)
        rmSync(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('压缩快照自动恢复两轮原文及跨 200 行的 135 个工具步骤', async ({}, info) => {
    await select('long'); await ready('long')
    expect(reads.find(read => read.sessionId === sessionId('long'))?.rows).toBe(274)
    await expect(conversation().getByText(answer('long', 0), { exact: true })).toHaveCount(1)
    await expect(conversation().getByText(answer('long', 1), { exact: true })).toHaveCount(1)
    await navigate('long', 0); await navigate('long', 1)
    const process = conversation().getByRole('button', { name: '展开过程 135 步', exact: true })
    await expect(process).toBeVisible(); await process.click()
    const activity = conversation().locator('.work-inline-activity[data-tool-count="135"]')
    await expect(activity).toHaveCount(1)
    const last = activity.locator('[data-work-tool-id="archive-tool-134"]')
    await last.locator('button').first().click()
    await expect(last).toContainText('ORIGINAL_TOOL_RESULT_134')
    const previous = activity.getByRole('button', { name: '上一页', exact: true })
    while (await previous.isEnabled()) await previous.click()
    const first = activity.locator('[data-work-tool-id="archive-tool-0"]')
    await first.locator('button').first().click()
    await expect(first).toContainText('ORIGINAL_TOOL_RESULT_0')
    await conversation().getByRole('button', { name: '收起过程 135 步', exact: true }).click()
    await capture(info, 'complete-two-turn-history')
    await draftsUnchanged('long')
  })

  test('完整索引显示四条波纹，未加载轮次可直接点击并保留最新回复', async ({}, info) => {
    await select('index'); await ready('index')
    const initial = reads.find(read => read.sessionId === sessionId('index'))
    expect(initial?.loadedTurnIds).toEqual([userId('index', 2), userId('index', 3)])
    await expect(message('index', 0)).toHaveCount(0)
    await navigate('index', 0)
    await expect.poll(() => reads.some(read => read.sessionId === sessionId('index') && read.anchor === userId('index', 0))).toBe(true)
    for (let index = 0; index < 4; index++) await expect(conversation().getByText(answer('index', index), { exact: true })).toHaveCount(1)
    await expect(waves()).toHaveCount(4)
    await capture(info, 'indexed-history-navigation')
    await draftsUnchanged('index')
  })

  test('运行中迟到的展示快照不覆盖实时增量，仍可加载更早整轮', async ({}, info) => {
    holds.set('live', { anchor: null, pending: false })
    await select('live')
    await expect.poll(() => holds.get('live')?.pending).toBe(true)
    await expect.poll(() => Boolean(liveStream && !liveStream.destroyed)).toBe(true)
    emit({ content: '\n\nLIVE_AFTER_DISPLAY_REQUEST：归档读取期间新增的正文。' })
    await expect(conversation()).toContainText('LIVE_AFTER_DISPLAY_REQUEST')
    holds.get('live')!.release!()
    await ready('live')
    await expect(conversation()).toContainText('LIVE_AFTER_DISPLAY_REQUEST')
    await navigate('live', 0)
    await expect(conversation().getByText(answer('live', 0), { exact: true })).toHaveCount(1)
    await expect(conversation()).toContainText('LIVE_AFTER_DISPLAY_REQUEST')
    emit({ content: '\n\nLIVE_AFTER_OLDER_TURN：加载旧轮次后仍在继续输出。' })
    await expect(conversation()).toContainText('LIVE_AFTER_OLDER_TURN')
    await expect(conversation().getByText(answer('live', 2), { exact: true })).toHaveCount(1)
    await expect(conversation().locator('.work-turn-feedback[data-state="running"]')).toHaveCount(1)
    await capture(info, 'stream-survives-history-load')
    await draftsUnchanged('live')
    liveRun = { ...liveRun, status: 'succeeded', version: 2, seq: sequence + 1, updatedAt: Date.now(), finishedAt: Date.now() }
    histories.get('live')!.at(-1)!.content = liveContent
    emit({ run: liveRun }); liveStream!.end('data: [DONE]\n\n')
    await expect(conversation().locator('.work-turn-feedback[data-state="running"]')).toHaveCount(0)
  })

  test('切换会话后旧的展示响应不会污染当前正文、导航和草稿', async () => {
    holds.set('late', { anchor: null, pending: false })
    await select('late')
    await expect.poll(() => holds.get('late')?.pending).toBe(true)
    await select('control'); await ready('control')
    holds.get('late')!.release!()
    await expect.poll(() => holds.has('late')).toBe(false)
    // HTTP runs in Electron's main process, so browser waitForResponse cannot
    // observe it. Read the current task through two real navigation gestures.
    await navigate('control', 0); await navigate('control', 1)
    await expect(conversation().getByText(answer('control', 0), { exact: true })).toHaveCount(1)
    await expect(conversation().getByText(answer('control', 1), { exact: true })).toHaveCount(1)
    await expect(conversation()).not.toContainText('ANSWER_late_')
    await expect(waves()).toHaveCount(2)
    await draftsUnchanged('control')
  })

  test('读取失败明确提示并可重试，不把压缩片段伪装成完整记录', async ({}, info) => {
    failNext.add('retry')
    await select('retry')
    const notice = conversation().locator('.work-history-notice[role="alert"]')
    await expect(notice).toContainText('完整记录暂时不可读取')
    await notice.getByRole('button', { name: '重新加载完整记录', exact: true }).click()
    await ready('retry'); await navigate('retry', 0)
    await expect(conversation().getByText(answer('retry', 0), { exact: true })).toHaveCount(1)
    await expect(conversation().getByText(answer('retry', 2), { exact: true })).toHaveCount(1)
    await expect(notice).toHaveCount(0)
    await capture(info, 'history-retry-restored')
    await draftsUnchanged('retry')
    await select('long'); await ready('long')
    await expect(conversation().getByText(answer('long', 0), { exact: true })).toHaveCount(1)
    await expect(conversation().getByRole('button', { name: '展开过程 135 步', exact: true })).toHaveCount(1)
  })
})
