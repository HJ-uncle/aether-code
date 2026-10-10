/** Real Electron + authenticated remote HTTP: automatic compaction status, live status sweep,
 * footer alignment at normal/narrow widths, reduced-motion readability, read-only meter,
 * session isolation, nested cache rows and archive recovery. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
const root = resolve(__dirname, '..'), token = 'context-usage-fixture-token'
const sessionA = 'context-session-A', sessionB = 'context-session-B'
const modelA = 'context-model-A-with-a-complete-provider-and-version-name-2026', modelB = 'context-model-B'
let fixture = '', app: ElectronApplication | undefined, page: Page, heldStream: ServerResponse | undefined
let aCompacted = false, aRun: RootRun | undefined
let aHistory: EngineHistoryRow[] = [
  { id: 'seed-user', role: 'user', content: 'CONTEXT_HISTORY_A', conversationId: 'seed-turn', createdAt: 1 },
  { id: 'seed-assistant', role: 'assistant', content: 'INITIAL_A_REPLY', conversationId: 'seed-turn', modelId: modelA, createdAt: 2,
    usage: { promptTokens: 8000, completionTokens: 2, totalTokens: 8002, currentPromptTokens: 12000, contextWindow: 100000, cacheHitTokens: 6000, cacheMissTokens: 2000 } }
]
const errors: string[] = [], snapshots: string[] = [], chats: Record<string, unknown>[] = []
const compressions: string[] = [], archiveReads: string[] = []
const envelope = (data: unknown) => JSON.stringify({ code: 200, message: 'ok', data })
function snapshot(sessionId: string) {
  const history = sessionId === sessionA ? aHistory : sessionId === sessionB ? [
    { id: 'b-user', role: 'user', content: 'CONTEXT_HISTORY_B', conversationId: 'b-turn', createdAt: 3 },
    { id: 'b-assistant', role: 'assistant', content: 'B_REPLY', conversationId: 'b-turn', modelId: modelB, createdAt: 4,
      usage: { promptTokens: 16000, completionTokens: 2, totalTokens: 16002, currentPromptTokens: 16000, contextWindow: 64000 } }
  ] : []
  const run = sessionId === sessionA ? aRun : undefined
  return { schemaVersion: 1, source: 'persisted', sessionId, eventId: null, finished: true, projection: [], run, runs: run ? [run] : [], history: sessionId === sessionA && aCompacted ? [{ id: 'auto-summary', role: 'system', content: 'AUTOMATIC_CONTEXT_SUMMARY', metadata: { isCompactSummary: true } }, ...history.slice(2)] : history, historyCompacted: sessionId === sessionA && aCompacted, todos: [], changes: [], commandJobs: [] }
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
      compressions.push(path); response.writeHead(404).end(envelope(null)); return
    }
    if (path === '/api/v1/conversation/archive') {
      const sessionId = url.searchParams.get('sessionId') ?? '', current = Number(url.searchParams.get('current')), pageSize = Number(url.searchParams.get('pageSize'))
      archiveReads.push(sessionId)
      const rows = sessionId === sessionA ? aHistory : [], totalPages = Math.ceil(rows.length / pageSize)
      response.end(JSON.stringify({ code: 200, message: 'ok', data: rows.slice((current - 1) * pageSize, current * pageSize), pagination: { current, pageSize, total: rows.length, totalPages }, metadata: { archiveMessageCount: rows.length, archiveRevision: 'context-' + rows.length } })); return
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
const activeAssistant = () => page.locator('.message--assistant').last()
const runStatus = () => activeAssistant().getByRole('status', { name: '运行状态', exact: true })
const streamingHint = () => activeAssistant().locator('.message__streaming-hint')
const streamingText = () => streamingHint().locator('.message__streaming-text')
const turnUsageDialog = () => page.getByRole('dialog', { name: '本次问答用量', exact: true })
const sessionUsageDialog = () => page.getByRole('dialog', { name: '会话用量明细', exact: true })
async function expectCacheStatistics(dialog: ReturnType<typeof turnUsageDialog>, input: string, hit: string, miss: string, output: string, total: string) {
  await expect(dialog.locator('.usage-detail--cache')).toHaveCount(0)
  await expect(dialog.getByRole('region', { name: '缓存统计', exact: true })).toHaveCount(0)
  const breakdown = dialog.locator('.usage-detail:not(.usage-detail--meta)')
  await expect(breakdown).toHaveCount(1)
  const peers = breakdown.locator('.usage-detail__row:not(.usage-detail__row--child) .usage-detail__label')
  await expect(peers).toHaveText(['累计输入 Prompt', '输出 Completion'])
  for (const [label, value] of [['累计输入 Prompt', input], ['缓存命中', hit], ['输出 Completion', output], ['缓存未命中', miss]]) {
    const row = breakdown.locator('.usage-detail__row').filter({ has: page.getByText(label, { exact: true }) })
    await expect(row).toHaveCount(1)
    if (label === '缓存未命中' || label === '缓存命中') await expect(row).toHaveClass(/usage-detail__row--child/)
    else await expect(row).not.toHaveClass(/usage-detail__row--child/)
    await expect(row.locator('.usage-detail__value')).toHaveText(value)
    await expect(dialog.getByText(label, { exact: true })).toHaveCount(1)
  }
  await expect(dialog.locator('.usage-popover__total-value')).toHaveText(total)
  const exactAmounts = await dialog.evaluate(element => {
    const exactTokens = (field: Element): number => {
      const raw = field.getAttribute('title')?.split(' tokens')[0].replaceAll(',', '') ?? ''
      if (!/^\d+$/.test(raw)) throw new Error('Missing exact token amount: ' + field.className)
      return Number(raw)
    }
    const peers = Array.from(element.querySelectorAll('.usage-detail:not(.usage-detail--meta) .usage-detail__row:not(.usage-detail__row--child):not(.usage-detail__row--subtotal) .usage-detail__value'))
    const total = element.querySelector('.usage-popover__total-value')
    if (!total || peers.length !== 2) throw new Error('Missing exact primary usage rows or total')
    return { parts: peers.map(exactTokens), total: exactTokens(total) }
  })
  expect(exactAmounts.parts.reduce((sum, amount) => sum + amount, 0), '完整累计输入和输出的精确数字应等于累计总用量，缓存子项不能再次相加').toBe(exactAmounts.total)
  await expect.poll(() => dialog.evaluate(element => {
    const rows = Array.from(element.querySelectorAll('.usage-detail__row'))
    const input = rows.find(row => row.querySelector('.usage-detail__label')?.textContent === '累计输入 Prompt')
    const hit = rows.find(row => row.querySelector('.usage-detail__label')?.textContent === '缓存命中')
    const output = rows.find(row => row.querySelector('.usage-detail__label')?.textContent === '输出 Completion')
    if (!input || !hit || !output) throw new Error('Missing input, cache or output peer rows')
    const inputLabel = input.querySelector('.usage-detail__label'), cacheLabel = hit.querySelector('.usage-detail__label')
    const inputValue = input.querySelector('.usage-detail__value'), cacheValue = hit.querySelector('.usage-detail__value')
    if (!inputLabel || !cacheLabel || !inputValue || !cacheValue) throw new Error('Missing cache alignment slots')
    const inputBar = input.querySelector('.usage-detail__bar'), cacheBar = hit.querySelector('.usage-detail__bar'), outputBar = output.querySelector('.usage-detail__bar')
    if (!inputBar || !cacheBar || !outputBar) throw new Error('Missing peer row color bars')
    const probe = document.createElement('span')
    probe.style.color = 'var(--usage-cache)'; element.append(probe)
    const expectedCacheColor = getComputedStyle(probe).color
    probe.remove()
    const cacheColor = getComputedStyle(cacheBar).backgroundColor
    if (cacheColor !== expectedCacheColor || getComputedStyle(cacheLabel).color !== expectedCacheColor || getComputedStyle(cacheValue).color !== expectedCacheColor ||
      cacheColor === getComputedStyle(inputBar).backgroundColor || cacheColor === getComputedStyle(outputBar).backgroundColor) return Number.POSITIVE_INFINITY
    const model = element.querySelector('.usage-detail__row--model .usage-detail__value')
    if (model) {
      const style = getComputedStyle(model)
      if (style.whiteSpace === 'nowrap' || style.textOverflow === 'ellipsis' || model.scrollWidth - model.clientWidth > 1) return Number.POSITIVE_INFINITY
    }
    const breakdown = element.querySelector('.usage-detail:not(.usage-detail--meta)')
    if (!breakdown) throw new Error('Missing usage breakdown')
    const dialogBox = element.getBoundingClientRect()
    return Math.max(
      Math.max(0, inputLabel.getBoundingClientRect().left + 2 - cacheLabel.getBoundingClientRect().left),
      Math.abs(inputValue.getBoundingClientRect().right - cacheValue.getBoundingClientRect().right),
      Math.max(0, breakdown.scrollWidth - breakdown.clientWidth),
      Math.max(0, -dialogBox.left), Math.max(0, dialogBox.right - innerWidth),
      Math.max(0, -dialogBox.top), Math.max(0, dialogBox.bottom - innerHeight)
    )
  }), { message: '累计输入显示完整值，缓存命中缩进为淡绿色子项并与输入共享数值轴；长模型名完整换行，popover 不溢窗（允许 1px DPR 取整）' }).toBeLessThanOrEqual(1)
}
async function expectContextCardReadable(used: string, limit: string, percent: string) {
  const card = page.locator('.ctx-card')
  await expect(card).toBeVisible()
  await expect(card.locator('.ctx-card__tokens-value')).toHaveCount(1)
  await expect(card.locator('.ctx-card__exact-tokens')).toHaveCount(1)
  const compactUsed = compactContextValue(used), compactLimit = compactContextValue(limit)
  await expect(card.locator('.ctx-card__tokens-value')).toHaveText(`${compactUsed} / ${compactLimit}`)
  await expect(card.locator('.ctx-card__tokens-label')).toHaveText('使用 / 上限')
  await expect(card.locator('.ctx-card__exact-tokens')).toHaveText(`${used} / ${limit} tokens`)
  await expect(card.locator('.ctx-card__percent')).toContainText(percent)
  await expect(card).toContainText('单次请求占用')
  await expect(card).toContainText('累计计费用量')
  await expect.poll(() => card.evaluate(element => {
    const required = [['.ctx-card__header', 13], ['.ctx-card__percent', 18], ['.ctx-card__tokens-value', 14], ['.ctx-card__exact-tokens', 12]] as const
    for (const [selector, minimum] of required) {
      const field = element.querySelector(selector)
      if (!field || parseFloat(getComputedStyle(field).fontSize) < minimum) return Number.POSITIVE_INFINITY
    }
    const notes = Array.from(element.querySelectorAll('.ctx-card__hint, .ctx-card__billing-hint'))
    if (!notes.length || notes.some(note => {
      const style = getComputedStyle(note), font = parseFloat(style.fontSize)
      return font < 12 || parseFloat(style.lineHeight) < font * 1.45
    })) return Number.POSITIVE_INFINITY
    const tokens = element.querySelector('.ctx-card__tokens'), exact = element.querySelector('.ctx-card__exact-tokens'), label = element.querySelector('.ctx-card__tokens-label'), bar = element.querySelector('.ctx-card__bar')
    if (!tokens || !exact || !label || !bar) throw new Error('Missing compact/exact context usage or progress bar')
    if (parseFloat(getComputedStyle(tokens).marginTop) < 10 || parseFloat(getComputedStyle(bar).marginTop) < 10) return Number.POSITIVE_INFINITY
    const compactBox = tokens.querySelector('.ctx-card__tokens-value')!.getBoundingClientRect(), exactBox = exact.getBoundingClientRect(), labelBox = label.getBoundingClientRect()
    if (exactBox.top - compactBox.bottom < 3) return Number.POSITIVE_INFINITY
    if (Math.abs(compactBox.top + compactBox.height / 2 - labelBox.top - labelBox.height / 2) > 1) return Number.POSITIVE_INFINITY
    const style = getComputedStyle(element), box = element.getBoundingClientRect()
    return Math.max(
      Math.max(0, 16 - parseFloat(style.paddingLeft)), Math.max(0, 16 - parseFloat(style.paddingRight)),
      Math.max(0, element.scrollWidth - element.clientWidth),
      Math.max(0, -box.left), Math.max(0, box.right - innerWidth),
      Math.max(0, -box.top), Math.max(0, box.bottom - innerHeight)
    )
  }), { message: '上下文卡应同时展示紧凑与精确用量，首行使用/上限同基线；辅助文字至少 12px/舒适行距，分区留白足够且不溢出窗口' }).toBeLessThanOrEqual(1)
}
function compactContextValue(value: string): string {
  const numeric = Number(value.replaceAll(',', ''))
  if (!Number.isFinite(numeric)) return value
  if (numeric >= 1_000_000) return `${(numeric / 1_000_000).toFixed(numeric % 1_000_000 ? 1 : 0).replace(/\.0$/, '')}M`
  if (numeric >= 1_000) return `${(numeric / 1_000).toFixed(numeric % 1_000 ? 1 : 0).replace(/\.0$/, '')}k`
  return String(numeric)
}
async function expectSingleRunStatusBelowFooter(text: string) {
  await expect(runStatus()).toHaveCount(1)
  await expect(runStatus()).toHaveText(text)
  await expect(activeAssistant().locator('.message__footer')).toBeVisible()
  await expect.poll(() => activeAssistant().evaluate(element => {
    const footer = element.querySelector('.message__footer')
    const status = element.querySelector('[role="status"][aria-label="运行状态"]')
    if (!footer || !status) throw new Error('Missing assistant footer or run status')
    return status.getBoundingClientRect().top - footer.getBoundingClientRect().bottom
  }), { message: '唯一运行状态必须显示在用量与操作 footer 的下方' }).toBeGreaterThanOrEqual(-1)
  await expect.poll(() => activeAssistant().evaluate(element => {
    const status = element.querySelector('.message__run-status')
    const slot = status?.querySelector('.message__run-status-icon')
    const label = status?.querySelector('.message__run-status-text')
    if (!status || !slot || !label) throw new Error('Missing run status alignment slots')
    const footer = element.querySelector('.message__footer')
    if (!footer) throw new Error('Missing assistant footer')
    const messageBox = element.getBoundingClientRect(), statusBox = status.getBoundingClientRect()
    const footerBox = footer.getBoundingClientRect()
    const iconBox = slot.getBoundingClientRect(), labelBox = label.getBoundingClientRect()
    const usageIcon = element.querySelector('.turn-usage__trigger svg')
    const usageValue = element.querySelector('.turn-usage__value')
    const fallback = element.querySelector('.message__footer > .turn-usage__model')
    const deltas = [
      Math.abs(iconBox.width - 16),
      Math.max(0, 26 - statusBox.height),
      Math.abs(statusBox.top - footerBox.bottom - 4),
      Math.max(0, statusBox.right - messageBox.right),
      Math.max(0, labelBox.right - statusBox.right),
      Math.max(0, status.scrollWidth - status.clientWidth)
    ]
    if (usageIcon && usageValue) {
      const usageIconBox = usageIcon.getBoundingClientRect()
      const usage = element.querySelector('.turn-usage')
      const trigger = element.querySelector('.turn-usage__trigger')
      const model = trigger?.querySelector('.turn-usage__model')
      if (!usage || !trigger || !model) throw new Error('Missing assistant usage, trigger or complete model name')
      const usageStyle = getComputedStyle(usage), usageBox = usage.getBoundingClientRect()
      const usageContentWidth = usageBox.width - parseFloat(usageStyle.paddingLeft) - parseFloat(usageStyle.paddingRight)
        - parseFloat(usageStyle.borderLeftWidth) - parseFloat(usageStyle.borderRightWidth)
      const modelStyle = getComputedStyle(model), modelBox = model.getBoundingClientRect()
      const valueBox = usageValue.getBoundingClientRect()
      if (modelStyle.whiteSpace === 'nowrap' || modelStyle.textOverflow === 'ellipsis' || modelStyle.textAlign !== 'left') return Number.POSITIVE_INFINITY
      deltas.push(
        Math.abs(usageIconBox.left - iconBox.left),
        Math.abs(usageIconBox.width - iconBox.width),
        Math.abs(trigger.getBoundingClientRect().width - usageContentWidth),
        Math.abs(valueBox.left - labelBox.left),
        Math.max(0, 26 - trigger.getBoundingClientRect().height),
        Math.max(0, model.scrollWidth - model.clientWidth),
        Math.max(0, modelBox.right - messageBox.right)
      )
      if (modelBox.top > valueBox.top + 2) deltas.push(Math.abs(modelBox.left - valueBox.left))
      const spinner = slot.querySelector('.message__spinner')
      if (spinner) {
        const spinnerBox = spinner.getBoundingClientRect()
        deltas.push(Math.abs(spinnerBox.left + spinnerBox.width / 2 - usageIconBox.left - usageIconBox.width / 2))
      }
    } else if (fallback) {
      deltas.push(Math.abs(fallback.getBoundingClientRect().left - labelBox.left))
      const separator = getComputedStyle(fallback, '::before').content
      if (separator !== 'none' && separator !== 'normal' && separator !== '""') return Number.POSITIVE_INFINITY
    } else throw new Error('Missing assistant usage or model fallback')
    const historySummary = element.querySelector('.interaction-history > summary')
    if (historySummary) {
      const historyBox = historySummary.getBoundingClientRect()
      const historyIcon = historySummary.querySelector('svg:not(.interaction-history__chevron)')
      const historyText = historySummary.querySelector('.pending-card__summary-text')
      if (!historyIcon || !historyText) throw new Error('Missing confirmation record icon or label')
      deltas.push(
        Math.abs(historyBox.top - statusBox.bottom - 4),
        Math.max(0, 26 - historyBox.height),
        Math.abs(historyIcon.getBoundingClientRect().left - iconBox.left),
        Math.abs(historyText.getBoundingClientRect().left - labelBox.left)
      )
    }
    return Math.max(...deltas)
  }), { message: '用量、运行状态、确认记录应共用图标/文字轴与 4px 行间距；每行至少 26px，模型完整显示且不横向溢出（允许 1px DPR 取整）' }).toBeLessThanOrEqual(1)
}
async function expectRunningSweep(text: string) {
  await expectSingleRunStatusBelowFooter(text)
  await expect(runStatus()).toHaveClass(/message__streaming-hint/)
  await expect(streamingHint()).toHaveCount(1)
  await expect(streamingHint()).toHaveText(text)
  await expect(streamingHint()).toHaveAttribute('role', 'status')
  await expect(streamingHint()).toHaveAttribute('aria-label', '运行状态')
  await expect(streamingHint()).toHaveAttribute('aria-live', 'polite')
  await expect(streamingText()).toHaveCount(1)
  await expect(streamingText()).toHaveText(text)
  await expect(streamingText()).toHaveCSS('animation-name', 'message-status-shimmer')
  await expect(streamingText()).toHaveCSS('animation-iteration-count', 'infinite')
  await expect(streamingText()).toHaveCSS('background-clip', 'text')
  const clock = () => streamingText().evaluate(element => {
    const sweep = element.getAnimations().find(animation => animation instanceof CSSAnimation && animation.animationName === 'message-status-shimmer')
    return { state: sweep?.playState, time: Number(sweep?.currentTime ?? -1) }
  })
  await expect.poll(async () => (await clock()).state).toBe('running')
  const initial = (await clock()).time
  await expect.poll(async () => (await clock()).time, { message: '运行中的扫光动画必须实际推进' }).toBeGreaterThan(initial + 50)
  const position = () => streamingText().evaluate(element => getComputedStyle(element).backgroundPosition)
  const initialPosition = await position()
  await expect.poll(position, { message: '扫光的背景位置必须实际变化，不能只有动画时钟在推进' }).not.toBe(initialPosition)
}
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
    heldStream?.destroy(); await app?.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
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
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await expect(activeAssistant().locator('.message__footer > .turn-usage__model')).toHaveText(modelA)
    await expectRunningSweep('正在生成回复…')
    // The initial model-only row must remain on the same text axis when usage first arrives.
    const initialStatusLeft = await runStatus().locator('.message__run-status-text').evaluate(element => element.getBoundingClientRect().left)
    // The input lacks a window, so its own model capability is the fallback.
    frame({ usage: { modelId: modelA, promptTokens: 12000, completionTokens: 1, totalTokens: 12001, currentPromptTokens: 12000, cacheHitTokens: 9000, cacheMissTokens: 3000 } }, 3)
    await expect(ring()).toHaveAttribute('aria-label', /12k \/ 100k/); await expect(page.locator('.turn-usage__value').last()).toHaveText('12k')
    await expectSingleRunStatusBelowFooter('正在生成回复…')
    expect(Math.abs(await runStatus().locator('.message__run-status-text').evaluate(element => element.getBoundingClientRect().left) - initialStatusLeft), '首个用量帧到来不能移动状态文字左边线').toBeLessThanOrEqual(1)
    await activeAssistant().locator('.turn-usage__trigger').click()
    await expectCacheStatistics(turnUsageDialog(), '12k', '9k', '3k', '1', '12k')
    await page.locator('.chat__input').click()
    const originalAppearance = await page.locator('html').getAttribute('data-appearance')
    const appearances: { color: string; gradient: string }[] = []
    try {
      // Exercise the production theme tokens without reloading and interrupting the held SSE run.
      for (const appearance of ['dark', 'light']) {
        await page.evaluate(value => { document.documentElement.dataset.appearance = value }, appearance)
        await expectRunningSweep('正在生成回复…')
        const paint = await streamingText().evaluate(element => {
          const style = getComputedStyle(element)
          return { color: style.color, gradient: style.backgroundImage, fill: style.webkitTextFillColor }
        })
        expect(paint.gradient).toContain('linear-gradient')
        expect(paint.fill).toBe('rgba(0, 0, 0, 0)')
        expect(paint.color).not.toBe('rgba(0, 0, 0, 0)')
        appearances.push(paint)
        const screenshot = testInfo.outputPath(`running-status-${appearance}.png`)
        // Capture the highlight in the middle of its sweep rather than a random edge pause.
        await streamingText().evaluate(element => {
          ;(element as HTMLElement).style.animationPlayState = 'paused'
          const sweep = element.getAnimations().find(animation => animation instanceof CSSAnimation && animation.animationName === 'message-status-shimmer')
          if (!sweep) throw new Error('Missing running status animation')
          sweep.currentTime = 1200
        })
        try {
          await activeAssistant().screenshot({ path: screenshot })
        } finally {
          await streamingText().evaluate(element => {
            // Restore CSS ownership so later media queries can cancel the animation.
            ;(element as HTMLElement).style.removeProperty('animation-play-state')
          })
        }
        await testInfo.attach(`运行提示 ${appearance}`, { path: screenshot, contentType: 'image/png' })

        await page.emulateMedia({ reducedMotion: 'reduce' })
        await expect(streamingText()).toHaveCSS('animation-name', 'none')
        await expect(streamingText()).toHaveCSS('background-image', 'none')
        await expect(streamingHint().locator('.message__spinner')).toHaveCSS('animation-name', 'none')
        const staticPaint = await streamingText().evaluate(element => {
          const style = getComputedStyle(element)
          return { color: style.color, fill: style.webkitTextFillColor, animations: element.getAnimations().length }
        })
        expect(staticPaint.fill, '减少动态效果时应恢复实际文字填充，不能留下透明文字').toBe(staticPaint.color)
        expect(staticPaint.color).not.toBe('rgba(0, 0, 0, 0)')
        expect(staticPaint.animations).toBe(0)
        await expect(streamingHint()).toHaveText('正在生成回复…')
        await page.emulateMedia({ reducedMotion: 'no-preference' })

        const originalSize = await app!.evaluate(({ BrowserWindow }) => {
          const [width, height] = BrowserWindow.getAllWindows()[0].getSize()
          return { width, height }
        })
        try {
          // Resize the real Electron window; 940px is the application's supported minimum.
          await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(940, 720))
          await expect.poll(() => page.evaluate(() => innerWidth), { message: '应实际进入应用最小窗口宽度' }).toBeLessThanOrEqual(940)
          await expectSingleRunStatusBelowFooter('正在生成回复…')
          await activeAssistant().locator('.turn-usage__trigger').hover()
          await expectSingleRunStatusBelowFooter('正在生成回复…')
          await activeAssistant().locator('.turn-usage__trigger').click()
          await expect(page.getByText('累计输入 Prompt', { exact: true })).toBeVisible()
          await expectCacheStatistics(turnUsageDialog(), '12k', '9k', '3k', '1', '12k')
          await expect(turnUsageDialog().locator('.usage-detail__row--model .usage-detail__value')).toHaveText(modelA)
          await expectSingleRunStatusBelowFooter('正在生成回复…')
          const cacheScreenshot = testInfo.outputPath(`cache-statistics-narrow-${appearance}.png`)
          await turnUsageDialog().screenshot({ path: cacheScreenshot })
          await testInfo.attach(`窄窗口缓存嵌套展示 ${appearance}`, { path: cacheScreenshot, contentType: 'image/png' })
          await page.locator('.chat__input').click()
          const narrowScreenshot = testInfo.outputPath(`running-status-alignment-narrow-${appearance}.png`)
          await activeAssistant().screenshot({ path: narrowScreenshot })
          await testInfo.attach(`窄窗口运行提示对齐 ${appearance}`, { path: narrowScreenshot, contentType: 'image/png' })
          await ring().hover()
          await expectContextCardReadable('12,000', '100,000', '12.0')
          const contextScreenshot = testInfo.outputPath(`context-card-narrow-${appearance}.png`)
          await page.locator('.ctx-card').screenshot({ path: contextScreenshot })
          await testInfo.attach(`窄窗口上下文卡可读性 ${appearance}`, { path: contextScreenshot, contentType: 'image/png' })
          await page.locator('.chat__input').click()
        } finally {
          await app!.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), originalSize)
        }
      }
      expect(appearances[0].color, '深浅主题应分别使用可读的文字颜色').not.toBe(appearances[1].color)
      expect(appearances[0].gradient, '深浅主题的扫光应跟随各自主题令牌').not.toBe(appearances[1].gradient)
    } finally {
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await page.evaluate(value => {
        if (value === null) delete document.documentElement.dataset.appearance
        else document.documentElement.dataset.appearance = value
      }, originalAppearance)
    }
    frame({ usage: { modelId: modelB } }, 4)
    await expect(page.locator('.turn-usage__model').last()).toHaveText(modelB)
    await expectSingleRunStatusBelowFooter('正在生成回复…')
    await expect(ring()).toHaveAttribute('aria-label', /12k \/ 100k/)
    await activeAssistant().locator('.turn-usage__trigger').click()
    await expectCacheStatistics(turnUsageDialog(), '12k', '9k', '3k', '1', '12k')
    frame({ usage: { modelId: modelA, promptTokens: 34000, completionTokens: 2, totalTokens: 34002, currentPromptTokens: 22000, contextWindow: 100000, cacheHitTokens: 28000, cacheMissTokens: 6000 } }, 5)
    await expect(ring()).toHaveAttribute('aria-label', /22k \/ 100k/); await expect(page.locator('.turn-usage__value').last()).toHaveText('34k')
    // Live provider cache counters must update in the open panel without changing the billing total.
    await expectCacheStatistics(turnUsageDialog(), '34k', '28k', '6k', '2', '34k')
    await page.locator('.chat__input').click()
    const firstCompactionAt = Date.now()
    aRun = { ...aRun!, version: 2, seq: 6, updatedAt: Date.now(), compaction: { phase: 'running', startedAt: firstCompactionAt, beforeTokens: 22000 } }
    frame({ run: aRun }, 6)
    await expect(ring()).toHaveAttribute('role', 'img'); await expect(ring()).toHaveAttribute('aria-label', '正在自动压缩上下文')
    await ring().hover(); await expect(page.getByRole('progressbar', { name: '自动压缩上下文' })).toBeVisible()
    await expect(page.getByRole('progressbar', { name: '自动压缩上下文' })).not.toHaveAttribute('aria-valuenow')
    await expect(page.locator('.ctx-card__percent')).toHaveText('压缩中…'); await expect(page.locator('.ctx-card__exact-tokens')).toHaveText('22,000 / 100,000 tokens')
    await expect(page.locator('.message__streaming-hint').last()).toHaveText('正在自动压缩上下文…')
    await expectRunningSweep('正在自动压缩上下文…')
    await expect(page.getByRole('status', { name: '运行状态' }).last()).toHaveText('正在自动压缩上下文…')
    await expect(page.locator('.message--assistant').first()).not.toContainText('正在自动压缩上下文')
    aRun = { ...aRun, version: 3, seq: 7, updatedAt: Date.now(), compaction: { phase: 'succeeded', startedAt: firstCompactionAt, finishedAt: Date.now(), beforeTokens: 22000, afterTokens: 8000 } }
    frame({ run: aRun }, 7)
    await expect(ring()).toHaveAttribute('aria-label', '自动压缩完成（历史估算 22k → 8k）')
    await expect(page.locator('.ctx-card__exact-tokens')).toHaveText('22,000 / 100,000 tokens')
    await expect(page.getByRole('progressbar', { name: '自动压缩上下文' })).toHaveCount(0)
    await expect(page.locator('.message__streaming-hint').last()).toHaveText('正在生成回复…')
    await expectRunningSweep('正在生成回复…')
    const nextCompactionAt = Date.now()
    aRun = { ...aRun, version: 4, seq: 8, updatedAt: Date.now(), compaction: { phase: 'running', startedAt: nextCompactionAt, beforeTokens: 22000 } }
    frame({ run: aRun }, 8); await expect(ring()).toHaveAttribute('aria-label', '正在自动压缩上下文')
    aRun = { ...aRun, version: 5, seq: 9, updatedAt: Date.now(), compaction: { phase: 'failed', startedAt: nextCompactionAt, finishedAt: Date.now(), beforeTokens: 22000, error: 'COMPRESS_PROVIDER_UNAVAILABLE' } }
    frame({ run: aRun }, 9); await expect(ring()).toHaveAttribute('aria-label', '自动压缩失败：COMPRESS_PROVIDER_UNAVAILABLE')
    await expect(page.locator('.ctx-card__status-hint')).toContainText('COMPRESS_PROVIDER_UNAVAILABLE')
    await expect(page.locator('.message__streaming-hint').last()).toHaveText('正在生成回复…')
    await expectRunningSweep('正在生成回复…')
    // Repeated old sequence must not regress the UI even if its snapshot differs.
    frame({ usage: { promptTokens: 12000, totalTokens: 12001, currentPromptTokens: 12000, contextWindow: 100000 } }, 3)
    frame({ usage: { modelId: modelA, promptTokens: 44000, completionTokens: 3, totalTokens: 44003, currentPromptTokens: 10000, contextWindow: 100000, cacheHitTokens: 38000, cacheMissTokens: 6000 } }, 10)
    await expect(ring()).toHaveAttribute('aria-label', /10k \/ 100k/, { timeout: 10000 }); await expect(page.locator('.turn-usage__value').last()).toHaveText('44k')
    await ring().hover(); await expectContextCardReadable('10,000', '100,000', '10.0')
    await expect(page.locator('.ctx-card__header')).toContainText('当前上下文')
    await expect(page.locator('.ctx-card')).toContainText('模型统计或估算')
    await expect(page.locator('.ctx-card')).toContainText('单次请求占用')
    await expect(page.locator('.ctx-card')).toContainText('累计计费用量')
    await expect(page.locator('.ctx-card')).toContainText('生成中')
    await page.screenshot({ path: testInfo.outputPath('context-ring-hover.png') })
    await page.locator('.chat__input').click(); await expect(page.locator('.chat__input')).toBeFocused()
    await expect(page.locator('.ctx-card')).toHaveCount(0)
    aRun = { ...aRun!, status: 'succeeded', version: 6, seq: 11, actualModelId: modelA, updatedAt: Date.now(), finishedAt: Date.now(), pending: [
      { requestId: 'context-answer', kind: 'permission', toolCallId: 'context-tool', toolName: 'write_file', args: { path: 'example.txt' }, description: '确认写入例子文件', status: 'answered', output: 'approved' }
    ] }
    aHistory = [...aHistory, { id: 'context-user', role: 'user', content: 'EXERCISE_CONTEXT_COMPRESSION', conversationId: 'context-turn', createdAt: 10 },
      ...[12000, 22000, 10000].map((promptTokens, index) => ({ id: 'context-segment-' + index, role: 'assistant', content: index === 2 ? 'CONTEXT_LIVE_REPLY' : '', conversationId: 'context-turn', modelId: modelA, createdAt: 11 + index, usage: { promptTokens, completionTokens: 1, totalTokens: promptTokens + 1, currentPromptTokens: promptTokens, contextWindow: 100000, cacheHitTokens: [9000, 19000, 10000][index], cacheMissTokens: [3000, 3000, 0][index] } }))]
    frame({ run: aRun }, 11); heldStream!.end('data: [DONE]\n\n')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    await expect(page.locator('.message__streaming-hint')).toHaveCount(0)
    await expect(page.locator('.message__streaming-text')).toHaveCount(0)
    await expectSingleRunStatusBelowFooter('已完成')
    const confirmation = activeAssistant().locator('.interaction-history')
    const confirmationSummary = confirmation.locator('summary')
    await expect(confirmationSummary).toContainText('确认记录')
    await expect(confirmation).not.toHaveAttribute('open', '')
    await confirmationSummary.focus(); await confirmationSummary.press('Enter')
    await expect(confirmation).toHaveAttribute('open', '')
    await expect(confirmation.locator('.interaction-history__result')).toHaveText('已允许这次操作')
    await expect(confirmation.locator('.pending-card__history-question')).toContainText('确认写入例子文件')
    await expectSingleRunStatusBelowFooter('已完成')
    await confirmationSummary.press('Space')
    await expect(confirmation).not.toHaveAttribute('open', '')
    await expectSingleRunStatusBelowFooter('已完成')
    await page.locator('.chat__input').click()
    const completedScreenshot = testInfo.outputPath('completed-metadata-alignment.png')
    await activeAssistant().locator('.message__meta').screenshot({ path: completedScreenshot })
    await testInfo.attach('完成后的用量、状态与确认记录对齐', { path: completedScreenshot, contentType: 'image/png' })
    await expect(runStatus()).toHaveCSS('animation-name', 'none')
    expect(await runStatus().evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0)
    await page.reload(); await expect(ring()).toHaveAttribute('aria-label', /10k \/ 100k/); await expect(page.locator('.turn-usage__value').last()).toHaveText('44k')
    await page.locator('.turn-usage__trigger').last().click(); await expect(page.getByText('累计输入 Prompt', { exact: true })).toBeVisible()
    await expectCacheStatistics(turnUsageDialog(), '44k', '38k', '6k', '3', '44k')
    await expectSingleRunStatusBelowFooter('已完成'); await page.locator('.chat__input').click()
    await expect(page.locator('.usage-meter__tokens')).toHaveText('52k')
    await page.locator('.usage-meter__trigger').click()
    await expectCacheStatistics(sessionUsageDialog(), '52k', '44k', '8k', '5', '52k')
    await page.locator('.chat__input').click()
    expect(errors).toEqual([])
  })
  test('用量环只展示自动压缩，鼠标和键盘操作无手动请求，切会话及重载恢复状态', async () => {
    aRun = { ...aRun!, status: 'succeeded', version: 7, finishedAt: Date.now(), compaction: { phase: 'running', startedAt: Date.now(), beforeTokens: 40000 } }
    await page.reload(); await expect(ring()).toHaveAttribute('aria-label', '正在自动压缩上下文')
    await expect(page.locator('.message__streaming-hint').last()).toHaveText('正在自动压缩上下文…')
    await expectRunningSweep('正在自动压缩上下文…')
    await expect(page.getByRole('button', { name: /压缩上下文/ })).toHaveCount(0)
    await ring().click(); await ring().press('Enter'); await ring().press('Space')
    await expect(ring()).toHaveAttribute('role', 'img'); await expect(ring()).toHaveCSS('cursor', 'default')
    await ring().press('Escape'); await expect(page.locator('.ctx-card')).toHaveCount(0)
    expect(compressions).toEqual([])
    await selectSession(sessionB); await expect(ring()).toHaveAttribute('aria-label', /16k \/ 64k/)
    await expect(ring()).toHaveAttribute('data-compaction-phase', 'idle')
    await expect(page.locator('.message--assistant')).not.toContainText('正在自动压缩上下文')
    await page.locator('.turn-usage__trigger').last().click()
    await expect(turnUsageDialog()).toBeVisible()
    await expect(turnUsageDialog().locator('.usage-detail--cache')).toHaveCount(0)
    await expect(turnUsageDialog().getByText('缓存命中', { exact: true })).toHaveCount(0)
    await expect(turnUsageDialog().getByText('缓存未命中', { exact: true })).toHaveCount(0)
    await expect(turnUsageDialog().locator('.usage-detail__row').filter({ has: page.getByText('累计输入 Prompt', { exact: true }) }).locator('.usage-detail__value')).toHaveText('16k')
    await expect(turnUsageDialog().locator('.usage-popover__total-value')).toHaveText('16k')
    await page.locator('.chat__input').click()
    await page.locator('.usage-meter__trigger').click()
    await expect(sessionUsageDialog()).toBeVisible()
    await expect(sessionUsageDialog().locator('.usage-detail--cache')).toHaveCount(0)
    await page.locator('.chat__input').click()
    const oldSessionReads = snapshots.filter(id => id === sessionA).length
    aRun = { ...aRun!, status: 'succeeded', version: 8, finishedAt: Date.now(), compaction: { phase: 'succeeded', startedAt: Date.now() - 9000, finishedAt: Date.now() - 7000, beforeTokens: 40000, afterTokens: 8000 } }
    await expect(ring()).toHaveAttribute('aria-label', /16k \/ 64k/); expect(snapshots.filter(id => id === sessionA)).toHaveLength(oldSessionReads)
    await selectSession(sessionA); await expect(ring()).toHaveAttribute('aria-label', /10k \/ 100k/)
    await expect(ring()).toHaveAttribute('data-compaction-phase', 'idle'); expect(compressions).toEqual([]); expect(errors).toEqual([])
  })
  test('自动压缩后的模型输入快照与历史归档独立，恢复更早对话和重开客户端保持一致', async () => {
    aHistory = [...aHistory, { id: 'after-auto-compaction', role: 'assistant', content: 'AUTO_COMPACT_CONTINUATION', conversationId: 'context-turn', modelId: modelA, createdAt: 20,
      usage: { promptTokens: 8000, completionTokens: 1, totalTokens: 8001, currentPromptTokens: 8000, contextWindow: 100000 } }]
    aCompacted = true; await page.reload()
    await expect(ring()).toHaveAttribute('aria-label', /最近一次模型请求 8k \/ 100k/)
    await expect(page.locator('.message--user')).toHaveCount(1); await expect(page.locator('.message--assistant')).toContainText('AUTO_COMPACT_CONTINUATION')
    await expect(page.locator('.message--assistant')).not.toContainText('AUTOMATIC_CONTEXT_SUMMARY')
    await expect(page.locator('.turn-usage__value').last()).toHaveText('52k')
    await page.locator('.chat__load-earlier[data-archive-page="true"]').click()
    await expect(page.locator('.message--user')).toHaveCount(2); await expect(page.locator('.message--user').first()).toContainText('CONTEXT_HISTORY_A')
    await expect(page.locator('.message--assistant').first()).toContainText('INITIAL_A_REPLY')
    await expect(ring()).toHaveAttribute('aria-label', /8k \/ 100k/); await expect(page.locator('.turn-usage__value').last()).toHaveText('52k')
    expect(archiveReads).toEqual([sessionA, sessionA]); expect(compressions).toEqual([])
    await app!.close(); app = await electron.launch({ args: ['.', '--user-data-dir=' + fixture], cwd: root, env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 }); await expect(ring()).toHaveAttribute('aria-label', /8k \/ 100k/)
    await expect(page.locator('.turn-usage__value').last()).toHaveText('52k'); await expect(ring()).toHaveAttribute('data-compaction-phase', 'idle')
    await expect(page.locator('.chat__load-earlier[data-archive-page="true"]')).toBeVisible(); expect(compressions).toEqual([]); expect(errors).toEqual([])
  })
})
