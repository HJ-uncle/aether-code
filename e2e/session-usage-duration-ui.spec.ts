/** Real Electron + authenticated HTTP: execution duration excludes idle gaps,
 * survives history reload, advances only for active runs, and shares the same
 * semantics in Work and Code. Owns one profile/window; build before running. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'usage-duration-token', model = 'usage-duration-model', now = Date.now()
const settled = 'work-usage-three-turns', live = 'work-usage-live-turn', unknown = 'work-usage-unknown', partial = 'work-usage-partial'
const titles = new Map([[settled, '三个简短回合'], [live, '继续执行的会话'], [unknown, '缺少计时的历史'], [partial, '部分计时的历史']])
const prompts = ['你是谁', '项目需要生成 Excel 和文档、PPT', '你好']
const histories = new Map<string, EngineHistoryRow[]>(), roots = new Map<string, RootRun[]>()
const errors: string[] = [], requests: string[] = []
let app: ElectronApplication | undefined, page: Page, fixture = '', storageKey = '', source = ''
let activeStream: ServerResponse | undefined, eventSequence = 0
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const latestRun = (id: string): RootRun | undefined => roots.get(id)?.at(-1)

function appendRun(id: string, index: number, start: number | undefined, finish: number | undefined, status: RootRun['status']): void {
  const at = start ?? now - 120_000
  const run: RootRun = { schemaVersion: 1, runId: `${id}-root-${index}`, sessionId: id,
    turnId: `${id}-turn-${index}`, userMessageId: `${id}-user-${index}`, assistantMessageId: `${id}-assistant-${index}`,
    seq: index, version: status === 'running' ? 1 : 2, status, modelId: model, pending: [],
    createdAt: at, updatedAt: finish ?? at, workspacePaths: ['/remote/usage-test'],
    ...(start === undefined ? {} : { startedAt: start }), ...(finish === undefined ? {} : { finishedAt: finish }) }
  roots.set(id, [...(roots.get(id) ?? []), run])
  const metadata = { rootRunId: run.runId }, conversationId = run.turnId
  const rows: EngineHistoryRow[] = [
    { id: run.userMessageId, role: 'user', content: prompts[index - 1] ?? '继续处理', conversationId, metadata, createdAt: at },
    { id: run.assistantMessageId, role: 'assistant', content: status === 'running' ? 'LIVE_EXECUTION' : `FINAL_${id}_${index}`,
      conversationId, metadata, createdAt: finish ?? at,
      usage: { promptTokens: 7000, completionTokens: index === 3 ? 400 : 300, totalTokens: index === 3 ? 7400 : 7300 } }
  ]
  histories.set(id, [...(histories.get(id) ?? []), ...rows])
}

function closeStream(): void {
  if (activeStream && !activeStream.destroyed && !activeStream.writableEnded) activeStream.end('data: [DONE]\n\n')
  activeStream = undefined
}

function resetHistory(): void {
  closeStream(); histories.clear(); roots.clear(); eventSequence = 0
  for (const id of [settled, live, partial]) {
    // Nearly seven hours separate the first question from the last answer,
    // while each root really ran for ten seconds.
    for (const [index, offset] of [-7 * 3600_000, -3 * 3600_000, -600_000].entries())
      appendRun(id, index + 1, now + offset, now + offset + 10_000, 'succeeded')
  }
  appendRun(live, 4, now - 5000, undefined, 'running')
  appendRun(unknown, 1, undefined, undefined, 'succeeded')
  appendRun(partial, 4, undefined, undefined, 'succeeded')
}

function finishLive(): void {
  const previous = latestRun(live)
  if (!previous || !activeStream) throw new Error('The live execution has not subscribed')
  const run: RootRun = { ...previous, status: 'succeeded', version: 2, updatedAt: now + 10_000, finishedAt: now + 10_000 }
  roots.set(live, [...roots.get(live)!.slice(0, -1), run])
  histories.set(live, histories.get(live)!.map(row => row.id === run.assistantMessageId ? { ...row, content: 'LIVE_FINISHED', createdAt: run.finishedAt } : row))
  const payload: ChatSsePayload = { run }
  activeStream.write(`id: ${run.runId}:${++eventSequence}\ndata: ${JSON.stringify(payload)}\n\n`)
  closeStream()
}

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, id = url.searchParams.get('sessionId') ?? ''
  requests.push(`${request.method} ${path} ${id}`)
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  let raw = ''; for await (const chunk of request) raw += chunk.toString()
  const input: unknown = raw ? JSON.parse(raw) : {}
  const run = latestRun(id), rows = histories.get(id) ?? []
  if (path === '/api/v1/workspace/bind') {
    const workspaceRoot = input && typeof input === 'object' && 'workspaceRoot' in input ? input.workspaceRoot : '/remote/usage-test'
    response.end(envelope({ workspaceRoot })); return
  }
  if (path === '/api/v1/chat/stream') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    if (id === live && run?.status === 'running') {
      if (activeStream && !activeStream.destroyed && !activeStream.writableEnded) throw new Error('Duplicate live execution subscription')
      activeStream = response
      response.flushHeaders()
      response.once('close', () => { if (activeStream === response) activeStream = undefined })
    } else response.end('data: [DONE]\n\n')
    return
  }
  if (path === '/api/v1/conversation/display') {
    const users = rows.filter(row => row.role === 'user')
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: users.map(row => ({ userMessageId: row.id,
      conversationId: row.conversationId, preview: row.content, createdAt: row.createdAt })), messages: rows,
      loadedTurnIds: users.map(row => row.id), revision: `${id}-${rows.length}-${run?.version ?? 0}`,
      mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  if (['/api/v1/cron/capabilities', '/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET') throw new Error(`Unexpected mutation: ${request.method} ${path}`)
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'d'.repeat(64)}`, protocolVersion: 1,
      toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'usage-duration' }
    : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: '耗时核对模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: run?.status === 'running' ? 'live' : 'persisted',
      eventId: run?.status === 'running' ? `${run.runId}:${eventSequence}` : null, finished: run?.status !== 'running',
      history: rows, projection: [], run, runs: roots.get(id) ?? [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: run?.status === 'running', finished: run?.status !== 'running', run,
      lastEventId: run?.status === 'running' ? `${run.runId}:${eventSequence}` : null }
    : path === '/api/v1/chat/runs' ? { runs: roots.get(id) ?? [] }
    : path === '/api/v1/conversation/history' ? rows
    : path === '/api/v1/conversation/sessions' ? [...titles].map(([sessionId, title]) => ({ sessionId, title, lastAt: now, messageCount: histories.get(sessionId)?.length ?? 0 }))
    : path === '/api/v1/workspace/directory' ? { root: '/remote/usage-test', bindingEpoch: `binding-${id}`, entries: [] }
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

const work = (): Locator => page.locator('.work-view')
const meter = (owner = work()): Locator => owner.locator('.usage-meter')
const time = (owner = work()): Locator => meter(owner).locator('.usage-meter__time')
const popover = (): Locator => page.getByRole('dialog', { name: '会话用量明细', exact: true })

async function seed(): Promise<void> {
  resetHistory()
  await page.clock.setFixedTime(now)
  const tasks = [...titles].map(([id, title]) => ({ id, title, status: id === live ? 'running' : 'done', draft: '', mentions: [],
    createdAt: now - 7 * 3600_000, updatedAt: now, workspacePath: '/remote/usage-test', modelId: model, attachments: [], sources: [] }))
  await page.evaluate(({ key, tasks, activeTaskId }) => {
    window.dispatchEvent(new Event('blur'))
    localStorage.setItem(key, JSON.stringify({ tasks, activeTaskId, homeSources: [] }))
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 56 }))
  }, { key: storageKey, tasks, activeTaskId: settled })
  await page.reload()
  await expect(work().getByRole('heading', { name: titles.get(settled)!, exact: true })).toBeVisible()
  await expect(meter().locator('.usage-meter__tokens')).toHaveText('22k')
}

async function selectTask(id: string): Promise<void> {
  await work().locator(`.work-sidebar__task-row[data-task-id="${id}"] .work-sidebar__task`).click()
  await expect(work().getByRole('heading', { name: titles.get(id)!, exact: true })).toBeVisible()
}

test.describe.serial('会话累计执行用时', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    source = engineStorageKey({ mode: 'remote', baseUrl: origin }); storageKey = 'aether.work.state.v1:' + encodeURIComponent(source)
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'usage-duration-profile-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin,
      remoteWorkspaceRoot: '/remote/usage-test', autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: model, appearance: 'dark', thinkingMode: 'off' }))
    const env = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY',
      'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900); window.show(); window.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  })
  test.beforeEach(seed)
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && page && !page.isClosed()) {
      const path = info.outputPath('usage-duration-failure.png')
      await page.screenshot({ path }); await info.attach('失败时页面', { path, contentType: 'image/png' })
    }
    await info.attach('usage-duration-http', { body: JSON.stringify({ errors, requests }, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([])
  })
  test.afterAll(async () => {
    closeStream()
    try { await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('usage-duration-profile-')) throw new Error(`Unsafe cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  test('跨近七小时的三轮短对话仅累计三十秒，重载保持计时和 Token 总量', async ({}, info) => {
    await expect(time()).toHaveText('30s')
    await expect(time()).toHaveAttribute('title', /含轮内等待，不含轮间空闲/)
    await meter().locator('button').click()
    await expect(popover()).toContainText('已加载 3 轮 · 累计 30s')
    await expect(popover().locator('.usage-popover__total-value')).toHaveAttribute('title', '22,000 tokens')
    await popover().screenshot({ path: info.outputPath('session-usage-duration-corrected.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await page.reload()
    await expect(time()).toHaveText('30s')
    await expect(meter().locator('.usage-meter__tokens')).toHaveText('22k')
  })

  test('新一轮仅增加本轮执行时间，终态后时钟前进不再增加', async () => {
    await selectTask(live)
    await expect.poll(() => Boolean(activeStream)).toBe(true)
    await expect(time()).toHaveText('35s')
    await page.clock.setFixedTime(now + 10_000)
    await expect(time()).toHaveText('45s')
    finishLive()
    await expect(work().locator('.work-task-heading__actions')).toContainText('已完成')
    await expect(time()).toHaveText('45s')
    await page.clock.setFixedTime(now + 4 * 3600_000)
    await meter().locator('button').click()
    await expect(popover()).toContainText('已加载 4 轮 · 累计 45s')
    await expect(time()).toHaveText('45s')
    await page.keyboard.press('Escape')
    await selectTask(settled)
    await expect(time()).toHaveText('30s')
    await selectTask(live)
    await expect(time()).toHaveText('45s')
  })

  test('缺少可靠起止时间不沿用另一会话用时，部分计时明确为已知部分', async () => {
    await selectTask(unknown)
    await expect(meter().locator('.usage-meter__tokens')).toHaveText('7.3k')
    await expect(time()).toHaveCount(0)
    await meter().locator('button').click()
    await expect(popover()).toContainText('已加载 1 轮')
    await expect(popover().locator('.usage-popover__head .usage-popover__meta')).toHaveAttribute('title', /部分历史记录缺少起止时间/)
    await page.keyboard.press('Escape')
    await selectTask(partial)
    await expect(time()).toHaveText('≥30s')
    await meter().locator('button').click()
    await expect(popover()).toContainText('已加载 4 轮 · 已知 30s')
    await page.keyboard.press('Escape')
    await selectTask(settled)
    await expect(time()).toHaveText('30s')
  })

  test('Code 模式共用累计执行时间，不再显示跨轮空闲跨度', async () => {
    await page.evaluate(({ key, sessionId }) => {
      localStorage.setItem(key, sessionId)
      localStorage.setItem('aether.app.mode', 'code')
    }, { key: sessionStorageKey('aether:lastSessionId', source), sessionId: settled })
    await page.reload()
    const chat = page.locator('.chat')
    if (!await chat.isVisible()) await page.getByRole('button', { name: '切换对话面板', exact: true }).click()
    await expect(chat).toBeVisible()
    await expect(time(chat)).toHaveText('30s')
    await expect(meter(chat).locator('.usage-meter__tokens')).toHaveText('22k')
    await meter(chat).locator('button').click()
    await expect(popover()).toContainText('已加载 3 轮 · 累计 30s')
  })
})
