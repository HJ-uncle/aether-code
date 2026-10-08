/** Real Electron + engine + deterministic local Anthropic SSE: model tools control the visible guest and receive actual screenshot image blocks. */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
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
const finalAnswer = '已完成真实浏览器验证：中文输入、按钮、手机视口、截图、控制台和网络均通过。'
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
  'network_request_more'
] as const
type Step = (typeof steps)[number]
const toolName = (step: Step): string =>
  `browser_${step === 'network_request_more' ? 'network_request' : step}`
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
let fixture = '',
  origin = '',
  app: ElectronApplication | undefined,
  page: Page
let pingCount = 0,
  streamCount = 0,
  pixels = '',
  imageDescription = ''
const outputs = new Map<Step, unknown>()
const requestedTools: string[] = []
const providerErrors: string[] = []
const rendererErrors: string[] = []
const pageHtml = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI 浏览器闭环夹具</title><style>body{font:18px sans-serif;margin:24px}input,button{font:inherit;padding:8px}canvas{display:block;background:#edd7a7;margin-top:16px}</style></head><body><h1>AI 可视化测试页面</h1><label for="name">名称</label><input id="name" value="初始值"><button id="confirm">确认</button><p id="result">等待输入</p><p id="network">网络未请求</p><canvas width="220" height="180"></canvas><script>document.querySelector('#confirm').onclick=async()=>{document.querySelector('#result').textContent='完成：'+document.querySelector('#name').value;console.log('AI_BROWSER_CONFIRMED');await fetch('/ping');document.querySelector('#network').textContent='网络完成'};const c=document.querySelector('canvas').getContext('2d');c.beginPath();c.arc(90,90,24,0,Math.PI*2);c.fill();</script></body></html>`

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
  if (step === 'open') return { url: `${origin}/page` }
  const tab = outputs.get('open') as BrowserTabState | undefined
  if (!tab?.tabId) throw new Error('browser_open did not return a tabId')
  if (step === 'snapshot') return { tabId: tab.tabId }
  const snapshot = outputs.get('snapshot') as BrowserSnapshot | undefined
  if (!snapshot || !Number.isInteger(snapshot.tab?.navigationId))
    throw new Error('snapshot did not return navigation identity')
  const target = { tabId: tab.tabId, navigationId: snapshot.tab.navigationId }
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
        `({value:document.querySelector('#name').value,result:document.querySelector('#result').textContent,width:innerWidth,node:typeof require,bridge:typeof window.aether})`
      )
    }, `${origin}/page`)
    expect(actual).toEqual({
      value: 'AI闭环中文',
      result: '完成：AI闭环中文',
      width: 390,
      node: 'undefined',
      bridge: 'undefined'
    })
    expect(rendererErrors).toEqual([])
    const history = (await recovery()).history
    for (const step of steps)
      expect(
        history.filter((row) => row.role === 'tool' && row.toolCallId === `browser-agent-${step}`)
      ).toHaveLength(1)
    await testInfo.attach('agent-browser-mobile.png', { body: png, contentType: 'image/png' })
    writeFileSync(testInfo.outputPath('agent-browser-mobile.png'), png)
    await page.screenshot({
      path: testInfo.outputPath('agent-browser-conversation.png'),
      fullPage: true
    })
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
})
