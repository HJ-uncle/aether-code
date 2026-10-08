/** Real Electron + engine + local provider: context, write/edit versions, quoted argv, failed assertions,
 * unsupported HTML diagnostics, native copy and history replay. Only model replies are fixtures. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

type Message = { role: string; content?: unknown; tool_call_id?: string }
type Body = { stream?: boolean; tools?: Array<{ function: { name: string } }>; messages: Message[] }
const root = resolve(__dirname, '..'), engineRoot = resolve(root, '..', 'ai-agent-engine')
const model = 'tool-ergonomics-fixture', sessionId = 'tool-ergonomics-session', encryptionKey = 'e'.repeat(64)
const promptMarker = '[tool-ergonomics-regression]', finalText = '工具链验收完成；断言失败和 HTML 静态诊断限制均已如实保留。'
const scriptPath = '.ae/tmp/verify-gomoku.mjs'
const originalScript = 'console.log("WRITE_VERSION");\n', updatedScript = 'console.log("EDIT_VERSION");\n'
const commandScript = 'console.log(\'ERGONOMICS_QUOTED_OUTPUT "hello"\'); require("node:assert/strict").equal(4, 5, "winning line must contain five stones")'
const steps = ['get_current_context', 'write_file', 'edit_file', 'execute_cmd', 'code_diagnose']
let fixture = '', baseUrl = '', app: ElectronApplication | undefined, page: Page
const received = new Map<string, string>(), errors: string[] = [], advertisedTools = new Set<string>()
const sentSteps: string[] = []

function respond(response: ServerResponse, body: Body, step?: number, args?: unknown): void {
  const calls = step === undefined ? [] : [{ id: `ergonomics-${step}`, type: 'function', function: { name: steps[step], arguments: JSON.stringify(args) } }]
  const content = step === undefined ? finalText : ''
  const finishReason = calls.length ? 'tool_calls' : 'stop'
  if (body.stream) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ id: 'ergonomics', model, choices: [{ index: 0, delta: { role: 'assistant', content,
      ...(calls.length ? { tool_calls: calls.map((call, index) => ({ ...call, index })) } : {}) }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ id: 'ergonomics', model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`)
    response.end('data: [DONE]\n\n')
  } else response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'ergonomics', model,
    choices: [{ index: 0, message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: finishReason }],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }))
}

const provider = createServer((incoming, response) => {
  void (async () => {
    let raw = ''; for await (const chunk of incoming) raw += chunk.toString()
    const body = JSON.parse(raw) as Body
    if (!body.tools?.some(tool => tool.function.name === 'get_current_context') ||
      !body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(promptMarker))) { respond(response, body); return }
    for (const tool of body.tools ?? []) advertisedTools.add(tool.function.name)
    for (const message of body.messages) {
      if (message.role === 'tool' && message.tool_call_id?.startsWith('ergonomics-')) {
        received.set(message.tool_call_id, typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
      }
    }
    let step = 0
    while (received.has(`ergonomics-${step}`)) step++
    if (step >= steps.length) { respond(response, body); return }
    let args: unknown
    if (step === 0) args = { includeTools: true }
    else if (step === 1) args = { path: scriptPath, data: originalScript }
    else if (step === 2) {
      const expectedHash = received.get('ergonomics-1')?.match(/^expectedHash: (sha256:[a-f0-9]{64})$/m)?.[1]
      if (!expectedHash) throw new Error('write_file did not expose the actual expectedHash to the model')
      args = { path: scriptPath, expectedHash, edits: [{ oldText: 'WRITE_VERSION', newText: 'EDIT_VERSION' }] }
    } else if (step === 3) args = { command: 'node', args: ['-e', commandScript], timeoutMs: 10000 }
    else args = { filePath: 'index.html' }
    sentSteps.push(steps[step])
    respond(response, body, step, args)
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})

function environment(): NodeJS.ProcessEnv {
  return { ...process.env, AETHER_IDE_ENGINE_ENTRY: join(engineRoot, 'dist/main.js'), AUTH_ENABLED: 'false', HISTORY_BACKEND: 'jsonl',
    LLM_PROVIDER: 'openai', LLM_PRIMARY_MODEL: model, LLM_MODEL: model, LLM_FALLBACK_MODEL: '', OPENAI_API_KEY: 'ergonomics-local-key',
    OPENAI_BASE_URL: baseUrl, DEFAULT_SECURITY_MODE: 'standard', OSM_MODE: 'methodology', MAX_ITERATIONS: '10',
    ENABLE_LONG_TERM_MEMORY: 'false', AETHER_GLOBAL_DIR: join(fixture, 'global'), WORKSPACE_ROOT: join(fixture, 'sandboxes'),
    MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills') }
}

async function copyReport(): Promise<string> {
  const instance = app!
  const previous = await instance.evaluate(({ clipboard }) => ({ formats: clipboard.availableFormats(), text: clipboard.readText(), html: clipboard.readHTML(),
    rtf: clipboard.readRTF(), image: clipboard.readImage().toPNG().toString('base64'), bookmark: clipboard.readBookmark() }))
  let report = ''
  try {
    const message = page.locator('.message--assistant').filter({ hasText: finalText }).last()
    await message.hover()
    await message.getByRole('button', { name: '复制', exact: true }).click()
    await expect.poll(() => instance.evaluate(({ clipboard }) => clipboard.readText())).toContain(finalText)
    report = await instance.evaluate(({ clipboard }) => clipboard.readText())
    return report
  } finally {
    await instance.evaluate(({ clipboard, nativeImage }, saved) => {
      if (!saved.report || clipboard.readText() !== saved.report) return
      if (!saved.previous.formats.length) { clipboard.clear(); return }
      clipboard.write({ text: saved.previous.text, html: saved.previous.html, rtf: saved.previous.rtf,
        ...(saved.previous.image ? { image: nativeImage.createFromDataURL(`data:image/png;base64,${saved.previous.image}`) } : {}),
        ...(saved.previous.bookmark.title ? { bookmark: saved.previous.bookmark.title } : {}) })
    }, { report, previous })
  }
}

test.describe.serial('工具执行与诊断真实闭环', () => {
  test.beforeAll(async () => {
    await new Promise<void>(done => provider.listen(0, '127.0.0.1', done))
    const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Missing provider address')
    baseUrl = `http://127.0.0.1:${address.port}/v1`
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
    fixture = mkdtempSync(join(root, '.e2e-tmp', 'tool-ergonomics-'))
    mkdirSync(join(fixture, 'workspace'), { recursive: true }); mkdirSync(join(fixture, 'engine', 'secrets'), { recursive: true })
    writeFileSync(join(fixture, 'workspace', 'index.html'), '<!doctype html><html><body><canvas></canvas></body></html>')
    writeFileSync(join(fixture, 'engine', 'secrets', 'engine-secrets.json'), JSON.stringify({ encrypted: false, encryptionKey }))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'embedded', preferredPort: 12457, autoStartEngine: true,
      lastSessionId: sessionId, lastModelId: model, lastFolder: join(fixture, 'workspace'), thinkingMode: 'off' }))
    const url = (name: string) => pathToFileURL(join(engineRoot, 'dist', name)).href
    const config = Object.fromEntries(Object.entries(environment()).filter(([name]) => ['LLM_PRIMARY_MODEL', 'LLM_MODEL', 'LLM_PROVIDER',
      'LLM_FALLBACK_MODEL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'DEFAULT_SECURITY_MODE', 'OSM_MODE', 'MAX_ITERATIONS', 'HISTORY_BACKEND'].includes(name)))
    const seed = `const {initDb,getDb}=await import(${JSON.stringify(url('storage/sqlite/db.js'))});
      const {ModelsStore}=await import(${JSON.stringify(url('storage/sqlite/models.js'))});
      const {systemConfigStore}=await import(${JSON.stringify(url('storage/sqlite/system-config.js'))});
      await initDb();
      await new ModelsStore().createModel({tenantId:'default',provider:'openai',modelId:${JSON.stringify(model)},apiKey:'ergonomics-local-key',
        baseUrl:${JSON.stringify(baseUrl)},displayName:'工具协议测试模型',isEnabled:true,capabilities:{toolCalling:true,parallelTools:true,streamUsage:true,contextWindow:128000}});
      for(const[name,value]of Object.entries(${JSON.stringify(config)}))await systemConfigStore.set(name,value,name==='OPENAI_API_KEY');getDb().close();`
    execFileSync(process.execPath, ['--input-type=module', '-e', seed], { encoding: 'utf8', windowsHide: true, timeout: 30000,
      env: { ...environment(), DATA_DIR: join(fixture, 'engine', 'state', 'agent.db'), ENCRYPTION_KEY: encryptionKey } })
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env: environment() })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(String(error)))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
    const security = await page.evaluate(sessionId => window.aether.engine.request({ method: 'PUT', path: '/security/mode', body: { sessionId, mode: 'standard' } }), sessionId)
    expect(security.ok, security.message).toBe(true)
  })
  test.afterAll(async () => {
    await app?.close(); provider.closeAllConnections(); await new Promise<void>(done => provider.close(() => done()))
    if (!fixture) return
    const absolute = resolve(fixture)
    if (dirname(absolute) !== resolve(root, '.e2e-tmp') || !basename(absolute).startsWith('tool-ergonomics-')) throw new Error('Unsafe ergonomics fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  test('真实写改版本衔接、带引号命令执行、模型错误反馈、复制与重载均保留诊断', async () => {
    await page.locator('.chat__input').fill(`${promptMarker} 验证本地工具链，执行故意失败的测试并保留具体诊断。`)
    await page.getByRole('button', { name: '发送', exact: true }).click()
    // Inline source is approval-gated by the real policy; approve this known local
    // fixture through the same card as a user instead of weakening the policy.
    const allow = page.getByRole('button', { name: '允许执行', exact: true })
    await expect(allow).toBeVisible({ timeout: 30000 })
    await allow.click()
    await expect(page.locator('.message--assistant .md')).toContainText(finalText, { timeout: 90000 })
    expect(errors).toEqual([])
    expect(sentSteps).toEqual(steps)
    expect([...advertisedTools]).toEqual(expect.arrayContaining(steps))
    if (advertisedTools.has('browser_tabs')) expect(received.get('ergonomics-0')).toContain('已注册 browser_tabs')
    else expect(received.get('ergonomics-0')).toContain('本次未注册 browser_tabs')
    expect(received.get('ergonomics-2')).toMatch(/^Edited /)
    expect(readFileSync(join(fixture, 'workspace', scriptPath), 'utf8')).toBe(updatedScript)
    const commandOutput = received.get('ergonomics-3')!
    expect(commandOutput).toContain('ERGONOMICS_QUOTED_OUTPUT "hello"')
    expect(commandOutput).toContain('AssertionError')
    expect(commandOutput).toContain('winning line must contain five stones')
    expect(commandOutput).toContain('COMMAND_EXIT_FAILED')
    expect(commandOutput).toContain('exitCode=1')
    expect(received.get('ergonomics-4')).toContain('DIAGNOSTIC_UNSUPPORTED')
    expect(received.get('ergonomics-4')).toContain('未执行静态诊断')
    const checkReport = (report: string): void => {
      expect(report).toContain('COMMAND_EXIT_FAILED')
      expect(report).toContain('退出码：1')
      expect(report).toContain('node -e')
      expect(report).toContain('ERGONOMICS_QUOTED_OUTPUT "hello"')
      expect(report).toContain('AssertionError')
      expect(report).toContain('winning line must contain five stones')
      expect(report).toContain('DIAGNOSTIC_UNSUPPORTED')
      expect(report).toContain('未执行静态诊断')
    }
    checkReport(await copyReport())
    await page.reload()
    await expect(page.locator('.message--assistant .md')).toContainText(finalText)
    checkReport(await copyReport())
    for (const summary of await page.locator('.process__summary').all()) {
      if (await summary.getAttribute('aria-expanded') !== 'true') await summary.click()
    }
    const command = page.locator('.logline').filter({ hasText: '执行命令' })
    await expect(command).toHaveCount(1)
    await expect(command).toContainText('命令退出码 1')
    await expect(command.locator('.logline__summary')).toContainText('node -e')
    await command.click()
    await expect(page.locator('.logline__detail')).toContainText('winning line must contain five stones')
    expect(errors).toEqual([])
  })
})
