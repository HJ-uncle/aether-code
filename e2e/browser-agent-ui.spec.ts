/** Real Electron + engine + deterministic local Anthropic SSE: model tools control the visible guest and receive actual screenshot image blocks. */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AetherIdeApi } from '../src/preload'
import type { BrowserSnapshot, BrowserTabState } from '../src/shared/browser'
import type { BrowserNetworkDetail, BrowserNetworkList } from '../src/shared/browser-network'
import type { ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'

declare global {
  interface Window {
    aether: AetherIdeApi
  }
}

const root = resolve(__dirname, '..')
const engineRoot = resolve(root, '..', 'ai-agent-engine')
const model = 'browser-visual-anthropic-fixture'
const sessionId = 'browser-agent-loop'
const key = 'b'.repeat(64)
const finalAnswer = '已完成真实浏览器验证：中文输入、按钮、手机视口、截图、控制台、网络及失败后的恢复均通过。'
const steps = [
  'open',
  'snapshot',
  'fill',
  'click',
  'wait',
  'set_viewport',
  'screenshot',
  'console',
  'network',
  'network_request',
  'network_request_more',
  'open_error_tab',
  'close_error_tab',
  'click_closed',
  'recover_fill'
] as const
type Step = (typeof steps)[number]
const toolAliases: Partial<Record<Step, string>> = {
  network_request_more: 'network_request', open_error_tab: 'open',
  close_error_tab: 'close', click_closed: 'click', recover_fill: 'fill'
}
const toolName = (step: Step): string => `browser_${toolAliases[step] ?? step}`
type Block = {
  type: string
  text?: string
  tool_use_id?: string
  content?: string | Block[]
  source?: { type: string; media_type?: string; data?: string }
  [key: string]: unknown
}
type RequestBody = {
  stream?: boolean
  messages: Array<{ role: string; content?: string | Block[] }>
  tools?: Array<{ name: string }>
}
type Frame = { type: string; [key: string]: unknown }
type StopScenario = {
  mode: 'cancel' | 'recover'
  target: { tabId: string; navigationId: number; selector: string }
  issued: boolean
  pendingResponse?: ServerResponse
  recoveredResult?: Block
}
let stopScenario: StopScenario | undefined
let fixture = '',
  origin = '',
  app: ElectronApplication | undefined,
  page: Page
let pingCount = 0,
  streamCount = 0,
  pixels = '',
  imageDescription = ''
const outputs = new Map<Step, unknown>()
const providerToolResults = new Map<Step, Block>()
const requestedTools: string[] = []
const providerErrors: string[] = []
const rendererErrors: string[] = []
const pageHtml = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI 浏览器闭环夹具</title><style>body{font:18px sans-serif;margin:24px}input,button{font:inherit;padding:8px}canvas{display:block;background:#edd7a7;margin-top:16px}#visual-marker{position:fixed;right:14px;top:12px;width:36px;height:28px;background:rgb(220,30,70);z-index:9999;pointer-events:none}</style></head><body><div id="visual-marker" aria-hidden="true"></div><h1>AI 可视化测试页面</h1><label for="name">名称</label><input id="name" value="初始值"><button id="confirm">确认</button><p id="result">等待输入</p><p id="network">网络未请求</p><canvas width="220" height="180"></canvas><script>
window.__fixtureClickCount=0;window.__fixtureInputs=[];document.querySelector('#name').addEventListener('input',event=>window.__fixtureInputs.push({value:event.target.value,trusted:event.isTrusted}));
document.querySelector('#confirm').onclick=async(event)=>{
  window.__fixtureClickCount++;
  const bounds=event.currentTarget.getBoundingClientRect();
  window.__fixtureClick={x:event.clientX,y:event.clientY,trusted:event.isTrusted,bounds:{x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height},viewport:{width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio,scrollX,scrollY}};
  document.querySelector('#result').textContent='完成：'+document.querySelector('#name').value;console.log('AI_BROWSER_CONFIRMED');await fetch('/ping');document.querySelector('#network').textContent='网络完成'
};const c=document.querySelector('canvas').getContext('2d');c.beginPath();c.arc(90,90,24,0,Math.PI*2);c.fill();</script></body></html>`

function stream(response: ServerResponse, block: Block, reason = 'end_turn'): void {
  const frames: Frame[] = [
    {
      type: 'message_start',
      message: {
        id: `browser-response-${streamCount}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 30, output_tokens: 0 }
      }
    },
    { type: 'content_block_start', index: 0, content_block: block },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: reason, stop_sequence: null },
      usage: { output_tokens: 12 }
    },
    { type: 'message_stop' }
  ]
  response.writeHead(200, { 'Content-Type': 'text/event-stream;charset=utf-8' })
  response.end(
    frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('')
  )
}
function decode(result: Block): unknown {
  if (typeof result.content !== 'string')
    throw new Error(
      `Expected structured text tool result, got ${JSON.stringify(result.content).slice(0, 200)}`
    )
  return JSON.parse(result.content)
}
function captureResults(body: RequestBody): void {
  const results = body.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'tool_result')
      : []
  )
  for (const step of steps) {
    if (outputs.has(step)) continue
    const result = results.find((block) => block.tool_use_id === `browser-agent-${step}`)
    if (!result) continue
    providerToolResults.set(step, result)
    if (step === 'screenshot') {
      if (!Array.isArray(result.content))
        throw new Error('Screenshot did not reach the model as multimodal content')
      const image = result.content.find((block) => block.type === 'image')
      if (
        image?.source?.type !== 'base64' ||
        image.source.media_type !== 'image/png' ||
        !image.source.data
      )
        throw new Error('Missing real screenshot image block')
      pixels = image.source.data
      imageDescription = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n')
      outputs.set(step, {
        mimeType: image.source.media_type,
        bytes: Buffer.from(pixels, 'base64').length,
        description: imageDescription
      })
    } else {
      const decoded = decode(result)
      if (!decoded || typeof decoded !== 'object')
        throw new Error(`Invalid ${step} result: ${String(decoded)}`)
      outputs.set(step, decoded)
    }
  }
}
function argsFor(step: Step): Record<string, unknown> {
  if (step === 'open' || step === 'open_error_tab') return { url: `${origin}/page` }
  if (step === 'close_error_tab' || step === 'click_closed') {
    const closed = outputs.get('open_error_tab') as BrowserTabState | undefined
    if (!closed?.tabId) throw new Error('Missing error fixture tab')
    return { tabId: closed.tabId, navigationId: closed.navigationId,
      ...(step === 'click_closed' ? { selector: '#confirm' } : {}) }
  }
  const tab = outputs.get('open') as BrowserTabState | undefined
  if (!tab?.tabId) throw new Error('browser_open did not return a tabId')
  if (step === 'snapshot') return { tabId: tab.tabId }
  const snapshot = outputs.get('snapshot') as BrowserSnapshot | undefined
  if (!snapshot || !Number.isInteger(snapshot.tab?.navigationId))
    throw new Error('snapshot did not return navigation identity')
  const target = { tabId: tab.tabId, navigationId: snapshot.tab.navigationId }
  if (step === 'recover_fill') return { ...target, selector: '#name', text: 'AI闭环中文' }
  if (step === 'fill') {
    const input = snapshot.elements.find((element) => element.role === 'textbox' && element.ref)
    if (!input?.ref) throw new Error('snapshot did not expose an actionable input ref')
    return { ...target, ref: input.ref, text: 'AI闭环中文' }
  }
  if (step === 'click') return { ...target, selector: '#confirm' }
  if (step === 'wait') return { ...target, text: '网络完成', timeoutMs: 10000 }
  if (step === 'set_viewport')
    return { ...target, viewport: { width: 390, height: 600, mobile: true, deviceScaleFactor: 2 } }
  if (step === 'network')
    return {
      tabId: tab.tabId,
      query: { url: '/ping', resourceType: 'Fetch', status: '200', limit: 1 }
    }
  if (step === 'network_request' || step === 'network_request_more') {
    const request = (outputs.get('network') as BrowserNetworkList).entries[0]
    if (!request?.id) throw new Error('Network list did not expose a stable request ID')
    return {
      tabId: tab.tabId,
      requestId: request.id,
      bodyTarget: 'response',
      bodyOffset:
        step === 'network_request_more'
          ? (outputs.get('network_request') as BrowserNetworkDetail).response.body.nextOffset
          : 0,
      bodyLimit: step === 'network_request_more' ? 12000 : 32
    }
  }
  return target
}

