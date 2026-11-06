/** Fresh tail-navigation acceptance: a very short final turn must remain the
 * active navigation marker when physically at the transcript bottom. A mounted
 * earlier history window must never masquerade as the global last turn.
 * Authenticated HTTP fixture only; no old E2E, exports or model writes. */
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'work-tail-anchor-fixture', model = 'work-tail-anchor-model'
const ids = ['two', 'window'] as const
type Scenario = typeof ids[number]
const counts: Record<Scenario, number> = { two: 3, window: 96 }
const titles: Record<Scenario, string> = { two: '三轮对话短尾导航', window: '长会话窗口单击到底' }
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
        content: id === 'two' && index === 2 ? `完成。\n\n${marker(id, index)}` : `## 第 ${index + 1} 轮交付\n\n${table}\n\n${sections}\n\n${marker(id, index)}` }]
  }).flat()]))
const errors: string[] = [], chatWrites: unknown[] = []
let fixture = '', source = '', app: ElectronApplication | undefined, page: Page, health: ElectronHealthMonitor | undefined
const envelope = (data: unknown, code = 200, message = 'ok') => JSON.stringify({ code, message, data })
function snapshot(id: Scenario | undefined) {
  return { schemaVersion: 1, sessionId: id ? sessionId(id) : '', source: 'persisted', finished: true,
    eventId: null, projection: [], history: id ? histories.get(id)! : [], historyCompacted: false,
    runs: [], todos: [], changes: [], commandJobs: [], subagentRuns: [] }
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
        loadedTurnIds: selected.map(row => row.id), revision: `${requested}:stable`, mutationRevision: `${requested}:unchanged`,
        backend: 'jsonl', completeness: 'complete' })); return
    }
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: 'sha256:' + 'b'.repeat(64), protocolVersion: 1,
        toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'work-tail-anchor' }
      : path === '/api/v1/models' ? [{ id: model, modelId: model, displayName: '单击到底验收模型', provider: 'openai', isEnabled: true, capabilities: { toolCalling: true } }]
      : path === '/api/v1/chat/snapshot' ? { ...snapshot(id), sessionId: requested }
      : path === '/api/v1/chat/status' ? { running: false, finished: true }
      : path === '/api/v1/chat/runs' ? { runs: [] }
      : path === '/api/v1/conversation/history' ? snapshot(id).history
      : path === '/api/v1/conversation/sessions' ? ids.map(item => ({ sessionId: sessionId(item), title: titles[item], lastAt: createdAt, messageCount: histories.get(item)!.length }))
      : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'tail-anchor', sessionId: requested,
        namespace: { id: 'tail-anchor-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'general' ? 'general' : 'code', runLifetime: 'durable', subagentProtocol: 2 },
        root: null, predecessor: null }
      : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
      : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'tail-anchor' }
      : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, durableQueueReceipts: false, receiptPagination: false, runtimeCommunication: false, mailboxConsumer: false, userControllerMutation: false, rootUserControllerMutation: false }
      : path === '/api/v1/security/mode' ? { sessionId: requested, mode: 'standard' }
      : path === '/api/v1/memory/settings' ? { sessionId: requested, memoryScope: 'session', effectiveScope: 'session', enabled: true, globalEnabled: false, sessionDefaultEnabled: true, sessionOverride: null, sessionEnabled: true }
      : path === '/api/v1/workspace/directory' ? { root: '/remote/tail-anchor', entries: [] }
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

test.describe.serial('Work 会话末尾导航高亮（新专项）', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing bottom fixture port')
    const origin = `http://127.0.0.1:${address.port}`; source = engineStorageKey({ mode: 'remote', baseUrl: origin })
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'work-tail-anchor-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true,
      lastModelId: model, appearance: 'dark', lastFolder: '', lastSessionId: '' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'work-tail-anchor', [token])
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.evaluate(({ key, tasks }) => {
      localStorage.setItem(key, JSON.stringify({ tasks, activeTaskId: tasks[0].id }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', workspace: false }))
    }, { key: 'aether.work.state.v1:' + encodeURIComponent(source), tasks: ids.map(id => ({ id: sessionId(id), title: titles[id],
      draft: `未发送草稿 ${id}`, status: 'done', createdAt, updatedAt: createdAt,
      workspacePath: null, modelId: model, attachments: [], sources: [] })) })
    await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus) {
      await capture(info, 'tail-anchor-failure')
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
        if (dirname(owned) !== fixtureRoot || !basename(owned).startsWith('work-tail-anchor-')) throw new Error(`Unsafe cleanup: ${owned}`)
        rmSync(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('三轮对话的末轮很短：单击到底必须高亮第三条，而非第二条', async ({}, info) => {
    await select('two'); await inspectTop('two')
    const waves = nav().locator('.chat__nav-wave')
    await expect(waves).toHaveCount(3)
    await expect(waves.nth(0)).toHaveAttribute('aria-current', 'true')
    await nav().getByRole('button', { name: '回到底部', exact: true }).click()
    await atBottom('two', info, 'short-tail-bottom')
    const geometry = await scroll().evaluate(element => {
      const outer = element.getBoundingClientRect()
      const anchors = [...element.querySelectorAll<HTMLElement>('.work-conversation-turn')].map(turn => ({
        id: turn.dataset.turnId, top: turn.getBoundingClientRect().top - outer.top,
        bottom: turn.getBoundingClientRect().bottom - outer.top
      }))
      return { gap: element.scrollHeight - element.clientHeight - element.scrollTop,
        viewport: element.clientHeight, anchors }
    })
    await info.attach('short-tail-probe', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' })
    // Prove this fixture exposes the old 1/3-viewport heuristic: the actual
    // final turn starts below that probe despite being fully visible at bottom.
    expect(geometry.anchors.at(-1)!.top).toBeGreaterThan(geometry.viewport / 3)
    await capture(info, 'short-tail-at-bottom')
    await expect(waves.nth(2)).toHaveAttribute('aria-current', 'true', { timeout: 3000 })
    await expect(waves.nth(1)).not.toHaveAttribute('aria-current', 'true')
  })

  test('早期历史窗口的局部底部不会高亮整个会话最后一轮', async ({}, info) => {
    await select('window'); await inspectTop('window')
    await expect(conversation().locator('.work-conversation__content')).toHaveAttribute('data-history-start', '0')
    await expect(conversation().locator('.work-conversation__content')).toHaveAttribute('data-history-end', '180')
    await scroll().evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect.poll(distance).toBeLessThanOrEqual(2)
    await settledGeometry()
    await nav().getByRole('button', { name: '展开消息导航', exact: true }).click()
    const entries = nav().locator('.chat__nav-item')
    await expect(entries).toHaveCount(96)
    await expect(entries.nth(89)).toHaveAttribute('aria-current', 'true')
    await expect(entries.nth(95)).not.toHaveAttribute('aria-current', 'true')
    await expect(conversation().locator(`[data-message-id="${userId('window', 95)}"]`)).toHaveCount(0)
    await capture(info, 'earlier-window-not-global-tail')
  })
})
