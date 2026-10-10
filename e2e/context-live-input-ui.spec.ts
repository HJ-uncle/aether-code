/** Real Electron + authenticated HTTP: exact production counts and slow-provider input-only snapshots. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
const root = resolve(__dirname, '..'), token = 'live-input-fixture-token'
const sessionId = 'live-input-session', modelId = 'deepseek-v4.1-flash'
let fixture = '', app: ElectronApplication | undefined, page: Page, heldStream: ServerResponse | undefined
let run: RootRun | undefined, sequence = 0
const projection: Record<string, unknown>[] = [], errors: string[] = [], requests: string[] = []
const history = [
  { id: 'seed-user', role: 'user', content: 'EXACT_CONTEXT_HISTORY', conversationId: 'seed-turn', createdAt: 1 },
  { id: 'seed-assistant', role: 'assistant', content: 'INITIAL_REPLY', conversationId: 'seed-turn', modelId, createdAt: 2,
    usage: { promptTokens: 800, completionTokens: 200, totalTokens: 1000, currentPromptTokens: 14577, contextWindow: 1000000 },
    metadata: { contextUsageEstimated: true } }
]
const envelope = (data: unknown) => JSON.stringify({ code: 200, message: 'ok', data })
function frame(payload: Record<string, unknown>) {
  if (!heldStream || heldStream.writableEnded) throw new Error('Missing open fixture stream')
  projection.push(structuredClone(payload)); sequence++
  heldStream.write('id: live-input-run:' + sequence + '\ndata: ' + JSON.stringify(payload) + '\n\n')
}
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    requests.push(request.method + ' ' + path)
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) {
      response.writeHead(401, { 'content-type': 'application/json' }).end(envelope(null)); return
    }
    let raw = ''; for await (const chunk of request) raw += chunk.toString()
    if (path === '/api/v1/chat' && request.method === 'POST') {
      const body = JSON.parse(raw) as Record<string, unknown>
      if (body.sessionId !== sessionId || body.model !== modelId) throw new Error('Wrong conversation or model')
      run = { schemaVersion: 1, runId: 'live-input-run', sessionId, turnId: 'live-input-turn', userMessageId: 'live-input-user',
        assistantMessageId: 'live-input-assistant', seq: 1, version: 1, status: 'running', modelId, pending: [], createdAt: Date.now(), updatedAt: Date.now() }
      heldStream = response; response.writeHead(200, { 'content-type': 'text/event-stream' })
      frame({ run }); frame({ userMessage: { id: run.userMessageId, role: 'user', content: body.message, conversationId: run.turnId, createdAt: run.createdAt } })
      return
    }
    if (path === '/api/v1/chat/stream') {
      if (url.searchParams.get('sessionId') !== sessionId || url.searchParams.get('lastEventId') !== 'live-input-run:' + sequence) throw new Error('Wrong resume cursor')
      heldStream = response; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); return
    }
    response.setHeader('content-type', 'application/json')
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: 'sha256:' + 'c'.repeat(64), protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'live-input-fixture' }
      : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 1000000 } }]
      : path === '/api/v1/conversation/sessions' ? [{ sessionId, title: 'EXACT_CONTEXT_HISTORY', lastAt: 2, messageCount: 2 }]
      : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, source: run ? 'live' : 'persisted', sessionId, eventId: run ? 'live-input-run:' + sequence : null,
        finished: !run || run.status !== 'running', run, runs: run ? [run] : [], history, projection, todos: [], changes: [], commandJobs: [] }
      : path === '/api/v1/chat/runs' ? { runs: run ? [run] : [] }
      : path === '/api/v1/workspace/directory' ? { root: '/remote/context', entries: [] }
      : []
    response.end(envelope(data))
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})
const ring = () => page.locator('.context-ring')
const exact = () => page.locator('.ctx-card__exact-tokens')
const billed = () => page.locator('.turn-usage__value').last()
const lifetime = () => page.locator('.usage-meter__tokens')
async function showCard() { await ring().hover(); await expect(page.locator('.ctx-card')).toHaveCount(1) }

test.beforeAll(async () => {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  mkdirSync(join(root, '.e2e-tmp'), { recursive: true }); fixture = mkdtempSync(join(root, '.e2e-tmp', 'context-live-input-ui-'))
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: 'http://127.0.0.1:' + address.port, autoStartEngine: true, lastSessionId: '', thinkingMode: 'off' }))
  app = await electron.launch({ args: ['.', '--user-data-dir=' + fixture], cwd: root, env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
  await page.getByRole('button', { name: '会话历史', exact: true }).click(); await page.locator('.history-view__item[data-session-id="' + sessionId + '"]').click()
  await expect(page.locator('.message--user').first()).toContainText('EXACT_CONTEXT_HISTORY'); await expect(page.locator('.model-picker__trigger')).toBeEnabled()
})
test.afterAll(async () => {
  heldStream?.destroy(); await app?.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
  if (!fixture) return
  const absolute = resolve(fixture)
  if (dirname(absolute) !== join(root, '.e2e-tmp') || !basename(absolute).startsWith('context-live-input-ui-')) throw new Error('Unsafe fixture cleanup')
  rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test('真实14,577→14,589→14,605逐值显示；确认后预估只呈现待确认状态，账单只随计费帧增长', async ({}, testInfo) => {
  await expect(ring()).toHaveAttribute('data-context-source', 'estimated'); await expect(ring()).toHaveAttribute('data-context-pending', 'true'); await showCard()
  await expect(page.getByTestId('context-request-estimate')).toHaveCount(0)
  await expect(exact()).toHaveText('14,577 / 1,000,000 tokens'); await expect(page.locator('.ctx-card')).toContainText('输入估算')
  await page.locator('.chat__input').fill('EXERCISE_SLOW_PROVIDER_INPUT'); await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => Boolean(heldStream)).toBe(true)
  // The provider response stays open. Dispatch and observed input carry no billing counters.
  frame({ usage: { usageScope: 'turn', modelId, currentPromptTokens: 42900, contextWindow: 100000, contextUsageEstimated: true } })
  await expect(ring()).toHaveAttribute('aria-label', /42.9k \/ 100k/); await expect(ring()).toHaveAttribute('data-context-pending', 'true'); await expect(lifetime()).toHaveText('1k')
  await showCard(); await expect(exact()).toHaveText('42,900 / 100,000 tokens'); await expect(page.locator('.ctx-card')).toContainText('当前请求的输入估算')
  frame({ usage: { modelId, currentPromptTokens: 39000, contextWindow: 100000, contextUsageEstimated: false, contextUsageProvisional: false } })
  await expect(exact()).toHaveText('39,000 / 100,000 tokens'); await expect(ring()).toHaveAttribute('data-context-source', 'reported')
  await expect(page.locator('.ctx-card')).toContainText('最近确认的模型请求的输入（模型统计）'); await expect(ring()).toHaveAttribute('data-context-pending', 'false'); await expect(lifetime()).toHaveText('1k')
  const production = [[14577, 139352, '139.4k', '1.458%'], [14589, 198324, '198.3k', '1.459%'], [14605, 242434, '242.4k', '1.461%']] as const
  for (const [currentPromptTokens, totalTokens, compactBilling, precisePercent] of production) {
    frame({ usage: { usageScope: 'turn', modelId, currentPromptTokens, contextWindow: 1000000, contextUsageEstimated: false,
      promptTokens: totalTokens - 1, completionTokens: 1, totalTokens } })
    await expect(exact()).toHaveText(currentPromptTokens.toLocaleString('en-US') + ' / 1,000,000 tokens')
    await expect(page.locator('.ctx-card__percent')).toHaveText(precisePercent); await expect(page.locator('.ctx-card__tokens-value')).toHaveText(currentPromptTokens.toLocaleString('en-US') + ' / 1M')
    await expect(billed()).toHaveText(compactBilling); await expect(ring()).toHaveAttribute('data-context-pending', 'false')
  }
  await page.screenshot({ path: testInfo.outputPath('real-context-precision.png') })
  const billingBefore = await billed().textContent(), lifetimeBefore = await lifetime().textContent()
  frame({ usage: { modelId, currentPromptTokens: 17100, contextWindow: 100000, contextUsageEstimated: true } })
  frame({ content: 'UNCONFIRMED_17100_INPUT_FRAME' })
  await expect(page.locator('.message--assistant').last()).toContainText('UNCONFIRMED_17100_INPUT_FRAME')
  await expect(ring()).toHaveAttribute('data-context-pending', 'true')
  await expect(page.locator('.ctx-card__source-hint')).toContainText('最新请求输入尚未确认')
  await expect(page.getByTestId('context-request-estimate')).toHaveCount(0)
  await expect(page.locator('.ctx-card')).not.toContainText('17,100')
  await expect(exact()).toHaveText('14,605 / 1,000,000 tokens'); await expect(ring()).toHaveAttribute('data-context-source', 'reported')
  await expect(billed()).toHaveText(billingBefore!); await expect(lifetime()).toHaveText(lifetimeBefore!)
  // An explicitly reported zero remains visible and is distinct from absent usage.
  frame({ usage: { modelId, currentPromptTokens: 0, contextWindow: 100000, contextUsageEstimated: false, contextUsageProvisional: false } })
  await expect(exact()).toHaveText('0 / 100,000 tokens'); await expect(ring()).toHaveAttribute('data-context-source', 'reported'); await expect(ring()).toHaveAttribute('data-context-pending', 'false')
  await expect(page.locator('.ctx-card__source-hint')).not.toContainText('最新请求输入尚未确认')
  await expect(page.locator('.ctx-card__percent')).toHaveText('0.000%'); await expect(billed()).toHaveText(billingBefore!)
  await page.reload(); await expect.poll(() => requests.includes('GET /api/v1/chat/stream')).toBe(true)
  await expect(ring()).toHaveAttribute('aria-label', /最近一次模型请求 0 \/ 100k/); await expect(ring()).toHaveAttribute('data-context-source', 'reported'); await expect(ring()).toHaveAttribute('data-context-pending', 'false')
  await expect(billed()).toHaveText(billingBefore!); await expect(lifetime()).toHaveText(lifetimeBefore!)
  await showCard(); await expect(exact()).toHaveText('0 / 100,000 tokens'); await expect(page.locator('.ctx-card')).toContainText('模型统计')
  run = { ...run!, status: 'succeeded', version: 2, updatedAt: Date.now(), finishedAt: Date.now() }; frame({ run }); heldStream!.end('data: [DONE]\n\n')
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0); expect(errors).toEqual([])
})