const provider = createServer((request, response) => {
  void (async () => {
    const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname
    if (path === '/page') {
      response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }).end(pageHtml)
      return
    }
    if (path === '/ping') {
      pingCount++
      response
        .writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Fixture-Trace': 'browser-request-detail'
        })
        .end(
          JSON.stringify({
            ok: true,
            message: '请求详情中文',
            token: 'fixture-response-secret',
            data: '可继续读取'.repeat(40)
          })
        )
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(404).end()
      return
    }
    let raw = ''
    request.setEncoding('utf8')
    for await (const chunk of request) raw += String(chunk)
    const body = JSON.parse(raw) as RequestBody
    if (!body.stream) {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          id: 'browser-auxiliary',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: '浏览器闭环测试' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 6 }
        })
      )
      return
    }
    streamCount++
    if (stopScenario) {
      if (stopScenario.mode === 'cancel') {
        if (stopScenario.issued) throw new Error('Cancelled run unexpectedly requested another model response')
        // The test opens a real modal before releasing this real tool request.
        stopScenario.pendingResponse = response
        return
      }
      const recoveredResult = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .find(block => block.type === 'tool_result' && block.tool_use_id === 'browser-after-user-stop')
      if (recoveredResult) {
        stopScenario.recoveredResult = recoveredResult
        stream(response, { type: 'text', text: '停止后已恢复，合法点击只执行一次。' })
        return
      }
      if (stopScenario.issued) throw new Error('Recovery click was duplicated without a result')
      stopScenario.issued = true
      stream(response, { type: 'tool_use', id: 'browser-after-user-stop', name: 'browser_click', input: stopScenario.target }, 'tool_use')
      return
    }
    captureResults(body)
    const next = steps.find((step) => !outputs.has(step))
    if (!next) {
      stream(response, { type: 'text', text: finalAnswer })
      return
    }
    const name = toolName(next)
    if (!body.tools?.some((tool) => tool.name === name))
      throw new Error(`Engine did not advertise ${name}`)
    requestedTools.push(name)
    stream(
      response,
      { type: 'tool_use', id: `browser-agent-${next}`, name, input: argsFor(next) },
      'tool_use'
    )
  })().catch((error) => {
    providerErrors.push(error instanceof Error ? error.message : String(error))
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { type: 'fixture_error', message: String(error) } }))
  })
})

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AETHER_IDE_ENGINE_ENTRY: join(engineRoot, 'dist/main.js'),
    AUTH_ENABLED: 'false',
    HISTORY_BACKEND: 'jsonl',
    LLM_PROVIDER: 'anthropic',
    LLM_PRIMARY_MODEL: model,
    LLM_MODEL: model,
    LLM_FALLBACK_MODEL: '',
    ANTHROPIC_API_KEY: 'local-browser-fixture-key',
    ANTHROPIC_BASE_URL: origin,
    DEFAULT_SECURITY_MODE: 'safe',
    OSM_MODE: 'balanced',
    MAX_ITERATIONS: '20',
    ENABLE_LONG_TERM_MEMORY: 'false',
    AETHER_GLOBAL_DIR: join(fixture, 'global'),
    WORKSPACE_ROOT: join(fixture, 'sandboxes'),
    MCP_CONFIG_PATH: join(fixture, 'mcp.json'),
    SKILLS_ROOT: join(fixture, 'skills')
  }
}
async function recovery(): Promise<ChatRecoverySnapshot> {
  const response = await page.evaluate(
    (sessionId) =>
      window.aether.engine.request<ChatRecoverySnapshot>({
        method: 'GET',
        path: '/chat/snapshot',
        query: { sessionId }
      }),
    sessionId
  )
  expect(response.ok, response.message).toBe(true)
  return response.data!
}

