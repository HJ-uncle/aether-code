/** Real Electron + controlled authenticated HTTP: stable hover DOM, rolling digits, continuous progress, reduced motion and themes. No provider calls. */
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'

const root = resolve(__dirname, '..'), token = 'context-motion-fixture-token'
const sessionId = 'context-motion-session', modelId = 'deepseek-v4.1-flash'
let fixture = '', app: ElectronApplication | undefined, page: Page, heldStream: ServerResponse | undefined
let run: RootRun | undefined, sequence = 0, settledBilling = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
const projection: Record<string, unknown>[] = [], errors: string[] = [], requests: string[] = []
const history = [
  { id: 'motion-seed-user', role: 'user', content: 'CONTEXT_MOTION_HISTORY', conversationId: 'motion-seed-turn', createdAt: 1 },
  { id: 'motion-seed-assistant', role: 'assistant', content: 'MOTION_INITIAL_REPLY', conversationId: 'motion-seed-turn', modelId, createdAt: 2,
    usage: { promptTokens: 800, completionTokens: 200, totalTokens: 1000, currentPromptTokens: 14577, contextWindow: 100000 },
    metadata: { contextUsageEstimated: true } }
]
const envelope = (data: unknown) => JSON.stringify({ code: 200, message: 'ok', data })
function frame(payload: Record<string, unknown>) {
  if (!heldStream || heldStream.writableEnded) throw new Error('Missing open motion fixture stream')
  const usage = payload.usage as Record<string, unknown> | undefined
  if (usage && typeof usage.totalTokens === 'number') {
    settledBilling = { promptTokens: typeof usage.promptTokens === 'number' ? usage.promptTokens : settledBilling.promptTokens,
      completionTokens: typeof usage.completionTokens === 'number' ? usage.completionTokens : settledBilling.completionTokens,
      totalTokens: usage.totalTokens }
  }
  projection.push(structuredClone(payload)); sequence++
  heldStream.write('id: context-motion-run:' + sequence + '\ndata: ' + JSON.stringify(payload) + '\n\n')
}
function input(used: number, contextWindow = 100000) {
  // Explicit final confirmation exercises the primary number animation without
  // turning conservative request estimates into confirmed or billed usage.
  frame({ usage: { usageScope: 'turn', modelId, currentPromptTokens: used, contextWindow, contextUsageEstimated: false, contextUsageProvisional: false } })
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
      if (body.sessionId !== sessionId || body.model !== modelId) throw new Error('Wrong motion conversation or model')
      run = { schemaVersion: 1, runId: 'context-motion-run', sessionId, turnId: 'context-motion-turn', userMessageId: 'context-motion-user',
        assistantMessageId: 'context-motion-assistant', seq: 1, version: 1, status: 'running', modelId, pending: [], createdAt: Date.now(), updatedAt: Date.now() }
      heldStream = response; response.writeHead(200, { 'content-type': 'text/event-stream' })
      frame({ run }); frame({ userMessage: { id: run.userMessageId, role: 'user', content: body.message, conversationId: run.turnId, createdAt: run.createdAt } })
      return
    }
    response.setHeader('content-type', 'application/json')
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: 'sha256:' + 'f'.repeat(64), protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'context-motion-fixture' }
      : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 1000000 } }]
      : path === '/api/v1/conversation/sessions' ? [{ sessionId, title: 'CONTEXT_MOTION_HISTORY', lastAt: 2, messageCount: 2 }]
      : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, source: run ? 'live' : 'persisted', sessionId,
        eventId: run ? 'context-motion-run:' + sequence : null, finished: !run || run.status !== 'running', run, runs: run ? [run] : [], history,
        projection, todos: [], changes: [], commandJobs: [], subagentRuns: [],
        sessionUsage: { promptTokens: 800 + settledBilling.promptTokens, completionTokens: 200 + settledBilling.completionTokens, totalTokens: 1000 + settledBilling.totalTokens } }
      : path === '/api/v1/chat/runs' ? { runs: run ? [run] : [] }
      : path === '/api/v1/workspace/directory' ? { root: '/remote/context-motion', entries: [] }
      : []
    response.end(envelope(data))
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})
const card = () => page.getByTestId('context-usage-card')
const number = () => page.getByTestId('context-used-number')
const bar = () => page.getByTestId('context-usage-bar')
const exact = () => page.locator('.ctx-card__exact-tokens')
const billed = () => page.locator('.turn-usage__value').last()
const lifetime = () => page.locator('.usage-meter__tokens')

