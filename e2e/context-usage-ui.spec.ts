/** Real Electron + authenticated remote HTTP: context snapshots, cumulative spend and delayed compression ownership. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
const root = resolve(__dirname, '..'), token = 'context-usage-fixture-token'
const sessionA = 'context-session-A', sessionB = 'context-session-B'
const modelA = 'context-model-A', modelB = 'context-model-B'
let fixture = '', app: ElectronApplication | undefined, page: Page, heldStream: ServerResponse | undefined, heldCompression: ServerResponse | undefined
let holdCompression = true, aRun: RootRun | undefined
let aHistory: EngineHistoryRow[] = [
  { id: 'seed-user', role: 'user', content: 'CONTEXT_HISTORY_A', conversationId: 'seed-turn', createdAt: 1 },
  { id: 'seed-assistant', role: 'assistant', content: 'INITIAL_A_REPLY', conversationId: 'seed-turn', modelId: modelA, createdAt: 2,
    usage: { promptTokens: 8000, completionTokens: 2, totalTokens: 8002, currentPromptTokens: 12000, contextWindow: 100000 } }
]
const errors: string[] = [], snapshots: string[] = [], chats: Record<string, unknown>[] = []
const envelope = (data: unknown) => JSON.stringify({ code: 200, message: 'ok', data })
function snapshot(sessionId: string) {
  const history = sessionId === sessionA ? aHistory : sessionId === sessionB ? [
    { id: 'b-user', role: 'user', content: 'CONTEXT_HISTORY_B', conversationId: 'b-turn', createdAt: 3 },
    { id: 'b-assistant', role: 'assistant', content: 'B_REPLY', conversationId: 'b-turn', modelId: modelB, createdAt: 4,
      usage: { promptTokens: 16000, completionTokens: 2, totalTokens: 16002, currentPromptTokens: 16000, contextWindow: 64000 } }
  ] : []
  const run = sessionId === sessionA ? aRun : undefined
  return { schemaVersion: 1, source: 'persisted', sessionId, eventId: null, finished: true, projection: [], run, runs: run ? [run] : [], history, todos: [], changes: [], commandJobs: [] }
}
function frame(payload: unknown, seq: number) {
  if (!heldStream || heldStream.writableEnded) throw new Error('Missing open fixture stream')
  heldStream.write('id: context-run:' + seq + '\ndata: ' + JSON.stringify(payload) + '\n\n')
}
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) {
      response.writeHead(401, { 'content-type': 'application/json' }).end(envelope(null)); return
    }
    let raw = ''; for await (const chunk of request) raw += chunk.toString()
    if (path === '/api/v1/chat' && request.method === 'POST') {
      const body = JSON.parse(raw) as Record<string, unknown>; chats.push(body); heldStream = response
      aRun = { schemaVersion: 1, runId: 'context-run', sessionId: sessionA, turnId: 'context-turn', userMessageId: 'context-user', assistantMessageId: 'context-assistant', seq: 1, version: 1, status: 'running', modelId: modelA, createdAt: Date.now(), updatedAt: Date.now(), pending: [] }
      response.writeHead(200, { 'content-type': 'text/event-stream' }); frame({ run: aRun }, 1); frame({ content: 'CONTEXT_LIVE_REPLY' }, 2); return
    }
    response.setHeader('content-type', 'application/json')
    if (path === '/api/v1/conversation/compress') {
      if (holdCompression) { heldCompression = response; return }
      response.end(envelope({ stats: { originalTokens: 40000, compressedTokens: 8000 } })); return
    }
    if (path === '/api/v1/chat/snapshot') {
      const sessionId = url.searchParams.get('sessionId') ?? ''; snapshots.push(sessionId); response.end(envelope(snapshot(sessionId))); return
    }
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: 'sha256:' + 'e'.repeat(64), protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'context-usage-fixture' }
      : path === '/api/v1/models' ? [modelA, modelB].map((modelId, index) => ({ id: modelId, modelId, provider: 'openai', displayName: modelId, isEnabled: true, capabilities: { toolCalling: true, contextWindow: index ? 64000 : 100000 } }))
      : path === '/api/v1/conversation/sessions' ? [{ sessionId: sessionA, title: 'CONTEXT_HISTORY_A', lastAt: 2, messageCount: 2 }, { sessionId: sessionB, title: 'CONTEXT_HISTORY_B', lastAt: 4, messageCount: 2 }]
      : path === '/api/v1/chat/runs' ? { runs: [] }
      : path === '/api/v1/workspace/directory' ? { root: '/remote/context', entries: [] }
      : []
    response.end(envelope(data))
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})
const ring = () => page.locator('.context-ring')
async function selectSession(id: string) {
  if (!await page.locator('.history-view').isVisible()) await page.getByRole('button', { name: '会话历史', exact: true }).click()
  await page.locator('.history-view__item[data-session-id="' + id + '"]').click()
  await expect(page.locator('.message--user').first()).toContainText(id === sessionA ? 'CONTEXT_HISTORY_A' : 'CONTEXT_HISTORY_B')
  await expect(page.locator('.model-picker__trigger')).toBeEnabled()
}
test.describe.serial('上下文用量环与会话压缩隔离', () => {
  test.beforeAll(async () => {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true }); fixture = mkdtempSync(join(root, '.e2e-tmp', 'context-usage-ui-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: 'http://127.0.0.1:' + address.port, autoStartEngine: true, lastSessionId: '', thinkingMode: 'off' }))
    app = await electron.launch({ args: ['.', '--user-data-dir=' + fixture], cwd: root, env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 }); await selectSession(sessionA)
  })
  test.afterAll(async () => {
    heldStream?.destroy(); heldCompression?.destroy(); await app?.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (!fixture) return
    const absolute = resolve(fixture)
    if (dirname(absolute) !== join(root, '.e2e-tmp') || !basename(absolute).startsWith('context-usage-ui-')) throw new Error('Unsafe context fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  test('显式历史快照优先，12K→22K→10K按调用更新而本轮累计用量持续增长，刷新保持一致', async ({}, testInfo) => {
    await expect(ring()).toHaveAttribute('aria-label', /最近一次模型请求 12k \/ 100k/)
    await page.locator('.model-picker__trigger').click(); await page.locator('.model-picker__item').filter({ has: page.locator('.model-picker__name', { hasText: modelB }) }).click()
    await expect(ring()).toHaveAttribute('aria-label', /12k \/ 100k/)
    await page.locator('.model-picker__trigger').click(); await page.locator('.model-picker__item').filter({ has: page.locator('.model-picker__name', { hasText: modelA }) }).click()
    await page.locator('.chat__input').fill('EXERCISE_CONTEXT_COMPRESSION'); await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => chats.length).toBe(1); expect(chats[0]).toMatchObject({ sessionId: sessionA, model: modelA })
    // The input lacks a window, so its own model capability is the fallback.
    frame({ usage: { modelId: modelA, promptTokens: 12000, completionTokens: 1, totalTokens: 12001, currentPromptTokens: 12000 } }, 3)
    await expect(ring()).toHaveAttribute('aria-label', /12k \/ 100k/); await expect(page.locator('.turn-usage__value').last()).toHaveText('12k')
    frame({ usage: { modelId: modelB } }, 4)
    await expect(page.locator('.turn-usage__model').last()).toHaveText(modelB)
    await expect(ring()).toHaveAttribute('aria-label', /12k \/ 100k/)
    frame({ usage: { modelId: modelA, promptTokens: 34000, completionTokens: 2, totalTokens: 34002, currentPromptTokens: 22000, contextWindow: 100000 } }, 5)
    await expect(ring()).toHaveAttribute('aria-label', /22k \/ 100k/); await expect(page.locator('.turn-usage__value').last()).toHaveText('34k')
    // Repeated old sequence must not regress the UI even if its snapshot differs.
    frame({ usage: { promptTokens: 12000, totalTokens: 12001, currentPromptTokens: 12000, contextWindow: 100000 } }, 3)
    frame({ usage: { modelId: modelA, promptTokens: 44000, completionTokens: 3, totalTokens: 44003, currentPromptTokens: 10000, contextWindow: 100000 } }, 6)
    await expect(ring()).toHaveAttribute('aria-label', /10k \/ 100k/); await expect(page.locator('.turn-usage__value').last()).toHaveText('44k')
    await ring().hover(); await expect(page.locator('.ctx-card__tokens-value')).toHaveText('10k / 100k')
    await expect(page.locator('.ctx-card__header')).toContainText('当前上下文')
    await expect(page.locator('.ctx-card')).toContainText('模型统计或估算')
    await expect(page.locator('.ctx-card')).toContainText('可减少')
    await expect(page.locator('.ctx-card')).toContainText('生成中')
    await page.screenshot({ path: testInfo.outputPath('context-ring-hover.png') })
    await page.locator('.chat__input').click(); await expect(page.locator('.chat__input')).toBeFocused()
    await expect(page.locator('.ctx-card')).toHaveCount(0)
    aRun = { ...aRun!, status: 'succeeded', version: 2, actualModelId: modelA, updatedAt: Date.now(), finishedAt: Date.now() }
    aHistory = [...aHistory, { id: 'context-user', role: 'user', content: 'EXERCISE_CONTEXT_COMPRESSION', conversationId: 'context-turn', createdAt: 10 },
      ...[12000, 22000, 10000].map((promptTokens, index) => ({ id: 'context-segment-' + index, role: 'assistant', content: index === 2 ? 'CONTEXT_LIVE_REPLY' : '', conversationId: 'context-turn', modelId: modelA, createdAt: 11 + index, usage: { promptTokens, completionTokens: 1, totalTokens: promptTokens + 1, currentPromptTokens: promptTokens, contextWindow: 100000 } }))]
    frame({ run: aRun }, 7); heldStream!.end('data: [DONE]\n\n')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    await page.reload(); await expect(ring()).toHaveAttribute('aria-label', /10k \/ 100k/); await expect(page.locator('.turn-usage__value').last()).toHaveText('44k')
    await page.locator('.turn-usage__trigger').last().click(); await expect(page.getByText('累计输入 Prompt', { exact: true })).toBeVisible(); await page.locator('.chat__input').click()
    expect(errors).toEqual([])
  })
  test('会话A的延迟手动压缩完成不能重新加载A或覆盖已打开的B', async () => {
    await ring().click(); await expect.poll(() => Boolean(heldCompression)).toBe(true); await expect(ring()).toHaveAttribute('aria-label', '正在压缩上下文…')
    await selectSession(sessionB); await expect(ring()).toHaveAttribute('aria-label', /16k \/ 64k/)
    const oldSessionReads = snapshots.filter(id => id === sessionA).length
    heldCompression!.end(envelope({ stats: { originalTokens: 40000, compressedTokens: 8000 } }))
    // Observe the actual IPC response through several render frames after server completion.
    await page.evaluate(() => new Promise<void>(done => setTimeout(done, 650)))
    await expect(page.locator('.message--user')).toContainText('CONTEXT_HISTORY_B'); await expect(page.locator('.message--user')).not.toContainText('CONTEXT_HISTORY_A')
    await expect(ring()).toHaveAttribute('aria-label', /16k \/ 64k/); expect(snapshots.filter(id => id === sessionA)).toHaveLength(oldSessionReads)
    expect(errors).toEqual([])
  })
  test('手动压缩成功提示结束后仍展示最近输入快照，重开客户端仍一致', async () => {
    holdCompression = false; await selectSession(sessionA); await ring().click()
    await expect(ring()).toHaveAttribute('aria-label', '已压缩 40k → 8k')
    await expect(ring()).toHaveAttribute('aria-label', /最近一次模型请求 10k \/ 100k/, { timeout: 10000 })
    await app!.close(); app = await electron.launch({ args: ['.', '--user-data-dir=' + fixture], cwd: root, env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 }); await expect(ring()).toHaveAttribute('aria-label', /10k \/ 100k/); await expect(page.locator('.turn-usage__value').last()).toHaveText('44k')
    expect(errors).toEqual([])
  })
})