/** Display evidence is persisted separately from the compact model input. */
function historySnapshot(history: ChatRecoverySnapshot['history'], step: Step): BrowserSnapshot {
  const rows = history.filter(row => row.role === 'tool' && row.toolCallId === `browser-agent-${step}`)
  expect(rows, `${step} 必须有唯一的持久化工具结果`).toHaveLength(1)
  const content = rows[0]?.content
  expect(typeof content, `${step} 持久化工具结果应为结构化 JSON 文本`).toBe('string')
  if (typeof content !== 'string') throw new Error(`Missing persisted ${step} result`)
  return JSON.parse(content) as BrowserSnapshot
}

function expectModelImageMetadata(modelResult: BrowserSnapshot, displayResult: BrowserSnapshot): void {
  const expectMarker = (marker: unknown, saved: BrowserSnapshot['screenshot']): void => {
    if (!saved) return
    expect(saved.dataUrl).toMatch(/^data:image\/png;base64,iVBOR/)
    expect(marker).toEqual({ width: saved.width, height: saved.height, retainedForDisplay: true })
  }
  expectMarker(modelResult.screenshot, displayResult.screenshot)
  expectMarker(modelResult.interaction?.screenshot, displayResult.interaction?.screenshot)
  expect(JSON.stringify(modelResult), '页面快照送给模型时只保留图片元数据').not.toContain('data:image/')
  expect(JSON.stringify(modelResult)).not.toContain('"dataUrl"')
  expect(displayResult.elements, '隐藏元素展示不能删除模型或历史中的元素数据').toEqual(modelResult.elements)
  expect(displayResult.viewport).toEqual(modelResult.viewport)
}

async function sampleSavedPng(dataUrl: string, coordinate: { x: number; y: number; width: number; height: number }): Promise<{ width: number; height: number; color: number[] }> {
  return page.evaluate(async ({ dataUrl, coordinate }) => {
    const image = new Image()
    await new Promise<void>((done, reject) => { image.onload = () => done(); image.onerror = () => reject(new Error('Saved browser image did not decode')); image.src = dataUrl })
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
    const context = canvas.getContext('2d'); if (!context) throw new Error('Missing PNG decoder')
    context.drawImage(image, 0, 0)
    const x = Math.floor(coordinate.x * image.naturalWidth / coordinate.width)
    const y = Math.floor(coordinate.y * image.naturalHeight / coordinate.height)
    return { width: image.naturalWidth, height: image.naturalHeight, color: [...context.getImageData(x, y, 1, 1).data] }
  }, { dataUrl, coordinate })
}

/** Check both the saved PNG and actual rendered SVG pixels. Merely exposing a
 * data URL, or painting the screenshot against the wrong viewport, must fail. */
async function expectMapScreenshot(map: Locator, capture: {
  viewport: { width: number; height: number }
  screenshot?: { dataUrl: string; width: number; height: number }
}): Promise<void> {
  const saved = capture.screenshot
  expect(saved, '位置图必须使用这次工具实际保存的截图').toBeDefined()
  if (!saved) throw new Error('Missing screenshot in browser tool result')
  expect(saved.dataUrl).toMatch(/^data:image\/png;base64,iVBOR/)
  const embedded = map.locator('.tool-browser-position__image')
  await expect(embedded).toBeVisible()
  expect(await embedded.getAttribute('href') === saved.dataUrl).toBe(true)
  expect(Number(await embedded.getAttribute('width'))).toBe(capture.viewport.width)
  expect(Number(await embedded.getAttribute('height'))).toBe(capture.viewport.height)
  const pixels = await sampleSavedPng(saved.dataUrl, { x: capture.viewport.width - 32, y: 26, ...capture.viewport })
  expect(pixels.width).toBe(saved.width)
  expect(pixels.height).toBe(saved.height)
  expect(pixels.width).toBeGreaterThan(100)
  expect(pixels.height).toBeGreaterThan(100)
  expect(pixels.color).toEqual([220, 30, 70, 255])
  await map.scrollIntoViewIfNeeded()
  const renderedCoordinate = await map.evaluate((node, viewport) => {
    const svg = node as SVGSVGElement, matrix = svg.getScreenCTM(), box = svg.getBoundingClientRect()
    if (!matrix) throw new Error('Position map has no screen transform')
    const point = new DOMPoint(viewport.width - 32, 26).matrixTransform(matrix)
    return { x: point.x - box.left, y: point.y - box.top, width: box.width, height: box.height }
  }, capture.viewport)
  await expect.poll(async () => {
    const rendered = await map.screenshot()
    return (await sampleSavedPng('data:image/png;base64,' + rendered.toString('base64'), renderedCoordinate)).color
  }).toEqual([220, 30, 70, 255])
}

async function expectNoElementPresentation(card: Locator): Promise<void> {
  await expect(card.locator('.tool-browser-snapshot__elements, .tool-browser-snapshot__element, .tool-browser-snapshot__list-heading, .tool-browser-snapshot__content')).toHaveCount(0)
  await expect(card.locator('.tool-browser-elements-map, .tool-browser-snapshot__geometry')).toHaveCount(0)
  await expect(card.getByRole('region', { name: '页面元素', exact: true })).toHaveCount(0)
  await expect(card).not.toContainText('页面元素')
  await expect(card).not.toContainText('元素位置')
  await expect(card.locator('.tool-browser-snapshot__facts')).not.toContainText('个元素')
}

/** Each browser action returns its own snapshot. Probe the click result so a
 * screenshot card or a later wait result cannot accidentally satisfy this check. */
