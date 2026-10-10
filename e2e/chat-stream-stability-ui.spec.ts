/** Real Electron + authenticated held remote SSE: painted streaming frames stay at
 * the bottom, sealed Markdown nodes survive appends, user history reading is not
 * pulled away, late image layout is followed without another engine frame, and
 * new streamed text fades without replaying old text or accumulating wrappers. */
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootRun } from '../src/shared/root-run'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'chat-stream-stability-token', sessionId = 'chat-stream-stability-session', modelId = 'stream-stability-model'
const sealedText = 'STREAM_SEALED_PARAGRAPH：这段已经完成的正文在后续流式输出中必须保留原来的节点。'
let fixture = '', remoteUrl = '', app: ElectronApplication | undefined, page: Page
let heldStream: ServerResponse | undefined, run: RootRun | undefined, runNumber = 0, sequence = 0, runContent = '', runPrompt = ''
const errors: string[] = []
// The renderer CSP allows data images. Swapping an already loaded placeholder's
// source exercises genuine browser decode/size events without bypassing that CSP.
const placeholderImage = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="lightsteelblue"/></svg>').toString('base64')}`
const decodedImage = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="lightsteelblue"/></svg>').toString('base64')}`
let history: EngineHistoryRow[] = [
  { id: 'seed-user', role: 'user', content: 'STREAM_HISTORY_START', conversationId: 'seed-turn', createdAt: 1 },
  { id: 'seed-assistant', role: 'assistant', conversationId: 'seed-turn', createdAt: 2,
    content: Array.from({ length: 30 }, (_, index) => `HISTORY_ANCHOR_${index + 1}：已完成的历史段落。用户向上阅读时，新回复不能将这一段拉走。`).join('\n\n'),
    modelId, usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100, currentPromptTokens: 1000, contextWindow: 100000 } }
]
const envelope = (data: unknown) => JSON.stringify({ code: 200, message: 'ok', data })
function frame(payload: Record<string, unknown>): void {
  if (!heldStream || heldStream.writableEnded || !run) throw new Error('Missing open stability fixture stream')
  if (typeof payload.content === 'string') runContent += payload.content
  heldStream.write(`id: ${run.runId}:${++sequence}\ndata: ${JSON.stringify(payload)}\n\n`)
}
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
    if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) {
      response.writeHead(401, { 'content-type': 'application/json' }).end(envelope(null)); return
    }
    let raw = ''; for await (const chunk of request) raw += chunk.toString()
    if (path === '/api/v1/chat' && request.method === 'POST') {
      const body = JSON.parse(raw) as { content?: string; message?: string }
      runPrompt = body.content ?? body.message ?? 'STREAM_REQUEST'
      heldStream = response; runContent = ''; sequence = 0; runNumber += 1
      run = { schemaVersion: 1, runId: `stability-run-${runNumber}`, sessionId, turnId: `stability-turn-${runNumber}`,
        userMessageId: `stability-user-${runNumber}`, assistantMessageId: `stability-assistant-${runNumber}`,
        seq: 1, version: 1, status: 'running', modelId, createdAt: Date.now(), updatedAt: Date.now(), pending: [] }
      response.writeHead(200, { 'content-type': 'text/event-stream' }); frame({ run });
      frame({ usage: { modelId, promptTokens: 1000, completionTokens: 1, totalTokens: 1001, currentPromptTokens: 1000, contextWindow: 100000 } }); return
    }
    response.setHeader('content-type', 'application/json')
    const data = path === '/health' ? { status: 'ok' }
      : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'a'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'chat-stream-stability-fixture' }
      : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: modelId, isEnabled: true, capabilities: { toolCalling: true, contextWindow: 100000 } }]
      : path === '/api/v1/conversation/sessions' ? [{ sessionId, title: 'STREAM_HISTORY_START', lastAt: 2, messageCount: history.length }]
      : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, source: 'persisted', sessionId, eventId: null, finished: true,
          projection: [], run, runs: run ? [run] : [], history, todos: [], changes: [], commandJobs: [] }
      : path === '/api/v1/chat/runs' ? { runs: [] }
      : path === '/api/v1/workspace/directory' ? { root: '/remote/stream-stability', entries: [] }
      : []
    response.end(envelope(data))
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})

type Sample = { time: number; phase: 'animation-frame' | 'resize'; top: number; height: number; gap: number; statusTop: number; statusBottom: number; anchorTop: number; anchorConnected: boolean; width: number }
type Probe = { samples: Sample[]; frame: number; observer: MutationObserver; resizeObserver: ResizeObserver; removed: number; stop: () => void }
type ProbeWindow = Window & { __streamStabilityProbe?: Probe }
type FadeEvent = { kind: 'start' | 'end'; time: number; text: string; opacity: number; duration: string; appearance: string; protected: string[] }
type FadeSample = { text: string; opacity: number; animation: string; appearance: string }
type GraphemeSample = { time: number; cluster: string; parts: { text: string; animated: boolean }[] }
type FadeProbe = { events: FadeEvent[]; samples: FadeSample[]; protectedSamples: { marker: string; opacity: number }[];
  protectedMarkers: string[]; graphemeClusters: string[]; graphemeSamples: GraphemeSample[];
  observer: MutationObserver; frame: number; stop: () => void }
