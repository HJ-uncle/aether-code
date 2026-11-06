/** Fresh Work navigation acceptance: 1/2/10/11 persisted turns through real
 * Electron and authenticated engine HTTP. Checks wave-to-turn mapping, hover
 * and keyboard previews, actual scroll navigation, external edge controls,
 * radar overflow and session isolation. No live model, legacy suite or export. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'work-message-nav-waves-fixture', model = 'work-message-nav-waves-model'
const counts = [1, 2, 10, 11] as const
const sessionId = (count: number) => `work-message-nav-${count}`
const title = (count: number) => `波纹导航 ${count} 条`
const prompt = (count: number, index: number) => `第 ${index + 1} 条：${count} 轮会话中的独立问题 ${String(index + 1).padStart(2, '0')}`
const userId = (count: number, index: number) => `${sessionId(count)}-user-${index}`
const draft = (count: number) => `${count} 条会话未发送的草稿`
const createdAt = Date.now() - 100_000
const histories = new Map<number, EngineHistoryRow[]>(counts.map(count => [count,
  Array.from({ length: count }, (_, index): EngineHistoryRow[] => [
    { id: userId(count, index), role: 'user', content: prompt(count, index),
      conversationId: `${sessionId(count)}-turn-${index}`, createdAt: createdAt + index * 1000 },
    { id: `${sessionId(count)}-assistant-${index}`, role: 'assistant', modelId: model,
      conversationId: `${sessionId(count)}-turn-${index}`, createdAt: createdAt + index * 1000 + 1,
      content: `## 第 ${index + 1} 条问题的答复\n\n` + Array.from({ length: 13 }, (_, line) =>
        `答复段落 ${line + 1}：保留当前轮次的阅读位置。通过消息导航，应当定位这条问题，而不是相邻消息。`).join('\n\n') }
  ]).flat()]))
const errors: string[] = [], chatWrites: unknown[] = []
let fixture = '', source = '', app: ElectronApplication | undefined, page: Page, health: ElectronHealthMonitor | undefined
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token)
      throw new Error(`Unauthenticated fixture request: ${path}`)
    let raw = ''; for await (const chunk of request) raw += String(chunk)
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    const id = String(body.sessionId ?? url.searchParams.get('sessionId') ?? '')
    const count = counts.find(value => sessionId(value) === id), history = histories.get(count ?? 0) ?? []
    if (path === '/api/v1/chat' && request.method === 'POST') {
      chatWrites.push(body)
      throw new Error('Navigation must never send a model request')
    }
    if (path === '/api/v1/chat/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return
    }
    if (path === '/api/v1/cron/capabilities') { response.writeHead(404).end(); return }
    response.setHeader('content-type', 'application/json')
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: 'sha256:' + 'd'.repeat(64), protocolVersion: 1,
        toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'work-message-nav-waves' }
      : path === '/api/v1/models' ? [{ id: model, modelId: model, displayName: '消息导航验收模型', provider: 'openai',
        isEnabled: true, capabilities: { toolCalling: true } }]
      : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', finished: true,
        eventId: null, projection: [], history, runs: [], todos: [], changes: [], commandJobs: [], subagentRuns: [] }
      : path === '/api/v1/chat/status' ? { running: false, finished: true }
      : path === '/api/v1/chat/runs' ? { runs: [] }
      : path === '/api/v1/conversation/history' ? history
      : path === '/api/v1/conversation/sessions' ? counts.map(value => ({ sessionId: sessionId(value),
        title: title(value), lastAt: createdAt, messageCount: value * 2 }))
      : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'nav-waves', sessionId: id,
        namespace: { id: 'nav-waves-db', generation: 'one' }, transport: {
          toolProfile: request.headers['x-aether-tool-profile'] === 'general' ? 'general' : 'code',
          runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
      : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'],
        toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
      : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'nav-waves' }
      : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, durableQueueReceipts: false,
        receiptPagination: false, runtimeCommunication: false, mailboxConsumer: false,
        userControllerMutation: false, rootUserControllerMutation: false }
      : path === '/api/v1/security/mode' ? { sessionId: id, mode: 'standard' }
      : path === '/api/v1/memory/settings' ? { sessionId: id, memoryScope: 'session', effectiveScope: 'session',
        enabled: true, globalEnabled: false, sessionDefaultEnabled: true, sessionOverride: null, sessionEnabled: true }
      : path === '/api/v1/workspace/directory' ? { root: '/remote/nav-waves', entries: [] }
      : path === '/api/v1/command-jobs' ? { jobs: [] }
      : /^\/api\/v1\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
      : []
    response.end(envelope(data))
  })().catch(error => {
    errors.push(String(error))
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ code: 500, message: String(error) }))
  })
})

const work = () => page.locator('.work-view')
const conversation = () => work().getByRole('region', { name: '协作对话', exact: true })
const nav = () => conversation().getByRole('navigation', { name: '消息导航', exact: true })
const waves = () => nav().locator('button.chat__nav-wave')
const scroll = () => conversation().locator('.work-conversation__scroll')
const tooltip = () => nav().getByRole('tooltip')
async function selectCount(count: number): Promise<void> {
  await page.mouse.move(1, 1)
  await work().locator('.work-sidebar__task').filter({ hasText: title(count) }).click()
  await expect(work().getByRole('heading', { name: title(count), exact: true })).toBeVisible()
  await expect(conversation().locator('.work-conversation-turn')).toHaveCount(count)
  await expect(work().getByRole('button', { name: '切换本会话访问权限：标准模式', exact: true })).toBeEnabled()
  await expect(work().locator('[role="alert"]:visible')).toHaveCount(0)
  if (count > 1) await expect.poll(() => scroll().evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  await assertDrafts(count)
}
async function assertDrafts(activeCount: number): Promise<void> {
  expect(await page.evaluate(key => {
    const state = JSON.parse(localStorage.getItem(key) ?? '{}')
    return { activeTaskId: state.activeTaskId,
      drafts: state.tasks.map((task: { id: string; draft: string }) => [task.id, task.draft]).sort() }
  }, 'aether.work.state.v1:' + encodeURIComponent(source))).toEqual({ activeTaskId: sessionId(activeCount),
    drafts: counts.map(count => [sessionId(count), draft(count)]).sort() })
}
async function expectNoRailOverflow(): Promise<void> {
  expect(await nav().evaluate(element => [...element.querySelectorAll<HTMLElement>('.chat__nav-waves, .chat__nav-wave')]
    .map(item => ({ x: item.scrollWidth - item.clientWidth, y: item.scrollHeight - item.clientHeight })))).toEqual(
      expect.arrayContaining([expect.objectContaining({ x: 0, y: 0 })]))
  expect(await nav().evaluate(element => [...element.querySelectorAll<HTMLElement>('.chat__nav-waves, .chat__nav-wave')]
    .every(item => item.scrollHeight <= item.clientHeight + 1 && item.scrollWidth <= item.clientWidth + 1))).toBe(true)
}
async function edgesOutsidePanel(): Promise<void> {
  for (const name of ['回到顶部', '回到底部']) {
    const edge = nav().getByRole('button', { name, exact: true })
    await expect(edge).toBeVisible()
    expect(await edge.evaluate(element => element.closest('.chat__nav-list') === null)).toBe(true)
  }
}
async function expectTurnVisible(count: number, index: number): Promise<void> {
  await expect(conversation().locator(`[data-message-id="${userId(count, index)}"]`)).toBeInViewport()
}
async function capture(info: TestInfo, name: string): Promise<void> {
  const output = info.outputPath(name + '.png')
  await page.screenshot({ path: output, animations: 'disabled' })
  await info.attach(name, { path: output, contentType: 'image/png' })
}
async function expectPreview(row: Locator, text: string): Promise<void> {
  await row.hover()
  await expect(tooltip()).toBeVisible()
  await expect(tooltip()).toContainText(text)
  expect(await tooltip().evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1
  })).toBe(true)
}

test.describe.serial('Work 消息波纹与雷达阈值（新专项）', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    source = engineStorageKey({ mode: 'remote', baseUrl: origin })
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'work-nav-waves-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin,
      autoStartEngine: true, lastModelId: model, appearance: 'dark', lastFolder: '', lastSessionId: '' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root, env })
    health = await monitorElectronHealth(app, 'work-message-nav-waves', [token])
    page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.evaluate(({ key, tasks }) => {
      localStorage.setItem(key, JSON.stringify({ tasks, activeTaskId: tasks[0].id }))
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', workspace: false }))
    }, { key: 'aether.work.state.v1:' + encodeURIComponent(source), tasks: counts.map(count => ({
      id: sessionId(count), title: title(count), draft: draft(count), status: 'done',
      createdAt, updatedAt: createdAt, workspacePath: null, modelId: model, attachments: [], sources: [] })) })
    await page.reload()
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  })
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus) await capture(info, 'navigation-failure')
    health?.assertHealthy(); expect(errors).toEqual([]); expect(chatWrites).toEqual([])
    await expect(work().locator('[role="alert"]:visible')).toHaveCount(0)
    await expect(work().getByText(/协作能力响应无效|Admission response is not an object/)).toHaveCount(0)
  })
  test.afterAll(async ({}, info) => {
    try { if (health) await health.closeAndAssert(info); else await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const owned = resolve(fixture)
        if (dirname(owned) !== fixtureRoot || !basename(owned).startsWith('work-nav-waves-')) throw new Error(`Unsafe cleanup: ${owned}`)
        rmSync(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('只有一轮消息不显示波纹或雷达', async () => {
    await selectCount(1)
    await expect(nav()).toHaveCount(0)
    await assertDrafts(1)
  })

  test('两轮消息逐条显示波纹与悬停预览，外部顶底按钮直接导航', async ({}, info) => {
    await selectCount(2)
    await expect(nav()).toHaveAttribute('data-variant', 'waves')
    await expect(waves()).toHaveCount(2)
    await expect(nav().locator('.chat__nav-trigger')).toHaveCount(0)
    await expect(nav().locator('.chat__nav-list:visible')).toHaveCount(0)
    await edgesOutsidePanel(); await expectNoRailOverflow()
    for (const index of [0, 1]) {
      await expectPreview(waves().nth(index), prompt(2, index))
      await waves().nth(index).click()
      await expectTurnVisible(2, index)
    }
    await capture(info, 'two-message-waves')
    await nav().getByRole('button', { name: '回到顶部', exact: true }).click()
    await expect.poll(() => scroll().evaluate(element => element.scrollTop)).toBeLessThanOrEqual(1)
    await expectTurnVisible(2, 0)
    await nav().getByRole('button', { name: '回到底部', exact: true }).click()
    await expect.poll(() => scroll().evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(2)
    await page.mouse.move(1, 1)
    await expect(tooltip()).toBeHidden()
    await assertDrafts(2)
  })

  test('十轮保持十条波纹，键盘逐条聚焦预览并跳转', async ({}, info) => {
    await selectCount(10)
    await expect(nav()).toHaveAttribute('data-variant', 'waves')
    await expect(waves()).toHaveCount(10)
    await expect(nav().locator('.chat__nav-trigger')).toHaveCount(0)
    await expectNoRailOverflow(); await edgesOutsidePanel()
    for (let index = 0; index < 10; index++) await expectPreview(waves().nth(index), prompt(10, index))
    await page.mouse.move(1, 1)
    await waves().nth(4).focus()
    await page.keyboard.press('Home')
    await expect(waves().first()).toBeFocused()
    await expect(tooltip()).toContainText(prompt(10, 0))
    await page.keyboard.press('ArrowDown')
    await expect(waves().nth(1)).toBeFocused()
    await expect(tooltip()).toContainText(prompt(10, 1))
    await page.keyboard.press('Enter')
    await expectTurnVisible(10, 1)
    await page.keyboard.press('End')
    await expect(waves().last()).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(waves().nth(8)).toBeFocused()
    await page.keyboard.press('Enter')
    await expectTurnVisible(10, 8)
    await capture(info, 'ten-message-waves')
    await assertDrafts(10)
  })

  test('超过十轮收拢雷达，列表才滚动，退出与切换会话清除旧预览', async ({}, info) => {
    await selectCount(11)
    await expect(nav()).toHaveAttribute('data-variant', 'radar')
    await expect(waves()).toHaveCount(0)
    const trigger = nav().getByRole('button', { name: '展开消息导航', exact: true })
    const panel = nav().locator('.chat__nav-list'), entries = nav().locator('.chat__nav-entries')
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await expect(panel).toBeHidden(); await edgesOutsidePanel()
    await trigger.hover()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await expect(panel).toBeVisible()
    await expect(entries.getByRole('button')).toHaveCount(11)
    await expect.poll(() => entries.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0)
    await capture(info, 'eleven-message-radar')
    const last = entries.getByRole('button', { name: `跳转到：${prompt(11, 10)}`, exact: true })
    await last.click()
    await expectTurnVisible(11, 10)
    await expect.poll(() => entries.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await page.mouse.move(1, 1)
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await expect(panel).toBeHidden()
    await trigger.focus()
    await page.keyboard.press('ArrowDown')
    await expect(panel).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
    await expect(panel).toBeHidden()
    await selectCount(2)
    await expect(waves()).toHaveCount(2)
    await expect(nav().locator('.chat__nav-trigger')).toHaveCount(0)
    await expect(tooltip()).toBeHidden()
    await expectPreview(waves().first(), prompt(2, 0))
    await assertDrafts(2)
    await selectCount(1)
    await expect(nav()).toHaveCount(0)
  })
})
