/** Fresh regression for the long-run oversized_frame failure: real Electron,
 * embedded ReAct, native click and PNG captures. Also checks the 268K default
 * context contract in both modes against a 1M-capable model. Only the provider is scripted. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AetherIdeApi } from '../src/preload'
import type { BrowserSnapshot, BrowserTabState } from '../src/shared/browser'
import type { StreamEvent } from '../src/shared/stream-event'
import type { ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

type ObservedWindow = Window & { aether: AetherIdeApi; budgetEvents: StreamEvent[] }
type Block = { type: string; text?: string; tool_use_id?: string; content?: string | Block[]; [key: string]: unknown }
type Body = { stream?: boolean; messages?: Array<{ content?: string | Block[] }>; tools?: Array<{ name: string }> }
type Receipt = { toolCallId: string; output: string; metadata?: { browserOutputRecovery?: { originalFrameBytes: number; omittedImages: string[] } }; [key: string]: unknown }
const root = resolve(__dirname, '..'), engineRoot = process.env.AETHER_E2E_ENGINE_ROOT || resolve(root, '..', 'ai-agent-engine')
const model = 'publication-byte-budget-local', key = 'c'.repeat(64), limit = 1024 * 1024
const steps = ['open', 'set_viewport', 'click', 'console'] as const
type Step = typeof steps[number]
const outputs = new Map<Step, unknown>(), providerErrors: string[] = [], rendererErrors: string[] = []
const answer = '大截图点击成功，后续控制台工具与最终回复均已送达。'
let fixture = '', origin = '', sessionId = '', app: ElectronApplication | undefined, page: Page, health: ElectronHealthMonitor | undefined

// High-entropy pixels force two genuine preview images over one frame's budget.
// The native browser owns resizing/capture; the test never replaces tool output.
const html = `<!doctype html><meta charset="utf-8"><title>大截图真实点击回归</title>
<style>html,body{margin:0;overflow:hidden}canvas{position:fixed;inset:0;width:100vw;height:100vh}button,p{position:fixed;z-index:1;left:20px;font:20px sans-serif;padding:12px;background:white}button{top:20px}p{top:70px}</style>
<canvas></canvas><button id="confirm">确认真实点击</button><p id="result">尚未点击</p><script>
function paint(){const c=document.querySelector('canvas');c.width=innerWidth;c.height=innerHeight;const x=c.getContext('2d'),im=x.createImageData(c.width,c.height);let s=123456789;for(let i=0;i<im.data.length;i+=4){s^=s<<13;s^=s>>>17;s^=s<<5;im.data[i]=s&255;im.data[i+1]=(s>>>8)&255;im.data[i+2]=(s>>>16)&255;im.data[i+3]=255}x.putImageData(im,0,0)}paint();addEventListener('resize',paint);
window.actualClicks=0;document.querySelector('#confirm').onclick=e=>{window.actualClicks++;window.trustedClick=e.isTrusted;document.querySelector('#result').textContent='真实点击完成';console.log('BUDGET_CLICK_CONFIRMED')};</script>`

function respond(response: ServerResponse, block: Block, stop = 'end_turn'): void {
  const frames = [
    { type: 'message_start', message: { id: 'budget-response', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: block }, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } }, { type: 'message_stop' }
  ]
  response.writeHead(200, { 'Content-Type': 'text/event-stream;charset=utf-8' })
  response.end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''))
}
const provider = createServer((request, response) => {
  void (async () => {
    if (request.url === '/page') { response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }).end(html); return }
    if (request.method !== 'POST') { response.writeHead(404).end(); return }
    let raw = ''; request.setEncoding('utf8'); for await (const chunk of request) raw += String(chunk)
    const body = JSON.parse(raw) as Body
    if (!body.stream) {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'budget-aux', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: '大截图回归' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } })); return
    }
    const results = (body.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content : [])
    for (const step of steps) {
      const result = results.find(block => block.type === 'tool_result' && block.tool_use_id === 'budget-' + step)
      if (!outputs.has(step) && result) {
        if (typeof result.content !== 'string') throw new Error('Expected semantic tool result for ' + step)
        outputs.set(step, JSON.parse(result.content))
      }
    }
    const step = steps.find(value => !outputs.has(value))
    if (!step) { respond(response, { type: 'text', text: answer }); return }
    const name = 'browser_' + step
    if (!body.tools?.some(tool => tool.name === name)) throw new Error('Missing advertised tool ' + name)
    const tab = outputs.get('open') as BrowserTabState | undefined
    const latest = outputs.get('set_viewport') as BrowserSnapshot | undefined
    const input = step === 'open' ? { url: origin + '/page' }
      : step === 'set_viewport' ? { tabId: tab!.tabId, navigationId: tab!.navigationId, viewport: { width: 1000, height: 800, mobile: false, deviceScaleFactor: 1 } }
      : { tabId: tab!.tabId, navigationId: latest!.tab.navigationId, ...(step === 'click' ? { selector: '#confirm' } : {}) }
    respond(response, { type: 'tool_use', id: 'budget-' + step, name, input }, 'tool_use')
  })().catch(error => { providerErrors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(JSON.stringify({ error: { message: String(error) } })) })
})

function environment(): NodeJS.ProcessEnv {
  const result = { ...process.env, AETHER_IDE_ENGINE_ENTRY: join(engineRoot, 'dist/main.js'), AUTH_ENABLED: 'false', HISTORY_BACKEND: 'jsonl',
    LLM_PROVIDER: 'anthropic', LLM_PRIMARY_MODEL: model, LLM_MODEL: model, LLM_FALLBACK_MODEL: '', ANTHROPIC_API_KEY: 'local-byte-budget-key', ANTHROPIC_BASE_URL: origin,
    DEFAULT_SECURITY_MODE: 'safe', OSM_MODE: 'balanced', MAX_ITERATIONS: '12', ENABLE_LONG_TERM_MEMORY: 'false',
    AETHER_GLOBAL_DIR: join(fixture, 'global'), WORKSPACE_ROOT: join(fixture, 'sandboxes'), MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills') }
  delete result.ELECTRON_RUN_AS_NODE; delete result.ELECTRON_RENDERER_URL
  return result
}
async function snapshot(): Promise<ChatRecoverySnapshot> {
  const result = await page.evaluate(sessionId => (window as ObservedWindow).aether.engine.request<ChatRecoverySnapshot>({ method: 'GET', path: '/chat/snapshot', query: { sessionId } }), sessionId)
  expect(result.ok, result.message).toBe(true); return result.data!
}
function latestRequestWindow(value: ChatRecoverySnapshot): number | undefined {
  for (const row of [...value.history].reverse()) {
    const usage = row.usage
    if (row.role === 'assistant' && usage && typeof usage === 'object' && 'contextWindow' in usage && typeof usage.contextWindow === 'number') return usage.contextWindow
  }
  return undefined
}

test('真实双截图超出单帧预算时，点击证据完整持久化且后续工具与终态继续显示', async ({}, testInfo) => {
  test.setTimeout(240_000)
  try {
    await new Promise<void>((done, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', done) })
    const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Missing provider address')
    origin = `http://127.0.0.1:${address.port}`
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true }); fixture = mkdtempSync(join(root, '.e2e-tmp', 'browser-budget-'))
    mkdirSync(join(fixture, 'workspace'), { recursive: true }); mkdirSync(join(fixture, 'engine', 'secrets'), { recursive: true })
    writeFileSync(join(fixture, 'engine', 'secrets', 'engine-secrets.json'), JSON.stringify({ encrypted: false, encryptionKey: key }))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'embedded', preferredPort: 12467, autoStartEngine: true, lastSessionId: 'browser-budget-session', lastModelId: model, lastFolder: join(fixture, 'workspace'), thinkingMode: 'off' }))
    const url = (file: string) => pathToFileURL(join(engineRoot, 'dist', file)).href
    const config = Object.fromEntries(Object.entries(environment()).filter(([name]) => ['LLM_PRIMARY_MODEL', 'LLM_MODEL', 'LLM_PROVIDER', 'LLM_FALLBACK_MODEL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'DEFAULT_SECURITY_MODE', 'OSM_MODE', 'MAX_ITERATIONS', 'HISTORY_BACKEND'].includes(name)))
    const seed = `const {initDb,getDb}=await import(${JSON.stringify(url('storage/sqlite/db.js'))});const {ModelsStore}=await import(${JSON.stringify(url('storage/sqlite/models.js'))});const {systemConfigStore}=await import(${JSON.stringify(url('storage/sqlite/system-config.js'))});await initDb();await new ModelsStore().createModel({tenantId:'default',provider:'anthropic',modelId:${JSON.stringify(model)},apiKey:'local-byte-budget-key',baseUrl:${JSON.stringify(origin)},displayName:'截图字节预算真实回归',isEnabled:true,capabilities:{vision:true,toolCalling:true,parallelTools:true,streamUsage:true,contextWindow:1000000}});for(const[name,value]of Object.entries(${JSON.stringify(config)}))await systemConfigStore.set(name,value,name==='ANTHROPIC_API_KEY');getDb().close();`
    execFileSync(process.execPath, ['--input-type=module', '-e', seed], { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...environment(), DATA_DIR: join(fixture, 'engine', 'state', 'agent.db'), ENCRYPTION_KEY: key } })
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env: environment() })
    health = await monitorElectronHealth(app, 'browser-budget'); page = await app.firstWindow()
    page.on('pageerror', error => rendererErrors.push(String(error)))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
    await expect.poll(() => page.evaluate(() => (window as ObservedWindow).aether.browser.getConnection())).toMatchObject({ status: 'connected' })
    sessionId = (await page.evaluate(() => (window as ObservedWindow).aether.browser.getConnection())).sessionId!
    await page.evaluate(() => { const target = window as ObservedWindow; target.budgetEvents = []; target.aether.engine.onStreamEvent(event => { if (target.budgetEvents.length < 500) target.budgetEvents.push(event) }) })
    await page.locator('.chat__input').fill('打开本地高熵页面，在 1000×800 视口真实点击确认按钮，读取控制台后给出结果。')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.locator('.message--assistant .message__content')).toHaveText(answer, { timeout: 90000 })
    const recovered = await snapshot(); expect(recovered.run?.status).toBe('succeeded')
    expect(latestRequestWindow(recovered)).toBe(268000)
    await expect(page.locator('#mode-code .context-ring')).toHaveAttribute('aria-label', /268,000 tokens/)
    expect(providerErrors).toEqual([]); expect(rendererErrors).toEqual([]); expect([...outputs.keys()]).toEqual([...steps])
    expect(outputs.get('console')).toMatchObject({ entries: expect.arrayContaining([expect.objectContaining({ message: 'BUDGET_CLICK_CONFIRMED' })]) })
    const actual = await app.evaluate(async ({ webContents }, origin) => {
      const guest = webContents.getAllWebContents().find(contents => contents.getURL() === origin + '/page')
      if (!guest) throw new Error('Real guest disappeared')
      return guest.executeJavaScript('({clicks:window.actualClicks,trusted:window.trustedClick,text:document.querySelector("#result").textContent})')
    }, origin)
    expect(actual).toEqual({ clicks: 1, trusted: true, text: '真实点击完成' })
    const rows = recovered.history.filter(row => row.role === 'tool' && row.toolCallId === 'budget-click'); expect(rows).toHaveLength(1)
    expect(typeof rows[0].content).toBe('string'); const durable = JSON.parse(String(rows[0].content)) as BrowserSnapshot
    expect(durable.screenshot?.dataUrl).toMatch(/^data:image\/png;base64,iVBOR/); expect(durable.interaction?.screenshot?.dataUrl).toMatch(/^data:image\/png;base64,iVBOR/)
    const events = await page.evaluate(() => (window as ObservedWindow).budgetEvents)
    expect(events.filter(event => event.type === 'error' || event.type === 'snapshot-required')).toEqual([])
    const receipts = events.flatMap(event => event.type === 'payload' ? [event.payload.toolEnd, event.payload.toolResult].filter(Boolean) as Receipt[] : [])
    const clicked = receipts.filter(receipt => receipt.toolCallId === 'budget-click'); expect(clicked).toHaveLength(2)
    for (const receipt of clicked) {
      expect(Buffer.byteLength('\x00__tool_result__' + JSON.stringify(receipt))).toBeLessThanOrEqual(limit)
      expect(receipt.metadata?.browserOutputRecovery?.originalFrameBytes).toBeGreaterThan(limit)
      const original = { ...receipt, output: rows[0].content, metadata: { ...receipt.metadata } }; delete original.metadata.browserOutputRecovery
      expect(Buffer.byteLength(JSON.stringify(original))).toBeGreaterThan(limit)
      const streamed = JSON.parse(receipt.output) as BrowserSnapshot
      expect(streamed.screenshot).toMatchObject({ omittedFromStream: true, retainedInHistory: true })
      expect(streamed.interaction?.screenshot?.dataUrl === durable.interaction?.screenshot?.dataUrl).toBe(true)
    }
    for (const summary of await page.locator('.process__summary').all()) if (await summary.getAttribute('aria-expanded') !== 'true') await summary.click()
    const clickRow = page.locator('.logline-wrap').filter({ has: page.locator('.logline__name', { hasText: /^点击浏览器元素$/ }) })
    await expect(clickRow).toHaveCount(1); const toggle = clickRow.locator('button.logline'); if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
    await expect(clickRow.locator('.tool-browser-click')).toContainText('点击前画面')
    expect(await clickRow.locator('.tool-browser-position__image').getAttribute('href') === durable.interaction?.screenshot?.dataUrl).toBe(true)
    const evidence = { sessionId, terminalStatus: recovered.run?.status, trustedClick: actual, durableImageBytes: [durable.screenshot!, durable.interaction!.screenshot!].map(image => Buffer.from(image.dataUrl.split(',')[1], 'base64').length),
      streamFrameBytes: clicked.map(receipt => Buffer.byteLength('\x00__tool_result__' + JSON.stringify(receipt))), recovery: clicked[0].metadata?.browserOutputRecovery, providerErrors, rendererErrors }
    const report = testInfo.outputPath('browser-byte-budget-evidence.json'); writeFileSync(report, JSON.stringify(evidence, null, 2)); await testInfo.attach('browser-byte-budget-evidence', { path: report, contentType: 'application/json' })
    await page.screenshot({ path: testInfo.outputPath('browser-byte-budget.png') })
    const codeSessionId = sessionId
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    const work = page.locator('#mode-work')
    await work.getByRole('textbox', { name: '任务目标', exact: true }).fill('验证本次 Work 请求使用默认 268K 上下文预算，简短回复。')
    const start = work.getByRole('button', { name: '开始任务', exact: true })
    await expect(start).toBeEnabled(); await start.click()
    await expect(work.locator('.work-message--assistant')).toContainText(answer, { timeout: 30000 })
    sessionId = (await page.evaluate(() => (window as ObservedWindow).aether.browser.getConnection())).sessionId!
    expect(sessionId).not.toBe(codeSessionId)
    const workSnapshot = await snapshot()
    expect(workSnapshot.run?.status).toBe('succeeded')
    expect(latestRequestWindow(workSnapshot)).toBe(268000)
    await expect(work.locator('.context-ring')).toHaveAttribute('aria-label', /268,000 tokens/)
    const catalog = await page.evaluate(() => (window as ObservedWindow).aether.engine.request<{
      modelId: string; effectiveContextWindow?: number; resolvedCapabilities?: { contextWindow?: number }
    }[]>({ method: 'GET', path: '/models' }))
    expect(catalog.data?.find(item => item.modelId === model)).toMatchObject({ effectiveContextWindow: 268000, resolvedCapabilities: { contextWindow: 1000000 } })
    await testInfo.attach('context-default-both-modes', { contentType: 'application/json', body: JSON.stringify({ codeSessionId, workSessionId: sessionId,
      codeContext: latestRequestWindow(recovered), workContext: latestRequestWindow(workSnapshot), modelCapability: 1000000 }) })
    await page.screenshot({ path: testInfo.outputPath('context-work-268k.png') }); health.assertHealthy()
  } finally {
    try { if (health) await health.closeAndAssert(testInfo); else await app?.close() }
    finally {
      provider.closeAllConnections(); await new Promise<void>(done => provider.close(() => done()))
      if (fixture) { const absolute = resolve(fixture); if (dirname(absolute) !== resolve(root, '.e2e-tmp') || !basename(absolute).startsWith('browser-budget-')) throw new Error('Unsafe budget fixture cleanup'); rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    }
  }
})