type FadeWindow = Window & { __streamFadeProbe?: FadeProbe; __historyFadeStarts?: string[] }
const assistant = () => page.locator('.message--assistant').last()
const region = () => page.locator('.chat__messages')
async function bottomGap(): Promise<number> {
  return region().evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)
}
async function startRun(prompt: string, initialContent = `${sealedText}\n\n正在逐段输出。`): Promise<void> {
  const previous = runNumber
  await page.locator('.chat__input').fill(prompt); await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => runNumber).toBe(previous + 1)
  frame({ content: initialContent })
  await expect(assistant()).toContainText(sealedText)
  await expect(assistant().getByRole('status', { name: '运行状态', exact: true })).toHaveText('正在生成回复…')
  await expect(assistant().locator('.message__footer')).toBeVisible()
  await expect.poll(bottomGap).toBeLessThanOrEqual(2)
  expect(await region().evaluate(element => element.scrollHeight - element.clientHeight), '夹具必须已形成实际纵向滚动').toBeGreaterThan(300)
}
async function completeRun(): Promise<void> {
  if (!run || !heldStream || heldStream.writableEnded) return
  run = { ...run, status: 'succeeded', version: run.version + 1, seq: sequence + 1, updatedAt: Date.now(), finishedAt: Date.now() }
  history = [...history,
    { id: run.userMessageId, role: 'user', content: runPrompt, conversationId: run.turnId, createdAt: Date.now() },
    { id: run.assistantMessageId, role: 'assistant', content: runContent, conversationId: run.turnId, modelId, createdAt: Date.now() + 1 }]
  frame({ run }); heldStream.end('data: [DONE]\n\n')
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
}
async function startProbe(anchorText = sealedText): Promise<void> {
  await page.evaluate(anchorText => {
    const target = window as ProbeWindow; target.__streamStabilityProbe?.stop()
    const scroll = document.querySelector('.chat__messages')
    if (!(scroll instanceof HTMLElement)) throw new Error('Missing scroll region')
    const paragraphs = [...scroll.querySelectorAll('.md p')]
    const anchor = paragraphs.findLast(element => element.textContent?.includes(anchorText))
    if (!anchor) throw new Error('Missing sealed Markdown anchor: ' + anchorText)
    const active = scroll.querySelectorAll('.message--assistant'); const message = active[active.length - 1]
    const status = message?.querySelector('[role="status"][aria-label="运行状态"]')
    if (!status) throw new Error('Missing running status')
    const probe: Probe = { samples: [], frame: 0, removed: 0, observer: new MutationObserver(records => {
      for (const record of records) {
        for (const removed of record.removedNodes) {
          if (removed === anchor || removed.contains(anchor)) probe.removed += 1
          if (record.target === scroll && removed instanceof Element) probe.resizeObserver.unobserve(removed)
        }
        if (record.target === scroll) for (const added of record.addedNodes) {
          if (added instanceof Element) probe.resizeObserver.observe(added)
        }
      }
    }), resizeObserver: new ResizeObserver(() => record(performance.now(), 'resize')),
    stop: () => { cancelAnimationFrame(probe.frame); probe.observer.disconnect(); probe.resizeObserver.disconnect() } }
    probe.observer.observe(scroll, { childList: true, subtree: true })
    const record = (time: number, phase: Sample['phase']): void => {
      const box = status.getBoundingClientRect()
      probe.samples.push({ time, phase, top: scroll.scrollTop, height: scroll.scrollHeight,
        gap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
        statusTop: box.top, statusBottom: box.bottom, anchorTop: anchor.getBoundingClientRect().top,
        anchorConnected: anchor.isConnected, width: scroll.clientWidth })
    }
    const sample = (time: number): void => {
      record(time, 'animation-frame')
      probe.frame = requestAnimationFrame(sample)
    }
    // A rendering cycle delivers rAF, then layout/ResizeObserver, then paint.
    // Image decode can therefore expose its new height to rAF before the app's
    // observer pins it in that same cycle. This later-created observer records
    // the layout phase after the app's observer, retaining the raw rAF samples.
    // Without the app's observer, resize samples still expose the persistent gap.
    probe.resizeObserver.observe(scroll)
    for (const child of scroll.children) probe.resizeObserver.observe(child)
    target.__streamStabilityProbe = probe; probe.frame = requestAnimationFrame(sample)
  }, anchorText)
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__streamStabilityProbe?.samples.filter(sample => sample.phase === 'animation-frame').length ?? 0),
    { message: '布局变化前先采集正常绘制帧，确保诊断不会是空集合' }).toBeGreaterThanOrEqual(2)
}
async function stopProbe(testInfo: TestInfo, name: string): Promise<{ samples: Sample[]; removed: number }> {
  const data = await page.evaluate(() => {
    const target = window as ProbeWindow, probe = target.__streamStabilityProbe
    if (!probe) throw new Error('Missing frame probe')
    probe.stop(); delete target.__streamStabilityProbe; return { samples: probe.samples, removed: probe.removed }
  })
  const range = (values: number[]) => Math.max(...values) - Math.min(...values)
  const animationFrames = data.samples.filter(sample => sample.phase === 'animation-frame')
  const resizeFrames = data.samples.filter(sample => sample.phase === 'resize')
  const summary = { frames: animationFrames.length, resizeSamples: resizeFrames.length, removed: data.removed,
    maxBottomGap: Math.max(...data.samples.map(sample => sample.gap)),
    maxAnimationFrameBottomGap: Math.max(...animationFrames.map(sample => sample.gap)),
    maxResizeBottomGap: resizeFrames.length ? Math.max(...resizeFrames.map(sample => sample.gap)) : null,
    statusBottomRange: range(data.samples.map(sample => sample.statusBottom)),
    anchorTopRange: range(data.samples.map(sample => sample.anchorTop)),
    scrollTopRange: range(data.samples.map(sample => sample.top)),
    widthRange: range(data.samples.map(sample => sample.width)),
    largestHeightDrop: Math.max(0, ...data.samples.slice(1).map((sample, index) => data.samples[index].height - sample.height)) }
  await testInfo.attach(name, { body: JSON.stringify({ summary, ...data }, null, 2), contentType: 'application/json' })
  console.log(`${name}: ${JSON.stringify(summary)}`)
  return data
}
async function append(content: string, marker: string): Promise<void> {
  frame({ content }); await expect(assistant()).toContainText(marker)
}
function expectFollowing(allSamples: Sample[]): void {
  const samples = allSamples.filter(sample => sample.phase === 'animation-frame')
  expect(samples.length, '必须覆盖多个实际绘制帧，而不是只检查最终状态').toBeGreaterThan(15)
  expect(Math.max(...samples.map(sample => sample.gap)), '持续流式输出的任何绘制帧都不能留下底部空隙').toBeLessThanOrEqual(2)
  const bottoms = samples.map(sample => sample.statusBottom)
  expect(Math.max(...bottoms) - Math.min(...bottoms), '吸底时状态栏应保持在相同视口位置，不能先跳下再跳回').toBeLessThanOrEqual(2)
  expect(samples.every(sample => sample.anchorConnected), '已完成的正文节点不应被卸载').toBe(true)
}
async function scrollToHistory(): Promise<void> {
  const box = await region().boundingBox(); if (!box) throw new Error('Missing scroll region box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -600)
  await expect.poll(bottomGap).toBeGreaterThan(200)
  await region().evaluate(scroll => {
    const anchor = [...scroll.querySelectorAll('.md p')].find(element => element.textContent?.includes('HISTORY_ANCHOR_12：'))
    if (!anchor) throw new Error('Missing old history anchor')
    scroll.scrollTop += anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 100
  })
  await expect.poll(bottomGap).toBeGreaterThan(300)
}
async function releaseImage(alt: string): Promise<void> {
  const image = assistant().getByAltText(alt, { exact: true })
  await image.evaluate((element, source) => { (element as HTMLImageElement).src = source }, decodedImage)
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalHeight)).toBe(360)
}

