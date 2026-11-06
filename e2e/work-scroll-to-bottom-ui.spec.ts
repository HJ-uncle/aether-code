/** Fresh single-click bottom navigation acceptance in real Electron. Measures
 * scroll geometry after lazy Markdown/window/footer layout settles, instead of
 * treating a hidden follow button as proof of reaching the bottom. Includes
 * both controls, a >60-message window, live growth and manual scroll intent.
 * Authenticated HTTP fixture only; no old E2E, exports or model writes. */
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
const token = 'work-single-click-bottom-fixture', model = 'work-single-click-bottom-model'
const ids = ['two', 'window', 'live'] as const
type Scenario = typeof ids[number]
const counts: Record<Scenario, number> = { two: 2, window: 96, live: 3 }
const titles: Record<Scenario, string> = { two: '两轮长正文单击到底', window: '长会话窗口单击到底', live: '实时回复单击到底' }
const sessionId = (id: Scenario) => `work-bottom-${id}`
const userId = (id: Scenario, index: number) => `${sessionId(id)}-user-${index}`
const turnId = (id: Scenario, index: number) => `${sessionId(id)}-turn-${index}`
const assistantId = (id: Scenario, index: number) => `${sessionId(id)}-assistant-${index}`
const prompt = (id: Scenario, index: number) => `${titles[id]} 第 ${index + 1} 轮：查看完整交付。`
const marker = (id: Scenario, index: number) => `END_${id}_${index}_COMPLETE`
const createdAt = Date.now() - 100_000
const histories = new Map<Scenario, EngineHistoryRow[]>(ids.map(id => [id,
  Array.from({ length: counts[id] }, (_, index): EngineHistoryRow[] => {
    const common = { conversationId: turnId(id, index), createdAt: createdAt + index * 1000 }
    const table = '| 文件 | 职责 |\n| --- | --- |\n' + Array.from({ length: id === 'window' ? 4 : 12 }, (_, row) =>
      `| \`src/module-${index}-${row}.ts\` | 独立的规则、交互与渲染模块 ${row + 1} |`).join('\n')
    const sections = Array.from({ length: id === 'window' ? 3 + index % 5 : 15 + index * 3 }, (_, row) =>
      `### 验证结果 ${row + 1}\n\n- 持续检查页面布局和滚动位置，正文需要完整显示。\n- 从历史导航返回最新内容时，一次点击应到达实际底部。\n- 内容高度改变后仍遵循当前阅读意图，用户上滚可以暂停跟随。`).join('\n\n')
    return [{ ...common, id: userId(id, index), role: 'user', content: prompt(id, index) },
      { ...common, id: assistantId(id, index), role: 'assistant', modelId: model,
        content: `## 第 ${index + 1} 轮交付\n\n${table}\n\n${sections}\n\n${marker(id, index)}` }]
  }).flat()]))
let liveRun: RootRun = { schemaVersion: 1, runId: 'single-click-live-run', sessionId: sessionId('live'), turnId: turnId('live', 2),
  userMessageId: userId('live', 2), assistantMessageId: assistantId('live', 2), modelId: model,
  seq: 1, version: 1, status: 'running', pending: [], workspacePaths: [], createdAt, updatedAt: createdAt }