interface MotionFrame {
  time: number; visible: boolean; sameNode: boolean; left: number; top: number; right: number; bottom: number
  viewportWidth: number; viewportHeight: number; opacity: number; styleLeft: number; styleTop: number
  anchorTop: number; anchorBottom: number; value: number | null; numberMotion: string | null; reduced: string | null
  barMotion: string | null; ratio: number | null; gain: boolean; fillWidth: number; trackWidth: number
  reelY: number[]; reelUnit: number[]; reelScopes: string[]
}
interface MotionProbe {
  root: HTMLElement | null; lastNode: HTMLElement | null; removed: number; replacements: number; missing: number
  frames: MotionFrame[]; observer: MutationObserver; raf: number
}
interface ProbeResult { removed: number; replacements: number; missing: number; frames: MotionFrame[] }

/** Observe DOM lifetime and every rendered animation frame, rather than only the eventual text. */
async function startProbe() {
  await page.evaluate(() => {
    const host = window as unknown as { __aetherContextMotionProbe?: MotionProbe }
    const previous = host.__aetherContextMotionProbe
    if (previous) { previous.observer.disconnect(); cancelAnimationFrame(previous.raf) }
    const probe: MotionProbe = { root: null, lastNode: null, removed: 0, replacements: 0, missing: 0,
      frames: [], observer: new MutationObserver(() => {}), raf: 0 }
    const sample = () => {
      const node = document.querySelector<HTMLElement>('[data-testid="context-usage-card"]')
      if (!node) { if (probe.root) probe.missing++; return }
      if (!probe.root) probe.root = node
      if (node !== probe.lastNode && probe.lastNode) probe.replacements++
      probe.lastNode = node
      const rect = node.getBoundingClientRect(), css = getComputedStyle(node)
      const trigger = document.querySelector('.context-ring')?.getBoundingClientRect()
      const used = node.querySelector<HTMLElement>('[data-testid="context-used-number"]')
      const progress = node.querySelector<HTMLElement>('[data-testid="context-usage-bar"]')
      const fill = node.querySelector<HTMLElement>('.ctx-card__bar-fill')
      const track = node.querySelector<HTMLElement>('.ctx-card__bar')
      const reels = Array.from(node.querySelectorAll<HTMLElement>('.ctx-number__reel'))
      probe.frames.push({ time: performance.now(), visible: css.visibility !== 'hidden' && css.display !== 'none' && Number(css.opacity) > 0.05 && rect.width > 0,
        sameNode: node === probe.root, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        viewportWidth: innerWidth, viewportHeight: innerHeight, opacity: Number(css.opacity), styleLeft: parseFloat(css.left), styleTop: parseFloat(css.top),
        anchorTop: trigger?.top ?? -1, anchorBottom: trigger?.bottom ?? -1,
        value: used?.dataset.value === undefined ? null : Number(used.dataset.value), numberMotion: used?.dataset.motion ?? null,
        reduced: used?.dataset.reducedMotion ?? node.dataset.reducedMotion ?? null,
        barMotion: progress?.dataset.motion ?? null, ratio: progress?.dataset.ratio === undefined ? null : Number(progress.dataset.ratio),
        gain: node.querySelector('.ctx-card__bar-gain')?.getAttribute('data-active') === 'true',
        fillWidth: fill?.getBoundingClientRect().width ?? -1, trackWidth: track?.getBoundingClientRect().width ?? -1,
        reelY: reels.map(reel => { const transform = getComputedStyle(reel).transform; return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42 }),
        reelUnit: reels.map(reel => parseFloat(getComputedStyle(reel).fontSize)),
        reelScopes: reels.map(reel => {
          const owner = reel.closest<HTMLElement>('.ctx-number')
          return (owner?.dataset.testid ?? 'unknown') + ':' + (owner ? Array.from(owner.querySelectorAll('.ctx-number__reel')).indexOf(reel) : -1)
        }) })
    }
    probe.observer.disconnect()
    probe.observer = new MutationObserver(records => {
      if (probe.root) for (const record of records) for (const removed of Array.from(record.removedNodes)) {
        if (removed === probe.root || (removed instanceof Element && removed.contains(probe.root))) probe.removed++
      }
      sample()
    })
    probe.observer.observe(document.body, { childList: true, subtree: true, attributes: true })
    const tick = () => { sample(); probe.raf = requestAnimationFrame(tick) }
    host.__aetherContextMotionProbe = probe
    tick()
  })
}
async function readProbe(stop = false): Promise<ProbeResult> {
  return page.evaluate(stop => {
    const probe = (window as unknown as { __aetherContextMotionProbe?: MotionProbe }).__aetherContextMotionProbe
    if (!probe) throw new Error('Missing context motion frame probe')
    if (stop) { probe.observer.disconnect(); cancelAnimationFrame(probe.raf) }
    return { removed: probe.removed, replacements: probe.replacements, missing: probe.missing, frames: probe.frames }
  }, stop)
}
function assertStable(result: ProbeResult) {
  const visible = result.frames.filter(frame => frame.visible)
  expect(visible.length).toBeGreaterThan(3)
  expect(result.removed).toBe(0); expect(result.replacements).toBe(0); expect(result.missing).toBe(0)
  expect(visible.every(frame => frame.sameNode)).toBe(true)
  expect(visible.every(frame => Number.isFinite(frame.styleLeft) && Number.isFinite(frame.styleTop) && frame.styleLeft > 0 && frame.styleTop > 0)).toBe(true)
  expect(visible.every(frame => frame.left >= 7 && frame.top >= 7 && frame.right <= frame.viewportWidth - 7 && frame.bottom <= frame.viewportHeight - 7)).toBe(true)
  expect(visible.every(frame => frame.bottom <= frame.anchorTop - 4 || frame.top >= frame.anchorBottom + 4)).toBe(true)
  expect(Math.max(...visible.map(frame => frame.left)) - Math.min(...visible.map(frame => frame.left))).toBeLessThanOrEqual(1)
  expect(visible.every(frame => frame.opacity >= 0.95)).toBe(true)
}
function reelDeltas(frames: MotionFrame[], value: number, motion: 'up' | 'down') {
  const moving = frames.filter(frame => frame.visible && frame.value === value && frame.numberMotion === motion)
  const deltas: number[] = []
  for (let index = 1; index < moving.length; index++) {
    const before = moving[index - 1], after = moving[index]
    if (before.reelY.length !== after.reelY.length) continue
    for (let digit = 0; digit < after.reelY.length; digit++) {
      const delta = after.reelY[digit] - before.reelY[digit]
      // Repeated reels normalize by whole cycles at settlement. This jump is visually identical, not scrolling backwards.
      if (Math.abs(delta) > 0.02 && Math.abs(delta) < (after.reelUnit[digit] || 12) * 5) deltas.push(delta)
    }
  }
  return deltas
}
function motionSteps(frames: MotionFrame[], value: number, motion: 'up' | 'down') {
  const moving = frames.filter(frame => frame.visible && frame.value === value && frame.numberMotion === motion)
  const steps: Array<Record<string, number | string | boolean>> = []
  for (let index = 1; index < moving.length; index++) {
    const before = moving[index - 1], after = moving[index]
    if (before.reelY.length !== after.reelY.length) continue
    for (let digit = 0; digit < after.reelY.length; digit++) {
      const delta = after.reelY[digit] - before.reelY[digit]
      const unit = after.reelUnit[digit] || 12, cycle = unit * 10
      steps.push({ value, motion, beforeTime: before.time, afterTime: after.time, digit,
        scopeBefore: before.reelScopes[digit], scopeAfter: after.reelScopes[digit],
        beforeY: before.reelY[digit], afterY: after.reelY[digit], rawDelta: delta,
        beforeUnit: before.reelUnit[digit], afterUnit: after.reelUnit[digit],
        includedByOriginalFilter: Math.abs(delta) > 0.02 && Math.abs(delta) < unit * 5,
        nearestCycle: Math.round(delta / cycle), cycleResidual: delta - Math.round(delta / cycle) * cycle })
    }
  }
  return steps
}
async function attachProbe(testInfo: TestInfo, label: string, result: ProbeResult, details: Record<string, unknown> = {}) {
  const artifact = testInfo.outputPath('context-motion-' + label + '-probe.json')
  writeFileSync(artifact, JSON.stringify({ schemaVersion: 1, label, ...result, ...details }, null, 2))
  await testInfo.attach(label + ' frame evidence', { path: artifact, contentType: 'application/json' })
}
async function showCard() { await page.locator('.context-ring').hover(); await expect(card()).toBeVisible() }
async function settled(used: number, limit = 100000) {
  await expect(number()).toHaveAttribute('data-value', String(used))
  await expect(number()).toHaveAttribute('data-motion', 'idle')
  await expect(exact()).toHaveText(used.toLocaleString('en-US') + ' / ' + limit.toLocaleString('en-US') + ' tokens')
  await expect.poll(async () => Number(await bar().getAttribute('data-ratio'))).toBe(Math.min(1, used / limit))
  await expect(bar()).toHaveAttribute('data-motion', 'idle')
  const geometry = await card().evaluate(node => {
    const fill = node.querySelector('.ctx-card__bar-fill'), track = node.querySelector('.ctx-card__bar')
    if (!fill || !track) throw new Error('Missing context progress geometry')
    return { fill: fill.getBoundingClientRect().width, track: track.getBoundingClientRect().width }
  })
  expect(geometry.track).toBeGreaterThan(100)
  expect(geometry.fill / geometry.track).toBeCloseTo(Math.min(1, used / limit), 3)
}