async function expectClickSnapshotCard(): Promise<Locator> {
  for (const summary of await page.locator('.process__summary').all()) {
    if (await summary.getAttribute('aria-expanded') !== 'true') await summary.click()
  }
  const row = page.locator('.logline-wrap').filter({
    has: page.locator('.logline__name', { hasText: /^点击浏览器元素$/ })
  }).filter({ hasNot: page.locator('.logline__name--error') })
  await expect(row).toHaveCount(1)
  const toggle = row.locator('button.logline')
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  const card = row.locator('.tool-browser-snapshot')
  await expect(card).toBeVisible()
  await expect(card).toContainText('AI 浏览器闭环夹具')
  await expect(card).toContainText(`${origin}/page`)
  await expect(card.getByRole('button', { name: '页面文字', exact: true })).toHaveCount(0)
  await expect(card.locator('.tool-browser-snapshot__views')).toHaveCount(0)
  await expectNoElementPresentation(card)
  await expect(card.locator('.tool-browser-page')).toHaveCount(0)
  await expect(card.locator('.tool-browser-position__map')).toHaveCount(1)
  const clicked = outputs.get('click') as BrowserSnapshot
  const interaction = clicked.interaction
  const displayClicked = historySnapshot((await recovery()).history, 'click')
  const displayInteraction = displayClicked.interaction
  expect(interaction, '点击工具必须保留实际派发时的位置证据').toBeDefined()
  if (!interaction) throw new Error('Missing click evidence from the real browser result')
  expect(displayInteraction, '历史工具结果必须保留点击前的展示截图').toBeDefined()
  if (!displayInteraction) throw new Error('Missing persisted click evidence')
  expectModelImageMetadata(clicked, displayClicked)
  const location = card.locator('.tool-browser-click')
  await expect(location).toBeVisible()
  await expect(location).toContainText('点击位置')
  await expect(location).toContainText('点击前画面')
  await expect(location).toContainText('确认')
  await expect(location).toContainText('#confirm')
  const map = location.locator('.tool-browser-click__map')
  const viewBox = (await map.getAttribute('viewBox'))?.trim().split(/\s+/).map(Number)
  expect(viewBox).toEqual([0, 0, interaction.viewport.width, interaction.viewport.height])
  const point = map.locator('.tool-browser-click__point')
  await expect(point).toHaveCount(1)
  expect(Number(await point.getAttribute('cx'))).toBeCloseTo(interaction.x, 6)
  expect(Number(await point.getAttribute('cy'))).toBeCloseTo(interaction.y, 6)
  await expectMapScreenshot(map, displayInteraction)
  await location.getByRole('button', { name: '放大查看 点击前页面截图', exact: true }).click()
  const clickDialog = page.getByRole('dialog', { name: '点击前页面截图', exact: true })
  await expect(clickDialog).toBeVisible()
  await expectMapScreenshot(clickDialog.locator('.tool-browser-click__map'), displayInteraction)
  expect(Number(await clickDialog.locator('.tool-browser-click__point').getAttribute('cx'))).toBeCloseTo(interaction.x, 6)
  expect(Number(await clickDialog.locator('.tool-browser-click__point').getAttribute('cy'))).toBeCloseTo(interaction.y, 6)
  await page.keyboard.press('Escape')
  await expect(clickDialog).toBeHidden()

  // Technical evidence remains available, but does not replace the visual card.
  const raw = row.locator('.tool-result__metadata').filter({
    has: page.locator('summary', { hasText: /^原始数据$/ })
  })
  await expect(raw).toHaveJSProperty('open', false)
  await raw.locator('summary').click()
  await expect(raw.locator('pre')).toBeVisible()
  await expect(raw.locator('pre')).toContainText('"navigationId"')
  await raw.locator('summary').click()
  await expect(raw).toHaveJSProperty('open', false)

  return card
}

async function expectPageSnapshotCard(): Promise<Locator> {
  const row = page.locator('.logline-wrap').filter({
    has: page.locator('.logline__name', { hasText: /^调整浏览器视口$/ })
  })
  await expect(row).toHaveCount(1)
  const toggle = row.locator('button.logline')
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  const card = row.locator('.tool-browser-snapshot')
  await expect(card).toBeVisible()
  await expectNoElementPresentation(card)
  await expect(card.getByRole('button', { name: '页面文字', exact: true })).toHaveCount(0)
  await expect(card.locator('.tool-browser-snapshot__views, .tool-browser-click')).toHaveCount(0)
  await expect(card.locator('.tool-browser-page')).toBeVisible()
  await expect(card.locator('.tool-browser-position__map')).toHaveCount(1)
  const resized = outputs.get('set_viewport') as BrowserSnapshot
  const displayResized = historySnapshot((await recovery()).history, 'set_viewport')
  expectModelImageMetadata(resized, displayResized)
  const map = card.locator('.tool-browser-page__map')
  await expect(map).toBeVisible()
  expect((await map.getAttribute('viewBox'))?.trim().split(/\s+/).map(Number))
    .toEqual([0, 0, resized.viewport.width, resized.viewport.height])
  // Non-click results show the saved page without selected element rectangles
  // or click crosshairs; the SVG keeps only its viewport background rectangle.
  await expect(map.locator('path, circle, .tool-browser-elements-map__selected, .tool-browser-click__bounds')).toHaveCount(0)
  await expect(map.locator('rect')).toHaveCount(1)
  await expectMapScreenshot(map, displayResized)
  const raw = row.locator('.tool-result__metadata').filter({ has: page.locator('summary', { hasText: /^原始数据$/ }) })
  await expect(raw).toHaveJSProperty('open', false)
  await card.getByRole('button', { name: '放大查看 页面截图', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '页面截图', exact: true })
  await expect(dialog).toBeVisible()
  const expanded = dialog.locator('.tool-browser-page__map')
  await expect(expanded.locator('path, circle, .tool-browser-elements-map__selected, .tool-browser-click__bounds')).toHaveCount(0)
  await expectMapScreenshot(expanded, displayResized)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  return card
}

