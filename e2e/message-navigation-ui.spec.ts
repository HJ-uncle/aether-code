/** Real Electron: Default workspace message navigation advances through short turns,
 * loads all Work history before ordinary navigation, respects boundaries and keyboard operation,
 * and keeps its compact popover within the reading pane in both appearances.
 * The isolated HTTP fixture does not send prompts or mutate conversation data. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

type Mode = 'work'
const root = resolve(__dirname, '..'), fixtures = join(root, '.e2e-tmp')
const sessionId = 'work-message-nav', model = 'message-nav-fixture'
const token = 'disposable-message-navigation-token', workspaceRoot = '/remote/message-navigation'
const count = 12, now = Date.now() - 180_000
const session = (_mode: Mode): string => sessionId
const prompt = (index: number): string => `导航第 ${String(index + 1).padStart(2, '0')} 条：检查这一项。`
const userId = (id: string, index: number): string => `${id}-user-${index}`
const histories = new Map<string, EngineHistoryRow[]>(), runs = new Map<string, RootRun[]>()
for (const id of [sessionId]) {
  const roots = Array.from({ length: count }, (_, index): RootRun => ({
    schemaVersion: 1, runId: `${id}-run-${index}`, sessionId: id, turnId: `${id}-turn-${index}`,
    userMessageId: userId(id, index), assistantMessageId: `${id}-assistant-${index}`,
    seq: index + 1, version: 2, status: 'succeeded', modelId: model, pending: [], workspacePaths: [workspaceRoot],
    createdAt: now + index * 1000, updatedAt: now + index * 1000 + 100, finishedAt: now + index * 1000 + 100
  }))
  runs.set(id, roots)
  histories.set(id, roots.flatMap((run, index) => [
    { id: run.userMessageId, role: 'user', content: prompt(index), createdAt: run.createdAt,
      conversationId: run.turnId, metadata: { rootRunId: run.runId } },
    { id: run.assistantMessageId, role: 'assistant', content: `ANSWER_${index + 1}：已检查。`, createdAt: run.updatedAt,
      conversationId: run.turnId, metadata: { rootRunId: run.runId } }
  ]))
}
const errors: string[] = [], mutations: string[] = []
const reads: Array<{ sessionId: string; anchor: string | null; limit: number }> = []
let heldAnchor: string | undefined, held: { response: ServerResponse; body: string } | undefined
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
function releaseRead(nextAnchor?: string): void { held?.response.end(held.body); held = undefined; heldAnchor = nextAnchor }
function appendServerTurn(id: string): number {
  const ownRuns = runs.get(id)!, index = ownRuns.length, previous = ownRuns.at(-1)!, createdAt = previous.createdAt + 1000
  const next: RootRun = { ...previous, runId: `${id}-run-${index}`, turnId: `${id}-turn-${index}`,
    userMessageId: userId(id, index), assistantMessageId: `${id}-assistant-${index}`, seq: index + 1,
    createdAt, updatedAt: createdAt + 100, finishedAt: createdAt + 100 }
  runs.set(id, [...ownRuns, next])
  histories.set(id, [...histories.get(id)!,
    { id: next.userMessageId, role: 'user', content: prompt(index), createdAt,
      conversationId: next.turnId, metadata: { rootRunId: next.runId } },
    { id: next.assistantMessageId, role: 'assistant', content: `ANSWER_${index + 1}：后台新增消息。`, createdAt: createdAt + 100,
      conversationId: next.turnId, metadata: { rootRunId: next.runId } }
  ])
  return index
}
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  if (['/api/v1/cron/capabilities', '/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  const rows = histories.get(id) ?? [], ownRuns = runs.get(id) ?? [], current = ownRuns.at(-1) ?? null
  if (path === '/api/v1/workspace/bind') { response.end(envelope({ workspaceRoot })); return }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  if (request.method !== 'GET') { mutations.push(`${request.method} ${path}`); throw new Error(`Navigation must not mutate ${path}`) }
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user'), anchor = url.searchParams.get('anchorMessageId')
    const limit = Number(url.searchParams.get('limit') ?? 2)
    const start = anchor ? users.findIndex(row => row.id === anchor) : Math.max(0, users.length - limit)
    if (start < 0) throw new Error(`Missing requested turn ${anchor}`)
    const selected = users.slice(start, start + limit), ids = new Set(selected.map(row => row.conversationId))
    reads.push({ sessionId: id, anchor, limit })
    const body = envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({
      userMessageId: row.id, conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })),
      messages: rows.filter(row => ids.has(row.conversationId)), loadedTurnIds: selected.map(row => row.id),
      revision: `${id}-stable`, mutationRevision: 'unchanged', backend: 'jsonl', completeness: 'complete' })
    if (id === sessionId && anchor === heldAnchor) { held = { response, body }; return }
    response.end(body); return
  }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'e'.repeat(64)}`, protocolVersion: 1,
      toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'message-navigation' }
    : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '消息导航测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: id === sessionId ? rows.slice(-4) : rows, projection: [], run: current, runs: ownRuns, subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: current, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: ownRuns }
    : path === '/api/v1/conversation/history' ? (id === sessionId ? rows.slice(-4) : rows)
    : path === '/api/v1/conversation/sessions' ? [{ sessionId, title: '消息导航', lastAt: now, messageCount: histories.get(sessionId)!.length }]
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: 'nav-test', sessionId: id,
      namespace: { id: 'nav-test-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/workspace/directory' ? { root: workspaceRoot, bindingEpoch: 'one', entries: [] }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId: id }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

let app: ElectronApplication | undefined, page: Page, fixture = '', storageKey = ''
const surface = (_mode: Mode): Locator => page.locator('.work-view')
const nav = (mode: Mode): Locator => surface(mode).getByRole('navigation', { name: '消息导航', exact: true })
const scroller = (mode: Mode): Locator => surface(mode).locator('.work-conversation__scroll')
const row = (mode: Mode, index: number): Locator => nav(mode).locator(`[data-nav-index="${index}"]`)
const turnId = (mode: Mode, index: number, targetSessionId = session(mode)): string => `message:${userId(targetSessionId, index)}`

async function seed(mode: Mode, targetSessionId = session(mode), initialHold?: string): Promise<void> {
  releaseRead(initialHold)
  await app!.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900) })
  await page.evaluate(({ key, id, model, workspaceRoot, now }) => {
    localStorage.setItem(key, JSON.stringify({ tasks: [{ id, title: 'Work 消息导航', status: 'done', draft: '', mentions: [],
      createdAt: now, updatedAt: now, workspacePath: workspaceRoot, modelId: model, attachments: [], sources: [] }], activeTaskId: id, homeSources: [] }))
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 56 }))
  }, { key: storageKey, id: sessionId, model, workspaceRoot, now })
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  const expectedCount = runs.get(targetSessionId)!.length
  if (initialHold) {
    await expect.poll(() => Boolean(held)).toBe(true)
    await expect(nav(mode)).toHaveAttribute('data-variant', 'waves')
    await expect(nav(mode).locator('[data-nav-index]')).toHaveCount(2)
  } else {
    await expect(nav(mode)).toHaveAttribute('data-variant', 'radar')
    await expect(nav(mode).locator('[data-nav-index]')).toHaveCount(expectedCount)
  }
  await expect(scroller(mode)).toContainText(`ANSWER_${expectedCount}`)
  await page.locator('html').evaluate(element => element.setAttribute('data-appearance', 'light'))
}
async function openNav(mode: Mode): Promise<void> {
  const trigger = nav(mode).getByRole('button', { name: '展开消息导航', exact: true })
  // Enter is a supported open gesture and keeps focus in the navigation while
  // the longer transform finishes. Opacity alone becomes ready too early.
  await trigger.focus(); await trigger.press('Enter')
  await expect(nav(mode)).toHaveAttribute('data-state', 'open')
  await expect(nav(mode).locator('.chat__nav-list')).toHaveCSS('opacity', '1')
  await expect(nav(mode).locator('.chat__nav-list')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
}
async function assertTarget(mode: Mode, index: number, targetSessionId = session(mode)): Promise<void> {
  const id = turnId(mode, index, targetSessionId)
  await expect(scroller(mode).locator(`[data-turn-id="${id}"]`).first()).toBeVisible()
  // Wait through scroll callbacks and host layout effects. A transient active
  // class alone would pass while the next frame silently selects another turn.
  await scroller(mode).evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect(row(mode, index)).toHaveAttribute('aria-current', 'true')
  await expect.poll(async () => scroller(mode).evaluate((container, id) => {
    const anchor = Array.from(container.querySelectorAll<HTMLElement>('[data-turn-id]')).find(node => node.dataset.turnId === id)
    if (!anchor) return Number.POSITIVE_INFINITY
    const top = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
    const expected = Math.min(Math.max(0, top - 8), Math.max(0, container.scrollHeight - container.clientHeight))
    return Math.abs(container.scrollTop - expected)
  }, id)).toBeLessThanOrEqual(3)
}
async function select(mode: Mode, index: number, targetSessionId = session(mode)): Promise<void> {
  await openNav(mode); await row(mode, index).click(); await assertTarget(mode, index, targetSessionId)
}

test.describe.serial('默认工作台消息导航', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    storageKey = 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin }))
    mkdirSync(fixtures, { recursive: true }); fixture = mkdtempSync(join(fixtures, 'message-navigation-profile-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, remoteWorkspaceRoot: workspaceRoot,
      autoStartEngine: true, lastSessionId: sessionId, lastFolder: '', lastModelId: model, appearance: 'light', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900); window.show(); window.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  })
  test.afterEach(async ({}, info) => {
    releaseRead()
    if (info.status !== info.expectedStatus && page && !page.isClosed()) {
      const path = info.outputPath('message-navigation-failure.png'); await page.screenshot({ path }); await info.attach('失败时页面', { path, contentType: 'image/png' })
    }
    await info.attach('navigation-http', { body: JSON.stringify({ errors, mutations, reads }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([]); expect(mutations).toEqual([])
  })
  test.afterAll(async () => {
    releaseRead()
    try { await app?.close() } finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtures || !basename(target).startsWith('message-navigation-profile-')) throw new Error(`Unsafe cleanup ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('Work 初次自动加载全部12轮，上一条下一条直接定位且不再读取分页', async () => {
    const beforeSeed = reads.length
    await seed('work')
    await expect(scroller('work').locator('.work-conversation__content > .work-conversation-turn')).toHaveCount(count)
    await expect(scroller('work').locator('.work-message')).toHaveCount(count * 2)
    await expect(scroller('work')).toContainText('ANSWER_1：已检查。')
    expect(reads.slice(beforeSeed).filter(read => read.sessionId === sessionId))
      .toEqual(expect.arrayContaining([{ sessionId, anchor: null, limit: 10 }, { sessionId, anchor: userId(sessionId, 0), limit: 10 }]))
    const beforeNavigation = reads.length
    await select('work', 7)
    for (const index of [6, 5, 4]) {
      await nav('work').getByRole('button', { name: '上一条', exact: true }).click(); await assertTarget('work', index)
    }
    for (const index of [5, 6, 7]) {
      await nav('work').getByRole('button', { name: '下一条', exact: true }).click(); await assertTarget('work', index)
    }
    await select('work', 0); await expect(nav('work').getByRole('button', { name: '上一条', exact: true })).toBeDisabled()
    await select('work', count - 1); await expect(nav('work').getByRole('button', { name: '下一条', exact: true })).toBeDisabled()
    expect(reads.slice(beforeNavigation).filter(read => read.sessionId === sessionId && read.anchor !== null)).toEqual([])
    await expect(scroller('work').locator('.work-conversation__content > .work-conversation-turn')).toHaveCount(count)
  })

  test('Work 冷历史加载期间切换目标，迟到的完整响应保留最新导航意图', async () => {
    await seed('work', sessionId, userId(sessionId, 0))
    expect(reads.at(-1)).toEqual({ sessionId, anchor: userId(sessionId, 0), limit: 10 })
    await expect(scroller('work').locator('.work-conversation__content > .work-conversation-turn')).toHaveCount(2)
    await expect(scroller('work').locator(`[data-turn-id="${turnId('work', 0)}"]`)).toHaveCount(0)
    // The full cache commits atomically. Only the two snapshot turns are
    // navigable while the first older body is deliberately held by the server.
    await row('work', 0).click()
    await expect(row('work', 0)).toHaveAttribute('aria-current', 'true')
    await row('work', 1).click()
    await expect(row('work', 1)).toHaveAttribute('aria-current', 'true')
    expect(Boolean(held), 'both navigation choices must precede the late response').toBe(true)
    releaseRead()
    await expect(nav('work')).toHaveAttribute('data-variant', 'radar')
    await expect(nav('work').locator('[data-nav-index]')).toHaveCount(count)
    await expect(scroller('work').locator('.work-conversation__content > .work-conversation-turn')).toHaveCount(count)
    // The selected message moves from local index 1 to global index 11. A
    // stale hydration must not retain index 1 or restore the earlier selection.
    await assertTarget('work', count - 1)
    await expect(row('work', count - 2)).not.toHaveAttribute('aria-current', 'true')
    await openNav('work')
    await nav('work').getByRole('button', { name: '上一条', exact: true }).click(); await assertTarget('work', count - 2)
    await nav('work').getByRole('button', { name: '下一条', exact: true }).click(); await assertTarget('work', count - 1)
  })

  test('Work 冷历史补齐保留用户实际滚动后的阅读位置，之后仍可自由滚动', async () => {
    const original = histories.get(sessionId)!
    histories.set(sessionId, original.map((message, index) => index === original.length - 1 ? { ...message,
      content: `ANSWER_${count}：已检查。\n\n` + Array.from({ length: 50 }, (_, index) =>
        `READING_PARAGRAPH_${index + 1}：完整历史还未返回时，先阅读这一段长回复。`).join('\n\n') } : message))
    try {
      await seed('work', sessionId, userId(sessionId, 0))
      await row('work', 1).click()
      await expect(row('work', 1)).toHaveAttribute('aria-current', 'true')
      const beforeWheel = await scroller('work').evaluate(element => element.scrollTop)
      await scroller('work').hover({ position: { x: 8, y: 32 } })
      await page.mouse.wheel(0, 500)
      await expect.poll(() => scroller('work').evaluate(element => element.scrollTop)).toBeGreaterThan(beforeWheel + 100)
      const readPosition = () => scroller('work').evaluate((element, messageId) => {
        const message = element.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)!
        return { top: element.scrollTop, offset: message.getBoundingClientRect().top - element.getBoundingClientRect().top }
      }, `${sessionId}-assistant-${count - 1}`)
      await scroller('work').evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const reading = await readPosition()
      expect(reading.offset, 'the user must actually be reading inside the long reply').toBeLessThan(-100)
      expect(Boolean(held)).toBe(true)
      releaseRead()
      await expect(scroller('work').locator('.work-conversation__content > .work-conversation-turn')).toHaveCount(count)
      await expect.poll(async () => Math.abs((await readPosition()).offset - reading.offset)).toBeLessThanOrEqual(3)
      const restored = await readPosition()
      expect(restored.top, 'the prepended prefix must be compensated without moving the visible reply').toBeGreaterThan(reading.top + 100)
      await page.mouse.wheel(0, -240)
      await expect.poll(() => scroller('work').evaluate(element => element.scrollTop)).toBeLessThan(restored.top - 100)
      await scroller('work').evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      expect((await readPosition()).top, 'restoring history must not lock later manual scrolling').toBeLessThan(restored.top - 100)
    } finally {
      releaseRead()
      histories.set(sessionId, original)
    }
  })

  test('Work 140轮完整历史保留已有节点与最新导航锚点，滚动不改变全量挂载', async () => {
    const originalHistory = histories.get(sessionId)!, originalRuns = runs.get(sessionId)!
    const total = 140
    while (runs.get(sessionId)!.length < total) appendServerTurn(sessionId)
    try {
      await seed('work', sessionId, userId(sessionId, 0))
      await row('work', 1).click()
      await expect(row('work', 1)).toHaveAttribute('aria-current', 'true')
      const existing = await scroller('work').evaluateHandle(element =>
        Array.from(element.querySelectorAll<HTMLElement>('.work-conversation__content > .work-conversation-turn')))
      try {
        releaseRead()
        await expect(scroller('work').locator('.work-conversation__content > .work-conversation-turn')).toHaveCount(total)
        await expect(scroller('work').locator('.work-message')).toHaveCount(total * 2)
        await expect(scroller('work')).toHaveCSS('visibility', 'visible')
        await assertTarget('work', total - 1)
        expect(await existing.evaluate(nodes => nodes.every(node => node.isConnected)), 'the original tail nodes must remain mounted').toBe(true)
        const height = await scroller('work').evaluate(element => element.scrollHeight)
        for (const index of [0, 70, total - 1]) {
          await select('work', index)
          await expect(scroller('work').locator('.work-conversation__content > .work-conversation-turn')).toHaveCount(total)
          expect(await scroller('work').evaluate(element => element.scrollHeight), 'navigation must retain the full transcript height').toBe(height)
        }
        expect(await existing.evaluate(nodes => nodes.every(node => node.isConnected))).toBe(true)
      } finally {
        await existing.dispose()
      }
    } finally {
      releaseRead()
      histories.set(sessionId, originalHistory)
      runs.set(sessionId, originalRuns)
    }
  })

  for (const mode of ['work'] as const) test(`${mode} 键盘跳转与窄窗深浅色导航保持紧凑可操作`, async ({}, info) => {
    await seed(mode); await openNav(mode)
    const trigger = nav(mode).getByRole('button', { name: '展开消息导航', exact: true })
    await trigger.focus(); await page.keyboard.press('Home'); await expect(row(mode, 0)).toBeFocused()
    await page.keyboard.press('ArrowDown'); await expect(row(mode, 1)).toBeFocused()
    await page.keyboard.press('Enter'); await assertTarget(mode, 1)
    await page.keyboard.press('End'); await expect(row(mode, count - 1)).toBeFocused()
    await page.keyboard.press('Enter'); await assertTarget(mode, count - 1)
    await page.keyboard.press('Escape'); await expect(trigger).toBeFocused(); await expect(nav(mode)).toHaveAttribute('data-state', 'closed')
    await app!.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(600, 600); window.setContentSize(760, 900) })
    for (const appearance of ['light', 'dark']) {
      await page.locator('html').evaluate((element, value) => element.setAttribute('data-appearance', value), appearance)
      await openNav(mode)
      const bounds = await nav(mode).locator('.chat__nav-list').boundingBox()
      if (!bounds) throw new Error('Missing open message navigation panel')
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width)
      expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height)
      for (const label of ['上一条', '下一条']) {
        const button = await nav(mode).getByRole('button', { name: label, exact: true }).boundingBox()
        if (!button) throw new Error(`Missing navigation control ${label}`)
        expect(button.height).toBeGreaterThanOrEqual(24); expect(button.height).toBeLessThanOrEqual(40)
        expect(button.width).toBeLessThan(bounds.width / 2)
      }
      const path = info.outputPath(`${mode}-navigation-${appearance}-narrow.png`)
      await page.screenshot({ path, animations: 'disabled' }); await info.attach(`${mode}-${appearance}`, { path, contentType: 'image/png' })
    }
  })
})