let liveStream: ServerResponse | undefined, sequence = 1, liveContent = String(histories.get('live')!.at(-1)!.content)
const errors: string[] = [], chatWrites: unknown[] = []
let fixture = '', source = '', app: ElectronApplication | undefined, page: Page, health: ElectronHealthMonitor | undefined
const envelope = (data: unknown, code = 200, message = 'ok') => JSON.stringify({ code, message, data })
function snapshot(id: Scenario | undefined) {
  const isLive = id === 'live' && liveRun.status === 'running'
  return { schemaVersion: 1, sessionId: id ? sessionId(id) : '', source: isLive ? 'live' : 'persisted', finished: !isLive,
    eventId: isLive ? `${liveRun.runId}:${sequence}` : null, projection: isLive ? [{ content: liveContent }] : [],
    history: id ? histories.get(id)! : [], historyCompacted: false, run: id === 'live' ? liveRun : undefined,
    runs: id === 'live' ? [liveRun] : [], todos: [], changes: [], commandJobs: [], subagentRuns: [] }
}
function emit(payload: ChatSsePayload): void {
  if (!liveStream || liveStream.writableEnded || liveStream.destroyed) throw new Error('Missing live bottom-navigation SSE')
  if (payload.content) liveContent += payload.content
  liveStream.write(`id: ${liveRun.runId}:${++sequence}\ndata: ${JSON.stringify(payload)}\n\n`)
}
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token)
      throw new Error(`Unauthenticated bottom fixture request: ${path}`)
    let raw = ''; for await (const chunk of request) raw += String(chunk)
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    const requested = String(body.sessionId ?? url.searchParams.get('sessionId') ?? '')
    const id = ids.find(item => sessionId(item) === requested)
    if (path === '/api/v1/chat' && request.method === 'POST') {
      chatWrites.push(body); throw new Error('Scrolling must never send a model request')
    }
    if (path === '/api/v1/chat/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); response.flushHeaders()
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
      const anchor = url.searchParams.get('anchorMessageId'), limit = Number(url.searchParams.get('limit') ?? 2)
      const start = anchor ? users.findIndex(row => row.id === anchor) : Math.max(0, users.length - limit)
      if (start < 0 || limit < 1) throw new Error(`Invalid display selection ${anchor}`)
      const selected = users.slice(start, start + limit), selectedTurns = new Set(selected.map(row => row.conversationId))
      response.end(envelope({ schemaVersion: 1, turns: users.map(row => ({ userMessageId: row.id, conversationId: row.conversationId,
        preview: String(row.content), createdAt: row.createdAt })), messages: history.filter(row => selectedTurns.has(row.conversationId)),
        loadedTurnIds: selected.map(row => row.id), revision: `${requested}:${sequence}`, mutationRevision: `${requested}:unchanged`,
        backend: 'jsonl', completeness: 'complete' })); return
    }
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: 'sha256:' + 'b'.repeat(64), protocolVersion: 1,
        toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'work-single-click-bottom' }
      : path === '/api/v1/models' ? [{ id: model, modelId: model, displayName: '单击到底验收模型', provider: 'openai', isEnabled: true, capabilities: { toolCalling: true } }]
      : path === '/api/v1/chat/snapshot' ? { ...snapshot(id), sessionId: requested }
      : path === '/api/v1/chat/status' ? { running: id === 'live' && liveRun.status === 'running', finished: id !== 'live' || liveRun.status !== 'running', run: id === 'live' ? liveRun : undefined }
      : path === '/api/v1/chat/runs' ? { runs: id === 'live' ? [liveRun] : [] }
      : path === '/api/v1/conversation/history' ? snapshot(id).history
      : path === '/api/v1/conversation/sessions' ? ids.map(item => ({ sessionId: sessionId(item), title: titles[item], lastAt: createdAt, messageCount: histories.get(item)!.length }))
      : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'single-click-bottom', sessionId: requested,
        namespace: { id: 'single-click-bottom-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'general' ? 'general' : 'code', runLifetime: 'durable', subagentProtocol: 2 },
        root: id === 'live' ? { ...liveRun, attemptId: 'single-click-live-attempt' } : null,
        predecessor: id === 'live' ? { runId: liveRun.runId, attemptId: 'single-click-live-attempt', version: liveRun.version } : null }
      : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
      : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'single-click-bottom' }
      : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, durableQueueReceipts: false, receiptPagination: false, runtimeCommunication: false, mailboxConsumer: false, userControllerMutation: false, rootUserControllerMutation: false }
      : path === '/api/v1/security/mode' ? { sessionId: requested, mode: 'standard' }
      : path === '/api/v1/memory/settings' ? { sessionId: requested, memoryScope: 'session', effectiveScope: 'session', enabled: true, globalEnabled: false, sessionDefaultEnabled: true, sessionOverride: null, sessionEnabled: true }
      : path === '/api/v1/workspace/directory' ? { root: '/remote/single-click-bottom', entries: [] }
      : path === '/api/v1/command-jobs' ? { jobs: [] }
      : /^\/api\/v1\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
      : []
    response.end(envelope(data))
  })().catch(error => {
    errors.push(String(error)); if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
    response.end(envelope(null, 500, String(error)))
  })
})

