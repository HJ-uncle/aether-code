/** Real Electron + authenticated held remote SSE: painted streaming frames stay at
 * the bottom, sealed Markdown nodes survive appends, user history reading is not
 * pulled away, and late image layout is followed without another engine frame. */
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

type Sample = { time: number; top: number; height: number; gap: number; statusTop: number; statusBottom: number; anchorTop: number; anchorConnected: boolean; width: number }
type Probe = { samples: Sample[]; frame: number; observer: MutationObserver; removed: number; stop: () => void }
type ProbeWindow = Window & { __streamStabilityProbe?: Probe }
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
      for (const record of records) for (const removed of record.removedNodes) {
        if (removed === anchor || removed.contains(anchor)) probe.removed += 1
      }
    }), stop: () => { cancelAnimationFrame(probe.frame); probe.observer.disconnect() } }
    probe.observer.observe(scroll, { childList: true, subtree: true })
    const sample = (time: number): void => {
      const box = status.getBoundingClientRect()
      probe.samples.push({ time, top: scroll.scrollTop, height: scroll.scrollHeight,
        gap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
        statusTop: box.top, statusBottom: box.bottom, anchorTop: anchor.getBoundingClientRect().top,
        anchorConnected: anchor.isConnected, width: scroll.clientWidth })
      probe.frame = requestAnimationFrame(sample)
    }
    target.__streamStabilityProbe = probe; probe.frame = requestAnimationFrame(sample)
  }, anchorText)
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__streamStabilityProbe?.samples.length ?? 0),
    { message: '布局变化前先采集正常绘制帧，确保诊断不会是空集合' }).toBeGreaterThanOrEqual(2)
}
async function stopProbe(testInfo: TestInfo, name: string): Promise<{ samples: Sample[]; removed: number }> {
  const data = await page.evaluate(() => {
    const target = window as ProbeWindow, probe = target.__streamStabilityProbe
    if (!probe) throw new Error('Missing frame probe')
    probe.stop(); delete target.__streamStabilityProbe; return { samples: probe.samples, removed: probe.removed }
  })
  const range = (values: number[]) => Math.max(...values) - Math.min(...values)
  const summary = { frames: data.samples.length, removed: data.removed,
    maxBottomGap: Math.max(...data.samples.map(sample => sample.gap)),
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
function expectFollowing(samples: Sample[]): void {
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
      const { samples, removed } = await stopProbe(testInfo, 'history-reading-diagnostics')
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
      await expect.poll(() => page.evaluate(previous => (window as ProbeWindow).__streamStabilityProbe?.samples.some(sample => sample.height > previous + 100) ?? false, heightBefore),
        { message: '必须采集到图片解码后的真实布局绘制帧' }).toBe(true)
      // No frame is sent here: real image decode/layout alone must keep the viewport following.
      await expect.poll(bottomGap, { message: '迟到图片改变布局后也应继续吸底，无需下一帧正文补救' }).toBeLessThanOrEqual(2)
    } finally {
      const { samples } = await stopProbe(testInfo, 'late-image-follow-diagnostics')
      expect(Math.max(...samples.map(sample => sample.gap)), '图片加载不能造成可见的瞬时底部跳动').toBeLessThanOrEqual(2)
    }
    await scrollToHistory(); await startProbe('HISTORY_ANCHOR_12：')
    const secondHeightBefore = await region().evaluate(element => element.scrollHeight)
    try {
      await releaseImage(second)
      await expect.poll(() => page.evaluate(previous => (window as ProbeWindow).__streamStabilityProbe?.samples.some(sample => sample.height > previous + 100) ?? false, secondHeightBefore),
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
})
