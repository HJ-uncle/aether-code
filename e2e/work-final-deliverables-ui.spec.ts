/** Real Electron + engine + local model provider. Only model responses are fixtures:
 * execute_cmd creates real PNGs/files, deliver_files stages immutable snapshots,
 * and successful final publication owns the visible result. Covers source deletion
 * plus full restart, same-path versions across turns, process-only images and failed
 * or cancelled publication. No renderer state or final-result receipts are injected. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AetherIdeApi } from '../src/preload'
import type { FinalResult, FinalResultItem } from '../src/shared/final-result'
import type { RootRun } from '../src/shared/root-run'
import type { ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import { monitorElectronHealth, type ElectronHealthMonitor } from './helpers/electron-health'

declare global { interface Window { aether: AetherIdeApi } }

type Scenario = 'first' | 'second' | 'text' | 'process' | 'failed' | 'cancelled' | 'tool_image'
type ModelMessage = { role: string; content?: unknown; tool_call_id?: string }
type ModelBody = { stream?: boolean; messages: ModelMessage[]; tools?: Array<{ function: { name: string } }> }
type Step = { name: string; args: Record<string, unknown> }
type StoredRow = EngineHistoryRow & { metadata?: EngineHistoryRow['metadata'] & { finalResult?: FinalResult } }
type Asset = { path: string; content: string; isBinary: boolean; totalSize: number; tooLarge: boolean;
  truncated: boolean; mimeType: string; encoding: 'base64' | 'utf8' }

const root = resolve(__dirname, '..'), engineRoot = resolve(root, '..', 'ai-agent-engine')
const engineEntry = process.env.AETHER_E2E_ENGINE_ENTRY ? resolve(process.env.AETHER_E2E_ENGINE_ENTRY) : join(engineRoot, 'dist/main.js')
const model = 'work-final-deliverables-fixture', sessionId = 'work-final-deliverables-session'
const encryptionKey = '8'.repeat(64), apiKey = 'final-deliverables-local-key'
const imagePath = 'deliverables/最终 图 100% #+.png', reportPath = 'deliverables/交付说明.md'
const draftPath = 'process/draft.png', logPath = 'process/test.log', workerPath = '.ae/tmp/final-deliverables.cjs'
const imageName = '最终成品.png', reportName = '交付说明.md', draftName = '待替换草稿.png'
const finalText: Record<Scenario, string> = {
  first: 'FINAL_DELIVERY_FIRST：成品图和报告已交付。\n\n![未交付的过程草稿](<process/draft.png>)',
  second: 'FINAL_DELIVERY_SECOND：已交付同一路径的新版本。',
  text: 'FINAL_DELIVERY_TEXT：这一轮只有文字说明，没有新的交付物。',
  process: 'FINAL_DELIVERY_PROCESS：已查看检查图，本轮没有交付成品。',
  failed: 'FINAL_DELIVERY_FAILED_MUST_NOT_APPEAR',
  cancelled: 'FINAL_DELIVERY_CANCELLED_MUST_NOT_APPEAR',
  tool_image: 'FINAL_DELIVERY_TOOL_IMAGE：已明确交付查看工具返回的这张图片。'
}
const steps = (scenario: Scenario): Step[] => {
  if (scenario === 'text') return []
  const command: Step = { name: 'execute_cmd', args: { command: 'node', args: [workerPath, scenario], timeoutMs: 10000 } }
  const inspect: Step = { name: 'read_file', args: { path: draftPath, mode: 'vision' } }
  if (scenario === 'process') return [command, inspect]
  if (scenario === 'tool_image') return [command, inspect, { name: 'deliver_files', args: {
    items: [{ toolCallId: callId(scenario, 1), imageIndex: 0, name: '显式交付的查看图.png' }]
  } }]
  const deliver: Step = { name: 'deliver_files', args: { items: [{ path: imagePath, name: imageName }, { path: reportPath, name: reportName }] } }
  return scenario === 'first'
    ? [command, inspect, { name: 'read_file', args: { path: logPath, mode: 'full' } },
      { name: 'deliver_files', args: { items: [{ path: draftPath, name: draftName }] } }, deliver]
    : [command, deliver]
}

let fixture = '', baseUrl = '', app: ElectronApplication | undefined, page: Page
let health: ElectronHealthMonitor | undefined, launches = 0
const errors: string[] = [], requests: Array<{ scenario: Scenario; toolCalls: number }> = []
const advertised = new Set<string>(), received = new Map<string, string>()
const gates = new Map<Scenario, { response: ServerResponse; body: ModelBody }>()
const released = new Set<Scenario>(), rejectFinal = new Set<Scenario>()
const runs = new Map<Scenario, RootRun>(), manifests = new Map<Scenario, FinalResult>()
let firstImage: Buffer, firstReport: Buffer, secondImage: Buffer
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const workspace = (): string => join(fixture, 'workspace')
const local = (path: string): string => join(workspace(), path)
const callId = (scenario: Scenario, index: number): string => `delivery-${scenario}-${index}`
const ledger = (): string[] => readFileSync(local('.ae/tmp/executions.txt'), 'utf8').trim().split('\n')

// The command itself encodes image pixels; the test never prewrites the delivered
// files or supplies their bytes in model output, SSE, storage or renderer state.
const worker = String.raw`const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const variant = process.argv[2];
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(kind, data) { const name = Buffer.from(kind), size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([size, name, data, checksum]); }
function png(width, height, color) { const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const offset = y * (width * 4 + 1) + 1 + x * 4; for (let c = 0; c < 4; c++) scanlines[offset + c] = color[c]; }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]); }
for (const directory of ['deliverables', 'process', '.ae/tmp']) fs.mkdirSync(directory, { recursive: true });
fs.appendFileSync('.ae/tmp/executions.txt', variant + '\n');
fs.writeFileSync('process/draft.png', png(80, 48, [230, 145, 50, 255]));
fs.writeFileSync('process/test.log', 'PROCESS_TEST_LOG_' + variant + ': verification output belongs to the process.\n');
if (variant !== 'process') {
  const second = variant === 'second';
  fs.writeFileSync(${JSON.stringify(imagePath)}, png(second ? 96 : 160, second ? 64 : 96, second ? [50, 110, 220, 255] : [210, 65, 75, 255]));
  fs.writeFileSync(${JSON.stringify(reportPath)}, '# 交付说明\n\nREAL_REPORT_' + variant + '\n');
}
console.log('REAL_GENERATION_' + variant + ': draft image and test log remain process evidence.');`

function respond(response: ServerResponse, body: ModelBody, text: string, scenario?: Scenario, index?: number): void {
  const step = scenario !== undefined && index !== undefined ? steps(scenario)[index] : undefined
  const toolCalls = step ? [{ id: callId(scenario!, index!), type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] : []
  const finish = toolCalls.length ? 'tool_calls' : 'stop'
  if (body.stream) {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ id: 'final-delivery', model, choices: [{ index: 0, delta: { role: 'assistant', content: text,
      ...(toolCalls.length ? { tool_calls: toolCalls.map((call, index) => ({ ...call, index })) } : {}) }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ id: 'final-delivery', model, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`)
    response.end('data: [DONE]\n\n')
  } else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'final-delivery', model,
    choices: [{ index: 0, message: { role: 'assistant', content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }))
}
function failProvider(response: ServerResponse): void {
  response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: {
    message: 'FINAL_DELIVERABLES_PROVIDER_FAILURE: staged files are not a successful final answer', type: 'invalid_request_error', code: 'fixture_failure'
  } }))
}
const provider = createServer((incoming, response) => {
  void (async () => {
    let raw = ''; for await (const part of incoming) raw += String(part)
    const body = JSON.parse(raw) as ModelBody
    const marker = [...body.messages].reverse().find(message => message.role === 'user' &&
      /\[final-deliverables:(first|second|text|process|failed|cancelled|tool_image)\]/.test(JSON.stringify(message.content)))
    const scenario = marker && JSON.stringify(marker.content).match(/\[final-deliverables:(first|second|text|process|failed|cancelled|tool_image)\]/)?.[1] as Scenario | undefined
    if (!scenario) { respond(response, body, 'Local fixture ready.'); return }
    for (const tool of body.tools ?? []) advertised.add(tool.function.name)
    for (const message of body.messages) if (message.role === 'tool' && message.tool_call_id?.startsWith(`delivery-${scenario}-`)) {
      received.set(message.tool_call_id, typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
    }
    let index = 0; while (received.has(callId(scenario, index))) index++
    requests.push({ scenario, toolCalls: index })
    if (index < steps(scenario).length) {
      const note = scenario === 'first' && index === 0 ? 'PROCESS_NOTE_first：先生成草稿并检查日志，过程信息不属于交付说明。' : ''
      respond(response, body, note, scenario, index); return
    }
    if (rejectFinal.has(scenario)) { failProvider(response); return }
    if (['first', 'second', 'failed', 'cancelled'].includes(scenario) && !released.has(scenario)) {
      gates.set(scenario, { response, body }); return
    }
    respond(response, body, finalText[scenario])
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})
function release(scenario: Scenario): void {
  const gate = gates.get(scenario)
  if (!gate || gate.response.destroyed) throw new Error(`Missing live provider gate: ${scenario}`)
  released.add(scenario); gates.delete(scenario)
  respond(gate.response, gate.body, finalText[scenario])
}

function environment(): Record<string, string> {
  const env: NodeJS.ProcessEnv = { ...process.env, AETHER_IDE_ENGINE_ENTRY: engineEntry, AUTH_ENABLED: 'false', HISTORY_BACKEND: 'jsonl',
    LLM_PROVIDER: 'openai', LLM_PRIMARY_MODEL: model, LLM_MODEL: model, LLM_FALLBACK_MODEL: '', OPENAI_API_KEY: apiKey, OPENAI_BASE_URL: baseUrl,
    DEFAULT_SECURITY_MODE: 'standard', OSM_MODE: 'methodology', MAX_ITERATIONS: '12', ENABLE_LONG_TERM_MEMORY: 'false',
    AETHER_GLOBAL_DIR: join(fixture, 'global'), WORKSPACE_ROOT: join(fixture, 'sandboxes'), AETHER_ALLOWED_WORKSPACE_ROOTS: workspace(),
    MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills') }
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL'].includes(key.toUpperCase())) delete env[key]
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}
async function launch(): Promise<void> {
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || '.', `--user-data-dir=${fixture}`], cwd: root, env: environment() })
  health = await monitorElectronHealth(app, `final-delivery-${++launches}`, [apiKey])
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(String(error)))
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
  await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
}
const work = (): Locator => page.locator('.work-view')
const conversation = (): Locator => work().getByRole('region', { name: '协作对话', exact: true })
const turn = (run: RootRun): Locator => conversation().locator('.work-conversation-turn').filter({ has: page.locator(`[data-message-id="${run.userMessageId}"]`) })
const delivery = (run: RootRun): Locator => turn(run).getByRole('region', { name: '最终交付物', exact: true })
  .and(page.locator(`[data-final-result-run="${run.runId}"]`))
async function snapshot(): Promise<ChatRecoverySnapshot> {
  const result = await page.evaluate(sessionId => window.aether.engine.request<ChatRecoverySnapshot>({ method: 'GET', path: '/chat/snapshot', query: { sessionId } }), sessionId)
  expect(result.ok, result.message).toBe(true)
  return result.data!
}
async function send(scenario: Scenario): Promise<void> {
  await work().getByRole('textbox', { name: '继续对话', exact: true }).fill(`[final-deliverables:${scenario}] 请完成本轮任务，仅明确交付最终文件。`)
  await work().getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => requests.some(request => request.scenario === scenario), { timeout: 90000 }).toBe(true)
}
async function drive(scenario: Scenario, target: 'gate' | 'succeeded'): Promise<RootRun> {
  for (let attempt = 0; attempt < 8; attempt++) {
    let state = 'running'
    await expect.poll(async () => {
      const current = (await snapshot()).run
      state = current?.status === 'waiting' ? 'waiting' : target === 'gate' && gates.has(scenario) ? 'gate'
        : current && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(current.status) ? current.status : 'running'
      return state
    }, { timeout: 90000, message: `Waiting for real ${scenario} run or its policy approval` }).not.toBe('running')
    if (state === target) {
      const current = (await snapshot()).run!
      runs.set(scenario, current)
      return current
    }
    expect(state, `${scenario} must reach ${target} or a real approval`).toBe('waiting')
    const allow = work().getByRole('button', { name: '允许执行', exact: true }).last()
    await expect(allow).toBeVisible({ timeout: 30000 }); await allow.click()
  }
  throw new Error(`Too many approvals in ${scenario}`)
}
async function published(scenario: Scenario): Promise<FinalResult> {
  const current = await drive(scenario, 'succeeded')
  const response = await page.evaluate(({ sessionId, anchor }) => window.aether.engine.request<{ messages: StoredRow[] }>({
    method: 'GET', path: '/conversation/display', query: { sessionId, anchorMessageId: anchor, limit: '1' }
  }), { sessionId, anchor: current.userMessageId })
  expect(response.ok, response.message).toBe(true)
  const rows = response.data!.messages.filter(row => row.metadata?.finalResult)
  expect(rows).toHaveLength(1)
  const manifest = rows[0].metadata!.finalResult!
  expect(rows[0].role).toBe('assistant')
  expect(rows[0].id).toBe(manifest.assistantMessageId)
  expect(manifest).toMatchObject({ schemaVersion: 1, sessionId, runId: current.runId, turnId: current.turnId, text: finalText[scenario] })
  expect(manifest.publishedAt).toBeGreaterThanOrEqual(current.createdAt)
  if (scenario !== 'first') expect(manifest.text).not.toContain('![')
  expect(manifest.text).not.toContain('data:image')
  manifests.set(scenario, manifest)
  return manifest
}
async function asset(result: FinalResult, item: FinalResultItem): Promise<Buffer> {
  const response = await page.evaluate(({ sessionId, runId, assetId }) => window.aether.engine.request<Asset>({
    method: 'GET', path: '/conversation/result-asset', query: { sessionId, runId, assetId }
  }), { sessionId, runId: result.runId, assetId: item.assetId })
  expect(response.ok, response.message).toBe(true)
  expect(response.data).toMatchObject({ totalSize: item.size, tooLarge: false, truncated: false, mimeType: item.mimeType })
  const data = response.data!
  const bytes = Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8')
  expect(bytes.byteLength).toBe(item.size)
  expect(item.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(digest(bytes)).toBe(item.sha256)
  return bytes
}
async function expectRenderedImage(image: Locator, expected: Buffer, width: number, height: number): Promise<void> {
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate(element => ({ width: (element as HTMLImageElement).naturalWidth,
    height: (element as HTMLImageElement).naturalHeight }))).toEqual({ width, height })
  // Reading the rendered pixels avoids a fetch(blob:) request rejected by
  // connect-src, while still detecting a wrong image with identical dimensions.
  const pixels = await image.evaluate(async (element, expectedDataUrl) => {
    const rendered = element as HTMLImageElement, src = rendered.currentSrc
    if (!src.startsWith('blob:') && !src.startsWith('data:image/')) throw new Error('Expected self-contained image preview')
    const reference = new Image()
    reference.src = expectedDataUrl
    await reference.decode()
    const readPixels = (source: HTMLImageElement): Uint8ClampedArray => {
      const canvas = document.createElement('canvas')
      canvas.width = source.naturalWidth; canvas.height = source.naturalHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Unable to create image verification canvas')
      context.drawImage(source, 0, 0)
      return context.getImageData(0, 0, canvas.width, canvas.height).data
    }
    const actual = readPixels(rendered), expected = readPixels(reference)
    let mismatchedBytes = 0, firstMismatch = -1
    for (let index = 0; index < Math.max(actual.length, expected.length); index++) {
      if (actual[index] === expected[index]) continue
      mismatchedBytes++
      if (firstMismatch < 0) firstMismatch = index
    }
    return { referenceWidth: reference.naturalWidth, referenceHeight: reference.naturalHeight,
      actualBytes: actual.length, expectedBytes: expected.length, mismatchedBytes, firstMismatch }
  }, `data:image/png;base64,${expected.toString('base64')}`)
  expect(pixels).toEqual({ referenceWidth: width, referenceHeight: height, actualBytes: width * height * 4,
    expectedBytes: width * height * 4, mismatchedBytes: 0, firstMismatch: -1 })
}
async function expectImage(run: RootRun, expected: Buffer, width: number, height: number): Promise<void> {
  const region = delivery(run)
  await expect(region).toBeVisible()
  await expect(region).toHaveAttribute('data-final-result-session', sessionId)
  await expect(region.locator('[data-final-result-kind="image"]')).toHaveCount(1)
  await expect(region.locator('img')).toHaveCount(1)
  await expectRenderedImage(region.locator('img'), expected, width, height)
  for (const excluded of [draftName, draftPath, logPath, 'REAL_GENERATION_', 'PROCESS_TEST_LOG_']) await expect(region).not.toContainText(excluded)
}
async function capture(info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(name + '.png')
  await page.screenshot({ path, animations: 'disabled' })
  await info.attach(name, { path, contentType: 'image/png' })
}
async function expectCopiedFinalReply(run: RootRun, text: string): Promise<void> {
  const instance = app!
  const previous = await instance.evaluate(({ clipboard }) => ({ formats: clipboard.availableFormats(), text: clipboard.readText(), html: clipboard.readHTML(),
    rtf: clipboard.readRTF(), image: clipboard.readImage().toPNG().toString('base64'), bookmark: clipboard.readBookmark() }))
  let copied = ''
  try {
    await turn(run).getByRole('button', { name: '复制回复', exact: true }).click()
    // Windows clipboard text uses CRLF even when the final model text uses LF.
    await expect.poll(async () => (await instance.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n')).toBe(text)
    copied = await instance.evaluate(({ clipboard }) => clipboard.readText())
    expect(copied).not.toContain('PROCESS_NOTE_')
    expect(copied).not.toContain('PROCESS_TEST_LOG_')
  } finally {
    await instance.evaluate(({ clipboard, nativeImage }, saved) => {
      const current = clipboard.readText()
      if (saved.copied ? current !== saved.copied : current.replace(/\r\n/g, '\n') !== saved.expected) return
      if (!saved.previous.formats.length) { clipboard.clear(); return }
      clipboard.write({ text: saved.previous.text, html: saved.previous.html, rtf: saved.previous.rtf,
        ...(saved.previous.image ? { image: nativeImage.createFromDataURL(`data:image/png;base64,${saved.previous.image}`) } : {}),
        ...(saved.previous.bookmark.title ? { bookmark: saved.previous.bookmark.title } : {}) })
    }, { copied, previous, expected: text })
  }
}

test.describe.serial('Work 最终交付物真实持久闭环', () => {
  test.beforeAll(async () => {
    await new Promise<void>(done => provider.listen(0, '127.0.0.1', done))
    const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Missing provider address')
    baseUrl = `http://127.0.0.1:${address.port}/v1`
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true }); fixture = mkdtempSync(join(root, '.e2e-tmp', 'work-final-deliverables-'))
    mkdirSync(local('.ae/tmp'), { recursive: true }); mkdirSync(join(fixture, 'engine', 'secrets'), { recursive: true })
    writeFileSync(local(workerPath), worker)
    writeFileSync(join(fixture, 'engine', 'secrets', 'engine-secrets.json'), JSON.stringify({ encrypted: false, encryptionKey }))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'embedded', preferredPort: 12473, autoStartEngine: true,
      lastSessionId: sessionId, lastModelId: model, lastFolder: workspace(), thinkingMode: 'off' }))
    const moduleUrl = (name: string): string => pathToFileURL(join(dirname(engineEntry), name)).href
    const config = Object.fromEntries(Object.entries(environment()).filter(([name]) => ['LLM_PRIMARY_MODEL', 'LLM_MODEL', 'LLM_PROVIDER',
      'LLM_FALLBACK_MODEL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'DEFAULT_SECURITY_MODE', 'OSM_MODE', 'MAX_ITERATIONS', 'HISTORY_BACKEND'].includes(name)))
    const seed = `const {initDb,getDb}=await import(${JSON.stringify(moduleUrl('storage/sqlite/db.js'))});
      const {ModelsStore}=await import(${JSON.stringify(moduleUrl('storage/sqlite/models.js'))});
      const {systemConfigStore}=await import(${JSON.stringify(moduleUrl('storage/sqlite/system-config.js'))});
      const {WorkspaceManager}=await import(${JSON.stringify(moduleUrl('workspace/manager.js'))});
      await initDb();
      await new ModelsStore().createModel({tenantId:'default',provider:'openai',modelId:${JSON.stringify(model)},apiKey:${JSON.stringify(apiKey)},
        baseUrl:${JSON.stringify(baseUrl)},displayName:'最终交付验收模型',isEnabled:true,capabilities:{toolCalling:true,vision:true,streamUsage:true,contextWindow:128000}});
      for(const[name,value]of Object.entries(${JSON.stringify(config)}))await systemConfigStore.set(name,value,name==='OPENAI_API_KEY');
      new WorkspaceManager().bind({tenantId:'default',sessionId:${JSON.stringify(sessionId)}},${JSON.stringify(workspace())});getDb().close();`
    execFileSync(process.execPath, ['--input-type=module', '-e', seed], { encoding: 'utf8', windowsHide: true, timeout: 30000,
      env: { ...environment(), DATA_DIR: join(fixture, 'engine', 'state', 'agent.db'), ENCRYPTION_KEY: encryptionKey } })
    await launch()
    const task = { id: sessionId, title: '最终交付持久化验收', status: 'draft', draft: '', createdAt: Date.now(), updatedAt: Date.now(),
      workspacePath: workspace(), modelId: model, attachments: [], sources: [] }
    await page.evaluate(task => localStorage.setItem('aether.work.state.v1', JSON.stringify({ tasks: [task], activeTaskId: task.id })), task)
    await page.reload(); await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await expect(work().getByRole('textbox', { name: '继续对话', exact: true })).toBeVisible()
    const security = await page.evaluate(sessionId => window.aether.engine.request({ method: 'PUT', path: '/security/mode', body: { sessionId, mode: 'standard' } }), sessionId)
    expect(security.ok, security.message).toBe(true)
  })
  test.afterEach(() => { health?.assertHealthy(); expect(errors).toEqual([]) })
  test.afterAll(async ({}, info) => {
    for (const gate of gates.values()) gate.response.destroy()
    if (app && health) { await health.closeAndAssert(info); app = undefined }
    provider.closeAllConnections(); await new Promise<void>(done => provider.close(() => done()))
    if (!fixture) return
    const absolute = resolve(fixture)
    if (dirname(absolute) !== resolve(root, '.e2e-tmp') || !basename(absolute).startsWith('work-final-deliverables-')) throw new Error('Unsafe delivery fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  test('真实命令产图并显式交付，同轮后一次暂存替换草稿且成功后才显示成品', async ({}, info) => {
    await send('first')
    const running = await drive('first', 'gate')
    expect(running.status).toBe('running')
    expect([...advertised]).toEqual(expect.arrayContaining(['execute_cmd', 'read_file', 'deliver_files']))
    expect(received.get(callId('first', 0))).toContain('REAL_GENERATION_first')
    expect(JSON.parse(received.get(callId('first', 3))!)).toMatchObject({ status: 'staged', items: [{ name: draftName }] })
    expect(JSON.parse(received.get(callId('first', 4))!)).toMatchObject({ status: 'staged', items: [{ name: imageName }, { name: reportName }] })
    firstImage = readFileSync(local(imagePath)); firstReport = readFileSync(local(reportPath))
    expect(existsSync(local(draftPath))).toBe(true); expect(existsSync(local(logPath))).toBe(true)
    await expect(delivery(running)).toHaveCount(0)
    release('first')
    const result = await published('first'), settled = runs.get('first')!
    expect(result.items.map(item => item.name)).toEqual([imageName, reportName])
    expect(result.items.map(item => item.kind)).toEqual(['image', 'file'])
    expect(result.items.map(item => resolve(item.path))).toEqual([resolve(local(imagePath)), resolve(local(reportPath))])
    expect(await asset(result, result.items[0])).toEqual(firstImage)
    expect(await asset(result, result.items[1])).toEqual(firstReport)
    await expectImage(settled, firstImage, 160, 96)
    await expect(turn(settled).locator('img[alt="未交付的过程草稿"]')).toHaveCount(0)
    await expect(turn(settled).locator('.md img')).toHaveCount(0)
    await expectCopiedFinalReply(settled, finalText.first)
    await expect(delivery(settled)).toContainText(reportName)
    const process = turn(settled).locator('.work-message__process-toggle')
    await expect(process).toHaveAttribute('aria-expanded', 'false')
    await expect(turn(settled).locator('.work-message__process')).toHaveCount(0)
    await process.press('Enter')
    await expect(turn(settled).locator('.work-message__process')).toContainText('PROCESS_NOTE_first')
    const log = turn(settled).locator(`[data-work-tool-id="${callId('first', 2)}"]`)
    await log.locator('button.logline').press('Enter')
    await expect(log.locator('.logline__detail')).toContainText('PROCESS_TEST_LOG_first')
    await process.press('Enter')
    await expect(turn(settled).locator('.work-message__process')).toHaveCount(0)
    const preview = delivery(settled).getByRole('button', { name: `放大查看 ${imageName}`, exact: true })
    await preview.click()
    const dialog = page.getByRole('dialog', { name: imageName, exact: true })
    await expectRenderedImage(dialog.locator('img'), firstImage, 160, 96)
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(preview).toBeFocused()
    const downloadPath = info.outputPath('downloaded-final-image.png')
    mkdirSync(dirname(downloadPath), { recursive: true })
    await app!.evaluate(({ session }, path) => {
      session.defaultSession.once('will-download', (_event, item) => item.setSavePath(path))
    }, downloadPath)
    await delivery(settled).getByRole('button', { name: `下载 ${imageName}`, exact: true }).click()
    await expect.poll(() => existsSync(downloadPath) ? readFileSync(downloadPath) : null,
      { message: 'Downloaded final image must preserve the originally delivered bytes' }).toEqual(firstImage)
    await capture(info, 'work-final-delivered-image-and-report')
    expect(ledger()).toEqual(['first'])
  })

  test('删除源成品和报告后整体重启，历史附件仍保存原始字节且不重新执行工具', async ({}, info) => {
    const requestCount = requests.length, before = ledger(), first = manifests.get('first')!
    unlinkSync(local(imagePath)); unlinkSync(local(reportPath))
    expect(existsSync(local(imagePath))).toBe(false); expect(existsSync(local(reportPath))).toBe(false)
    await health!.closeAndAssert(info); app = undefined; health = undefined
    await launch()
    const run = runs.get('first')!
    await expectImage(run, firstImage, 160, 96)
    expect(await asset(first, first.items[0])).toEqual(firstImage)
    expect(await asset(first, first.items[1])).toEqual(firstReport)
    await delivery(run).getByRole('button', { name: `预览 ${reportName}`, exact: true }).click()
    const filePreview = work().getByRole('region', { name: '交付物预览', exact: true })
    await expect(filePreview).toHaveAttribute('data-final-result-run', first.runId)
    await expect(filePreview).toHaveAttribute('data-final-result-asset', first.items[1].assetId)
    await expect(filePreview).toContainText('REAL_REPORT_first')
    await work().getByRole('button', { name: '收起工作区', exact: true }).click()
    await expect(work().locator('.work-workspace')).toHaveCount(0)
    const restored = await published('first')
    expect(restored).toEqual(first)
    expect(ledger()).toEqual(before); expect(requests).toHaveLength(requestCount)
    await capture(info, 'work-final-image-after-source-deletion-and-restart')
  })

  test('第二轮同路径生成不同图，前一轮保留原图且附件不能跨 run 或 session 读取', async () => {
    await send('second')
    const running = await drive('second', 'gate')
    secondImage = readFileSync(local(imagePath))
    expect(digest(secondImage)).not.toBe(digest(firstImage))
    await expect(delivery(running)).toHaveCount(0)
    await expectImage(runs.get('first')!, firstImage, 160, 96)
    release('second')
    const second = await published('second'), first = manifests.get('first')!
    expect(second.items.map(item => item.path)).toEqual(first.items.map(item => item.path))
    expect(second.items[0].assetId).not.toBe(first.items[0].assetId)
    expect(await asset(second, second.items[0])).toEqual(secondImage)
    expect(await asset(first, first.items[0])).toEqual(firstImage)
    await expectImage(runs.get('second')!, secondImage, 96, 64)
    await expectImage(runs.get('first')!, firstImage, 160, 96)
    for (const identity of [{ sessionId, runId: second.runId }, { sessionId: 'foreign-final-session', runId: first.runId }]) {
      const denied = await page.evaluate(query => window.aether.engine.request({ method: 'GET', path: '/conversation/result-asset', query }),
        { ...identity, assetId: first.items[0].assetId })
      expect(denied.ok).toBe(false)
      expect(JSON.stringify(denied.data)).not.toContain(firstImage.toString('base64'))
    }
    expect(ledger()).toEqual(['first', 'second'])
  })

  test('第三轮只有文字，不沿用前两轮附件', async () => {
    await send('text')
    const result = await published('text'), current = runs.get('text')!
    expect(result.items).toEqual([])
    await expect(turn(current)).toContainText(finalText.text)
    await expect(delivery(current)).toHaveCount(0)
    await expect(turn(current).locator('img')).toHaveCount(0)
    await work().getByRole('button', { name: '打开工作区', exact: true }).click()
    const workspaceResults = work().getByRole('region', { name: '本会话成果', exact: true })
    await expect(workspaceResults).toContainText('本轮没有文件交付物')
    await expect(workspaceResults.getByRole('region', { name: '交付物预览', exact: true })).toHaveCount(0)
    await expect(workspaceResults.locator('img')).toHaveCount(0)
    await work().getByRole('button', { name: '收起工作区', exact: true }).click()
    await expect(work().locator('.work-workspace')).toHaveCount(0)
    await expectImage(runs.get('first')!, firstImage, 160, 96)
    await expectImage(runs.get('second')!, secondImage, 96, 64)
    expect(ledger()).toEqual(['first', 'second'])
  })

  test('只在过程查看图片和测试日志不会自动晋升为最终交付', async () => {
    await send('process')
    const result = await published('process'), current = runs.get('process')!
    expect(result.items).toEqual([])
    await expect(delivery(current)).toHaveCount(0)
    await expect(turn(current).locator('img')).toHaveCount(0)
    const toggle = turn(current).locator('.work-message__process-toggle')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await toggle.press('Enter')
    const read = turn(current).locator(`[data-work-tool-id="${callId('process', 1)}"]`)
    await expect(read).toBeVisible(); await read.locator('button.logline').press('Enter')
    await expectRenderedImage(read.locator('img').first(), readFileSync(local(draftPath)), 80, 48)
    expect(await read.evaluate(element => Boolean(element.closest('.work-message__process')))).toBe(true)
    await toggle.press('Enter')
    await expect(turn(current).locator('img')).toHaveCount(0)
    await expect(delivery(current)).toHaveCount(0)
    expect(ledger()).toEqual(['first', 'second', 'process'])
  })

  test('暂存后最终模型失败不显示成品，也不发布成功附件记录', async () => {
    await send('failed')
    const running = await drive('failed', 'gate')
    await expect(delivery(running)).toHaveCount(0)
    rejectFinal.add('failed')
    const gate = gates.get('failed')!; gates.delete('failed'); failProvider(gate.response)
    await expect.poll(async () => (await snapshot()).run?.status, { timeout: 90000 }).toBe('failed')
    await expect(delivery(running)).toHaveCount(0)
    await expect(turn(running).locator('.work-error-notice[role="alert"]')).toBeVisible()
    const response = await page.evaluate(({ sessionId, anchorMessageId }) => window.aether.engine.request<{ messages: StoredRow[] }>({
      method: 'GET', path: '/conversation/display', query: { sessionId, anchorMessageId, limit: '1' }
    }), { sessionId, anchorMessageId: running.userMessageId })
    expect(response.ok, response.message).toBe(true)
    expect(response.data!.messages.filter(row => row.metadata?.finalResult)).toEqual([])
    await expect(turn(running)).not.toContainText(finalText.failed)
  })

  test('暂存后停止任务不冒充已交付，刷新仍无最终附件', async () => {
    await send('cancelled')
    const running = await drive('cancelled', 'gate')
    await expect(delivery(running)).toHaveCount(0)
    await work().locator('.work-task-heading').getByRole('button', { name: '停止任务', exact: true }).click()
    await expect.poll(async () => (await snapshot()).run?.status, { timeout: 30000 }).toBe('cancelled')
    await expect(delivery(running)).toHaveCount(0)
    const response = await page.evaluate(({ sessionId, anchorMessageId }) => window.aether.engine.request<{ messages: StoredRow[] }>({
      method: 'GET', path: '/conversation/display', query: { sessionId, anchorMessageId, limit: '1' }
    }), { sessionId, anchorMessageId: running.userMessageId })
    expect(response.ok, response.message).toBe(true)
    expect(response.data!.messages.filter(row => row.metadata?.finalResult)).toEqual([])
    const executions = ledger(), requestCount = requests.length
    await page.reload()
    await expect(turn(running)).toBeVisible()
    await expect(delivery(running)).toHaveCount(0)
    await expect(turn(running)).not.toContainText(finalText.cancelled)
    expect(ledger()).toEqual(executions); expect(requests).toHaveLength(requestCount)
  })

  test('明确选择本轮 read_file 图片回执才会成为持久成品图', async ({}, info) => {
    await send('tool_image')
    const result = await published('tool_image'), current = runs.get('tool_image')!
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ name: '显式交付的查看图.png', kind: 'image', mimeType: 'image/png' })
    expect(result.items[0].path).toContain(`tool-result/${callId('tool_image', 1)}/0/`)
    const bytes = readFileSync(local(draftPath))
    expect(await asset(result, result.items[0])).toEqual(bytes)
    await expectImage(current, bytes, 80, 48)
    await expect(turn(current).locator('.work-message__process-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(delivery(current).getByRole('button', { name: '放大查看 显式交付的查看图.png', exact: true })).toBeVisible()
    unlinkSync(local(draftPath)); await page.reload()
    await expectImage(current, bytes, 80, 48)
    expect(await asset(result, result.items[0])).toEqual(bytes)
    await capture(info, 'work-explicit-tool-image-delivery')
  })
})