const work = () => page.locator('.work-view')
const conversation = () => work().getByRole('region', { name: '协作对话', exact: true })
const nav = () => conversation().getByRole('navigation', { name: '消息导航', exact: true })
const scroll = () => conversation().locator('.work-conversation__scroll')
const follow = () => conversation().getByRole('button', { name: '回到最新', exact: true })
const distance = () => scroll().evaluate(element => Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop))
async function select(id: Scenario): Promise<void> {
  await page.mouse.move(1, 1)
  await work().locator('.work-sidebar__task').filter({ hasText: titles[id] }).click()
  await expect(work().getByRole('heading', { name: titles[id], exact: true })).toBeVisible()
  await expect(conversation().getByText('正在加载完整对话…', { exact: true })).toHaveCount(0)
  await expect(nav()).toBeVisible()
  await expect(conversation().locator('[role="alert"]')).toHaveCount(0)
}
async function inspectTop(id: Scenario): Promise<void> {
  await nav().getByRole('button', { name: '回到顶部', exact: true }).click()
  await expect(scroll()).toHaveAttribute('data-browsing-history', 'true')
  await expect(conversation().locator(`[data-message-id="${userId(id, 0)}"]`)).toBeInViewport()
  await expect.poll(distance).toBeGreaterThan(1000)
  await expect(follow()).toBeVisible()
}
async function settledGeometry() {
  return scroll().evaluate(element => new Promise<Array<{ height: number; viewport: number; top: number; gap: number }>>(resolve => {
    const samples: Array<{ height: number; viewport: number; top: number; gap: number }> = []
    let stable = 0
    const sample = (): void => {
      const value = { height: element.scrollHeight, viewport: element.clientHeight, top: element.scrollTop,
        gap: Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop) }
      const previous = samples.at(-1)
      stable = previous && previous.height === value.height && previous.viewport === value.viewport && Math.abs(previous.top - value.top) < 0.5 ? stable + 1 : 0
      samples.push(value)
      // Observe rendering rather than advancing the scroll or waiting a guessed duration.
      const animating = element.parentElement?.parentElement?.getAnimations({ subtree: true }).some(animation =>
        animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity)
      if (samples.length >= 180 || stable >= 8 && !animating) resolve(samples)
      else requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }))
}
async function atBottom(id: Scenario, info: TestInfo, label: string, tail = marker(id, counts[id] - 1)): Promise<void> {
  await expect.poll(distance, { message: 'One click must reach the actual transcript bottom', timeout: 10_000 }).toBeLessThanOrEqual(2)
  const geometry = await settledGeometry()
  await info.attach(label + '-geometry', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' })
  expect(geometry.length).toBeGreaterThanOrEqual(9)
  expect(Math.max(...geometry.slice(-8).map(sample => sample.gap)), 'Lazy layout must not leave the bottom after the first click').toBeLessThanOrEqual(2)
  await expect(conversation().getByText(tail, { exact: true })).toBeInViewport()
  await expect(follow()).toHaveCount(0)
}
async function capture(info: TestInfo, name: string): Promise<void> {
  const output = info.outputPath(name + '.png'); await page.screenshot({ path: output, animations: 'disabled' })
  await info.attach(name, { path: output, contentType: 'image/png' })
}

test.describe.serial('Work 单击到底与跟随意图（新专项）', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing bottom fixture port')
    const origin = `http://127.0.0.1:${address.port}`; source = engineStorageKey({ mode: 'remote', baseUrl: origin })
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'work-single-click-bottom-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true,
      lastModelId: model, appearance: 'dark', lastFolder: '', lastSessionId: '' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'work-single-click-bottom', [token])
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
    await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus) {
      await capture(info, 'single-click-bottom-failure')
      await info.attach('scroll-geometry-failure', { body: JSON.stringify(await settledGeometry(), null, 2), contentType: 'application/json' })
    }
    health?.assertHealthy(); expect(errors).toEqual([]); expect(chatWrites).toEqual([])
  })
  test.afterAll(async ({}, info) => {
    try { if (health) await health.closeAndAssert(info); else await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const owned = resolve(fixture)
        if (dirname(owned) !== fixtureRoot || !basename(owned).startsWith('work-single-click-bottom-')) throw new Error(`Unsafe cleanup: ${owned}`)
        rmSync(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('两轮长正文：滚轮上翻后左侧回到底部单击到达真实底部', async ({}, info) => {
    await select('two')
    await expect.poll(distance).toBeLessThanOrEqual(2)
    await settledGeometry()
    await scroll().hover({ position: { x: 400, y: 180 } }); await page.mouse.wheel(0, -1100)
    await expect.poll(distance).toBeGreaterThan(200)
    await expect(scroll()).not.toHaveAttribute('data-browsing-history', 'true')
    await expect(follow()).toBeVisible()
    await nav().getByRole('button', { name: '回到底部', exact: true }).click()
    await atBottom('two', info, 'rail-single-click')
    await capture(info, 'rail-single-click-bottom')
  })

  test('两轮长正文：回到最新单击后不会只隐藏按钮', async ({}, info) => {
    await select('two'); await inspectTop('two')
    await follow().click()
    await atBottom('two', info, 'follow-single-click')
  })

  test('192条消息：切换历史窗口后一次到达末轮末尾', async ({}, info) => {
    await select('window'); await inspectTop('window')
    await expect(conversation().locator('.work-conversation__content')).toHaveAttribute('data-history-start', '0')
    await expect(conversation().locator('.work-conversation__content')).toHaveAttribute('data-history-end', '180')
    await nav().getByRole('button', { name: '回到底部', exact: true }).click()
    await atBottom('window', info, 'window-single-click')
    await expect(conversation().locator('.work-conversation__content')).toHaveAttribute('data-history-start', '132')
    await expect(conversation().locator('.work-conversation__content')).toHaveAttribute('data-history-end', '192')
    await capture(info, 'window-single-click-bottom')
  })

  test('实时正文增高保持底部，手动上滚后新输出不抢阅读位置', async ({}, info) => {
    await select('live'); await inspectTop('live')
    await expect.poll(() => Boolean(liveStream && !liveStream.destroyed)).toBe(true)
    const readingTop = (await settledGeometry()).at(-1)!.top
    emit({ content: '\n\n## 阅读旧轮时最后一轮继续生成\n\n' + Array.from({ length: 40 }, (_, index) =>
      `### 新章节 ${index + 1}\n\n| 类型 | 结果 |\n| --- | --- |\n| 第 ${index + 1} 组 | 历史浏览时旧的固有高度不能决定最新位置 |\n\n\`\`\`ts\nconst step${index} = ${index}\n\`\`\`\n\n最后一轮的实际正文增加，仍保留正在阅读的第一轮。`).join('\n\n') + '\n\nLIVE_HISTORY_GROWTH' })
    await expect(conversation()).toContainText('LIVE_HISTORY_GROWTH')
    expect(Math.abs((await settledGeometry()).at(-1)!.top - readingTop)).toBeLessThanOrEqual(2)
    await nav().getByRole('button', { name: '回到底部', exact: true }).click()
    await atBottom('live', info, 'live-single-click', 'LIVE_HISTORY_GROWTH')
    const beforeHeight = await scroll().evaluate(element => element.scrollHeight)
    emit({ content: '\n\n### 第一次后续更新\n\n' + Array.from({ length: 8 }, (_, index) => `后续段落 ${index + 1}：正文继续增高，应当自动跟随底部。`).join('\n\n') + '\n\nLIVE_GROWTH_ONE' })
    await expect(conversation()).toContainText('LIVE_GROWTH_ONE')
    await expect.poll(() => scroll().evaluate(element => element.scrollHeight)).toBeGreaterThan(beforeHeight)
    await expect.poll(distance).toBeLessThanOrEqual(2)
    expect(Math.max(...(await settledGeometry()).slice(-8).map(sample => sample.gap))).toBeLessThanOrEqual(2)
    await expect(conversation().getByText('LIVE_GROWTH_ONE', { exact: true })).toBeInViewport()
    await scroll().hover({ position: { x: 400, y: 180 } }); await page.mouse.wheel(0, -750)
    await expect.poll(distance).toBeGreaterThan(200)
    await expect(follow()).toBeVisible()
    const pausedTop = (await settledGeometry()).at(-1)!.top
    emit({ content: '\n\n### 阅读历史期间的新输出\n\n' + Array.from({ length: 8 }, (_, index) => `暂停跟随段落 ${index + 1}：保留读者手动选择的位置。`).join('\n\n') + '\n\nLIVE_GROWTH_TWO' })
    await expect(conversation()).toContainText('LIVE_GROWTH_TWO')
    const paused = (await settledGeometry()).at(-1)!
    expect(Math.abs(paused.top - pausedTop), 'New output must not override manual upward scrolling').toBeLessThanOrEqual(2)
    expect(paused.gap).toBeGreaterThan(200)
    await follow().click()
    await expect.poll(distance).toBeLessThanOrEqual(2)
    expect(Math.max(...(await settledGeometry()).slice(-8).map(sample => sample.gap))).toBeLessThanOrEqual(2)
    await expect(conversation().getByText('LIVE_GROWTH_TWO', { exact: true })).toBeInViewport()
    await expect(follow()).toHaveCount(0)
    await capture(info, 'live-growth-and-resume-bottom')
    liveRun = { ...liveRun, status: 'succeeded', version: 2, seq: sequence + 1, updatedAt: Date.now(), finishedAt: Date.now() }
    histories.get('live')!.at(-1)!.content = liveContent
    emit({ run: liveRun }); liveStream!.end('data: [DONE]\n\n')
  })
})
