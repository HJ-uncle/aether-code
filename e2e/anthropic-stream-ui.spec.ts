/** Real Electron + local Anthropic SSE: start-frame answers/tool input, durable replay and honest empty-output failure. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AetherIdeApi } from '../src/preload'
import type { ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'

declare global { interface Window { aether: AetherIdeApi } }

const root = resolve(__dirname, '..')
const engineRoot = resolve(root, '..', 'ai-agent-engine')
const model = 'anthropic-start-fixture'
const key = 'a'.repeat(64)
const toolCallId = 'anthropic-read-once'
const fixtureText = '起始工具参数已保留：五子棋，黑棋先行。'
const answers: Record<string, string> = {
  block: '正文来自内容块起始帧：五子棋，黑棋先行。',
  message: '正文来自消息起始帧：五子棋，白棋后行。',
  tool: '已读取文件：五子棋，黑棋先行。'
}
let fixture = '', baseUrl = '', app: ElectronApplication | undefined, page: Page
type Block = { type: string; text?: string; tool_use_id?: string; content?: unknown; [key: string]: unknown }
type Body = { model: string; stream?: boolean; messages: Array<{ role: string; content?: string | Block[] }> }
type Frame = { type: string; [key: string]: unknown }
const requests: Array<{ scenario: string; stream: boolean; toolResults: Block[] }> = []

function start(content: Block[] = []): Frame {
  return { type: 'message_start', message: {
    id: 'anthropic-fixture-response', type: 'message', role: 'assistant', model, content,
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 }
  } }
}
function stop(reason = 'end_turn'): Frame[] {
  return [
    { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 7 } },
    { type: 'message_stop' }
  ]
}
function withBlock(block: Block, reason = 'end_turn'): Frame[] {
  return [start(), { type: 'content_block_start', index: 0, content_block: block },
    { type: 'content_block_stop', index: 0 }, ...stop(reason)]
}
function stream(response: ServerResponse, frames: Frame[]): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
  // One wire chunk also catches SDK snapshot mutation accidentally duplicating an answer.
  response.end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''))
}
const provider = createServer((incoming, response) => {
  void (async () => {
    let raw = ''
    incoming.setEncoding('utf8')
    for await (const chunk of incoming) raw += chunk.toString()
    const body = JSON.parse(raw) as Body
    const scenario = JSON.stringify(body.messages).match(/\[anthropic:(\w+)\]/)?.[1] ?? 'auxiliary'
    const toolResults = body.messages.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(block => block.type === 'tool_result') : [])
    requests.push({ scenario, stream: body.stream === true, toolResults })
    // Auxiliary title/summary requests use the same isolated local provider.
    if (!body.stream) {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        id: 'anthropic-fixture-summary', type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text: '本地协议回归验证' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 7 }
      }))
      return
    }
    if (scenario === 'empty') { stream(response, [start(), ...stop()]); return }
    if (scenario === 'message') { stream(response, [start([{ type: 'text', text: answers.message }]), ...stop()]); return }
    if (scenario === 'tool' && toolResults.length === 0) {
      stream(response, withBlock({ type: 'tool_use', id: toolCallId, name: 'read_file', input: { path: 'fixture.txt' } }, 'tool_use'))
      return
    }
    stream(response, withBlock({ type: 'text', text: answers[scenario] ?? '本地协议回归验证' }))
  })().catch(error => {
    if (!response.headersSent) response.writeHead(500)
    response.end(String(error))
  })
})

function env(): NodeJS.ProcessEnv {
  return { ...process.env,
    AETHER_IDE_ENGINE_ENTRY: join(engineRoot, 'dist/main.js'), AUTH_ENABLED: 'false', HISTORY_BACKEND: 'jsonl',
    LLM_PROVIDER: 'anthropic', LLM_PRIMARY_MODEL: model, LLM_MODEL: model, LLM_FALLBACK_MODEL: '',
    ANTHROPIC_API_KEY: 'local-anthropic-fixture-key', ANTHROPIC_BASE_URL: baseUrl,
    DEFAULT_SECURITY_MODE: 'safe', OSM_MODE: 'methodology', MAX_ITERATIONS: '5', ENABLE_LONG_TERM_MEMORY: 'false',
    AETHER_GLOBAL_DIR: join(fixture, 'global'), WORKSPACE_ROOT: join(fixture, 'sandboxes'),
    MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills')
  }
}
async function snapshot(sessionId: string): Promise<ChatRecoverySnapshot> {
  const response = await page.evaluate(sessionId => window.aether.engine.request<ChatRecoverySnapshot>({
    method: 'GET', path: '/chat/snapshot', query: { sessionId }
  }), sessionId)
  expect(response.ok, response.message).toBe(true)
  return response.data!
}
async function select(sessionId: string): Promise<void> {
  await page.evaluate(sessionId => window.aether.settings.update({ lastSessionId: sessionId }), sessionId)
  await page.reload()
  await expect(page.locator('.chat__input')).toHaveAttribute('contenteditable', 'true')
}
async function send(scenario: string): Promise<void> {
  await page.locator('.chat__input').fill(`[anthropic:${scenario}] 请验证中文响应。`)
  await page.getByRole('button', { name: '发送', exact: true }).click()
}
function streamRequests(scenario: string) {
  return requests.filter(request => request.scenario === scenario && request.stream)
}
async function expectAnswer(scenario: string): Promise<void> {
  await expect(page.locator('.message--assistant .message__content')).toHaveText(answers[scenario])
  await expect(page.locator('.message--assistant .message__content')).toHaveCount(1)
  await expect(page.locator('.message--assistant .message__error')).toHaveCount(0)
}

test.describe.serial('Anthropic 起始帧兼容真机验收', () => {
  test.beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      provider.once('error', reject)
      provider.listen(0, '127.0.0.1', resolve)
    })
    const address = provider.address()
    if (!address || typeof address === 'string') throw new Error('Missing local Anthropic provider address')
    baseUrl = `http://127.0.0.1:${address.port}`
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
    fixture = mkdtempSync(join(root, '.e2e-tmp', 'anthropic-stream-ui-'))
    mkdirSync(join(fixture, 'workspace'), { recursive: true })
    mkdirSync(join(fixture, 'engine', 'secrets'), { recursive: true })
    writeFileSync(join(fixture, 'workspace', 'fixture.txt'), fixtureText)
    writeFileSync(join(fixture, 'engine', 'secrets', 'engine-secrets.json'), JSON.stringify({ encrypted: false, encryptionKey: key }))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({
      engineMode: 'embedded', preferredPort: 12449, autoStartEngine: true,
      lastSessionId: 'anthropic-block', lastModelId: model, lastFolder: join(fixture, 'workspace'), thinkingMode: 'off'
    }))
    const url = (file: string) => pathToFileURL(join(engineRoot, 'dist', file)).href
    const config = Object.fromEntries(Object.entries(env()).filter(([name]) => [
      'LLM_PRIMARY_MODEL', 'LLM_MODEL', 'LLM_PROVIDER', 'LLM_FALLBACK_MODEL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
      'DEFAULT_SECURITY_MODE', 'OSM_MODE', 'MAX_ITERATIONS', 'HISTORY_BACKEND'
    ].includes(name)))
    const seed = `
      const {initDb,getDb}=await import(${JSON.stringify(url('storage/sqlite/db.js'))});
      const {ModelsStore}=await import(${JSON.stringify(url('storage/sqlite/models.js'))});
      const {systemConfigStore}=await import(${JSON.stringify(url('storage/sqlite/system-config.js'))});
      await initDb();
      await new ModelsStore().createModel({tenantId:'default',provider:'anthropic',modelId:${JSON.stringify(model)},apiKey:'local-anthropic-fixture-key',baseUrl:${JSON.stringify(baseUrl)},displayName:'本地 Anthropic 起始帧测试',isEnabled:true,capabilities:{toolCalling:true,parallelTools:true,streamUsage:true,contextWindow:128000}});
      for(const[name,value]of Object.entries(${JSON.stringify(config)}))await systemConfigStore.set(name,value,name==='ANTHROPIC_API_KEY');
      getDb().close();`
    execFileSync(process.execPath, ['--input-type=module', '-e', seed], {
      encoding: 'utf8', windowsHide: true, timeout: 30000,
      env: { ...env(), DATA_DIR: join(fixture, 'engine', 'state', 'agent.db'), ENCRYPTION_KEY: key }
    })
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env: env() })
    page = await app.firstWindow()
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
  })
  test.afterAll(async () => {
    await app?.close()
    provider.closeAllConnections()
    await new Promise<void>(resolve => provider.close(() => resolve()))
    if (!fixture) return
    const absolute = resolve(fixture)
    if (dirname(absolute) !== resolve(root, '.e2e-tmp') || !basename(absolute).startsWith('anthropic-stream-ui-')) throw new Error('Unsafe fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  for (const scenario of ['block', 'message']) {
    test(`${scenario} 起始帧完整中文正文成功且只显示一次，刷新保留`, async ({}, testInfo) => {
      const sessionId = `anthropic-${scenario}`
      await select(sessionId)
      await send(scenario)
      await expect.poll(async () => (await snapshot(sessionId)).run?.status).toBe('succeeded')
      await expectAnswer(scenario)
      expect(streamRequests(scenario)).toHaveLength(1)
      await page.reload()
      await expectAnswer(scenario)
      expect((await snapshot(sessionId)).run?.status).toBe('succeeded')
      expect(streamRequests(scenario)).toHaveLength(1)
      if (scenario === 'block') await page.screenshot({ path: testInfo.outputPath('anthropic-start-answer.png'), fullPage: true })
    })
  }

  test('真正空响应仍标记 EMPTY_OUTPUT 中文失败且刷新不自动重试', async ({}, testInfo) => {
    const sessionId = 'anthropic-empty'
    await select(sessionId)
    await send('empty')
    await expect.poll(async () => (await snapshot(sessionId)).run?.status).toBe('failed')
    expect((await snapshot(sessionId)).run).toMatchObject({ status: 'failed', stopReason: 'empty_output', error: { code: 'EMPTY_OUTPUT' } })
    const diagnosticRecord = {
      content: '', metadata: { responseDiagnostics: {
        provider: 'anthropic', modelId: model, terminalChunkReceived: true,
        contentCharacters: 0, reasoningCharacters: 0, promptTokens: 12, completionTokens: 7
      } }
    }
    expect((await snapshot(sessionId)).history.find(row => row.role === 'assistant')).toMatchObject(diagnosticRecord)
    await expect(page.getByRole('status', { name: '运行状态' })).toHaveText('失败')
    await expect(page.locator('.message--assistant .message__error')).toContainText('未收到模型的最终回答')
    await expect(page.locator('.message--assistant .message__content')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeHidden()
    expect(streamRequests('empty')).toHaveLength(1)
    await page.reload()
    await expect(page.getByRole('status', { name: '运行状态' })).toHaveText('失败')
    await expect(page.locator('.message--assistant .message__error')).toContainText('未收到模型的最终回答')
    expect((await snapshot(sessionId)).history.find(row => row.role === 'assistant')).toMatchObject(diagnosticRecord)
    expect(streamRequests('empty')).toHaveLength(1)
    await page.screenshot({ path: testInfo.outputPath('anthropic-empty-output.png'), fullPage: true })
  })

  test('起始 tool_use.input 保留文件参数并真实读取一次，刷新不重复执行', async () => {
    const sessionId = 'anthropic-tool'
    await select(sessionId)
    await send('tool')
    await expect.poll(async () => (await snapshot(sessionId)).run?.status).toBe('succeeded')
    await expectAnswer('tool')
    const calls = streamRequests('tool')
    expect(calls).toHaveLength(2)
    expect(calls[0].toolResults).toEqual([])
    expect(calls[1].toolResults).toHaveLength(1)
    expect(calls[1].toolResults[0].tool_use_id).toBe(toolCallId)
    expect(JSON.stringify(calls[1].toolResults[0].content)).toContain(fixtureText)
    await expect.poll(async () => (await snapshot(sessionId)).history.filter(row => row.role === 'tool' && row.toolCallId === toolCallId).length).toBe(1)
    const result = (await snapshot(sessionId)).history.find(row => row.role === 'tool' && row.toolCallId === toolCallId)!
    expect(JSON.stringify(result.content)).toContain(fixtureText)
    await page.reload()
    await expectAnswer('tool')
    expect(streamRequests('tool')).toHaveLength(2)
    expect((await snapshot(sessionId)).history.filter(row => row.role === 'tool' && row.toolCallId === toolCallId)).toHaveLength(1)
  })
})
