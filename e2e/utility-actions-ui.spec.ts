/**
 * Utility actions real-window regression: AI commit message and composer polish.
 * The Electron app and engine stay real; only the OpenAI-compatible provider is local.
 * Also verifies the session history row tracks the active lastSessionId.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AetherIdeApi } from '../src/preload'

declare global { interface Window { aether: AetherIdeApi } }

const ROOT = resolve(__dirname, '..')
const ENGINE_ROOT = resolve(ROOT, '..', 'ai-agent-engine')
const MODEL = 'e2e-utility-model'
const KEY = 'e'.repeat(64)
const PORT = 12429
let fixture = ''
let baseUrl = ''
let app: ElectronApplication | undefined
let page: Page
const providerRequests: Array<{ model: string; prompt: string }> = []

const provider = createServer(async (request, response) => {
  if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
    response.writeHead(404).end()
    return
  }
  let raw = ''
  for await (const chunk of request) raw += chunk.toString()
  const body = JSON.parse(raw) as { model: string; messages?: Array<{ role: string; content?: string }> }
  const prompt = String(body.messages?.findLast((item) => item.role === 'user')?.content ?? '')
  providerRequests.push({ model: body.model, prompt })
  let content = 'feat: update workspace changes\n\n1. 更新编辑器与设置界面\n2. 保留完整的变更摘要'
  if (/润色|改写|清晰|改一下代码/.test(prompt)) content = '请清晰说明需要完成的代码修改，并补充验收标准。'
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ id: 'e2e-utility', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 } }))
})

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AETHER_IDE_ENGINE_ENTRY: join(ENGINE_ROOT, 'dist', 'main.js'),
    AUTH_ENABLED: 'false',
    HISTORY_BACKEND: 'sqlite',
    LLM_PROVIDER: 'openai',
    LLM_PRIMARY_MODEL: MODEL,
    LLM_MODEL: MODEL,
    LLM_FALLBACK_MODEL: '',
    OPENAI_API_KEY: 'local-e2e-utility',
    OPENAI_BASE_URL: baseUrl,
    DEFAULT_SECURITY_MODE: 'safe',
    OSM_MODE: 'methodology',
    MAX_ITERATIONS: '4',
    ENABLE_LONG_TERM_MEMORY: 'false',
    AETHER_GLOBAL_DIR: join(fixture, 'global'),
    WORKSPACE_ROOT: join(fixture, 'sandboxes'),
    MCP_CONFIG_PATH: join(fixture, 'mcp.json')
  }
}

function seed(): void {
  const workspace = join(fixture, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'README.md'), '# utility fixture\n')
  execFileSync('git', ['init'], { cwd: workspace, windowsHide: true })
  execFileSync('git', ['config', 'user.email', 'e2e@example.test'], { cwd: workspace, windowsHide: true })
  execFileSync('git', ['config', 'user.name', 'E2E Utility'], { cwd: workspace, windowsHide: true })
  execFileSync('git', ['add', '.'], { cwd: workspace, windowsHide: true })
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: workspace, windowsHide: true })
  writeFileSync(join(workspace, 'README.md'), '# utility fixture\n\nchanged line\n')
  mkdirSync(join(fixture, 'engine', 'secrets'), { recursive: true })
  writeFileSync(join(fixture, 'engine', 'secrets', 'engine-secrets.json'), JSON.stringify({ encrypted: false, encryptionKey: KEY }))
  writeFileSync(join(fixture, 'mcp.json'), JSON.stringify({ mcpServers: {} }))
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({
    engineMode: 'embedded', preferredPort: PORT, autoStartEngine: true,
    lastSessionId: 'utility-session-a', lastModelId: MODEL,
    utilityModelId: '', lastFolder: workspace, thinkingMode: 'off'
  }))

  const moduleUrl = (file: string): string => pathToFileURL(join(ENGINE_ROOT, 'dist', file)).href
  const script = `
    const { initDb, getDb } = await import(${JSON.stringify(moduleUrl('storage/sqlite/db.js'))});
    const { ModelsStore } = await import(${JSON.stringify(moduleUrl('storage/sqlite/models.js'))});
    const { systemConfigStore } = await import(${JSON.stringify(moduleUrl('storage/sqlite/system-config.js'))});
    await initDb();
    await new ModelsStore().createModel({ tenantId: 'default', provider: 'openai', modelId: ${JSON.stringify(MODEL)}, apiKey: 'local-e2e-utility', baseUrl: ${JSON.stringify(baseUrl)}, displayName: 'E2E utility model', isEnabled: true, capabilities: { toolCalling: true, parallelTools: true, streamUsage: true, contextWindow: 128000 } });
    for (const [key, value] of Object.entries(${JSON.stringify({ LLM_PROVIDER: 'openai', LLM_PRIMARY_MODEL: MODEL, LLM_MODEL: MODEL, OPENAI_API_KEY: 'local-e2e-utility', OPENAI_BASE_URL: baseUrl, DEFAULT_SECURITY_MODE: 'safe', OSM_MODE: 'methodology', HISTORY_BACKEND: 'sqlite', MAX_ITERATIONS: '4' })})) await systemConfigStore.set(key, value, key === 'OPENAI_API_KEY');
    const db = getDb();
    await db.execute({ sql: 'INSERT INTO conversations (tenant_id, session_id, conversation_id, message_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)' , args: ['default', 'utility-session-a', 'fixture-turn', 'fixture-user', 'user', '当前会话高亮夹具', Math.floor(Date.now() / 1000) - 5] });
    await db.execute({ sql: 'INSERT INTO conversations (tenant_id, session_id, conversation_id, message_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)' , args: ['default', 'utility-session-a', 'fixture-turn', 'fixture-assistant', 'assistant', 'fixture assistant reply', Math.floor(Date.now() / 1000)] });
    db.close();
  `
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: fixture, env: { ...env(), DATA_DIR: join(fixture, 'engine', 'state', 'agent.db'), ENCRYPTION_KEY: KEY }, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
}

async function launch(): Promise<void> {
  app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: ROOT, env: env() })
  page = await app.firstWindow()
  await expect(page.locator('.workbench')).toBeVisible()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
}

function cleanup(): void {
  const absolute = resolve(fixture)
  if (!absolute.startsWith(resolve(ROOT, '.e2e-tmp') + sep) || !basename(absolute).startsWith('utility-actions-')) throw new Error(`Unsafe cleanup path: ${absolute}`)
  rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

test.describe.serial('utility actions and active session highlight', () => {
  test.beforeAll(async () => {
    await new Promise<void>((resolvePromise, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolvePromise) })
    const address = provider.address()
    if (!address || typeof address === 'string') throw new Error('provider did not bind')
    baseUrl = `http://127.0.0.1:${address.port}/v1`
    mkdirSync(join(ROOT, '.e2e-tmp'), { recursive: true })
    fixture = mkdtempSync(join(ROOT, '.e2e-tmp', 'utility-actions-'))
    seed()
    await launch()
  })
  test.afterAll(async () => {
    await app?.close()
    await new Promise<void>((resolvePromise) => provider.close(() => resolvePromise()))
    if (fixture) cleanup()
  })

  test('AI 提交信息按钮调用已配置模型并回填提交信息', async () => {
    await page.getByRole('button', { name: '版本控制' }).click()
    await expect(page.locator('.git-commitbar__ai')).toBeVisible({ timeout: 15_000 })
    await page.locator('.git-commitbar__ai').click()
    await expect(page.locator('.git-commitbar__input')).toHaveValue(
      'feat: update workspace changes\n\n1. 更新编辑器与设置界面\n2. 保留完整的变更摘要',
      { timeout: 30_000 }
    )
    expect(providerRequests.some((item) => item.model === MODEL && /git|diff|改动/i.test(item.prompt))).toBe(true)
  })

  test('润色输入调用模型，且会话历史当前项保持高亮', async () => {
    await page.getByRole('button', { name: '会话历史' }).click()
    await expect(page.locator('.history-view')).toBeVisible({ timeout: 10_000 })
    await page.evaluate(() => window.aether.settings.update({ lastSessionId: 'utility-session-a' }))
    await page.reload()
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const active = page.locator('.history-view__item.is-active')
    await expect(active).toHaveCount(1)
    const input = page.locator('.chat__input')
    if (!(await input.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: '切换对话面板' }).click()
    }
    await expect(input).toBeVisible()
    // MentionInput is a contenteditable; keyboard input exercises its real onInput path.
    await input.click()
    await page.keyboard.press('Control+A')
    await page.keyboard.type('请帮我改一下代码')
    await expect(input).toContainText('请帮我改一下代码')
    await page.waitForTimeout(150)
    await page.getByRole('button', { name: 'AI 润色输入' }).click()
    await expect(input).toContainText('请清晰说明需要完成的代码修改', { timeout: 30_000 })
    expect(providerRequests.some((item) => item.model === MODEL && /改一下代码/.test(item.prompt))).toBe(true)
  })
})

