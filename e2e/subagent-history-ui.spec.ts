/** Real Electron + fake HTTP coverage: authoritative totals, fixed history watermarks,
 * bounded rows, explicit detail chunks and stale responses after switching tasks.
 * No model is invoked. The coordinator must build the IDE before running this spec. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { RootRun } from '../src/shared/root-run'
import type { SubagentRunView, SubagentToolSummary } from '../src/shared/subagent'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'subagent-history-fixture-token', modelId = 'subagent-history-model'
interface Session { run: RootRun; child: SubagentRunView; history: Array<{ id: string; role: string; content: string; createdAt: number }>; projection: ChatSsePayload[] }
const sessions = new Map<string, Session>()
const toolRequests: Array<{ runId: string; atSeq: number; cursor: number }> = []
const detailRequests: Array<{ runId: string; atSeq: number; offset: number; limit: number }> = []
const listRequests: string[] = []
const chatRequests: Array<{ sessionId: string; message: string }> = []
const invalidHistoryResponses: Array<{ runId: string; requestedSeq: number; returnedSeq: number }> = []
const errors: string[] = []
let app: ElectronApplication | undefined, page: Page, health: ElectronHealthMonitor | undefined, fixture = '', parent = ''
let holdNextPage = false, heldPage: { response: ServerResponse; body: string } | undefined
let invalidHistoryFor = '', holdRetryHistoryFor = ''
let heldRetryHistory: { response: ServerResponse; body: string } | undefined
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const capabilityBody = () => envelope({ schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true })
const summary = (index: number): SubagentToolSummary => ({ id: `tool-${index}`, name: 'read_file', args: { path: `file-${index}.ts` }, status: 'succeeded', ordinal: index, revisionSeq: index, detailRef: `detail-${index}`, detailTruncated: true })
const rawDetail = Buffer.from(JSON.stringify({ args: { path: 'file-1.ts' }, output: `FIRST_CHUNK_${'x'.repeat(40000)}SECOND_CHUNK_${'y'.repeat(40000)}FINAL_CHUNK` }), 'utf8')
function child(parentId: string, rootRun: RootRun): SubagentRunView {
  const latest = { ...summary(4100), name: 'grep_search' }
  return { schemaVersion: 2, view: 'summary', runId: `child-${parentId}`, tenantId: 'fixture', rootSessionId: parentId, parentSessionId: parentId,
    parentConversationId: rootRun.turnId, parentMessageId: rootRun.assistantMessageId, parentToolCallId: `delegate-${parentId}`, childSessionId: `context-${parentId}`,
    task: '检查长任务', description: '耐久测试代理', agentName: '耐久测试代理', modelId, status: 'running', lastSeq: 5000, createdAt: Date.now(), updatedAt: Date.now(),
    usage: {}, toolCount: 4100, activeToolCount: 0, toolCalls: [latest], latestActivity: latest, continuation: { readOnly: false },
    coverage: { asOfSeq: 5000, toolCount: 4100, includedToolCount: 1, activeToolCount: 0, includedActiveToolCount: 0, ids: [latest.id], hasMore: true, truncated: true, completeness: 'partial' } }
}
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) { response.writeHead(401).end(envelope(null)); return }
    let raw = ''
    for await (const part of request) raw += part.toString()
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    if (request.method === 'POST' && path === '/api/v1/chat') {
      const id = String(body.sessionId), now = Date.now()
      chatRequests.push({ sessionId: id, message: String(body.message) })
      const run: RootRun = { schemaVersion: 1, runId: `root-${id}`, sessionId: id, turnId: `turn-${id}`, userMessageId: `user-${id}`, assistantMessageId: `assistant-${id}`, seq: 4, version: 1, status: 'succeeded', modelId, pending: [], workspacePaths: [], createdAt: now, updatedAt: now, finishedAt: now }
      const delegated = child(id, run), user = { id: run.userMessageId, role: 'user', content: String(body.message), createdAt: now }
      const content = `任务已就绪：${String(body.message)}`
      const projection: ChatSsePayload[] = [{ userMessage: user }, { subagentEvent: { schemaVersion: 2, kind: 'snapshot', runId: delegated.runId, seq: delegated.lastSeq, view: delegated } }, { content }, { run }]
      sessions.set(id, { run, child: delegated, projection, history: [user, { id: run.assistantMessageId, role: 'assistant', content, createdAt: now }] })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      projection.forEach((payload, index) => response.write(`id: ${run.runId}:${index + 1}\ndata: ${JSON.stringify(payload)}\n\n`))
      response.end('data: [DONE]\n\n'); return
    }
    if (path === '/api/v1/subagent/capabilities') {
      response.setHeader('content-type', 'application/json')
      response.end(capabilityBody()); return
    }
    if (path === '/api/v1/subagent/runs') {
      listRequests.push(url.searchParams.get('parentSessionId') ?? '')
      response.setHeader('content-type', 'application/json')
      response.end(envelope({ schemaVersion: 2, runs: [...sessions.values()].map(value => value.child).filter(run => run.parentSessionId === url.searchParams.get('parentSessionId')), revision: 'fixture', listComplete: true, hasMore: false })); return
    }
    const match = path.match(/^\/api\/v1\/subagent\/runs\/([^/]+)(?:\/tools(?:\/([^/]+))?)?$/)
    if (match) {
      const value = [...sessions.values()].find(session => session.child.runId === decodeURIComponent(match[1]))
      if (!value) { response.writeHead(404).end(envelope(null)); return }
      const run = value.child, atSeq = Number(url.searchParams.get('atSeq') ?? run.lastSeq)
      response.setHeader('content-type', 'application/json')
      if (!path.includes('/tools')) { response.end(envelope(run)); return }
      if (match[2]) {
        const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limitBytes') ?? 32768), end = Math.min(rawDetail.length, offset + limit)
        detailRequests.push({ runId: run.runId, atSeq, offset, limit })
        response.end(envelope({ schemaVersion: 2, runId: run.runId, asOfSeq: atSeq, tool: summary(Number(decodeURIComponent(match[2]).slice(5))), detail: { encoding: 'json-utf8', text: rawDetail.subarray(offset, end).toString('utf8'), offset, totalBytes: rawDetail.length, hasMore: end < rawDetail.length, ...(end < rawDetail.length ? { nextOffset: end } : {}) } })); return
      }
      const cursor = Number(url.searchParams.get('cursor') ?? 0), limit = Number(url.searchParams.get('limit') ?? 50), total = atSeq === 5000 ? 4100 : run.toolCount, end = Math.min(total, cursor + limit)
      toolRequests.push({ runId: run.runId, atSeq, cursor })
      if (invalidHistoryFor === run.runId) {
        // Keep the parent and capability endpoints healthy; only this child's
        // actual page violates its requested watermark and must be rejected.
        invalidHistoryResponses.push({ runId: run.runId, requestedSeq: atSeq, returnedSeq: atSeq + 1 })
        response.end(envelope({ schemaVersion: 2, runId: run.runId, asOfSeq: atSeq + 1, totalCount: total,
          items: Array.from({ length: end - cursor }, (_, index) => ({ ...summary(cursor + index + 1), args: { path: 'CORRUPT_PROTOCOL_PAGE.ts' } })),
          hasMore: end < total, ...(end < total ? { nextCursor: String(end) } : {}) })); return
      }
      const result = envelope({ schemaVersion: 2, runId: run.runId, asOfSeq: atSeq, totalCount: total, items: Array.from({ length: end - cursor }, (_, index) => summary(cursor + index + 1)), hasMore: end < total, ...(end < total ? { nextCursor: String(end) } : {}) })
      if (holdRetryHistoryFor === run.runId) { holdRetryHistoryFor = ''; heldRetryHistory = { response, body: result }; return }
      if (holdNextPage) { holdNextPage = false; heldPage = { response, body: result }; return }
      response.end(result); return
    }
    if (path === '/api/v1/cron/capabilities') { response.writeHead(404).end(JSON.stringify({ code: 404, message: 'Legacy automation protocol' })); return }
    const id = url.searchParams.get('sessionId') ?? '', session = sessions.get(id)
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'f'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'subagent-history-fixture' }
        : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: 'History fixture model', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 128000 } }]
          : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: session ? `${session.run.runId}:4` : null, finished: true, projection: session?.projection ?? [], history: session?.history ?? [], run: session?.run, runs: session ? [session.run] : [], subagentRuns: session ? [session.child] : [], todos: [], changes: [], commandJobs: [] }
            : path === '/api/v1/chat/runs' ? { runs: session ? [session.run] : [] }
              : path === '/api/v1/conversation/sessions' ? [...sessions.entries()].map(([sessionId, item]) => ({ sessionId, title: item.history[0].content, lastAt: Date.now(), messageCount: item.history.length }))
                : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, agent: null }
                  : path === '/api/v1/security/mode' ? { mode: 'safe', sessionId: id }
                    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: true, sessionId: id }
                      : path === '/api/v1/workspace/directory' ? { root: '/remote/subagent-history', entries: [] }
                        : path === '/api/v1/workspace/bind' ? { workspaceRoot: '/remote/subagent-history' } : []
    response.setHeader('content-type', 'application/json'); response.end(envelope(data))
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})
const work = () => page.locator('.work-view')
const panel = () => work().getByRole('region', { name: '协作代理', exact: true })
const card = () => panel().locator('.subagent-card')
async function startTask(prompt: string): Promise<string> {
  await work().getByRole('button', { name: '新任务', exact: true }).click()
  await work().getByRole('textbox', { name: '任务目标', exact: true }).fill(prompt)
  const count = sessions.size
  await work().getByRole('button', { name: '开始任务', exact: true }).click()
  await expect.poll(() => sessions.size).toBe(count + 1)
  await expect(work().getByRole('region', { name: '协作对话', exact: true })).toContainText(`任务已就绪：${prompt}`)
  return [...sessions.keys()].at(-1)!
}
async function openChild(): Promise<void> {
  const tab = work().getByRole('tablist', { name: '工作区内容', exact: true }).getByRole('tab', { name: '子代理', exact: true })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await panel().getByRole('button', { name: '查看 耐久测试代理 子代理详情', exact: true }).click()
  await expect(card()).toBeVisible()
  const toggle = card().locator('.subagent-card__tools-header')
  if (!await card().locator('.subagent-history').count()) await toggle.click()
  await expect(card().locator('.subagent-history > .subagent-history__toolbar')).toContainText('4,100 条历史记录 · 当前显示 50 次调用')
}

async function openChildWithHistoryFailure(prompt: string): Promise<string> {
  const parentId = await startTask(prompt)
  // A capability outage also gates parent restoration. Restore the real parent
  // first, then inject a child-only page fault while preserving its first page.
  await page.reload()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
  const conversation = work().getByRole('region', { name: '协作对话', exact: true })
  await expect(conversation).toContainText(`任务已就绪：${prompt}`)
  await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toBeEnabled()
  await openChild()
  const runId = sessions.get(parentId)!.child.runId, history = card().locator('.subagent-history')
  expect(toolRequests.filter(value => value.runId === runId)).toEqual([{ runId, atSeq: 5000, cursor: 0 }])
  invalidHistoryFor = runId
  await history.getByRole('button', { name: '更新记录', exact: true }).click()
  await expect(history.getByRole('alert')).toContainText('子代理工具分页协议无效')
  await expect(history.getByRole('button', { name: '重试', exact: true })).toBeEnabled()
  await expect(history.locator('.subagent-card__call')).toHaveCount(50)
  await expect(history.locator('.subagent-card__call').first()).toContainText('file-1.ts')
  await expect(history.locator('.subagent-card__call').last()).toContainText('file-50.ts')
  await expect(history).not.toContainText('CORRUPT_PROTOCOL_PAGE.ts')
  expect(invalidHistoryResponses.filter(value => value.runId === runId)).toEqual([{ runId, requestedSeq: 5000, returnedSeq: 5001 }])
  expect(toolRequests.filter(value => value.runId === runId)).toEqual([
    { runId, atSeq: 5000, cursor: 0 }, { runId, atSeq: 5000, cursor: 0 }
  ])
  expect(chatRequests.filter(value => value.sessionId === parentId)).toEqual([{ sessionId: parentId, message: prompt }])
  await expect(conversation).not.toContainText('子代理工具分页协议无效')
  return parentId
}

test.describe.serial('子代理按需历史与详情', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing history fixture port')
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'subagent-history-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: `http://127.0.0.1:${address.port}`, autoStartEngine: true, remoteWorkspaceRoot: '/remote/subagent-history', lastSessionId: '', lastModelId: modelId, thinkingMode: 'off', appearance: 'dark', lastFolder: '' }))
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root, env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    health = await monitorElectronHealth(app, 'subagent-history', [token])
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
  })
  test.afterEach(() => { health?.assertHealthy(); expect(errors).toEqual([]) })
  test.afterAll(async ({}, testInfo) => {
    try { if (health) await health.closeAndAssert(testInfo); else await app?.close() }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) { const target = resolve(fixture); if (dirname(target) !== fixtureRoot || !basename(target).startsWith('subagent-history-')) throw new Error(`Unsafe cleanup: ${target}`); rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    }
  })

  test('摘要只有一项仍显示4100总数；分页固定水位且窗口最多128项', async () => {
    parent = await startTask('HISTORY_ORIGINAL_TASK')
    await work().getByRole('button', { name: '子代理', exact: true }).click()
    await expect(work().getByRole('tablist', { name: '工作区内容', exact: true }).getByRole('tab', { name: '子代理', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(panel()).toContainText('最近搜索内容')
    await panel().getByRole('button', { name: '查看 耐久测试代理 子代理详情', exact: true }).click()
    await expect(card().locator('summary')).toContainText('4,100 条历史记录')
    await card().locator('.subagent-card__tools-header').click()
    const history = card().locator('.subagent-history')
    await expect(history.locator('.subagent-card__call')).toHaveCount(50)
    await history.getByRole('button', { name: '加载更多记录', exact: true }).click(); await expect(history.locator(':scope > .subagent-history__toolbar')).toContainText('4,100 条历史记录 · 当前显示 100 次调用')
    await history.getByRole('button', { name: '加载更多记录', exact: true }).click(); await expect(history).toContainText('已读取 150 项')
    await expect(history.locator('.subagent-card__call')).toHaveCount(128)
    expect(toolRequests.map(value => value.atSeq)).toEqual([5000, 5000, 5000])
    const run = sessions.get(parent)!.child
    run.lastSeq = 5001; run.toolCount = 4101; run.coverage.asOfSeq = 5001; run.coverage.toolCount = 4101; run.updatedAt++
    await panel().getByRole('button', { name: '刷新子代理状态', exact: true }).click()
    await expect(card().locator('summary')).toContainText('4,101 条历史记录')
    await expect(history).toContainText('记录已更新')
    await history.getByRole('button', { name: '加载更多记录', exact: true }).click()
    await expect(history.locator(':scope > .subagent-history__toolbar')).toContainText('4,100 条历史记录 · 当前显示 128 次调用')
    await expect(history).toContainText('已读取 200 项')
    expect(toolRequests.at(-1)?.atSeq).toBe(5000)
    await history.getByRole('button', { name: '更新记录', exact: true }).click()
    await expect(history.locator(':scope > .subagent-history__toolbar')).toContainText('4,101 条历史记录 · 当前显示 50 次调用')
    expect(toolRequests.at(-1)?.atSeq).toBe(5001)
    await expect(history.locator('.subagent-card__tools-list')).toHaveCSS('overflow-y', 'auto')
  })

  test('工具详情按32KiB分段替换，下一段不累积上段正文', async () => {
    const history = card().locator('.subagent-history')
    await history.locator('.subagent-card__call-toggle').first().click()
    const detail = history.locator('.subagent-history__detail')
    await expect(detail).toContainText('FIRST_CHUNK_')
    await detail.getByRole('button', { name: '下一段内容', exact: true }).click()
    await expect(detail).toContainText('SECOND_CHUNK_')
    await expect(detail).not.toContainText('FIRST_CHUNK_')
    expect(detailRequests.slice(-2).map(value => ({ offset: value.offset, limit: value.limit, atSeq: value.atSeq }))).toEqual([{ offset: 0, limit: 32768, atSeq: 5001 }, { offset: 32768, limit: 32768, atSeq: 5001 }])
    expect(await detail.locator('pre').textContent()).toHaveLength(32768)
    await expect(detail).toHaveCSS('overflow-y', 'auto')
    await detail.getByRole('button', { name: '上一段内容', exact: true }).click()
    await expect(detail).toContainText('FIRST_CHUNK_')
    await expect(detail).not.toContainText('SECOND_CHUNK_')
    expect(detailRequests.at(-1)?.offset).toBe(0)
  })

  test('切换任务后旧分页响应不能回写新子代理窗口', async () => {
    holdNextPage = true
    await card().getByRole('button', { name: '加载更多记录', exact: true }).click()
    await expect.poll(() => Boolean(heldPage)).toBe(true)
    const other = await startTask('HISTORY_OTHER_TASK')
    expect(other).not.toBe(parent)
    await openChild()
    heldPage!.response.end(heldPage!.body); heldPage = undefined
    await expect(card()).toHaveAttribute('data-run-id', sessions.get(other)!.child.runId)
    await expect(card().locator('.subagent-history > .subagent-history__toolbar')).toContainText('4,100 条历史记录 · 当前显示 50 次调用')
    await expect(card().locator('.subagent-card__call')).toHaveCount(50)
    await expect(card()).not.toContainText('SECOND_CHUNK_')
  })

  test('子代理历史分页协议失败保留已有页；重试真正请求且等待时禁用重复提交', async () => {
    const prompt = 'HISTORY_RETRY_TASK', parentId = await openChildWithHistoryFailure(prompt)
    const runId = sessions.get(parentId)!.child.runId, history = card().locator('.subagent-history')
    invalidHistoryFor = ''; holdRetryHistoryFor = runId
    await history.getByRole('button', { name: '重试', exact: true }).click()
    await expect.poll(() => Boolean(heldRetryHistory)).toBe(true)
    await expect(history).toHaveAttribute('aria-busy', 'true')
    await expect(history.getByRole('button', { name: '更新记录', exact: true })).toBeDisabled()
    await expect(history.getByRole('button', { name: '加载更多记录', exact: true })).toBeDisabled()
    await expect(history.locator('.subagent-card__call')).toHaveCount(50)
    const expectedRequests = Array.from({ length: 3 }, () => ({ runId, atSeq: 5000, cursor: 0 }))
    expect(toolRequests.filter(value => value.runId === runId)).toEqual(expectedRequests)
    heldRetryHistory!.response.end(heldRetryHistory!.body); heldRetryHistory = undefined
    await expect(history).toHaveAttribute('aria-busy', 'false')
    await expect(history.locator(':scope > .subagent-history__toolbar')).toContainText('4,100 条历史记录 · 当前显示 50 次调用')
    await expect(history.locator('.subagent-card__call')).toHaveCount(50)
    await expect(history.getByRole('alert')).toHaveCount(0)
    expect(toolRequests.filter(value => value.runId === runId)).toEqual(expectedRequests)
    expect(chatRequests.filter(value => value.sessionId === parentId)).toEqual([{ sessionId: parentId, message: prompt }])
  })

  test('状态和详情刷新成功不抹去子分页错误；用户重试读取最新水位', async () => {
    const prompt = 'HISTORY_REFRESH_AFTER_FAILURE', parentId = await openChildWithHistoryFailure(prompt)
    const run = sessions.get(parentId)!.child, runId = run.runId, history = card().locator('.subagent-history')
    const readsBefore = listRequests.filter(id => id === parentId).length
    run.lastSeq = 5001; run.coverage.asOfSeq = 5001; run.updatedAt++; run.description = '耐久测试代理 · 状态已刷新'
    await panel().getByRole('button', { name: '刷新子代理状态', exact: true }).click()
    await expect.poll(() => listRequests.filter(id => id === parentId).length).toBeGreaterThan(readsBefore)
    await expect(card().locator('.subagent-card__task')).toContainText('状态已刷新')
    await expect(history).toContainText('记录已更新')
    await history.locator('.subagent-card__call-toggle').first().click()
    const detail = history.locator('.subagent-history__detail')
    await expect(detail).toContainText('FIRST_CHUNK_')
    await detail.getByRole('button', { name: '更新详情', exact: true }).click()
    await expect.poll(() => detailRequests.filter(value => value.runId === runId).map(value => value.atSeq)).toEqual([5000, 5001])
    await expect(history.getByRole('alert')).toContainText('子代理工具分页协议无效')
    await expect(history.getByRole('button', { name: '重试', exact: true })).toBeEnabled()
    await expect(history.locator('.subagent-card__call')).toHaveCount(50)
    expect(toolRequests.filter(value => value.runId === runId)).toEqual([
      { runId, atSeq: 5000, cursor: 0 }, { runId, atSeq: 5000, cursor: 0 }
    ])
    invalidHistoryFor = ''
    await history.getByRole('button', { name: '重试', exact: true }).click()
    await expect(history.locator(':scope > .subagent-history__toolbar')).toContainText('4,100 条历史记录 · 当前显示 50 次调用')
    await expect(history.getByRole('alert')).toHaveCount(0)
    await expect(history).not.toContainText('记录已更新')
    expect(toolRequests.filter(value => value.runId === runId)).toEqual([
      { runId, atSeq: 5000, cursor: 0 }, { runId, atSeq: 5000, cursor: 0 }, { runId, atSeq: 5001, cursor: 0 }
    ])
    expect(chatRequests.filter(value => value.sessionId === parentId)).toEqual([{ sessionId: parentId, message: prompt }])
  })
})