async function startFadeProbe(protectedMarkers: string[]): Promise<void> {
  await page.evaluate(protectedMarkers => {
    const target = window as FadeWindow; target.__streamFadeProbe?.stop()
    const scroll = document.querySelector('.chat__messages')
    if (!scroll) throw new Error('Missing streaming fade region')
    const onAnimation = (event: Event): void => {
      const element = event.target
      if (!(element instanceof Element) || !element.classList.contains('md-stream-chunk')) return
      const style = getComputedStyle(element)
      const text = element.textContent ?? ''
      probe.events.push({ kind: event.type === 'animationstart' ? 'start' : 'end', time: performance.now(), text,
        opacity: Number(style.opacity), duration: style.animationDuration, appearance: document.documentElement.dataset.appearance ?? '',
        protected: probe.protectedMarkers.filter(marker => text.includes(marker)) })
    }
    const probe: FadeProbe = { events: [], samples: [], protectedSamples: [], protectedMarkers,
      graphemeClusters: [], graphemeSamples: [], observer: new MutationObserver(() => {
        const messages = scroll.querySelectorAll('.message--assistant'), current = messages[messages.length - 1]
        if (!current || !probe.graphemeClusters.length) return
        const textNodes: { node: Node; start: number; end: number }[] = []
        const walker = document.createTreeWalker(current, NodeFilter.SHOW_TEXT)
        let text = ''
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const start = text.length; text += node.textContent ?? ''; textNodes.push({ node, start, end: text.length })
        }
        for (const cluster of probe.graphemeClusters) {
          const start = text.indexOf(cluster); if (start < 0) continue
          const end = start + cluster.length
          const parts = textNodes.filter(part => part.start < end && part.end > start).map(part => ({
            text: (part.node.textContent ?? '').slice(Math.max(0, start - part.start), Math.min(end, part.end) - part.start),
            animated: !!part.node.parentElement?.closest('.md-stream-chunk')
          }))
          probe.graphemeSamples.push({ time: performance.now(), cluster, parts })
        }
      }), frame: 0,
      stop: () => { cancelAnimationFrame(probe.frame); probe.observer.disconnect(); scroll.removeEventListener('animationstart', onAnimation, true); scroll.removeEventListener('animationend', onAnimation, true) } }
    // Collect from animation events and every actual browser frame. Polling an
    // element after IPC/locator waits can miss the entire 250ms transition.
    const sample = (): void => {
      for (const element of scroll.querySelectorAll('.md-stream-chunk')) {
        const style = getComputedStyle(element)
        probe.samples.push({ text: element.textContent ?? '', opacity: Number(style.opacity),
          animation: style.animationName, appearance: document.documentElement.dataset.appearance ?? '' })
      }
      const nodes = document.createTreeWalker(scroll, NodeFilter.SHOW_TEXT)
      for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
        if (!node.parentElement?.closest('.md')) continue
        for (const marker of probe.protectedMarkers) {
          if (!node.textContent?.includes(marker)) continue
          let opacity = 1
          for (let element: Element | null = node.parentElement; element && element !== scroll; element = element.parentElement) opacity *= Number(getComputedStyle(element).opacity)
          probe.protectedSamples.push({ marker, opacity })
        }
      }
      probe.frame = requestAnimationFrame(sample)
    }
    scroll.addEventListener('animationstart', onAnimation, true); scroll.addEventListener('animationend', onAnimation, true)
    probe.observer.observe(scroll, { childList: true, characterData: true, subtree: true })
    target.__streamFadeProbe = probe; probe.frame = requestAnimationFrame(sample)
  }, protectedMarkers)
}
async function protectFadeText(marker: string): Promise<void> {
  await page.evaluate(marker => {
    const probe = (window as FadeWindow).__streamFadeProbe
    if (!probe) throw new Error('Missing streaming fade probe')
    probe.protectedMarkers.push(marker)
  }, marker)
}
async function expectFade(marker: string, appearance: 'light' | 'dark'): Promise<void> {
  await expect.poll(() => page.evaluate(({ marker, appearance }) => {
    const probe = (window as FadeWindow).__streamFadeProbe
    return probe?.events.some(event => event.kind === 'start' && event.text.includes(marker) && event.appearance === appearance) ?? false
  }, { marker, appearance }), { message: '真实 animationstart 必须覆盖新流式文本' }).toBe(true)
  await expect.poll(() => page.evaluate(({ marker, appearance }) => {
    const probe = (window as FadeWindow).__streamFadeProbe
    return probe?.samples.some(sample => sample.text.includes(marker) && sample.appearance === appearance && sample.opacity > 0 && sample.opacity < 0.98) ?? false
  }, { marker, appearance }), { message: '新增文字必须实际经过中间透明度，不能只检查动画名称' }).toBe(true)
  await expect(assistant().locator('.md-stream-chunk'), '动画完成后临时片段必须回收').toHaveCount(0)
}
async function expectOldTextStayedVisible(markers: string[]): Promise<void> {
  const data = await page.evaluate(() => {
    const probe = (window as FadeWindow).__streamFadeProbe
    if (!probe) throw new Error('Missing streaming fade probe')
    return { events: probe.events, protectedSamples: probe.protectedSamples }
  })
  for (const marker of markers) {
    const samples = data.protectedSamples.filter(sample => sample.marker === marker)
    expect(samples.length, `必须采集旧文字 ${marker} 的真实绘制帧`).toBeGreaterThan(0)
    expect(Math.min(...samples.map(sample => sample.opacity)), `旧文字 ${marker} 不能重新变透明`).toBe(1)
    expect(data.events.filter(event => event.kind === 'start' && event.protected.includes(marker)), `旧文字 ${marker} 不能重播淡入`).toEqual([])
  }
}
async function appendSplitGrapheme(first: string, continuation: string, cluster: string, marker: string): Promise<void> {
  await page.evaluate(cluster => {
    const probe = (window as FadeWindow).__streamFadeProbe
    if (!probe) throw new Error('Missing streaming fade probe')
    probe.graphemeClusters.push(cluster)
  }, cluster)
  frame({ content: ` ${marker}:${first}` })
  // Wait for the live initial fragment, rather than waiting for its animation
  // to finish. The following SSE must close the cluster during its 250ms fade.
  await page.waitForFunction(marker => [...document.querySelectorAll('.message--assistant .md-stream-chunk')].some(element =>
    element.textContent?.includes(marker) && element.getAnimations().some(animation => animation.playState === 'running')), marker)
  frame({ content: `${continuation} ${marker}_ADJACENT_NEW` })
  await expect(assistant()).toContainText(cluster)
  await expectFade(`${marker}_ADJACENT_NEW`, 'light')
  const data = await page.evaluate(({ cluster, marker }) => {
    const probe = (window as FadeWindow).__streamFadeProbe
    if (!probe) throw new Error('Missing streaming fade probe')
    return { birth: probe.events.find(event => event.kind === 'start' && event.text.includes(`${marker}:`))?.time,
      samples: probe.graphemeSamples.filter(sample => sample.cluster === cluster) }
  }, { cluster, marker })
  expect(data.birth, '必须捕获初始碎片的真实动画开始时间').toBeDefined()
  expect(data.samples.length, '必须在组合字符真正形成时采集DOM').toBeGreaterThan(0)
  expect(data.samples[0].time - data.birth!, '跨SSE字符必须在首批淡入完成前组合，不能只检查动画结束后的裸文本').toBeLessThan(250)
  for (const sample of data.samples) {
    expect(sample.parts, '跨新增批次的整个grapheme应保留为单个裸文本，不能拆成不同透明度的片段').toEqual([{ text: cluster, animated: false }])
  }
}
async function stopFadeProbe(testInfo: TestInfo, name: string): Promise<void> {
  const data = await page.evaluate(() => {
    const target = window as FadeWindow, probe = target.__streamFadeProbe
    if (!probe) throw new Error('Missing streaming fade probe')
    probe.stop(); delete target.__streamFadeProbe
    return { events: probe.events, samples: probe.samples, protectedSamples: probe.protectedSamples, graphemeSamples: probe.graphemeSamples }
  })
  await testInfo.attach(name, { body: JSON.stringify(data, null, 2), contentType: 'application/json' })
}

