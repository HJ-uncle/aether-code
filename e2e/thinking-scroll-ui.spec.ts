/**
 * 思考过程展示规则的真窗验收：活跃末尾默认展开并贴底，用户上翻后不抢滚动位置，
 * 完成后折叠；与 wuzu-client Code 模式的时间线规则保持一致。
 *
 * 该用例使用隔离的 Electron profile、嵌入式引擎和本地 OpenAI SSE provider，
 * 不依赖生产账号或外部网络。思考详情节点由产品提供
 * `.logline__detail--thinking`，聊天滚动区由 `[data-chat-scroll-region]` 标记。
 */
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
const model = 'thinking-scroll-fixture'
const key = 'a'.repeat(64)
const sessionId = 'thinking-scroll-session'

let fixture = ''
let baseUrl = ''
let app: ElectronApplication | undefined
let page: Page
let heldResponse: ServerResponse | undefined

function sendDelta(response: ServerResponse, delta: Record<string, unknown>, finishReason: string | null = null): void {
  response.write(`data: ${JSON.stringify({ id: 'thinking-scroll', model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
}

const provider = createServer((request, response) => {
  void (async () => {
    let raw = ''
    for await (const chunk of request) raw += chunk.toString()
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    // Keep the stream open while the test exercises the live thinking panel.
    heldResponse = response
    sendDelta(response, { role: 'assistant', reasoning_content: '阶段一：先检查当前目录、项目约束和相关文件。\n' })
    sendDelta(response, {
      reasoning_content:
        '阶段二：整理执行计划，并逐项核对实现链路、状态变化和最终输出。\n'.repeat(18)
    })
  })().catch((error) => {
    if (!response.headersSent) response.writeHead(500)
    response.end(String(error))
  })
})

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AETHER_IDE_ENGINE_ENTRY: join(engineRoot, 'dist/main.js'),
    AUTH_ENABLED: 'false',
    HISTORY_BACKEND: 'jsonl',
    LLM_PROVIDER: 'openai',
    LLM_PRIMARY_MODEL: model,
    LLM_MODEL: model,
    LLM_FALLBACK_MODEL: '',
    OPENAI_API_KEY: 'local-thinking-scroll-key',
    OPENAI_BASE_URL: baseUrl,
    DEFAULT_SECURITY_MODE: 'safe',
    OSM_MODE: 'methodology',
    MAX_ITERATIONS: '3',
    ENABLE_LONG_TERM_MEMORY: 'false',
    AETHER_GLOBAL_DIR: join(fixture, 'global'),
    WORKSPACE_ROOT: join(fixture, 'sandboxes'),
    MCP_CONFIG_PATH: join(fixture, 'mcp.json'),
    SKILLS_ROOT: join(fixture, 'skills')
  }
}

async function launch(): Promise<void> {
  app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env: env() })
  page = await app.firstWindow()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
  await expect(page.locator('.chat__input')).toHaveAttribute('contenteditable', 'true')
}

async function snapshot(): Promise<ChatRecoverySnapshot> {
  const result = await page.evaluate((id) => window.aether.engine.request<ChatRecoverySnapshot>({
    method: 'GET',
    path: '/chat/snapshot',
    query: { sessionId: id }
  }), sessionId)
  expect(result.ok, result.message).toBe(true)
  return result.data!
}

test.describe.serial('思考过程默认展开与贴底滚动', () => {
  test.beforeAll(async () => {
    await new Promise<void>((resolveListen) => provider.listen(0, '127.0.0.1', resolveListen))
    const address = provider.address()
    if (!address || typeof address === 'string') throw new Error('missing local provider address')
    baseUrl = `http://127.0.0.1:${address.port}/v1`

    mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
    fixture = mkdtempSync(join(root, '.e2e-tmp', 'thinking-scroll-ui-'))
    mkdirSync(join(fixture, 'workspace'), { recursive: true })
    mkdirSync(join(fixture, 'engine', 'secrets'), { recursive: true })
    writeFileSync(join(fixture, 'engine', 'secrets', 'engine-secrets.json'), JSON.stringify({ encrypted: false, encryptionKey: key }))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({
      engineMode: 'embedded', preferredPort: 12441, autoStartEngine: true,
      lastSessionId: sessionId, lastModelId: model, lastFolder: join(fixture, 'workspace'), thinkingMode: 'high'
    }))

    const url = (file: string) => pathToFileURL(join(engineRoot, 'dist', file)).href
    const config = Object.fromEntries(Object.entries(env()).filter(([name]) => [
      'LLM_PRIMARY_MODEL', 'LLM_MODEL', 'LLM_PROVIDER', 'LLM_FALLBACK_MODEL',
      'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'DEFAULT_SECURITY_MODE', 'OSM_MODE',
      'MAX_ITERATIONS', 'HISTORY_BACKEND'
    ].includes(name)))
    const seed = `const {initDb,getDb}=await import(${JSON.stringify(url('storage/sqlite/db.js'))});
      const {ModelsStore}=await import(${JSON.stringify(url('storage/sqlite/models.js'))});
      const {systemConfigStore}=await import(${JSON.stringify(url('storage/sqlite/system-config.js'))});
      await initDb(); await new ModelsStore().createModel({tenantId:'default',provider:'openai',modelId:${JSON.stringify(model)},apiKey:'local-thinking-scroll-key',baseUrl:${JSON.stringify(baseUrl)},displayName:'Thinking scroll fixture',isEnabled:true,capabilities:{toolCalling:true,parallelTools:true,streamUsage:true,thinking:true,contextWindow:128000}});
      for(const [name,value] of Object.entries(${JSON.stringify(config)})) await systemConfigStore.set(name,value,name==='OPENAI_API_KEY'); getDb().close();`
    execFileSync(process.execPath, ['--input-type=module', '-e', seed], {
      encoding: 'utf8', windowsHide: true, timeout: 30_000,
      env: { ...env(), DATA_DIR: join(fixture, 'engine', 'state', 'agent.db'), ENCRYPTION_KEY: key }
    })
    await launch()
  })

  test.afterAll(async () => {
    heldResponse?.destroy()
    await app?.close()
    provider.closeAllConnections()
    await new Promise<void>((resolveClose) => provider.close(() => resolveClose()))
    if (!fixture) return
    const absolute = resolve(fixture)
    if (dirname(absolute) !== resolve(root, '.e2e-tmp') || !basename(absolute).startsWith('thinking-scroll-ui-')) throw new Error('unsafe fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  test('活跃末尾默认展开且详情贴底，上翻后追加内容不抢位置', async () => {
    await page.locator('.chat__input').fill('请按步骤检查当前项目')
    await page.getByRole('button', { name: '发送', exact: true }).click()

    const detail = page.locator('.logline__detail--thinking').last()
    await expect(detail).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-chat-scroll-region]').first()).toBeVisible()
    const process = page.locator('.process').last()
    await expect(process.locator('.process__summary')).toHaveAttribute('aria-expanded', 'true')
    // Internal thinking pane is constrained to 220px and starts at its bottom edge.
    await expect.poll(
      () => detail.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
      { timeout: 10_000 }
    ).toBeLessThanOrEqual(40)
    const initial = await detail.evaluate((element) => ({ top: element.scrollTop, max: element.scrollHeight - element.clientHeight, height: element.clientHeight }))
    expect(initial.height).toBeLessThanOrEqual(220)
    expect(initial.top).toBeGreaterThanOrEqual(Math.max(0, initial.max - 40))

    // User scrolls up: later streaming text must preserve that position.
    await detail.evaluate((element) => { element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 120) })
    const beforeAppend = await detail.evaluate((element) => element.scrollTop)
    sendDelta(heldResponse!, { reasoning_content: '阶段三：继续输出，用户已经主动上翻，因此不能把视图强行拉回末尾。\n'.repeat(8) })
    await expect.poll(() => detail.evaluate((element) => element.scrollTop)).toBeLessThan(beforeAppend + 40)

    // Returning to the end re-enables the Wuzu-style follow-tail behaviour.
    await detail.evaluate((element) => { element.scrollTop = element.scrollHeight })
    const atBottom = await detail.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)
    expect(atBottom).toBeLessThanOrEqual(40)

    // Manual close is respected while the run is still active.
    await process.locator('.process__summary').click()
    await expect(process.locator('.process__summary')).toHaveAttribute('aria-expanded', 'false')
    await expect(detail).toBeHidden()

    // Finish the stream: historical process groups are collapsed by default.
    sendDelta(heldResponse!, { content: '检查完成。' }, 'stop')
    heldResponse!.end('data: [DONE]\n\n')
    await expect.poll(async () => (await snapshot()).run?.status).toBe('succeeded')
    await expect(process.locator('.process__summary')).toHaveAttribute('aria-expanded', 'false')
  })
})