test.describe.serial('上下文 tooltip 连续动效与生命周期', () => {
  test.beforeAll(async () => {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true }); fixture = mkdtempSync(join(root, '.e2e-tmp', 'context-motion-ui-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: 'http://127.0.0.1:' + address.port,
      autoStartEngine: true, lastSessionId: '', thinkingMode: 'off', appearance: 'system' }))
    app = await electron.launch({ args: ['.', '--user-data-dir=' + fixture], cwd: root,
      env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
    await page.getByRole('button', { name: '会话历史', exact: true }).click()
    await page.locator('.history-view__item[data-session-id="' + sessionId + '"]').click()
    await expect(page.locator('.message--user').first()).toContainText('CONTEXT_MOTION_HISTORY')
    await expect(page.locator('.model-picker__trigger')).toBeEnabled()
  })
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus && page && !page.isClosed()) {
      const result = await readProbe(true).catch(() => null)
      if (result) await attachProbe(testInfo, 'failure', result)
    }
  })
  test.afterAll(async () => {
    if (page && !page.isClosed()) await readProbe(true).catch(() => undefined)
    heldStream?.destroy(); await app?.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (!fixture) return
    const absolute = resolve(fixture)
    if (dirname(absolute) !== join(root, '.e2e-tmp') || !basename(absolute).startsWith('context-motion-ui-')) throw new Error('Unsafe context motion fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  test('持续悬停不卸载或闪到原点；增长数字上滚与经验高光，缩减下滚且账目隔离', async ({}, testInfo) => {
    await page.locator('.chat__input').fill('EXERCISE_CONTEXT_MOTION')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => Boolean(heldStream)).toBe(true)
    await startProbe(); await showCard(); await settled(14577)
    const initial = await card().locator('.ctx-card__bar-fill').evaluate(node => node.getBoundingClientRect().width)
    input(42900)
    await expect.poll(async () => (await readProbe()).frames.filter(frame => frame.value === 42900 && frame.numberMotion === 'up' && frame.barMotion === 'grow' && frame.gain).length).toBeGreaterThan(2)
    await settled(42900)
    const growth = await readProbe(), growing = growth.frames.filter(frame => frame.value === 42900 && frame.barMotion === 'grow')
    const upward = reelDeltas(growth.frames, 42900, 'up')
    expect(upward.length).toBeGreaterThan(0); expect(upward.every(delta => delta < 0)).toBe(true)
    expect(growing.some(frame => frame.fillWidth > initial + 0.1 && frame.fillWidth < frame.trackWidth * 0.429 - 0.1)).toBe(true)
    expect(Math.min(...growing.map(frame => frame.fillWidth))).toBeGreaterThanOrEqual(initial - 0.1)
    await expect(page.locator('.ctx-card__source-hint')).toContainText('最近确认的模型请求的输入（模型统计）')
    await expect(lifetime()).toHaveText('1k')
    input(39000)
    await expect.poll(async () => (await readProbe()).frames.filter(frame => frame.value === 39000 && frame.numberMotion === 'down' && frame.barMotion === 'shrink').length).toBeGreaterThan(2)
    await settled(39000)
    const shrinking = await readProbe(), downward = reelDeltas(shrinking.frames, 39000, 'down')
    await attachProbe(testInfo, 'growth-shrink', shrinking, { upward, downward,
      upwardSteps: motionSteps(shrinking.frames, 42900, 'up'), downwardSteps: motionSteps(shrinking.frames, 39000, 'down') })
    expect(downward.length).toBeGreaterThan(0); expect(downward.every(delta => delta > 0)).toBe(true)
    const shrinkFrames = shrinking.frames.filter(frame => frame.value === 39000 && frame.barMotion === 'shrink')
    expect(shrinkFrames.some(frame => frame.gain)).toBe(false)
    expect(Math.max(...shrinkFrames.map(frame => frame.fillWidth))).toBeLessThanOrEqual(shrinkFrames[0].fillWidth + 0.1)
    await expect(page.locator('.context-ring')).toHaveAttribute('data-context-source', 'reported')
    await expect(lifetime()).toHaveText('1k')
    frame({ usage: { usageScope: 'turn', modelId, currentPromptTokens: 39000, contextWindow: 100000, contextUsageEstimated: false,
      promptTokens: 42000, completionTokens: 100, totalTokens: 42100 } })
    await expect(billed()).toHaveText('42.1k'); await expect(lifetime()).toHaveText('43.1k')
    assertStable(await readProbe(true))
    await page.locator('.chat__input').click(); await expect(page.locator('.chat__input')).toBeFocused(); await expect(card()).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('快速重入从当前可见状态续转，最终精确整数与进度稳定；hover不丢失且不增加账目', async () => {
    await startProbe(); await showCard()
    for (const value of [64000, 18000, 97000, 47001] as const) {
      input(value)
      await expect(number()).toHaveAttribute('data-value', String(value))
      await expect.poll(async () => (await readProbe()).frames.filter(frame => frame.value === value && frame.numberMotion !== 'idle').length).toBeGreaterThan(0)
    }
    await settled(47001)
    const result = await readProbe(true)
    assertStable(result)
    expect(new Set(result.frames.filter(frame => frame.value !== null).map(frame => frame.value))).toEqual(new Set([39000, 64000, 18000, 97000, 47001]))
    for (const value of [64000, 18000, 97000, 47001]) {
      const first = result.frames.findIndex(frame => frame.value === value)
      expect(first).toBeGreaterThan(0)
      // A new target starts at the last rendered width, rather than snapping to an obsolete target or zero.
      expect(Math.abs(result.frames[first].fillWidth - result.frames[first - 1].fillWidth)).toBeLessThanOrEqual(2)
    }
    await expect(number()).toHaveAttribute('aria-label', '47,001')
    await expect(page.getByTestId('context-percent-number')).toHaveAttribute('data-value', '47')
    await expect(billed()).toHaveText('42.1k'); await expect(lifetime()).toHaveText('43.1k')
    await page.locator('.chat__input').click(); await expect(page.locator('.chat__input')).toBeFocused(); await expect(card()).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('动态减少动画立即静态显示0及1M，进度保持精确且没有增长高光', async () => {
    await startProbe(); await showCard()
    input(65000)
    await expect.poll(async () => (await readProbe()).frames.filter(frame => frame.value === 65000 && frame.numberMotion === 'up' && frame.barMotion === 'grow').length).toBeGreaterThan(0)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(number()).toHaveAttribute('data-reduced-motion', 'true')
    await settled(65000)
    await expect.poll(async () => (await readProbe()).frames.filter(frame => frame.value === 65000 && frame.reduced === 'true'
      && frame.numberMotion === 'idle' && frame.barMotion === 'idle' && !frame.gain).length).toBeGreaterThan(0)
    input(0, 1000000); await settled(0, 1000000)
    await expect(number()).toHaveAttribute('aria-label', '0')
    input(1000000, 1000000); await settled(1000000, 1000000)
    await expect(number()).toHaveAttribute('aria-label', '1,000,000')
    const result = await readProbe(true)
    assertStable(result)
    const reducedFrames = result.frames.filter(frame => frame.reduced === 'true' && (frame.value === 0 || frame.value === 1000000))
    expect(reducedFrames.some(frame => frame.value === 0)).toBe(true)
    expect(reducedFrames.some(frame => frame.value === 1000000)).toBe(true)
    expect(reducedFrames.every(frame => frame.numberMotion === 'idle' && frame.barMotion === 'idle' && !frame.gain)).toBe(true)
    expect(reducedFrames.every(frame => Math.abs(frame.fillWidth / frame.trackWidth - (frame.value === 0 ? 0 : 1)) < 0.002)).toBe(true)
    await expect(billed()).toHaveText('42.1k'); await expect(lifetime()).toHaveText('43.1k')
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' }); await expect(number()).toHaveAttribute('data-reduced-motion', 'false')
    await page.locator('.chat__input').click(); await expect(card()).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('系统明暗切换保持同一tooltip及清晰材质，精确小进度与定位兼容', async ({}, testInfo) => {
    input(14577, 1000000)
    await expect(page.locator('.context-ring')).toHaveAttribute('aria-label', /14,577 \/ 1,000,000 tokens/)
    await startProbe(); await showCard(); await settled(14577, 1000000)
    await expect(page.getByTestId('context-percent-number')).toHaveAttribute('data-value', '1.5')
    const colors: string[] = []
    for (const appearance of ['light', 'dark'] as const) {
      // Exercise useTheme's live system preference listener while hover remains on the same DOM node.
      await page.emulateMedia({ colorScheme: appearance })
      await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
      await expect(card()).toBeVisible()
      colors.push(await card().evaluate(node => getComputedStyle(node).backgroundColor))
      await settled(14577, 1000000)
      const screenshot = testInfo.outputPath('context-motion-' + appearance + '.png')
      await card().screenshot({ path: screenshot }); await testInfo.attach(appearance + ' context tooltip', { path: screenshot, contentType: 'image/png' })
    }
    expect(colors[0]).not.toBe(colors[1])
    assertStable(await readProbe(true))
    await expect(billed()).toHaveText('42.1k'); await expect(lifetime()).toHaveText('43.1k')
    await page.locator('.chat__input').click(); await expect(page.locator('.chat__input')).toBeFocused(); await expect(card()).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('同尺寸工具栏移动及锚点增宽时同一tooltip跟随定位，不重挂或覆盖输入', async ({}, testInfo) => {
    await startProbe(); await showCard(); await settled(14577, 1000000)
    const geometry = async () => card().evaluate(node => {
      const trigger = document.querySelector('.context-ring')
      if (!trigger) throw new Error('Missing live context anchor')
      const anchor = trigger.getBoundingClientRect(), rect = node.getBoundingClientRect()
      return { left: rect.left, top: rect.top, bottom: rect.bottom, center: rect.left + rect.width / 2,
        anchorTop: anchor.top, anchorCenter: anchor.left + anchor.width / 2, anchorWidth: anchor.width }
    })
    const before = await geometry()
    await page.locator('.context-ring').evaluate(node => {
      const toolbar = node.parentElement
      if (!toolbar) throw new Error('Missing context toolbar')
      toolbar.dataset.contextMotionTestTransform = toolbar.style.transform
      toolbar.style.transform = 'translate(-8px, -8px)'
    })
    try {
      await expect.poll(async () => Math.abs((await geometry()).anchorTop - before.anchorTop + 8)).toBeLessThan(0.2)
      await expect.poll(async () => Math.abs((await geometry()).top - before.top + 8)).toBeLessThan(0.2)
      await expect.poll(async () => { const rect = await geometry(); return Math.abs(rect.center - rect.anchorCenter) }).toBeLessThan(1)
      await page.locator('.context-ring').evaluate(node => { (node as HTMLElement).style.width = '34px' })
      await expect.poll(async () => (await geometry()).anchorWidth).toBeGreaterThan(before.anchorWidth + 4)
      await expect.poll(async () => { const rect = await geometry(); return Math.abs(rect.center - rect.anchorCenter) }).toBeLessThan(1)
      await expect.poll(async () => { const rect = await geometry(); return Math.abs(rect.bottom - rect.anchorTop + 8) }).toBeLessThan(1)
      await expect(card()).toBeVisible()
      const result = await readProbe(true)
      await attachProbe(testInfo, 'live-anchor', result)
      expect(result.removed).toBe(0); expect(result.replacements).toBe(0); expect(result.missing).toBe(0)
      const visible = result.frames.filter(frame => frame.visible)
      expect(visible.length).toBeGreaterThan(3)
      expect(visible.every(frame => frame.sameNode && frame.opacity >= 0.95 && frame.styleLeft > 0 && frame.styleTop > 0)).toBe(true)
      expect(visible.every(frame => frame.left >= 7 && frame.top >= 7 && frame.right <= frame.viewportWidth - 7 && frame.bottom <= frame.viewportHeight - 7)).toBe(true)
      await expect(billed()).toHaveText('42.1k'); await expect(lifetime()).toHaveText('43.1k')
    } finally {
      await page.locator('.context-ring').evaluate(node => {
        const toolbar = node.parentElement
        if (toolbar) { toolbar.style.transform = toolbar.dataset.contextMotionTestTransform ?? ''; delete toolbar.dataset.contextMotionTestTransform }
        ;(node as HTMLElement).style.removeProperty('width')
      })
    }
    await page.locator('.chat__input').click(); await expect(page.locator('.chat__input')).toBeFocused(); await expect(card()).toHaveCount(0)
    expect(errors).toEqual([])
  })
  test('动效与主题更新后流正常结束且没有额外对话或账目漂移', async () => {
    run = { ...run!, status: 'succeeded', version: 2, updatedAt: Date.now(), finishedAt: Date.now() }
    frame({ run }); heldStream!.end('data: [DONE]\n\n')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    await expect(billed()).toHaveText('42.1k'); await expect(lifetime()).toHaveText('43.1k')
    expect(requests.filter(request => request === 'POST /api/v1/chat')).toHaveLength(1)
    expect(errors).toEqual([])
  })
})