test.describe.serial('聊天流式输出的绘制稳定性', () => {
  test.beforeAll(async () => {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing remote fixture port')
    remoteUrl = `http://127.0.0.1:${address.port}`
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'chat-stream-stability-ui-'))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: remoteUrl,
      autoStartEngine: true, lastSessionId: '', thinkingMode: 'off', appearance: 'dark' }))
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root,
      env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
    await page.getByRole('button', { name: '会话历史', exact: true }).click()
    await page.locator(`.history-view__item[data-session-id="${sessionId}"]`).click()
    await expect(page.locator('.message--user').first()).toContainText('STREAM_HISTORY_START')
    await expect(page.locator('.model-picker__trigger')).toBeEnabled()
  })
  test.afterEach(async () => { await completeRun() })
  test.afterAll(async () => {
    heldStream?.destroy()
    await app?.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (!fixture) return
    const absolute = resolve(fixture)
    if (dirname(absolute) !== fixtureRoot || !basename(absolute).startsWith('chat-stream-stability-ui-')) throw new Error('Unsafe streaming stability fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  test('逐帧追加段落、列表、代码与工具帧时保持吸底，既有正文不卸载', async ({}, testInfo) => {
    await startRun('STREAM_FRAME_STABILITY')
    await startProbe()
    try {
      await append('\n\n第一段正在继续补充', '第一段正在继续补充')
      await append('，包括更多文字与 **加粗内容**。\n\n', '包括更多文字与')
      await append('- STREAM_LIST_A：第一条\n', 'STREAM_LIST_A')
      await append('- STREAM_LIST_B：第二条\n', 'STREAM_LIST_B')
      await append('- STREAM_LIST_C：第三条\n\n', 'STREAM_LIST_C')
      await append('```javascript\nconst STREAM_CODE_A = 1\n', 'STREAM_CODE_A')
      await append('const STREAM_CODE_B = 2\n', 'STREAM_CODE_B')
      await append('console.log(STREAM_CODE_A + STREAM_CODE_B)\n```\n\n', 'console.log')
      frame({ toolStart: { toolCallId: 'stability-search', name: 'search_content', args: { pattern: 'STREAM_CODE' } } })
      await expect(assistant().getByRole('status', { name: '运行状态', exact: true })).not.toHaveText('正在生成回复…')
      frame({ toolResult: { toolCallId: 'stability-search', success: true, output: 'STREAM_SEARCH_OK', durationMs: 113 } })
      await expect(assistant().getByRole('status', { name: '运行状态', exact: true })).toHaveText('正在生成回复…')
      frame({ usage: { modelId, promptTokens: 1400, completionTokens: 200, totalTokens: 1600, currentPromptTokens: 1400, contextWindow: 100000 } })
      await expect(assistant().locator('.turn-usage__value')).toHaveText('1.6k')
      for (let index = 1; index <= 8; index++) await append(`\n\nSTREAM_TAIL_${index}：最后继续追加的正文段落，状态与内容应始终稳定。`, `STREAM_TAIL_${index}：`)
    } finally {
      const result = await stopProbe(testInfo, 'stream-frame-diagnostics')
      expect(result.removed, '追加正文不能移除已封口的段落').toBe(0)
      expectFollowing(result.samples)
    }
    expect(errors).toEqual([])
  })

  test('上翻阅读历史时新增内容不改变视口，回到底部后恢复连续跟随', async ({}, testInfo) => {
    await startRun('STREAM_HISTORY_SCROLL')
    await scrollToHistory()
    await startProbe('HISTORY_ANCHOR_12：')
    try {
      for (let index = 1; index <= 6; index++) await append(`\n\nUNFOLLOWED_TAIL_${index}：用户正在阅读历史时收到的正文。`, `UNFOLLOWED_TAIL_${index}：`)
      await expect(page.locator('.chat__back-to-bottom')).toBeVisible()
    } finally {
      const result = await stopProbe(testInfo, 'history-reading-diagnostics')
      const samples = result.samples.filter(sample => sample.phase === 'animation-frame'), removed = result.removed
      expect(removed).toBe(0)
      const positions = samples.map(sample => sample.anchorTop), tops = samples.map(sample => sample.top)
      expect(Math.max(...positions) - Math.min(...positions), '用户正在阅读的历史段落不能被新回复推走').toBeLessThanOrEqual(2)
      expect(Math.max(...tops) - Math.min(...tops), '暂停跟随后不能继续程序化吸底').toBeLessThanOrEqual(2)
      expect(Math.min(...samples.map(sample => sample.gap))).toBeGreaterThan(300)
    }
    await page.locator('.chat__back-to-bottom').click(); await expect.poll(bottomGap).toBeLessThanOrEqual(2)
    await startProbe()
    try {
      for (let index = 1; index <= 5; index++) await append(`\n\nFOLLOW_RESUMED_${index}：点击回底后继续输出。`, `FOLLOW_RESUMED_${index}：`)
    } finally { expectFollowing((await stopProbe(testInfo, 'resumed-following-diagnostics')).samples) }
    expect(errors).toEqual([])
  })

  test('没有新增SSE时迟到图片高度也保持吸底，上翻后图片加载不干扰阅读', async ({}, testInfo) => {
    const first = '迟到图片一', second = '迟到图片二'
    await startRun('STREAM_LATE_IMAGE_LAYOUT', `${sealedText}\n\n![${first}](${placeholderImage})\n\n![${second}](${placeholderImage})\n\n图片占位已加载，正文已经显示。`)
    await expect(assistant().locator('img')).toHaveCount(2)
    await expect.poll(() => assistant().locator('img').evaluateAll(elements => elements.every(element => {
      const image = element as HTMLImageElement
      return image.complete && image.naturalHeight === 1
    }))).toBe(true)
    const heightBefore = await region().evaluate(element => element.scrollHeight)
    await startProbe()
    try {
      await releaseImage(first)
      await expect.poll(() => region().evaluate(element => element.scrollHeight)).toBeGreaterThan(heightBefore + 100)
      await expect.poll(() => page.evaluate(previous => (window as ProbeWindow).__streamStabilityProbe?.samples.some(sample => sample.phase === 'resize' && sample.height > previous + 100) ?? false, heightBefore),
        { message: '必须采集到图片解码后、ResizeObserver交付后的真实布局帧' }).toBe(true)
      // No frame is sent here: real image decode/layout alone must keep the viewport following.
      await expect.poll(bottomGap, { message: '迟到图片改变布局后也应继续吸底，无需下一帧正文补救' }).toBeLessThanOrEqual(2)
    } finally {
      const result = await stopProbe(testInfo, 'late-image-follow-diagnostics')
      const samples = result.samples.filter(sample => sample.phase === 'resize')
      expect(samples.some(sample => sample.height > heightBefore + 100), '必须检查图片高度实际增长后的布局阶段').toBe(true)
      expect(Math.max(...samples.map(sample => sample.gap)), '图片加载后绘制前的布局阶段不能留下底部跳动').toBeLessThanOrEqual(2)
    }
    await scrollToHistory(); await startProbe('HISTORY_ANCHOR_12：')
    const secondHeightBefore = await region().evaluate(element => element.scrollHeight)
    try {
      await releaseImage(second)
      await expect.poll(() => page.evaluate(previous => (window as ProbeWindow).__streamStabilityProbe?.samples.some(sample => sample.phase === 'resize' && sample.height > previous + 100) ?? false, secondHeightBefore),
        { message: '暂停跟随后也必须采集到图片加载完成的绘制帧' }).toBe(true)
    } finally {
      const { samples } = await stopProbe(testInfo, 'late-image-unfollow-diagnostics')
      const positions = samples.map(sample => sample.anchorTop)
      expect(Math.max(...positions) - Math.min(...positions), '暂停跟随后图片加载不能改变历史阅读位置').toBeLessThanOrEqual(2)
      expect(Math.min(...samples.map(sample => sample.gap))).toBeGreaterThan(300)
    }
    await page.locator('.chat__back-to-bottom').click(); await expect.poll(bottomGap).toBeLessThanOrEqual(2)
    expect(errors).toEqual([])
  })

  test('新文字在同一段落中淡入，Markdown闭合与代码高亮不会重播已显示文字', async ({}, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark')
    await expect(page.locator('.message--assistant .md-stream-chunk'), '已完成的历史消息不应带入场动画').toHaveCount(0)
    await startRun('STREAM_TEXT_FADE_MARKDOWN', `${sealedText}\n\nFADE_OLD_PREFIX：已经阅读的同段文字。`)
    await expect(assistant().locator('.md-stream-chunk')).toHaveCount(0)
    const oldMarkers = [sealedText, 'FADE_OLD_PREFIX', 'BOLD_OLD', 'LINK_OLD', 'INLINE_CODE_OLD', 'FADE_CODE_OLD']
    await startFadeProbe(oldMarkers.slice(0, 2))
    try {
      await append(' FADE_NEW_SUFFIX：同段新增文字应平滑显现。', 'FADE_NEW_SUFFIX')
      await expectFade('FADE_NEW_SUFFIX', 'dark')
      await expect(assistant().locator('.md p').filter({ hasText: 'FADE_OLD_PREFIX' })).toContainText('FADE_NEW_SUFFIX')

      await append('\n\n**BOLD_OLD', 'BOLD_OLD')
      await expect(assistant().locator('.md-stream-chunk')).toHaveCount(0)
      await protectFadeText('BOLD_OLD')
      await append('** BOLD_NEW', 'BOLD_NEW')
      await expect(assistant().locator('strong').filter({ hasText: 'BOLD_OLD' })).toHaveText('BOLD_OLD')
      await expectFade('BOLD_NEW', 'dark')

      await append('\n\n[LINK_OLD', 'LINK_OLD')
      await expect(assistant().locator('.md-stream-chunk')).toHaveCount(0)
      await protectFadeText('LINK_OLD')
      await append('](https://example.com) LINK_NEW', 'LINK_NEW')
      await expect(assistant().getByRole('link', { name: 'LINK_OLD', exact: true })).toHaveAttribute('href', 'https://example.com')
      await expectFade('LINK_NEW', 'dark')

      await append('\n\n`INLINE_CODE_OLD', 'INLINE_CODE_OLD')
      await expect(assistant().locator('.md-stream-chunk')).toHaveCount(0)
      await protectFadeText('INLINE_CODE_OLD')
      await append('` INLINE_CODE_NEW', 'INLINE_CODE_NEW')
      await expect(assistant().locator('.md-inline-code').filter({ hasText: 'INLINE_CODE_OLD' })).toHaveText('INLINE_CODE_OLD')
      await expectFade('INLINE_CODE_NEW', 'dark')

      await append('\n\n```javascript\nconst FADE_CODE_OLD = 1\n', 'const FADE_CODE_OLD')
      await expect(assistant().locator('.md-stream-chunk')).toHaveCount(0)
      await protectFadeText('FADE_CODE_OLD')
      await append('const FADE_CODE_NEW = 2\n```\n\nFADE_AFTER_CODE', 'FADE_AFTER_CODE')
      await expectFade('FADE_CODE_NEW', 'dark')
      await expectFade('FADE_AFTER_CODE', 'dark')
      const code = assistant().locator('.md-code pre code')
      await expect(code.locator('.hljs-keyword')).toHaveCount(2)
      const expectedCode = 'const FADE_CODE_OLD = 1\nconst FADE_CODE_NEW = 2'
      expect((await code.textContent())?.trimEnd(), '淡入不能改变高亮代码的原始文本').toBe(expectedCode)
      await assistant().getByRole('button', { name: '复制代码', exact: true }).click()
      await expect.poll(async () => (await app!.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n').trimEnd(),
        { message: '复制必须保留真实代码，不带动画包装或丢失字符' }).toBe(expectedCode)

      await expectOldTextStayedVisible(oldMarkers)
      await completeRun()
      await expect(assistant().locator('.md-stream-chunk')).toHaveCount(0)
      await expect(assistant()).toContainText('FADE_AFTER_CODE')
      expect(errors).toEqual([])
    } finally { await stopFadeProbe(testInfo, 'streaming-text-fade-markdown-diagnostics') }
  })

  test('浅色主题淡入、减少动态效果即时可读，长回复和历史回放不保留动画片段', async ({}, testInfo) => {
    const appearance = await page.locator('html').getAttribute('data-appearance')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    // Use the production light tokens while keeping the real held SSE alive.
    await page.evaluate(() => { document.documentElement.dataset.appearance = 'light' })
    await startRun('STREAM_TEXT_FADE_ACCESSIBILITY', `${sealedText}\n\nLIGHT_OLD_PREFIX：浅色主题下已经显示的文字。`)
    await expect(assistant().locator('.md-stream-chunk')).toHaveCount(0)
    await startFadeProbe([sealedText, 'LIGHT_OLD_PREFIX'])
    try {
      await append(' LIGHT_NEW_SUFFIX：浅色下同样平滑显现。', 'LIGHT_NEW_SUFFIX')
      await expectFade('LIGHT_NEW_SUFFIX', 'light')
      await expectOldTextStayedVisible([sealedText, 'LIGHT_OLD_PREFIX'])

      await page.emulateMedia({ reducedMotion: 'reduce' })
      await append(' REDUCED_MOTION_NEW：减少动态效果时立即可读。', 'REDUCED_MOTION_NEW')
      const reduced = await assistant().locator('.md p').filter({ hasText: 'REDUCED_MOTION_NEW' }).evaluate(element => {
        const nodes = [element, ...element.querySelectorAll('.md-stream-chunk')]
        return nodes.map(node => ({ opacity: getComputedStyle(node).opacity,
          animation: getComputedStyle(node).animationName, animations: node.getAnimations().length }))
      })
      expect(reduced.length).toBeGreaterThan(0)
      expect(reduced.every(node => node.opacity === '1' && node.animation === 'none' && node.animations === 0),
        '减少动态效果不能残留透明内容或短暂执行装饰动画').toBe(true)
      const reducedEvents = await page.evaluate(() => (window as FadeWindow).__streamFadeProbe?.events.filter(event => event.kind === 'start' && event.text.includes('REDUCED_MOTION_NEW')) ?? [])
      expect(reducedEvents).toEqual([])

      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await appendSplitGrapheme('👩', '\u200d💻', '👩\u200d💻', 'SPLIT_EMOJI')
      await appendSplitGrapheme('e', '\u0301', 'e\u0301', 'SPLIT_COMBINING')

      await page.emulateMedia({ forcedColors: 'active' })
      await append(' FORCED_COLORS_NEW：高对比模式立即可读。', 'FORCED_COLORS_NEW')
      const forced = await assistant().locator('.md p').filter({ hasText: 'FORCED_COLORS_NEW' }).evaluate(element =>
        [element, ...element.querySelectorAll('.md-stream-chunk')].map(node => ({ opacity: getComputedStyle(node).opacity,
          animation: getComputedStyle(node).animationName, animations: node.getAnimations().length })))
      expect(forced.length).toBeGreaterThan(0)
      expect(forced.every(node => node.opacity === '1' && node.animation === 'none' && node.animations === 0),
        '系统高对比模式不能暂时隐藏新文字或执行装饰动画').toBe(true)
      expect(await page.evaluate(() => (window as FadeWindow).__streamFadeProbe?.events.filter(event =>
        event.kind === 'start' && event.text.includes('FORCED_COLORS_NEW')) ?? [])).toEqual([])
      await page.emulateMedia({ forcedColors: 'none' })

      for (let index = 1; index <= 40; index++) await append(` LONG_FADE_PART_${index}：持续追加。`, `LONG_FADE_PART_${index}：`)
      await expectFade('LONG_FADE_PART_40', 'light')
      await expect(assistant().locator('.md-stream-chunk'), '长回复不能永久积累批次动画节点').toHaveCount(0)
      const paragraph = assistant().locator('.md p').filter({ hasText: 'LIGHT_OLD_PREFIX' })
      expect(await paragraph.locator('span').count(), '普通长段落在淡入结束后应回到普通文本节点').toBe(0)
      await append(' FADE_FINAL_MARKER：完成后全部文字可见。', 'FADE_FINAL_MARKER')
      await completeRun()
      await expect(assistant().locator('.md-stream-chunk')).toHaveCount(0)
      await expect(paragraph).toHaveCSS('opacity', '1')
      await expect(paragraph).toContainText('FADE_FINAL_MARKER')
      expect(errors).toEqual([])
    } finally {
      await stopFadeProbe(testInfo, 'streaming-text-fade-accessibility-diagnostics')
      await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' })
      await page.evaluate(appearance => {
        if (appearance === null) delete document.documentElement.dataset.appearance
        else document.documentElement.dataset.appearance = appearance
      }, appearance)
    }

    // Capture before React mounts so a historical entry animation cannot finish
    // before a locator wait and produce a falsely green history assertion.
    await page.addInitScript(() => {
      const target = window as FadeWindow; target.__historyFadeStarts = []
      document.addEventListener('animationstart', event => {
        if (event.target instanceof Element && event.target.classList.contains('md-stream-chunk')) target.__historyFadeStarts!.push(event.target.textContent ?? '')
      }, true)
    })
    await page.reload()
    await expect(page.locator('.message--user').first()).toContainText('STREAM_HISTORY_START')
    await expect(assistant()).toContainText('FADE_FINAL_MARKER')
    await expect(page.locator('.message--assistant .md-stream-chunk')).toHaveCount(0)
    expect(await page.evaluate(() => (window as FadeWindow).__historyFadeStarts), '回放已有回复不能重播流式淡入').toEqual([])
    expect(errors).toEqual([])
  })
})