test.describe.serial('AI 模型到内置浏览器完整闭环', () => {
  test.beforeAll(async () => {
    await new Promise<void>((done, reject) => {
      provider.once('error', reject)
      provider.listen(0, '127.0.0.1', done)
    })
    const address = provider.address()
    if (!address || typeof address === 'string')
      throw new Error('Missing browser fixture server address')
    origin = `http://127.0.0.1:${address.port}`
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
    fixture = mkdtempSync(join(root, '.e2e-tmp', 'browser-agent-ui-'))
    mkdirSync(join(fixture, 'workspace'), { recursive: true })
    mkdirSync(join(fixture, 'engine', 'secrets'), { recursive: true })
    writeFileSync(
      join(fixture, 'engine', 'secrets', 'engine-secrets.json'),
      JSON.stringify({ encrypted: false, encryptionKey: key })
    )
    writeFileSync(
      join(fixture, 'settings.json'),
      JSON.stringify({
        engineMode: 'embedded',
        preferredPort: 12457,
        autoStartEngine: true,
        lastSessionId: sessionId,
        lastModelId: model,
        lastFolder: join(fixture, 'workspace'),
        thinkingMode: 'off'
      })
    )
    const url = (file: string) => pathToFileURL(join(engineRoot, 'dist', file)).href
    const config = Object.fromEntries(
      Object.entries(env()).filter(([name]) =>
        [
          'LLM_PRIMARY_MODEL',
          'LLM_MODEL',
          'LLM_PROVIDER',
          'LLM_FALLBACK_MODEL',
          'ANTHROPIC_API_KEY',
          'ANTHROPIC_BASE_URL',
          'DEFAULT_SECURITY_MODE',
          'OSM_MODE',
          'MAX_ITERATIONS',
          'HISTORY_BACKEND'
        ].includes(name)
      )
    )
    const seed = `
      const {initDb,getDb}=await import(${JSON.stringify(url('storage/sqlite/db.js'))});
      const {ModelsStore}=await import(${JSON.stringify(url('storage/sqlite/models.js'))});
      const {systemConfigStore}=await import(${JSON.stringify(url('storage/sqlite/system-config.js'))});
      await initDb();
      await new ModelsStore().createModel({tenantId:'default',provider:'anthropic',modelId:${JSON.stringify(model)},apiKey:'local-browser-fixture-key',baseUrl:${JSON.stringify(origin)},displayName:'本地浏览器视觉测试',isEnabled:true,capabilities:{vision:true,toolCalling:true,parallelTools:true,streamUsage:true,contextWindow:128000}});
      for(const[name,value]of Object.entries(${JSON.stringify(config)}))await systemConfigStore.set(name,value,name==='ANTHROPIC_API_KEY');
      getDb().close();`
    execFileSync(process.execPath, ['--input-type=module', '-e', seed], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      env: { ...env(), DATA_DIR: join(fixture, 'engine', 'state', 'agent.db'), ENCRYPTION_KEY: key }
    })
    app = await electron.launch({
      args: ['.', `--user-data-dir=${fixture}`],
      cwd: root,
      env: env()
    })
    page = await app.firstWindow()
    page.on('pageerror', (error) => rendererErrors.push(String(error)))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
    await expect
      .poll(() => page.evaluate(() => window.aether.browser.getConnection()))
      .toMatchObject({ status: 'connected', sessionId })
  })
  test.afterAll(async () => {
    await app?.close()
    provider.closeAllConnections()
    await new Promise<void>((done) => provider.close(() => done()))
    if (!fixture) return
    const absolute = resolve(fixture)
    if (
      dirname(absolute) !== resolve(root, '.e2e-tmp') ||
      !basename(absolute).startsWith('browser-agent-ui-')
    )
      throw new Error('Unsafe fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  test('真实工具调用操作同一可见网页，并将截图像素与导航信息送回模型', async ({}, testInfo) => {
    await page
      .locator('.chat__input')
      .fill(
        '[browser-agent] 在内置浏览器打开本地页面，填写中文并点击，检查手机视口、截图、控制台和网络。'
      )
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect
      .poll(
        async () => {
          const status = (await recovery()).run?.status
          return status === 'succeeded' || status === 'failed'
        },
        { timeout: 90000 }
      )
      .toBe(true)
    expect(providerErrors).toEqual([])
    expect((await recovery()).run?.status).toBe('succeeded')
    await expect(page.locator('.message--assistant .message__content')).toHaveText(finalAnswer)
    await expect(page.getByRole('region', { name: '内置浏览器', exact: true })).toBeVisible()
    expect(requestedTools).toEqual(steps.map(toolName))
    expect(streamCount).toBe(steps.length + 1)
    expect(pingCount).toBe(1)
    const opened = outputs.get('open') as BrowserTabState
    const filled = outputs.get('fill') as BrowserSnapshot
    expect(filled.elements).toContainEqual(
      expect.objectContaining({ role: 'textbox', value: 'AI闭环中文' })
    )
    expect((outputs.get('click') as BrowserSnapshot).text).toContain('完成：AI闭环中文')
    expect((outputs.get('set_viewport') as BrowserSnapshot).viewport.width).toBe(390)
    expect(outputs.get('console')).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ message: 'AI_BROWSER_CONFIRMED' })
      ])
    })
    expect(outputs.get('network')).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ url: `${origin}/ping`, status: 200 })
      ])
    })
    const network = outputs.get('network') as BrowserNetworkList
    expect(network).toMatchObject({ total: 1, hasMore: false })
    expect(JSON.stringify(network)).not.toContain('请求详情中文')
    const detail = outputs.get('network_request') as BrowserNetworkDetail
    const continuation = outputs.get('network_request_more') as BrowserNetworkDetail
    expect(detail.entry.id).toBe(network.entries[0].id)
    expect(detail.response.headers).toContainEqual(
      expect.objectContaining({
        name: expect.stringMatching(/^x-fixture-trace$/i),
        value: 'browser-request-detail'
      })
    )
    expect(detail.response.body).toMatchObject({
      state: 'available',
      offset: 0,
      hasMore: true,
      nextOffset: 32
    })
    const responseBody = JSON.parse(
      (detail.response.body.text ?? '') + (continuation.response.body.text ?? '')
    )
    expect(responseBody).toMatchObject({
      ok: true,
      message: '请求详情中文',
      data: '可继续读取'.repeat(40)
    })
    expect(JSON.stringify([detail, continuation])).not.toContain('fixture-response-secret')
    expect(continuation.response.body.hasMore).toBe(false)
    const png = Buffer.from(pixels, 'base64')
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(png.byteLength).toBeGreaterThan(1000)
    expect(imageDescription).toContain(`"browserTabId":"${opened.tabId}"`)
    expect(imageDescription).toContain(`"navigationId":${opened.navigationId}`)
    expect(imageDescription).toContain('"cssViewport":{"width":390,"height":600')
    const actual = await app!.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find((wc) => wc.getURL() === url)
      if (!guest) throw new Error('Visible browser page missing')
      return guest.executeJavaScript(
        `({value:document.querySelector('#name').value,result:document.querySelector('#result').textContent,width:innerWidth,node:typeof require,bridge:typeof window.aether,click:window.__fixtureClick,inputs:window.__fixtureInputs,currentBounds:document.querySelector('#confirm').getBoundingClientRect().toJSON()})`
      )
    }, `${origin}/page`)
    expect(actual).toMatchObject({
      value: 'AI闭环中文',
      result: '完成：AI闭环中文',
      width: 390,
      node: 'undefined',
      bridge: 'undefined'
    })
    expect(actual.inputs).toEqual([
      { value: 'AI闭环中文', trusted: true },
      { value: 'AI闭环中文', trusted: true }
    ])
    const failedProviderResult = providerToolResults.get('click_closed')
    expect(failedProviderResult?.is_error, '模型必须明确知道操作失败，不能把 null 当成成功结果').toBe(true)
    expect(failedProviderResult?.content).not.toBe('null')
    const failure = outputs.get('click_closed') as { success: boolean; error: string; code: string; operationPerformed: boolean | 'unknown'; recovery: string }
    expect(failure).toMatchObject({ success: false, error: expect.stringContaining('标签已关闭'), operationPerformed: false })
    expect(failure.code).toMatch(/^BROWSER_/)
    expect(failure.recovery.length).toBeGreaterThan(0)
    expect(providerToolResults.get('recover_fill')?.is_error).not.toBe(true)
    expect((outputs.get('recover_fill') as BrowserSnapshot).elements).toContainEqual(expect.objectContaining({ role: 'textbox', value: 'AI闭环中文' }))
    const surviving = await page.evaluate(() => window.aether.browser.list())
    expect(surviving.filter(tab => tab.url === `${origin}/page`).map(tab => tab.tabId)).toEqual([opened.tabId])
    const clicked = outputs.get('click') as BrowserSnapshot
    const interaction = clicked.interaction
    expect(interaction, '真实 click 工具返回点击前的坐标、目标及视口').toBeDefined()
    if (!interaction) throw new Error('Missing click evidence in the provider result')
    expect(interaction).toMatchObject({ type: 'click', navigationId: opened.navigationId, pageUrl: `${origin}/page`, target: { name: '确认', role: 'button', selector: '#confirm' } })
    expect(actual.click).toMatchObject({ trusted: true, viewport: interaction.viewport })
    // Chromium may round MouseEvent CSS coordinates at fractional display scale.
    expect(Math.abs(actual.click.x - interaction.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(actual.click.y - interaction.y)).toBeLessThanOrEqual(1)
    const bounds = interaction.target?.bounds
    expect(bounds, 'selector 点击结果必须包含实际目标边界').toBeDefined()
    if (!bounds) throw new Error('Missing click target bounds')
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(actual.click.bounds[key] - bounds[key])).toBeLessThanOrEqual(1)
    expect(interaction.x).toBeGreaterThanOrEqual(bounds.x)
    expect(interaction.x).toBeLessThanOrEqual(bounds.x + bounds.width)
    expect(interaction.y).toBeGreaterThanOrEqual(bounds.y)
    expect(interaction.y).toBeLessThanOrEqual(bounds.y + bounds.height)
    const clickedButton = clicked.elements.find(element => element.role === 'button' && element.name === '确认')
    expect(clickedButton?.bounds, '普通元素列表应包含按钮真实边界，不能只把坐标保存在interaction里').toBeDefined()
    if (!clickedButton?.bounds) throw new Error('Missing clicked snapshot element bounds')
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(actual.click.bounds[key] - clickedButton.bounds[key])).toBeLessThanOrEqual(1)
    const resized = outputs.get('set_viewport') as BrowserSnapshot
    const resizedButton = resized.elements.find(element => element.role === 'button' && element.name === '确认')
    expect(resizedButton?.bounds, '非点击的视口快照也必须提供真实元素位置').toBeDefined()
    if (!resizedButton?.bounds) throw new Error('Missing viewport snapshot element bounds')
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(actual.currentBounds[key] - resizedButton.bounds[key])).toBeLessThanOrEqual(1)
    expect(rendererErrors).toEqual([])
    const history = (await recovery()).history
    for (const step of steps)
      expect(
        history.filter((row) => row.role === 'tool' && row.toolCallId === `browser-agent-${step}`)
      ).toHaveLength(1)
    for (const step of ['snapshot', 'fill', 'click', 'wait', 'set_viewport'] as const) {
      expectModelImageMetadata(outputs.get(step) as BrowserSnapshot, historySnapshot(history, step))
    }
    const failedHistory = history.find(row => row.role === 'tool' && row.toolCallId === 'browser-agent-click_closed')!
    expect(failedHistory.success ?? failedHistory.metadata?.success).toBe(false)
    expect(typeof failedHistory.content).toBe('string')
    expect(JSON.parse(String(failedHistory.content))).toMatchObject({ success: false, error: failure.error, operationPerformed: false })
    for (const summary of await page.locator('.process__summary').all()) {
      if (await summary.getAttribute('aria-expanded') !== 'true') await summary.click()
    }
    const failedRow = page.locator('.logline-wrap').filter({ has: page.locator('.logline__name--error', { hasText: /^点击浏览器元素$/ }) })
    await expect(failedRow).toHaveCount(1)
    const failedToggle = failedRow.locator('button.logline')
    if (await failedToggle.getAttribute('aria-expanded') !== 'true') await failedToggle.click()
    await expect(failedRow.locator('.message__error')).toContainText(failure.error)
    const screenshotRow = page.locator('.logline-wrap').filter({ has: page.locator('.logline__name', { hasText: /^浏览器截图$/ }) })
    const resultImage = screenshotRow.locator('.tool-result__preview img')
    await expect(resultImage).toBeVisible()
    await expect(screenshotRow.locator('.tool-result__image figcaption')).toHaveCount(0)
    await expect.poll(() => resultImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
    await screenshotRow.locator('.tool-result__preview').click()
    await expect(page.locator('.modal--tool-result-image img')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.modal--tool-result-image')).toHaveCount(0)
    await screenshotRow.locator('.tool-result__metadata summary').click()
    await expect(screenshotRow.locator('.tool-result__metadata')).not.toContainText('data:image/png;base64,')
    const snapshotCard = await expectClickSnapshotCard()
    const snapshotPath = testInfo.outputPath('agent-browser-click-snapshot-card.png')
    await snapshotCard.locator('.tool-browser-click').screenshot({ path: snapshotPath })
    await testInfo.attach('browser-click-snapshot-card', { path: snapshotPath, contentType: 'image/png' })
    const viewportCard = await expectPageSnapshotCard()
    const viewportPath = testInfo.outputPath('agent-browser-page-snapshot.png')
    await viewportCard.screenshot({ path: viewportPath })
    await testInfo.attach('browser-page-snapshot', { path: viewportPath, contentType: 'image/png' })
    await testInfo.attach('agent-browser-mobile.png', { body: png, contentType: 'image/png' })
    writeFileSync(testInfo.outputPath('agent-browser-mobile.png'), png)
    await page.screenshot({
      path: testInfo.outputPath('agent-browser-conversation.png'),
      fullPage: true
    })
  })

  test('刷新后纯页面截图和点击图保持可视化，不恢复元素列表且工具名称保持中文', async () => {
    await page.reload()
    const screenshotRow = page.locator('.logline-wrap').filter({ has: page.locator('.logline__name', { hasText: /^浏览器截图$/ }) })
    await expect(screenshotRow.locator('.tool-result__preview img')).toBeVisible()
    await expect.poll(() => screenshotRow.locator('.tool-result__preview img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
    await expectClickSnapshotCard()
    await expectPageSnapshotCard()
    expect(requestedTools).toEqual(steps.map(toolName))
    expect(streamCount).toBe(steps.length + 1)
    expect(rendererErrors).toEqual([])
  })

  test('查看对话用量浮层时，不会隐藏旁边正在显示的网页', async ({}, testInfo) => {
    const visible = () =>
      app!.evaluate(({ BrowserWindow, WebContentsView }, url) => {
        const host = BrowserWindow.getAllWindows()[0]
        return host.contentView.children.some(
          (view) =>
            view instanceof WebContentsView &&
            view.webContents.getURL() === url &&
            view.getVisible()
        )
      }, `${origin}/page`)
    for (const side of ['right', 'left']) {
      if (side === 'left')
        await page.getByRole('button', { name: '对话面板与主区换位', exact: true }).click()
      await expect.poll(visible).toBe(true)
      await page.getByTitle('查看本次问答的时间、耗时与 Token 明细', { exact: true }).click()
      const popup = page.getByRole('dialog', { name: '本次问答用量', exact: true })
      await expect(popup).toBeVisible()
      const panelRect = await popup.boundingBox(),
        surfaceRect = await page.getByLabel('网页内容区域', { exact: true }).boundingBox()
      expect(
        panelRect &&
          surfaceRect &&
          (panelRect.x >= surfaceRect.x + surfaceRect.width ||
            panelRect.x + panelRect.width <= surfaceRect.x)
      ).toBe(true)
      const native = await app!.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
        const host = BrowserWindow.getAllWindows()[0]
        const sources = await desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: { width: 1920, height: 1200 }
        })
        return sources
          .find((source) => source.id === host.getMediaSourceId())
          ?.thumbnail.toPNG()
          .toString('base64')
      })
      if (native)
        writeFileSync(
          testInfo.outputPath(`usage-popover-${side}-native-window.png`),
          Buffer.from(native, 'base64')
        )
      await expect.poll(visible, { timeout: 3000 }).toBe(true)
      await page.keyboard.press('Escape')
      await expect(popup).not.toBeVisible()
      await expect.poll(visible).toBe(true)
    }
    expect(rendererErrors).toEqual([])
  })

  test('用户停止真实运行会取消已派发且等待显示的点击，恢复后不出现迟到点击', async ({}, testInfo) => {
    const tab = (await page.evaluate(() => window.aether.browser.list())).find(item => item.tabId === (outputs.get('open') as BrowserTabState).tabId)!
    expect(tab).toBeDefined()
    const guestIds = await app!.evaluate(({ webContents }, url) => webContents.getAllWebContents().filter(wc => wc.getURL() === url).map(wc => wc.id), `${origin}/page`)
    expect(guestIds).toHaveLength(1)
    const guestId = guestIds[0]
    const clickEvidence = () => app!.evaluate(({ webContents }, id) => webContents.fromId(id)!
      .executeJavaScript('({count:window.__fixtureClickCount,event:window.__fixtureClick})'), guestId)
    const nativeVisible = () => app!.evaluate(({ BrowserWindow, WebContentsView }, id) => BrowserWindow.getAllWindows()[0].contentView.children
      .some(view => view instanceof WebContentsView && view.webContents.id === id && view.getVisible()), guestId)
    const before = await clickEvidence()
    const blocked: StopScenario = { mode: 'cancel', target: { tabId: tab.tabId, navigationId: tab.navigationId, selector: '#confirm' }, issued: false }
    stopScenario = blocked
    await app!.evaluate(() => {
      const owned = globalThis as typeof globalThis & {
        stopFixtureOriginalFetch?: typeof fetch
        stopFixtureWatchRequests?: string[]
        stopFixtureWatchReplies?: Array<{ url: string; active: boolean }>
      }
      if (owned.stopFixtureOriginalFetch) throw new Error('Previous request monitor was not restored')
      const original = globalThis.fetch
      owned.stopFixtureOriginalFetch = original
      owned.stopFixtureWatchRequests = []
      owned.stopFixtureWatchReplies = []
      // Observe actual HTTP replies. The fixture never fabricates cancellation,
      // replaces AbortSignals, or short-circuits the browser service.
      globalThis.fetch = async (...args) => {
        const input = args[0]
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        const watching = /\/browser\/clients\/[^/]+\/requests\/[^/]+\/state\?wait=true(?:&|$)/.test(url)
        if (watching) owned.stopFixtureWatchRequests!.push(url)
        const response = await original.apply(globalThis, args)
        if (watching) void response.clone().json().then((body: { data?: { active?: unknown } }) => {
          if (typeof body.data?.active === 'boolean') owned.stopFixtureWatchReplies!.push({ url, active: body.data.active })
        }).catch(() => {})
        return response
      }
    })
    await page.evaluate(() => {
      const owned = window as typeof window & { stopFixtureReveals?: string[]; stopFixtureUnsubscribe?: () => void }
      owned.stopFixtureReveals = []
      owned.stopFixtureUnsubscribe = window.aether.browser.onEvent(event => { if (event.type === 'reveal') owned.stopFixtureReveals!.push(event.tabId) })
    })
    try {
      await page.locator('.chat__input').fill('[browser-user-stop] 等待我的停止指令，测试取消浏览器点击。')
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await expect.poll(() => !!blocked.pendingResponse).toBe(true)
      await page.keyboard.press('Control+Shift+p')
      await expect(page.locator('.palette')).toBeVisible()
      await expect.poll(nativeVisible).toBe(false)
      blocked.issued = true
      stream(blocked.pendingResponse!, { type: 'tool_use', id: 'browser-user-stop', name: 'browser_click', input: blocked.target }, 'tool_use')
      blocked.pendingResponse = undefined
      await expect.poll(() => page.evaluate(() => (window as typeof window & { stopFixtureReveals?: string[] }).stopFixtureReveals))
        .toEqual([tab.tabId])
      const watchRequests = () => app!.evaluate(() => (globalThis as typeof globalThis & { stopFixtureWatchRequests?: string[] }).stopFixtureWatchRequests ?? [])
      await expect.poll(async () => (await watchRequests()).length).toBeGreaterThan(0)
      const watchedUrl = (await watchRequests())[0]
      const activeRun = (await recovery()).run!
      expect(activeRun.status).toBe('running')
      expect(await clickEvidence()).toEqual(before)
      // The command palette covers the Stop button. Use the very same endpoint
      // as useChat.abort without dismissing the guard that is holding the click.
      const cancelled = await page.evaluate(sessionId => window.aether.engine.request<{ cancelled: boolean }>({
        method: 'POST', path: '/chat/cancel', body: { sessionId }
      }), sessionId)
      expect(cancelled.ok, cancelled.message).toBe(true)
      expect(cancelled.data?.cancelled).toBe(true)
      await expect.poll(async () => (await recovery()).run?.status).toBe('cancelled')
      await expect.poll(() => app!.evaluate((_electron, url) => {
        const replies = (globalThis as typeof globalThis & { stopFixtureWatchReplies?: Array<{ url: string; active: boolean }> }).stopFixtureWatchReplies ?? []
        return replies.some(reply => reply.url === url && reply.active === false)
      }, watchedUrl), { message: '真实独立控制通道必须把运行取消送达客户端' }).toBe(true)
      expect(await clickEvidence()).toEqual(before)
      await expect(page.locator('.palette')).toBeVisible()
      expect((await page.evaluate(() => window.aether.browser.getConnection())).status).toBe('connected')
      await page.keyboard.press('Escape')
      await expect.poll(nativeVisible).toBe(true)
      const resumed: StopScenario = { mode: 'recover', target: blocked.target, issued: false }
      stopScenario = resumed
      await page.locator('.chat__input').fill('[browser-after-stop] 现在执行一次合法浏览器点击，检查恢复。')
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await expect.poll(async () => {
        const run = (await recovery()).run
        return run?.runId !== activeRun.runId && run?.status === 'succeeded'
      }, { timeout: 30000 }).toBe(true)
      expect(resumed.recoveredResult).toBeDefined()
      expect(resumed.recoveredResult?.is_error).not.toBe(true)
      expect(decode(resumed.recoveredResult!)).toMatchObject({ tab: { tabId: tab.tabId } })
      const after = await clickEvidence()
      expect(after.count, '新运行仅点击一次；已停止运行的点击不得在模态关闭后补发').toBe(before.count + 1)
      expect(after.event.trusted).toBe(true)
      expect((await recovery()).runs.find(run => run.runId === activeRun.runId)?.status).toBe('cancelled')
      expect(providerErrors).toEqual([])
      expect(rendererErrors).toEqual([])
      await testInfo.attach('user-stop-browser-evidence', { body: JSON.stringify({ before, after, cancelledRunId: activeRun.runId, watchedUrl }), contentType: 'application/json' })
    } finally {
      blocked.pendingResponse?.destroy()
      await page.evaluate(sessionId => window.aether.engine.request({ method: 'POST', path: '/chat/cancel', body: { sessionId } }), sessionId).catch(() => {})
      stopScenario = undefined
      await app!.evaluate(() => {
        const owned = globalThis as typeof globalThis & {
          stopFixtureOriginalFetch?: typeof fetch
          stopFixtureWatchRequests?: string[]
          stopFixtureWatchReplies?: Array<{ url: string; active: boolean }>
        }
        if (owned.stopFixtureOriginalFetch) globalThis.fetch = owned.stopFixtureOriginalFetch
        delete owned.stopFixtureOriginalFetch; delete owned.stopFixtureWatchRequests; delete owned.stopFixtureWatchReplies
      })
      await page.evaluate(() => {
        const owned = window as typeof window & { stopFixtureReveals?: string[]; stopFixtureUnsubscribe?: () => void }
        owned.stopFixtureUnsubscribe?.(); delete owned.stopFixtureUnsubscribe; delete owned.stopFixtureReveals
      })
      if (await page.locator('.palette').isVisible()) await page.keyboard.press('Escape')
    }
  })
})
