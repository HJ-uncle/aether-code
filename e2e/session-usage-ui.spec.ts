/** Real Electron: lifetime billing survives compacted snapshots, archive pagination, live frames and session changes. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { SubagentRun } from '../src/shared/subagent'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
const root = resolve(__dirname, '..'), token = 'session-usage-fixture-token', sessionA = 'usage-session-A', sessionB = 'usage-session-B', model = 'usage-model'
let app: ElectronApplication | undefined, page: Page, fixture = '', compacted = true, heldStream: ServerResponse | undefined, liveRun: RootRun | undefined
const errors: string[] = [], archiveReads: Array<{ sessionId: string; current: number; pageSize: number }> = [], chats: Record<string, unknown>[] = []
const deleted: Array<{ method: string | undefined; sessionId: string; turnId: string }> = []
let history: EngineHistoryRow[] = Array.from({ length: 110 }, (_, index) => [
  { id: 'usage-user-' + index, role: 'user', content: 'USAGE_TASK_' + index, conversationId: 'usage-turn-' + index, createdAt: index * 2 + 1 },
  { id: 'usage-assistant-' + index, role: 'assistant', content: 'USAGE_REPLY_' + index, conversationId: 'usage-turn-' + index, modelId: model, createdAt: index * 2 + 2,
    usage: { promptTokens: 1000, completionTokens: 10, totalTokens: 1010, currentPromptTokens: 1000, contextWindow: 100000 } }
]).flat()
let parentUsage = { promptTokens: 110000, completionTokens: 1100, totalTokens: 111100 }
const childUsage = { totalTokens: 10000, count: 3, unknown: 1 }
const pairedSession = 'usage-child-watermark'
function child(runId: string, parentSessionId: string, totalTokens: number | undefined, lastSeq: number, unknown = false): SubagentRun {
  const paired = parentSessionId === pairedSession
  return { schemaVersion: 1, runId, tenantId: 'fixture', rootSessionId: parentSessionId, parentSessionId,
    parentConversationId: paired ? 'child-paired-turn' : 'usage-turn-109', parentMessageId: paired ? 'child-paired-assistant' : 'usage-assistant-109',
    parentToolCallId: runId + '-dispatch', childSessionId: runId + '-child', task: 'Verify child billing', description: '子 Agent 费用回归', modelId: model,
    status: 'succeeded', lastSeq, createdAt: 219, updatedAt: 220 + lastSeq, finishedAt: 220 + lastSeq,
    usage: { totalTokens, unknown }, toolCalls: [] }
}
const childrenA = [child('a-known-1', sessionA, 7000, 1), child('a-known-2', sessionA, 3000, 1), child('a-unknown', sessionA, undefined, 1, true)]
let pairedAligned = child('paired-child', pairedSession, 2000, 2, true)
let pairedLatest = child('paired-child', pairedSession, 2500, 3, true)
const pairedRaw = child('paired-child', pairedSession, 1000, 1, true)
let pairedHistory: EngineHistoryRow[] = [
  { id: 'child-paired-user', role: 'user', content: 'USAGE_CHILD_WATERMARK', conversationId: 'child-paired-turn', createdAt: 217 },
  { id: 'child-paired-assistant', role: 'assistant', content: 'CHILD_PAIRED_REPLY', conversationId: 'child-paired-turn', modelId: model, createdAt: 218,
    toolCall: { id: pairedRaw.parentToolCallId, name: 'subagent' }, usage: { promptTokens: 4000, completionTokens: 0, totalTokens: 4000, currentPromptTokens: 4000, contextWindow: 100000 } },
  { id: 'child-paired-result', role: 'tool', toolCallId: pairedRaw.parentToolCallId, content: 'STALE_CHILD_RESULT', conversationId: 'child-paired-turn', createdAt: 219, metadata: { subagent: pairedRaw } }
]
const historyB: EngineHistoryRow[] = [
  { id: 'b-user', role: 'user', content: 'USAGE_PEER_B', conversationId: 'b-turn' },
  { id: 'b-assistant', role: 'assistant', content: 'B_REPLY', conversationId: 'b-turn', modelId: model,
    usage: { promptTokens: 2000, completionTokens: 20, totalTokens: 2020, currentPromptTokens: 2000, contextWindow: 100000 } }
]
const sessionHistory = (sessionId: string) => sessionId === sessionA ? history : sessionId === pairedSession ? pairedHistory : sessionId === sessionB ? historyB : []
const pairedPresent = () => pairedHistory.some(row => row.conversationId === 'child-paired-turn')
const childReads: string[] = []
const envelope = (data: unknown) => JSON.stringify({ code: 200, message: 'ok', data })
function snapshot(sessionId: string) {
  const userStarts = history.reduce<number[]>((starts, row, index) => row.role === 'user' ? [...starts.slice(-1), index] : starts, [])
  const selected = sessionId === sessionA ? (compacted ? [{ id: 'usage-summary', role: 'system', content: 'COMPACT_SUMMARY', metadata: { isCompactSummary: true } }, ...history.slice(userStarts[0] ?? 0)] : history)
    : sessionHistory(sessionId)
  const run = sessionId === sessionA ? liveRun : undefined
  return { schemaVersion: 1, source: 'persisted', sessionId, eventId: null, finished: true, projection: [], run, runs: run ? [run] : [], history: selected, historyCompacted: sessionId === sessionA && compacted, todos: [], changes: [], commandJobs: [],
    sessionUsage: sessionId === pairedSession ? { promptTokens: pairedPresent() ? 4000 : 0, completionTokens: 0, totalTokens: pairedPresent() ? 4000 : 0 } : sessionId === sessionA ? parentUsage : sessionId === sessionB ? { promptTokens: 2000, completionTokens: 20, totalTokens: 2020 } : {},
    sessionSubagentUsage: sessionId === pairedSession && pairedPresent() ? { totalTokens: pairedAligned.usage.totalTokens, count: 1, unknown: pairedAligned.usage.unknown ? 1 : 0 } : sessionId === sessionA ? childUsage : { totalTokens: 0, count: 0, unknown: 0 },
    subagentRuns: sessionId === pairedSession && pairedPresent() ? [pairedAligned] : sessionId === sessionA ? childrenA : [] }
}
function frame(payload: unknown, sequence: number) {
  if (!heldStream || heldStream.writableEnded) throw new Error('No live fixture stream')
  heldStream.write('id: lifetime-run:' + sequence + '\ndata: ' + JSON.stringify(payload) + '\n\n')
}
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) { response.writeHead(401).end(envelope(null)); return }
    let raw = ''; for await (const chunk of request) raw += chunk.toString()
    if (path === '/api/v1/chat' && request.method === 'POST') {
      chats.push(JSON.parse(raw)); heldStream = response
      liveRun = { schemaVersion: 1, runId: 'lifetime-run', sessionId: sessionA, turnId: 'usage-live-turn', userMessageId: 'usage-live-user', assistantMessageId: 'usage-live-assistant', seq: 1, version: 1, status: 'running', modelId: model, actualModelId: model, createdAt: Date.now(), updatedAt: Date.now(), pending: [] }
      response.writeHead(200, { 'content-type': 'text/event-stream' }); frame({ run: liveRun }, 1); frame({ content: 'USAGE_LIVE_REPLY' }, 2); return
    }
    response.setHeader('content-type', 'application/json')
    if (path === '/api/v1/subagent/runs') {
      const parentSessionId = url.searchParams.get('parentSessionId') ?? ''; childReads.push(parentSessionId)
      response.end(envelope(parentSessionId === pairedSession && pairedPresent() ? [pairedLatest] : parentSessionId === sessionA ? childrenA : [])); return
    }
    if (path === '/api/v1/chat/snapshot') { response.end(envelope(snapshot(url.searchParams.get('sessionId') ?? ''))); return }
    if (path === '/api/v1/conversation/archive') {
      const sessionId = url.searchParams.get('sessionId') ?? '', current = Number(url.searchParams.get('current')), pageSize = Number(url.searchParams.get('pageSize'))
      archiveReads.push({ sessionId, current, pageSize })
      const rows = sessionHistory(sessionId), totalPages = Math.ceil(rows.length / pageSize)
      if (sessionId !== sessionA || !Number.isSafeInteger(current) || !Number.isSafeInteger(pageSize) || pageSize < 1 || current < 1 || current > Math.max(1, totalPages)) throw new Error('Invalid archive fixture page: ' + JSON.stringify({ sessionId, current, pageSize }))
      response.end(JSON.stringify({ code: 200, message: 'ok', data: rows.slice((current - 1) * pageSize, current * pageSize), pagination: { current, pageSize, total: rows.length, totalPages }, metadata: { archiveMessageCount: rows.length, archiveRevision: 'usage-' + rows.length } })); return
    }
    if (path === '/api/v1/conversation/history') { response.end(envelope(sessionHistory(url.searchParams.get('sessionId') ?? ''))); return }
    if (path.startsWith('/api/v1/conversation/turns/') && request.method === 'DELETE') {
      const sessionId = url.searchParams.get('sessionId') ?? '', turnId = decodeURIComponent(path.slice('/api/v1/conversation/turns/'.length))
      deleted.push({ method: request.method, sessionId, turnId })
      if (sessionId === sessionA && turnId === 'usage-live-turn' && history.some(row => row.conversationId === turnId)) {
        history = history.filter(row => row.conversationId !== turnId)
        parentUsage = { promptTokens: 110000, completionTokens: 1100, totalTokens: 111100 }; liveRun = undefined
      } else if (sessionId === pairedSession && turnId === 'child-paired-turn' && pairedPresent()) {
        pairedHistory = pairedHistory.filter(row => row.conversationId !== turnId)
      } else throw new Error('Invalid fixture DELETE: ' + JSON.stringify({ method: request.method, sessionId, turnId }))
      response.end(envelope({})); return
    }
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: 'sha256:' + 'f'.repeat(64), protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'session-usage-fixture' }
      : path === '/api/v1/models' ? [{ id: model, modelId: model, provider: 'openai', displayName: model, isEnabled: true, capabilities: { toolCalling: true, contextWindow: 100000 } }]
      : path === '/api/v1/conversation/sessions' ? [{ sessionId: sessionA, title: 'USAGE_PROJECT_A', lastAt: 2, messageCount: history.length }, { sessionId: sessionB, title: 'USAGE_PEER_B', lastAt: 4, messageCount: historyB.length }, { sessionId: pairedSession, title: 'USAGE_CHILD_WATERMARK', lastAt: 6, messageCount: pairedHistory.length }]
      : path === '/api/v1/chat/runs' ? { runs: [] }
      : path === '/api/v1/workspace/directory' ? { root: '/remote/usage', entries: [] }
      : []
    response.end(envelope(data))
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})
const meter = () => page.locator('.usage-meter__tokens')
const archiveButton = () => page.locator('.chat__load-earlier[data-archive-page]')
async function selectSession(id: string) {
  if (!await page.locator('.history-view').isVisible()) await page.getByRole('button', { name: '会话历史', exact: true }).click()
  await page.locator('.history-view__item[data-session-id="' + id + '"]').click()
  await expect(page.locator('.model-picker__trigger')).toBeEnabled()
  await expect(page.locator('.message--user')).toContainText([id === sessionA ? 'USAGE_TASK_109' : id === pairedSession ? 'USAGE_CHILD_WATERMARK' : 'USAGE_PEER_B'])
}
async function launch() {
  app = await electron.launch({ args: ['.', '--user-data-dir=' + fixture], cwd: root, env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
}
test.describe.serial('全会话累计用量与压缩归档独立', () => {
  test.beforeAll(async () => {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true }); fixture = mkdtempSync(join(root, '.e2e-tmp', 'session-usage-ui-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: 'http://127.0.0.1:' + address.port, autoStartEngine: true, lastSessionId: '', lastModelId: model, thinkingMode: 'off' }))
    await launch(); await selectSession(sessionA)
  })
  test.afterAll(async () => {
    heldStream?.destroy(); await app?.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (!fixture) return; const absolute = resolve(fixture)
    if (dirname(absolute) !== join(root, '.e2e-tmp') || !basename(absolute).startsWith('session-usage-ui-')) throw new Error('Unsafe session fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  test('紧凑快照只显示2轮但费用保留110轮、子代理已知下限和未知标记，分页不增加费用', async () => {
    await expect(page.locator('.message--user')).toHaveCount(2); await expect(meter()).toHaveText('121.1k')
    await page.locator('.usage-meter__trigger').click(); await expect(page.getByRole('dialog', { name: '会话用量明细' })).toContainText('子代理用量缺失（1 个）'); await expect(page.getByRole('dialog', { name: '会话用量明细' })).toContainText('已加载 2 轮'); await page.locator('.chat__input').click()
    await archiveButton().click(); await expect(page.locator('.message--user')).toHaveCount(10); await expect(meter()).toHaveText('121.1k')
    await archiveButton().click(); await expect(page.locator('.message--user')).toHaveCount(110); await expect(meter()).toHaveText('121.1k'); await expect(archiveButton()).toHaveCount(0)
    expect(archiveReads).toEqual([
      { sessionId: sessionA, current: 1, pageSize: 1 }, { sessionId: sessionA, current: 2, pageSize: 200 },
      { sessionId: sessionA, current: 1, pageSize: 1 }, { sessionId: sessionA, current: 1, pageSize: 200 }
    ])
    expect(await page.locator('.chat__turn[data-turn-id^="usage-user-"]').evaluateAll(elements => elements.map(element => element.getAttribute('data-turn-id'))))
      .toEqual(Array.from({ length: 110 }, (_, index) => 'usage-user-' + index))
    await page.locator('.usage-meter__trigger').click(); await expect(page.getByRole('dialog', { name: '会话用量明细' })).toContainText('已加载 110 轮'); await page.locator('.chat__input').click()
    expect(errors).toEqual([])
  })
  test('新累计帧只增加快照之后的费用，重复帧不双计，完整压缩刷新后不丢累计', async () => {
    await page.locator('.chat__input').fill('SESSION_LIVE_TASK'); await page.getByRole('button', { name: '发送', exact: true }).click(); await expect.poll(() => chats.length).toBe(1)
    const first = { usage: { usageScope: 'turn', modelId: model, promptTokens: 1000, completionTokens: 10, totalTokens: 1010, currentPromptTokens: 1000, contextWindow: 100000 } }
    frame(first, 3); await expect(meter()).toHaveText('122.1k')
    frame(first, 4); await expect(meter()).toHaveText('122.1k')
    frame({ usage: { usageScope: 'turn', modelId: model, promptTokens: 3000, completionTokens: 30, totalTokens: 3030, currentPromptTokens: 2000, contextWindow: 100000 } }, 5); await expect(meter()).toHaveText('124.1k')
    history.push({ id: 'usage-live-user', role: 'user', content: 'SESSION_LIVE_TASK', conversationId: 'usage-live-turn', createdAt: 300 },
      ...[1000, 2000].map((promptTokens, index) => ({ id: index ? 'usage-live-assistant' : 'usage-live-segment', role: 'assistant', content: index ? 'USAGE_LIVE_REPLY' : '', conversationId: 'usage-live-turn', modelId: model, createdAt: 301 + index, usage: { promptTokens, completionTokens: (index + 1) * 10, totalTokens: promptTokens + (index + 1) * 10, currentPromptTokens: promptTokens, contextWindow: 100000 } })))
    parentUsage = { promptTokens: 113000, completionTokens: 1130, totalTokens: 114130 }
    liveRun = { ...liveRun!, version: 2, status: 'succeeded', updatedAt: Date.now(), finishedAt: Date.now() }
    frame({ run: liveRun }, 6); heldStream!.end('data: [DONE]\n\n'); await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    compacted = true; await page.reload(); await expect(page.locator('.message--user')).toHaveCount(2); await expect(meter()).toHaveText('124.1k'); await expect(archiveButton()).toBeVisible()
    await expect(page.locator('.turn-usage__value').last()).toHaveText('3k'); expect(errors).toEqual([])
  })
  test('两个会话的权威累计互不污染，客户端重开仍保留压缩前全额', async () => {
    await selectSession(sessionB); await expect(meter()).toHaveText('2k')
    await selectSession(sessionA); await expect(meter()).toHaveText('124.1k')
    await app!.close(); await launch(); await expect(meter()).toHaveText('124.1k'); await expect(page.locator('.message--user')).toContainText(['SESSION_LIVE_TASK'])
    expect(errors).toEqual([])
  })
  test('真实删除整轮后采用服务端较低权威累计，不把旧锚点锁成历史峰值', async () => {
    await page.locator('.chat__turn[data-turn-id="usage-live-user"]').getByRole('button', { name: '删除本轮', exact: true }).first().click()
    await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
    await expect.poll(() => deleted.length).toBe(1); await expect(meter()).toHaveText('121.1k'); await expect(page.locator('.message--user').filter({ hasText: 'SESSION_LIVE_TASK' })).toHaveCount(0)
    expect(deleted[0]).toEqual({ method: 'DELETE', sessionId: sessionA, turnId: 'usage-live-turn' })
    expect(history.filter(row => row.conversationId === 'usage-live-turn')).toEqual([])
    expect(parentUsage).toEqual({ promptTokens: 110000, completionTokens: 1100, totalTokens: 111100 })
    await page.reload(); await expect(meter()).toHaveText('121.1k'); expect(errors).toEqual([])
  })
  test('子Agent独立刷新比费用快照新时保留增量，旧历史不重收权威已包含的费用', async () => {
    await selectSession(pairedSession); await expect(meter()).toHaveText('6.5k')
    await expect.poll(() => childReads.filter(id => id === pairedSession).length).toBeGreaterThan(0)
    await expect(page.locator('.usage-meter__unit')).toHaveText('tokens（已知）')
    await page.locator('.usage-meter__trigger').click(); await expect(page.getByRole('dialog', { name: '会话用量明细' })).toContainText('子代理用量缺失（1 个）'); await page.locator('.chat__input').click()
    pairedLatest = child('paired-child', pairedSession, 2500, 4)
    await page.reload(); await expect(meter()).toHaveText('6.5k'); await expect(page.locator('.usage-meter__unit')).toHaveText('tokens')
    await page.locator('.usage-meter__trigger').click()
    const details = page.getByRole('dialog', { name: '会话用量明细' })
    await expect(details).toContainText('子代理（已知用量）'); await expect(details).not.toContainText('子代理用量缺失')
    await expect(details).toContainText('已加载 1 轮'); await page.locator('.chat__input').click()
    // Raw history remains at 1k; authoritative paired runs and the fresh store agree at 3k.
    // A raw-history baseline would double count, while a store baseline would lose the first 500 delta.
    pairedAligned = child('paired-child', pairedSession, 3000, 5); pairedLatest = pairedAligned
    await page.reload(); await expect(meter()).toHaveText('7k'); await expect(page.locator('.usage-meter__unit')).toHaveText('tokens')
    await app!.close(); await launch(); await expect(meter()).toHaveText('7k'); await expect(page.locator('.usage-meter__unit')).toHaveText('tokens')
    expect(errors).toEqual([])
  })
  test('删除含子Agent的整轮会同时降低父子权威费用并移除已存在的卡片，重开不恢复旧账', async () => {
    const card = page.locator('.subagent-card[data-run-id="paired-child"]')
    await expect(meter()).toHaveText('7k'); await expect(card).toHaveCount(1)
    await page.locator('.chat__turn[data-turn-id="child-paired-user"]').getByRole('button', { name: '删除本轮', exact: true }).first().click()
    await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
    await expect.poll(() => deleted.length).toBe(2)
    expect(deleted[1]).toEqual({ method: 'DELETE', sessionId: pairedSession, turnId: 'child-paired-turn' })
    expect(pairedHistory).toEqual([])
    expect(snapshot(pairedSession)).toMatchObject({ history: [], subagentRuns: [],
      sessionUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      sessionSubagentUsage: { totalTokens: 0, count: 0, unknown: 0 } })
    await expect(card).toHaveCount(0); await expect(meter()).toHaveCount(0); await expect(page.locator('.message--user')).toHaveCount(0)
    await page.reload(); await expect(card).toHaveCount(0); await expect(meter()).toHaveCount(0)
    await selectSession(sessionA); await expect(meter()).toHaveText('121.1k')
    expect(historyB.map(row => row.id)).toEqual(['b-user', 'b-assistant'])
    expect(errors).toEqual([])
  })
})
