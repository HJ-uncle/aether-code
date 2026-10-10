/** Real Electron + authenticated HTTP: model-window edits, stable confirmed input, provisional usage and durable replay. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'

const root = resolve(__dirname, '..'), token = 'window-confirmed-fixture-token'
const sessionId = 'window-confirmed-session', modelId = 'deepseek-v4.1-flash', otherModel = 'context-other-64k'
let fixture = '', app: ElectronApplication | undefined, page: Page, stream: ServerResponse | undefined
let run: RootRun | undefined, sequence = 0
let projection: Record<string, unknown>[] = []
const errors: string[] = [], calls: Record<string, unknown>[] = [], updates: Record<string, unknown>[] = [], requests: string[] = []
const models = [modelId, otherModel].map((id, index) => ({ id: 'window-model-' + index, modelId: id, provider: 'openai', tenantId: 'default',
  displayName: index ? 'Other 64K' : 'Window edit fixture', apiKey: '...test', baseUrl: 'https://example.com/v1', isEnabled: true,
  capabilities: { toolCalling: true, contextWindow: index ? 64000 : 1000000 }, resolvedCapabilities: { toolCalling: true, contextWindow: index ? 64000 : 1000000 },
  capabilityOverrides: {} as Record<string, unknown>, createdAt: 1, updatedAt: 1 }))
let history: Record<string, unknown>[] = [
  { id: 'seed-user', role: 'user', content: 'WINDOW_CONFIRMED_HISTORY', conversationId: 'seed-turn', createdAt: 1 },
  { id: 'seed-assistant', role: 'assistant', content: 'INITIAL_WINDOW_REPLY', conversationId: 'seed-turn', modelId, createdAt: 2,
    usage: { promptTokens: 800, completionTokens: 200, totalTokens: 1000, currentPromptTokens: 19037, contextWindow: 1000000 },
    metadata: { contextUsageEstimated: false } }
]
const envelope = (data: unknown) => JSON.stringify({ code: 200, message: 'ok', data })
function frame(payload: Record<string, unknown>) {
  if (!stream || stream.writableEnded) throw new Error('Missing open fixture stream')
  projection.push(structuredClone(payload)); sequence++
  stream.write('id: window-confirmed-run:' + sequence + '\ndata: ' + JSON.stringify(payload) + '\n\n')
}
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    requests.push(request.method + ' ' + path)
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) {
      response.writeHead(401, { 'content-type': 'application/json' }).end(envelope(null)); return
    }
    let raw = ''; for await (const chunk of request) raw += chunk.toString()
    if (path === '/api/v1/models/window-model-0' && request.method === 'PUT') {
      const body = JSON.parse(raw) as Record<string, unknown>; updates.push(body)
      const patch = body.capabilityOverrides as Record<string, unknown> | undefined
      if (patch) for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete models[0].capabilityOverrides[key]
        else models[0].capabilityOverrides[key] = value
      }
      const window = models[0].capabilityOverrides.contextWindow ?? 1000000
      if (typeof window !== 'number') throw new Error('Invalid fixture context window')
      models[0].capabilities = models[0].resolvedCapabilities = { toolCalling: true, contextWindow: window }
      response.setHeader('content-type', 'application/json'); response.end(envelope(models[0])); return
    }
    if (path === '/api/v1/chat' && request.method === 'POST') {
      const body = JSON.parse(raw) as Record<string, unknown>; calls.push(body)
      if (body.sessionId !== sessionId || body.model !== modelId) throw new Error('Wrong fixture chat scope')
      run = { schemaVersion: 1, runId: 'window-confirmed-run', sessionId, turnId: 'window-confirmed-turn', userMessageId: 'window-confirmed-user',
        assistantMessageId: 'window-confirmed-assistant', seq: 1, version: 1, status: 'running', modelId, pending: [], createdAt: Date.now(), updatedAt: Date.now() }
      stream = response; response.writeHead(200, { 'content-type': 'text/event-stream' })
      frame({ run }); frame({ userMessage: { id: run.userMessageId, role: 'user', content: body.message, conversationId: run.turnId, createdAt: run.createdAt } })
      frame({ content: 'CONFIRMED_LIVE_REPLY' }); return
    }
    if (path === '/api/v1/chat/stream') {
      if (url.searchParams.get('sessionId') !== sessionId || url.searchParams.get('lastEventId') !== 'window-confirmed-run:' + sequence) throw new Error('Wrong fixture resume cursor')
      stream = response; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); return
    }
    response.setHeader('content-type', 'application/json')
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: 'sha256:' + '9'.repeat(64), protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'window-confirmed-fixture' }
      : path === '/api/v1/models' ? models
      : path === '/api/v1/conversation/sessions' ? [{ sessionId, title: 'WINDOW_CONFIRMED_HISTORY', lastAt: 2, messageCount: history.length }]
      : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, source: run?.status === 'running' ? 'live' : 'persisted', sessionId,
        eventId: run?.status === 'running' ? 'window-confirmed-run:' + sequence : null, finished: !run || run.status !== 'running', run,
        runs: run ? [run] : [], history, projection, todos: [], changes: [], commandJobs: [] }
      : path === '/api/v1/chat/runs' ? { runs: run ? [run] : [] }
      : path === '/api/v1/workspace/directory' ? { root: '/remote/context-window', entries: [] }
      : []
    response.end(envelope(data))
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})
const ring = () => page.locator('.context-ring')
const exact = () => page.locator('.ctx-card__exact-tokens')
const compact = () => page.locator('.ctx-card__tokens-value:not(.ctx-card__exact-tokens)')
const sourceHint = () => page.locator('.ctx-card__source-hint')
function compactTokens(value: number): string {
  const abs = Math.abs(value)
  const trim = (n: number): string => {
    const text = n.toFixed(1)
    return text.endsWith('.0') ? text.slice(0, -2) : text
  }
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`
  if (abs >= 1_000) return `${trim(value / 1_000)}k`
  return String(value)
}
async function expectContext(used: number, limit: number): Promise<void> {
  await expect(exact()).toHaveText(`${used.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')} tokens`)
  await expect(compact()).toHaveText(`${compactTokens(used)} / ${compactTokens(limit)}`)
  await expect(page.getByTestId('context-used-compact-number')).toHaveAttribute('data-value', String(used))
  await expect(page.getByTestId('context-used-number')).toHaveAttribute('data-value', String(used))
}
async function expectPending(...hiddenCounts: number[]) {
  await expect(ring()).toHaveAttribute('data-context-pending', 'true')
  await expect(sourceHint()).toContainText('最新请求输入尚未确认')
  await expect(page.getByTestId('context-request-estimate')).toHaveCount(0)
  for (const count of hiddenCounts) await expect(page.getByTestId('context-usage-card')).not.toContainText(count.toLocaleString('en-US'))
}
async function expectConfirmed() {
  await expect(ring()).toHaveAttribute('data-context-pending', 'false')
  await expect(sourceHint()).not.toContainText('最新请求输入尚未确认')
  await expect(page.getByTestId('context-request-estimate')).toHaveCount(0)
}
const billed = () => page.locator('.turn-usage__value').last()
const lifetime = () => page.locator('.usage-meter__tokens')
async function showCard() { await page.locator('.chat__input').click(); await ring().hover(); await expect(page.locator('.ctx-card')).toHaveCount(1) }
async function editWindow(value: string) {
  if (!await page.locator('.app-settings').isVisible()) await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: '模型', exact: true }).click()
  await page.locator('.settings-view--models .sg__row').filter({ hasText: 'Window edit fixture' }).getByRole('button', { name: '编辑', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '编辑模型' }); await expect(dialog).toBeVisible()
  await dialog.getByPlaceholder('如 128', { exact: true }).fill(value)
  await dialog.getByRole('button', { name: '保存', exact: true }).click(); await expect(dialog).toBeHidden()
}
async function selectModel(id: string) {
  await page.locator('.chat__input').click(); await page.locator('.model-picker__trigger').click()
  await page.locator('.model-picker__item').filter({ has: page.locator('.model-picker__name', { hasText: id === modelId ? 'Window edit fixture' : 'Other 64K' }) }).click()
}

test.describe.serial('窗口设置与已确认上下文独立显示', () => {
  test.beforeAll(async () => {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true }); fixture = mkdtempSync(join(root, '.e2e-tmp', 'context-window-confirmed-ui-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: 'http://127.0.0.1:' + address.port,
      autoStartEngine: true, lastSessionId: '', lastModelId: modelId, thinkingMode: 'off' }))
    app = await electron.launch({ args: ['.', '--user-data-dir=' + fixture], cwd: root, env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
    await page.getByRole('button', { name: '会话历史', exact: true }).click(); await page.locator('.history-view__item[data-session-id="' + sessionId + '"]').click()
    await expect(page.locator('.message--user').first()).toContainText('WINDOW_CONFIRMED_HISTORY'); await expect(page.locator('.model-picker__trigger')).toBeEnabled()
  })
  test.afterAll(async () => {
    stream?.destroy(); await app?.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (!fixture) return
    const absolute = resolve(fixture)
    if (dirname(absolute) !== join(root, '.e2e-tmp') || !basename(absolute).startsWith('context-window-confirmed-ui-')) throw new Error('Unsafe window fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  test('实际表单保存128K→256K→清空默认，历史1M不遮盖当前能力、异composer不串窗口', async () => {
    await showCard(); await expectContext(19037, 1000000)
    await editWindow('128'); expect(updates.at(-1)?.capabilityOverrides).toEqual({ contextWindow: 128000 })
    await showCard(); await expectContext(19037, 128000)
    await expect(page.locator('.ctx-card__percent')).toHaveText('14.9%')
    await page.reload(); await expect(ring()).toHaveAttribute('aria-label', /19k \/ 128k/)
    await showCard(); await expectContext(19037, 128000)
    await editWindow('256'); expect(updates.at(-1)?.capabilityOverrides).toEqual({ contextWindow: 256000 })
    await showCard(); await expectContext(19037, 256000)
    await editWindow(''); expect(updates.at(-1)?.capabilityOverrides).toEqual({ contextWindow: null })
    await showCard(); await expectContext(19037, 1000000)
    await editWindow('128'); await showCard(); await expectContext(19037, 128000)
    await selectModel(otherModel); await showCard(); await expectContext(19037, 128000)
    await selectModel(modelId); expect(calls).toHaveLength(0); expect(errors).toEqual([])
  })

  test('已确认55327→预估64673→起始19848不来回跳；只显示待确认状态、刷新保留确认值，只有最终计费增加账单', async ({}, testInfo) => {
    await page.locator('.chat__input').fill('EXERCISE_CONFIRMED_AND_PROVISIONAL_CONTEXT'); await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => Boolean(stream)).toBe(true); expect(calls).toHaveLength(1)
    frame({ usage: { usageScope: 'turn', modelId, currentPromptTokens: 55327, contextWindow: 128000, contextUsageEstimated: false,
      contextUsageProvisional: false, promptTokens: 55327, completionTokens: 100, totalTokens: 55427,
      confirmedContext: { used: 55327, contextWindow: 128000, modelId } } })
    await showCard(); await expectContext(55327, 128000); await expect(ring()).toHaveAttribute('data-context-source', 'reported'); await expectConfirmed()
    const billingBefore = await billed().textContent(), lifetimeBefore = await lifetime().textContent()
    const stableBounds = await page.getByTestId('context-usage-card').evaluate(node => {
      node.setAttribute('data-stability-probe', 'confirmed-context-card'); const rect = node.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    })
    const expectStableCard = async () => {
      const card = page.getByTestId('context-usage-card'); await expect(card).toHaveAttribute('data-stability-probe', 'confirmed-context-card');
      const rect = await card.boundingBox(); if (!rect) throw new Error('Missing context card bounds');
      for (const key of ['left', 'top', 'width', 'height'] as const) {
        const value = key === 'left' ? rect.x : key === 'top' ? rect.y : rect[key]; expect(Math.abs(value - stableBounds[key])).toBeLessThanOrEqual(1)
      }
    }
    frame({ usage: { modelId, currentPromptTokens: 64673, contextWindow: 128000, contextUsageEstimated: true, requestInputTokenEstimate: 64673,
      confirmedContext: { used: 55327, contextWindow: 128000, modelId } } })
    frame({ content: 'REQUEST_ESTIMATE_CONTEXT_FRAME' })
    await expect(page.locator('.message--assistant').last()).toContainText('REQUEST_ESTIMATE_CONTEXT_FRAME')
    await expectPending(64673); await expectContext(55327, 128000)
    await expect(ring()).toHaveAttribute('data-context-source', 'reported'); await expect(billed()).toHaveText(billingBefore!); await expect(lifetime()).toHaveText(lifetimeBefore!)
    frame({ usage: { modelId, currentPromptTokens: 19848, contextWindow: 128000, contextUsageEstimated: false, contextUsageProvisional: true,
      requestInputTokenEstimate: 64673, confirmedContext: { used: 55327, contextWindow: 128000, modelId } } })
    frame({ content: 'PROVISIONAL_CONTEXT_FRAME' })
    await expect(page.locator('.message--assistant').last()).toContainText('PROVISIONAL_CONTEXT_FRAME')
    await expectContext(55327, 128000); await expectPending(64673, 19848, 19849)
    await expect(billed()).toHaveText(billingBefore!); await expect(lifetime()).toHaveText(lifetimeBefore!)
    // Older engines omit the phase field on provider-start frames. They are
    // still distinguishable from confirmed cumulative billing samples.
    frame({ usage: { modelId, currentPromptTokens: 19849, contextWindow: 128000, contextUsageEstimated: false } })
    frame({ content: 'LEGACY_PROVIDER_START_FRAME' })
    await expect(page.locator('.message--assistant').last()).toContainText('LEGACY_PROVIDER_START_FRAME')
    await expectContext(55327, 128000); await expectPending(64673, 19848, 19849)
    await expect(billed()).toHaveText(billingBefore!); await expect(lifetime()).toHaveText(lifetimeBefore!)
    await expectStableCard()
    await page.getByTestId('context-usage-card').screenshot({ path: testInfo.outputPath('context-confirmed-with-pending-status.png') })
    const resumeBefore = requests.filter(value => value === 'GET /api/v1/chat/stream').length
    await page.reload(); await expect.poll(() => requests.filter(value => value === 'GET /api/v1/chat/stream').length).toBe(resumeBefore + 1)
    await showCard(); await expectContext(55327, 128000); await expectPending(64673, 19848, 19849)
    await expect(billed()).toHaveText(billingBefore!); await expect(lifetime()).toHaveText(lifetimeBefore!)
    frame({ usage: { usageScope: 'turn', modelId, currentPromptTokens: 56306, contextWindow: 128000, contextUsageEstimated: false,
      contextUsageProvisional: false, promptTokens: 111633, completionTokens: 300, totalTokens: 111933,
      confirmedContext: { used: 56306, contextWindow: 128000, modelId } } })
    await expectContext(56306, 128000); await expect(billed()).toHaveText('111.9k')
    await expect(lifetime()).toHaveText('112.9k'); await expectConfirmed()
    await expect(page.getByTestId('context-used-number')).toHaveAttribute('data-motion', 'idle')
    await expect(page.getByTestId('context-percent-number')).toHaveAttribute('data-motion', 'idle')
    await expect(page.getByTestId('context-usage-bar')).toHaveAttribute('data-motion', 'idle')
    await page.getByTestId('context-usage-card').screenshot({ path: testInfo.outputPath('context-confirmed-with-final-usage.png') }); expect(errors).toEqual([])
  })

  test('用户两组91K与87K截图回归：下一请求的预估保持内部数据、卡片只呈现已确认占用和状态', async () => {
    const billingBefore = await billed().textContent(), lifetimeBefore = await lifetime().textContent()
    for (const [confirmed, estimate, final] of [[91031, 110967, 91754], [87173, 100939, 87295]]) {
      // Each source sample is explicitly replaced before checking the next request;
      // a preceding fixture estimate cannot make an unchanged primary value pass.
      frame({ usage: { usageScope: 'turn', modelId, currentPromptTokens: confirmed, contextWindow: 128000,
        contextUsageEstimated: false, contextUsageProvisional: false,
        confirmedContext: { used: confirmed, contextWindow: 128000, modelId } } })
      frame({ content: 'SCREENSHOT_CONFIRMED_' + confirmed })
      await expect(page.locator('.message--assistant').last()).toContainText('SCREENSHOT_CONFIRMED_' + confirmed)
      await showCard(); await expectContext(confirmed, 128000); await expectConfirmed()
      frame({ usage: { modelId, currentPromptTokens: estimate, contextWindow: 128000, contextUsageEstimated: true,
        requestInputTokenEstimate: estimate, confirmedContext: { used: confirmed, contextWindow: 128000, modelId } } })
      frame({ content: 'SCREENSHOT_PENDING_' + estimate })
      await expect(page.locator('.message--assistant').last()).toContainText('SCREENSHOT_PENDING_' + estimate)
      await expectPending(estimate); await expectContext(confirmed, 128000)
      await expect(billed()).toHaveText(billingBefore!); await expect(lifetime()).toHaveText(lifetimeBefore!)
      frame({ usage: { usageScope: 'turn', modelId, currentPromptTokens: final, contextWindow: 128000,
        contextUsageEstimated: false, contextUsageProvisional: false,
        confirmedContext: { used: final, contextWindow: 128000, modelId } } })
      frame({ content: 'SCREENSHOT_FINAL_' + final })
      await expect(page.locator('.message--assistant').last()).toContainText('SCREENSHOT_FINAL_' + final)
      await expectContext(final, 128000); await expectConfirmed()
      await expect(billed()).toHaveText(billingBefore!); await expect(lifetime()).toHaveText(lifetimeBefore!)
    }
    frame({ usage: { usageScope: 'turn', modelId, currentPromptTokens: 56306, contextWindow: 128000,
      contextUsageEstimated: false, contextUsageProvisional: false,
      confirmedContext: { used: 56306, contextWindow: 128000, modelId } } })
    frame({ content: 'SCREENSHOT_RESTORED_FIXTURE' })
    await expect(page.locator('.message--assistant').last()).toContainText('SCREENSHOT_RESTORED_FIXTURE')
    await expectContext(56306, 128000); await expectConfirmed()
    expect(calls).toHaveLength(1); expect(errors).toEqual([])
  })

  test('历史持久快照同时保留confirmed与pending；上调设置不扩大最近请求实际128K窗口', async () => {
    frame({ usage: { modelId, currentPromptTokens: 70001, contextWindow: 128000, contextUsageEstimated: true, requestInputTokenEstimate: 70001,
      confirmedContext: { used: 56306, contextWindow: 128000, modelId } } })
    frame({ content: 'PERSISTED_PENDING_CONTEXT_FRAME' })
    await expect(page.locator('.message--assistant').last()).toContainText('PERSISTED_PENDING_CONTEXT_FRAME')
    await expectContext(56306, 128000); await expectPending(70001)
    run = { ...run!, status: 'succeeded', version: 2, updatedAt: Date.now(), finishedAt: Date.now() }
    frame({ run }); stream!.end('data: [DONE]\n\n')
    history = [...history, { id: 'window-confirmed-user', role: 'user', content: 'EXERCISE_CONFIRMED_AND_PROVISIONAL_CONTEXT', conversationId: run.turnId, createdAt: 3 },
      { id: 'window-confirmed-assistant', role: 'assistant', content: 'CONFIRMED_LIVE_REPLY', conversationId: run.turnId, modelId, createdAt: 4,
        usage: { promptTokens: 111633, completionTokens: 300, totalTokens: 111933, currentPromptTokens: 70001, contextWindow: 128000,
          requestInputTokenEstimate: 70001, confirmedContext: { used: 56306, contextWindow: 128000, modelId } }, metadata: { contextUsageEstimated: true } }]
    projection = []
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    await page.reload(); await showCard(); await expectContext(56306, 128000)
    await expectPending(70001); await expect(billed()).toHaveText('111.9k'); await expect(lifetime()).toHaveText('112.9k')
    await editWindow('256'); await showCard(); await expectContext(56306, 128000)
    await selectModel(otherModel); await showCard(); await expectContext(56306, 128000)
    expect(calls).toHaveLength(1); expect(errors).toEqual([])
  })

  test('孤立的初步模型统计不冒充本地估算或最终确认；历史刷新保持来源和真实账单', async () => {
    // This snapshot deliberately contains neither a previous confirmed sample
    // nor a request estimate. Aggregated billing remains independently known.
    history = [{ id: 'window-confirmed-assistant', role: 'assistant', content: 'ISOLATED_PROVISIONAL_HISTORY', conversationId: run!.turnId, modelId, createdAt: 5,
      usage: { promptTokens: 111633, completionTokens: 300, totalTokens: 111933, currentPromptTokens: 19848, contextWindow: 128000,
        contextUsageEstimated: false, contextUsageProvisional: true }, metadata: { contextUsageEstimated: false, contextUsageProvisional: true } }]
    projection = []
    await page.reload(); await expect(page.locator('.message--assistant')).toContainText('ISOLATED_PROVISIONAL_HISTORY')
    await showCard(); await expectContext(19848, 128000)
    await expect(ring()).toHaveAttribute('data-context-source', 'provisional')
    await expect(page.locator('.ctx-card__source-hint')).toContainText('模型初步统计')
    await expect(page.locator('.ctx-card__source-hint')).toContainText('等待最终确认')
    await expect(page.locator('.ctx-card__source-hint')).not.toContainText('本地预估')
    await expect(ring()).toHaveAttribute('data-context-pending', 'true')
    await expect(page.getByTestId('context-request-estimate')).toHaveCount(0); await expect(billed()).toHaveText('111.9k'); await expect(lifetime()).toHaveText('111.9k')
    expect(calls).toHaveLength(1); expect(errors).toEqual([])
  })

  test('已确认的零输入同时保持紧凑值与精确值为0；刷新后不退化为尚未确认', async () => {
    history = [{ id: 'window-confirmed-zero', role: 'assistant', content: 'CONFIRMED_ZERO_CONTEXT', conversationId: run!.turnId, modelId, createdAt: 6,
      usage: { promptTokens: 0, completionTokens: 20, totalTokens: 20, currentPromptTokens: 0, contextWindow: 128000,
        contextUsageEstimated: false, contextUsageProvisional: false,
        confirmedContext: { used: 0, contextWindow: 128000, modelId } }, metadata: { contextUsageEstimated: false } }]
    projection = []
    await page.reload(); await expect(page.locator('.message--assistant')).toContainText('CONFIRMED_ZERO_CONTEXT')
    await showCard(); await expectContext(0, 128000); await expectConfirmed()
    await page.reload(); await showCard(); await expectContext(0, 128000); await expectConfirmed()
    expect(calls).toHaveLength(1); expect(errors).toEqual([])
  })
})
