/** Real Electron: Code/Work message navigation advances through short turns,
 * loads unmounted Work history, respects boundaries and keyboard operation,
 * and keeps its compact popover within the reading pane in both appearances.
 * The isolated HTTP fixture does not send prompts or mutate conversation data. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey } from '../src/renderer/src/core/engine/source'

type Mode = 'code' | 'work'
const root = resolve(__dirname, '..'), fixtures = join(root, '.e2e-tmp')
const codeId = 'message-nav-code', longCodeId = 'message-nav-code-long', nestedCodeId = 'message-nav-code-nested', followCodeId = 'message-nav-code-follow'
const workId = 'work-message-nav', model = 'message-nav-fixture'
const token = 'disposable-message-navigation-token', workspaceRoot = '/remote/message-navigation'
const count = 12, longCount = 156, now = Date.now() - 180_000
const session = (mode: Mode): string => mode === 'work' ? workId : codeId
const prompt = (index: number): string => `导航第 ${String(index + 1).padStart(2, '0')} 条：检查这一项。`
const userId = (id: string, index: number): string => `${id}-user-${index}`
const nestedTable = [
  `| ${Array.from({ length: 40 }, (_, index) => `C${index + 1}`).join(' | ')} |`,
  `| ${Array.from({ length: 40 }, () => '---').join(' | ')} |`,
  `| ${Array.from({ length: 40 }, () => '是').join(' | ')} |`
].join('\n')
const histories = new Map<string, EngineHistoryRow[]>(), runs = new Map<string, RootRun[]>()
for (const id of [codeId, longCodeId, nestedCodeId, followCodeId, workId]) {
  const roots = Array.from({ length: id === longCodeId ? longCount : count }, (_, index): RootRun => ({
    schemaVersion: 1, runId: `${id}-run-${index}`, sessionId: id, turnId: `${id}-turn-${index}`,
    userMessageId: userId(id, index), assistantMessageId: `${id}-assistant-${index}`,
    seq: index + 1, version: 2, status: 'succeeded', modelId: model, pending: [], workspacePaths: [workspaceRoot],
    createdAt: now + index * 1000, updatedAt: now + index * 1000 + 100, finishedAt: now + index * 1000 + 100
  }))
  runs.set(id, roots)
  histories.set(id, roots.flatMap((run, index) => [
    { id: run.userMessageId, role: 'user', content: prompt(index), createdAt: run.createdAt,
      conversationId: run.turnId, metadata: { rootRunId: run.runId } },
    { id: run.assistantMessageId, role: 'assistant', content: id === nestedCodeId && index === count - 2
      ? `ANSWER_${index + 1}：已检查。\n\n${nestedTable}` : `ANSWER_${index + 1}：已检查。`, createdAt: run.updatedAt,
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
    if (id === workId && anchor === heldAnchor) { held = { response, body }; return }
    response.end(body); return
  }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'e'.repeat(64)}`, protocolVersion: 1,
      toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'message-navigation' }
    : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '消息导航测试模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true,
      history: id === workId ? rows.slice(-4) : rows, projection: [], run: current, runs: ownRuns, subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, run: current, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: ownRuns }
    : path === '/api/v1/conversation/history' ? (id === workId ? rows.slice(-4) : rows)
    : path === '/api/v1/conversation/sessions' ? [codeId, longCodeId, nestedCodeId, followCodeId].map(sessionId => ({ sessionId,
      title: sessionId === longCodeId ? 'Code 长会话消息导航' : sessionId === nestedCodeId ? 'Code 内层滚动导航'
        : sessionId === followCodeId ? 'Code 追加消息导航' : 'Code 消息导航', lastAt: now, messageCount: histories.get(sessionId)!.length }))
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
const surface = (mode: Mode): Locator => mode === 'work' ? page.locator('.work-view') : page.locator(`#mode-${mode}`)
const nav = (mode: Mode): Locator => surface(mode).getByRole('navigation', { name: '消息导航', exact: true })
const scroller = (mode: Mode): Locator => surface(mode).locator(mode === 'work' ? '.work-conversation__scroll' : '.chat__messages')
const row = (mode: Mode, index: number): Locator => nav(mode).locator(`[data-nav-index="${index}"]`)
const turnId = (mode: Mode, index: number, targetSessionId = session(mode)): string => `${mode === 'work' ? 'message:' : ''}${userId(targetSessionId, index)}`

async function seed(mode: Mode, targetSessionId = session(mode)): Promise<void> {
  releaseRead()
  await app!.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900) })
  await page.evaluate(({ key, mode, id, model, workspaceRoot, now }) => {
    localStorage.setItem(key, JSON.stringify({ tasks: [{ id, title: 'Work 消息导航', status: 'done', draft: '', mentions: [],
      createdAt: now, updatedAt: now, workspacePath: workspaceRoot, modelId: model, attachments: [], sources: [] }], activeTaskId: id, homeSources: [] }))
    localStorage.setItem('aether.app.mode', mode)
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 56 }))
  }, { key: storageKey, mode, id: workId, model, workspaceRoot, now })
  await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
  if (mode === 'code') {
    const history = surface(mode).getByRole('button', { name: '会话历史', exact: true })
    if (await history.getAttribute('aria-pressed') !== 'true') await history.click()
    await surface(mode).locator(`[data-session-id="${targetSessionId}"]`).click()
  }
  await expect(nav(mode)).toHaveAttribute('data-variant', 'radar')
  const expectedCount = runs.get(targetSessionId)!.length
  await expect(nav(mode).locator('[data-nav-index]')).toHaveCount(expectedCount)
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

test.describe.serial('Code / Work 消息导航', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    storageKey = 'aether.work.state.v1:' + encodeURIComponent(engineStorageKey({ mode: 'remote', baseUrl: origin }))
    mkdirSync(fixtures, { recursive: true }); fixture = mkdtempSync(join(fixtures, 'message-navigation-profile-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, remoteWorkspaceRoot: workspaceRoot,
      autoStartEngine: true, lastSessionId: codeId, lastFolder: '', lastModelId: model, appearance: 'light', thinkingMode: 'off' }))
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

  // Retired Code surface; Work navigation is covered below.
  test.skip('Code 短轮次连续上一条/下一条移动真实滚动位置，首尾禁用', async () => {
    await seed('code'); await select('code', 7)
    let previous = await scroller('code').evaluate(element => element.scrollTop)
    for (const index of [6, 5, 4, 3]) {
      await nav('code').getByRole('button', { name: '上一条', exact: true }).click(); await assertTarget('code', index)
      const current = await scroller('code').evaluate(element => element.scrollTop)
      expect(current).toBeLessThan(previous - 20); previous = current
    }
    for (const index of [4, 5, 6, 7]) {
      await nav('code').getByRole('button', { name: '下一条', exact: true }).click(); await assertTarget('code', index)
      const current = await scroller('code').evaluate(element => element.scrollTop)
      expect(current).toBeGreaterThan(previous + 20); previous = current
    }
    await select('code', 0); await expect(nav('code').getByRole('button', { name: '上一条', exact: true })).toBeDisabled()
    await select('code', count - 1); await expect(nav('code').getByRole('button', { name: '下一条', exact: true })).toBeDisabled()
    // The last few short turns can share one clamped scrollTop. Their cursor
    // must still step individually instead of snapping back to the last item.
    for (const index of [count - 2, count - 3]) {
      await nav('code').getByRole('button', { name: '上一条', exact: true }).click(); await assertTarget('code', index)
    }
    await select('code', 6)
    await page.keyboard.press('Escape'); await expect(nav('code')).toHaveAttribute('data-state', 'closed')
    const beforeWheel = await scroller('code').evaluate(element => element.scrollTop)
    const box = await scroller('code').boundingBox()
    if (!box) throw new Error('Missing Code reading pane')
    const point = { x: box.x + box.width * 0.8, y: box.y + box.height / 2 }
    await page.mouse.move(point.x, point.y)
    // The popup can overlap a narrow Code pane. Prove the wheel reaches the
    // transcript instead of scrolling the navigation list above it.
    await expect.poll(() => scroller('code').evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), point)).toBe(true)
    await page.mouse.wheel(0, -500)
    await expect.poll(() => scroller('code').evaluate(element => element.scrollTop)).toBeLessThan(beforeWheel - 100)
    await expect(row('code', 6)).not.toHaveAttribute('aria-current', 'true')
    await openNav('code')
    const readingIndex = Number(await nav('code').locator('[aria-current="true"]').getAttribute('data-nav-index'))
    expect(readingIndex).toBeGreaterThan(0)
    await nav('code').getByRole('button', { name: '上一条', exact: true }).click(); await assertTarget('code', readingIndex - 1)
  })

  test('Work 上一条读取未加载正文后准确定位，并能继续双向逐条导航', async () => {
    await seed('work'); await openNav('work')
    heldAnchor = userId(workId, 7)
    await row('work', 7).click()
    await expect.poll(() => Boolean(held)).toBe(true)
    await expect(scroller('work').locator(`[data-turn-id="${turnId('work', 7)}"]`)).toHaveCount(0)
    releaseRead(); await assertTarget('work', 7)
    for (const index of [6, 5, 4]) {
      await nav('work').getByRole('button', { name: '上一条', exact: true }).click(); await assertTarget('work', index)
      expect(reads.some(read => read.sessionId === workId && read.anchor === userId(workId, index))).toBe(true)
    }
    for (const index of [5, 6, 7]) {
      await nav('work').getByRole('button', { name: '下一条', exact: true }).click(); await assertTarget('work', index)
    }
    await select('work', 0); await expect(nav('work').getByRole('button', { name: '上一条', exact: true })).toBeDisabled()
    await select('work', count - 1); await expect(nav('work').getByRole('button', { name: '下一条', exact: true })).toBeDisabled()
  })

  test.skip('Code 超过300条消息时导航挂载早期轮次，尾部追加不挤出正在阅读的锚点', async () => {
    await seed('code', longCodeId)
    const first = scroller('code').locator(`[data-turn-id="${turnId('code', 0, longCodeId)}"]`)
    const second = scroller('code').locator(`[data-turn-id="${turnId('code', 1, longCodeId)}"]`)
    await expect(first).toHaveCount(0); await expect(second).toHaveCount(0)
    await expect(nav('code').locator('[data-nav-index]')).toHaveCount(longCount)
    await select('code', 1, longCodeId)
    await expect(scroller('code')).toContainText('ANSWER_2：已检查。')
    await nav('code').getByRole('button', { name: '上一条', exact: true }).click()
    await assertTarget('code', 0, longCodeId)
    await expect(nav('code').getByRole('button', { name: '上一条', exact: true })).toBeDisabled()
    await nav('code').getByRole('button', { name: '下一条', exact: true }).click()
    await assertTarget('code', 1, longCodeId)
    const readingTop = await scroller('code').evaluate(element => element.scrollTop)
    appendServerTurn(longCodeId)
    await expect(nav('code').locator('[data-nav-index]')).toHaveCount(longCount + 1)
    await expect(second).toHaveCount(1)
    await expect(row('code', 1)).toHaveAttribute('aria-current', 'true')
    await expect.poll(() => scroller('code').evaluate((element, previous) => Math.abs(element.scrollTop - previous), readingTop)).toBeLessThanOrEqual(2)
    await assertTarget('code', 1, longCodeId)
  })

  test('Work 旧历史响应晚到时保留最新上一条目标，不跳回旧轮次', async () => {
    await seed('work'); await openNav('work')
    heldAnchor = userId(workId, 7)
    await row('work', 7).click(); await expect.poll(() => Boolean(held)).toBe(true)
    await expect(row('work', 7)).toHaveAttribute('aria-current', 'true')
    await nav('work').getByRole('button', { name: '上一条', exact: true }).click()
    await expect(row('work', 6)).toHaveAttribute('aria-current', 'true')
    const readingWindow = await scroller('work').evaluate(element => ({
      top: element.scrollTop,
      anchors: Array.from(element.querySelectorAll<HTMLElement>('.work-conversation__content > .work-conversation-turn')).map(turn => turn.dataset.turnId)
    }))
    // Display reads are serialized. Hold the newer request as soon as the old
    // response is released, exposing the otherwise brief stale-response window.
    releaseRead(userId(workId, 6))
    await expect.poll(() => Boolean(held)).toBe(true)
    expect(reads.at(-1)).toEqual({ sessionId: workId, anchor: userId(workId, 6), limit: 2 })
    // Work caches the stale response but preserves firstId until the latest
    // navigation completes; an old response must not replace that mounted window.
    await expect.poll(() => scroller('work').evaluate(element => Array.from(element.querySelectorAll<HTMLElement>('.work-conversation__content > .work-conversation-turn')).map(turn => turn.dataset.turnId))).toEqual(readingWindow.anchors)
    await expect.poll(() => scroller('work').evaluate((element, top) => Math.abs(element.scrollTop - top), readingWindow.top)).toBeLessThanOrEqual(2)
    await expect(scroller('work').locator(`[data-turn-id="${turnId('work', 6)}"]`)).toHaveCount(0)
    await scroller('work').evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(row('work', 6)).toHaveAttribute('aria-current', 'true')
    await expect(row('work', 7)).not.toHaveAttribute('aria-current', 'true')
    releaseRead(); await assertTarget('work', 6)
    await nav('work').getByRole('button', { name: '下一条', exact: true }).click(); await assertTarget('work', 7)
  })

  test.skip('Code 内层表格滚轮只移动表格，不解除底部主动选择', async () => {
    await seed('code', nestedCodeId); await select('code', count - 2, nestedCodeId)
    await page.keyboard.press('Escape'); await expect(nav('code')).toHaveAttribute('data-state', 'closed')
    const table = scroller('code').locator(`[data-turn-id="${turnId('code', count - 2, nestedCodeId)}"] .md-table-wrap`).first()
    await expect(table).toHaveAttribute('data-scroll-axis', 'x')
    await expect.poll(() => table.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(500)
    await table.hover(); await expect(table).toBeInViewport({ ratio: 0.5 }); await assertTarget('code', count - 2, nestedCodeId)
    const before = await scroller('code').evaluate(element => element.scrollTop)
    await expect.poll(() => table.evaluate(element => element.scrollLeft)).toBe(0)
    await page.mouse.wheel(0, 240)
    await expect.poll(() => table.evaluate(element => element.scrollLeft)).toBeGreaterThan(100)
    await expect.poll(() => scroller('code').evaluate(element => element.scrollTop)).toBe(before)
    await expect(row('code', count - 2)).toHaveAttribute('aria-current', 'true')
    await openNav('code'); await nav('code').getByRole('button', { name: '下一条', exact: true }).click()
    await assertTarget('code', count - 1, nestedCodeId)
  })

  test.skip('Code 回到底部后服务端追加新轮次，导航跟随新的最后一条', async () => {
    await seed('code', followCodeId)
    await nav('code').getByRole('button', { name: '回到底部', exact: true }).click()
    await expect(row('code', count - 1)).toHaveAttribute('aria-current', 'true')
    await expect.poll(() => scroller('code').evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(2)
    appendServerTurn(followCodeId)
    // The regular idle-root poll discovers this server-owned append. No reload
    // or mode switch may erase the navigator's previous bottom selection.
    await expect(nav('code').locator('[data-nav-index]')).toHaveCount(count + 1)
    await expect(scroller('code')).toContainText(`ANSWER_${count + 1}：后台新增消息。`)
    await expect(row('code', count)).toHaveAttribute('aria-current', 'true')
    await expect(row('code', count - 1)).not.toHaveAttribute('aria-current', 'true')
    await expect.poll(() => scroller('code').evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(2)
    await openNav('code'); await expect(nav('code').getByRole('button', { name: '下一条', exact: true })).toBeDisabled()
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
