/**
 * Thinking preference contract: real Electron controls → real engine → local
 * DeepSeek-compatible gateway. Both embedded and remote connections must send
 * an explicit opt-out, and changing the preference cannot relabel an active run.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AetherIdeApi } from '../src/preload'

declare global { interface Window { aether: AetherIdeApi } }

const root = resolve(__dirname, '..')
const engineRoot = resolve(root, '..', 'ai-agent-engine')
const model = 'deepseek-v4.1-flash'
const key = 'b'.repeat(64)
const token = 'thinking-mode-local-fixture-token'

for (const mode of ['embedded', 'remote'] as const) {
  test.describe.serial(`思考开关贯通 ${mode}`, () => {
    let fixture = ''
    let baseUrl = ''
    let app: ElectronApplication | undefined
    let page: Page
    let remoteEngine: ChildProcess | undefined
    const captured: Array<{ body: Record<string, unknown>; response: ServerResponse }> = []

    const provider = createServer((request, response) => {
      void (async () => {
        let raw = ''
        for await (const chunk of request) raw += chunk.toString()
        const body = JSON.parse(raw) as Record<string, unknown>
        captured.push({ body, response })
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ id: 'thinking-contract', model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`)
      })().catch(error => {
        if (!response.headersSent) response.writeHead(500)
        response.end(String(error))
      })
    })

    const env = (): NodeJS.ProcessEnv => ({
      ...process.env,
      AETHER_IDE_ENGINE_ENTRY: join(engineRoot, 'dist/main.js'),
      AUTH_ENABLED: 'false', HISTORY_BACKEND: 'jsonl',
      LLM_PROVIDER: 'deepseek', LLM_PRIMARY_MODEL: model, LLM_MODEL: model, LLM_FALLBACK_MODEL: '',
      DEEPSEEK_API_KEY: 'thinking-mode-fixture-key', DEEPSEEK_BASE_URL: baseUrl,
      REASONING_EFFORT: 'medium', DEFAULT_SECURITY_MODE: 'safe', OSM_MODE: 'methodology',
      ENABLE_LONG_TERM_MEMORY: 'false', MAX_ITERATIONS: '3',
      AETHER_GLOBAL_DIR: join(fixture, 'global'), WORKSPACE_ROOT: join(fixture, 'sandboxes'),
      AETHER_ALLOWED_WORKSPACE_ROOTS: join(fixture, 'workspace'),
      MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills')
    })

    async function chooseThinking(label: 'Off' | 'High'): Promise<void> {
      await page.getByRole('button', { name: '对话偏好', exact: true }).click()
      await page.getByTitle('选择思考档位', { exact: true }).click()
      await page.getByRole('menuitem', { name: new RegExp(`^${label} `) }).click()
      await expect(page.getByTitle('选择思考档位', { exact: true }).locator('span').first()).toHaveText(label)
      expect(await page.evaluate(() => window.aether.settings.get().then(settings => settings.thinkingMode))).toBe('high')
      if (label === 'Off') {
        await expect(page.locator('.composer-options__summary').filter({ hasText: '下一次发送请求关闭推理' }))
          .toHaveText('下一次发送请求关闭推理；当前运行沿用原设置')
        await expect(page.getByText('思考已关闭，回答最快最省', { exact: true })).toHaveCount(0)
      }
      // The popover can cover the composer; close it through its own trigger.
      await page.getByRole('button', { name: '对话偏好', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '对话偏好', exact: true })).toHaveCount(0)
    }

    async function send(index: number): Promise<Record<string, unknown>> {
      await page.locator('.chat__input').fill(`只回复“契约验证 ${index} 完成”，不使用工具。`)
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await expect.poll(() => captured.length, { timeout: 30_000 }).toBe(index + 1)
      expect(captured[index].body.model).toBe(model)
      return captured[index].body
    }

    async function finish(index: number): Promise<void> {
      const response = captured[index].response
      response.write(`data: ${JSON.stringify({ id: 'thinking-contract', model, choices: [{ index: 0, delta: { content: `契约验证 ${index} 完成。` }, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
      await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
      await expect(page.getByRole('status', { name: '运行状态', exact: true }).last()).toHaveText('已完成')
    }

    test.beforeAll(async () => {
      await new Promise<void>(resolveListen => provider.listen(0, '127.0.0.1', resolveListen))
      const address = provider.address()
      if (!address || typeof address === 'string') throw new Error('Missing local provider port')
      baseUrl = `http://127.0.0.1:${address.port}/v1`
      mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
      fixture = mkdtempSync(join(root, '.e2e-tmp', `thinking-mode-${mode}-`))
      mkdirSync(join(fixture, 'workspace'), { recursive: true })
      mkdirSync(join(fixture, 'engine', 'secrets'), { recursive: true })
      writeFileSync(join(fixture, 'engine', 'secrets', 'engine-secrets.json'), JSON.stringify({ encrypted: false, encryptionKey: key }))
      const url = (file: string): string => pathToFileURL(join(engineRoot, 'dist', file)).href
      const config = Object.fromEntries(Object.entries(env()).filter(([name]) => [
        'LLM_PRIMARY_MODEL', 'LLM_MODEL', 'LLM_PROVIDER', 'LLM_FALLBACK_MODEL', 'DEEPSEEK_API_KEY',
        'DEEPSEEK_BASE_URL', 'REASONING_EFFORT', 'DEFAULT_SECURITY_MODE', 'OSM_MODE', 'MAX_ITERATIONS', 'HISTORY_BACKEND'
      ].includes(name)))
      const seed = `const {initDb,getDb}=await import(${JSON.stringify(url('storage/sqlite/db.js'))});
        const {ModelsStore}=await import(${JSON.stringify(url('storage/sqlite/models.js'))});
        const {systemConfigStore}=await import(${JSON.stringify(url('storage/sqlite/system-config.js'))});
        await initDb(); await new ModelsStore().createModel({tenantId:'default',provider:'deepseek',modelId:${JSON.stringify(model)},apiKey:'thinking-mode-fixture-key',baseUrl:${JSON.stringify(baseUrl)},displayName:'Thinking mode fixture',isEnabled:true,capabilities:{toolCalling:true,parallelTools:true,streamUsage:true,thinking:true,contextWindow:128000}});
        for(const [name,value] of Object.entries(${JSON.stringify(config)})) await systemConfigStore.set(name,value,name==='DEEPSEEK_API_KEY'); getDb().close();`
      execFileSync(process.execPath, ['--input-type=module', '-e', seed], {
        encoding: 'utf8', windowsHide: true, timeout: 30_000,
        env: { ...env(), DATA_DIR: join(fixture, 'engine', 'state', 'agent.db'), ENCRYPTION_KEY: key }
      })

      let remoteUrl = ''
      if (mode === 'remote') {
        const portProbe = createServer()
        await new Promise<void>(resolveListen => portProbe.listen(0, '127.0.0.1', resolveListen))
        const portAddress = portProbe.address()
        if (!portAddress || typeof portAddress === 'string') throw new Error('Missing remote engine port')
        const serverPort = portAddress.port
        await new Promise<void>(resolveClose => portProbe.close(() => resolveClose()))
        remoteUrl = `http://127.0.0.1:${serverPort}`
        let startupLog = ''
        let startupError: Error | undefined
        remoteEngine = spawn(process.execPath, [join(engineRoot, 'dist/main.js')], {
          cwd: fixture, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...env(), PORT: String(serverPort), HOST: '127.0.0.1', DATA_DIR: join(fixture, 'engine', 'state', 'agent.db'), ENCRYPTION_KEY: key, AETHER_INSTANCE_TOKEN: token }
        })
        remoteEngine.on('error', error => { startupError = error })
        const rememberStartup = (chunk: Buffer): void => { startupLog = (startupLog + chunk.toString()).slice(-4000) }
        remoteEngine.stdout?.on('data', rememberStartup)
        remoteEngine.stderr?.on('data', rememberStartup)
        await expect.poll(async () => {
          if (startupError) throw startupError
          if (remoteEngine?.exitCode !== null) throw new Error(`Remote fixture exited: ${remoteEngine?.exitCode}\n${startupLog}`)
          try { return (await fetch(`${remoteUrl}/health`, { signal: AbortSignal.timeout(2_000) })).status } catch { return 0 }
        }, { timeout: 90_000 }).toBe(200)
      }
      writeFileSync(join(fixture, 'settings.json'), JSON.stringify({
        engineMode: mode, preferredPort: 12443, autoStartEngine: true,
        lastSessionId: `thinking-mode-${mode}`, lastModelId: model,
        lastFolder: join(fixture, 'workspace'), thinkingMode: 'high',
        remoteBaseUrl: remoteUrl, remoteWorkspaceRoot: join(fixture, 'workspace')
      }))
      app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root,
        env: { ...env(), AETHER_IDE_REMOTE_INSTANCE_TOKEN: token } })
      page = await app.firstWindow()
      await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
      if (mode === 'remote') {
        // Remote sessions are endpoint-local. Seed the endpoint-scoped
        // selection so this contract uses a stable ID instead of the random
        // placeholder generated during the first render.
        await page.evaluate(({ url, sessionId }) => {
          localStorage.setItem(`aether:lastSessionId:${encodeURIComponent(`remote:${url}`)}`, sessionId)
        }, { url: remoteUrl, sessionId: `thinking-mode-${mode}` })
        await page.reload()
        await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
      }
      await expect(page.locator('.chat__input')).toHaveAttribute('contenteditable', 'true')
      expect(await page.evaluate(() => window.aether.engine.getSnapshot())).toMatchObject({ mode, phase: 'ready' })
    })

    test.afterAll(async () => {
      for (const item of captured) item.response.destroy()
      await app?.close()
      if (remoteEngine && remoteEngine.exitCode === null && remoteEngine.signalCode === null) {
        const child = remoteEngine
        await new Promise<void>((resolveExit, reject) => {
          const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Owned remote engine did not exit')) }, 15_000)
          child.once('exit', () => { clearTimeout(deadline); resolveExit() })
          child.kill('SIGTERM')
        })
      }
      provider.closeAllConnections()
      await new Promise<void>(resolveClose => provider.close(() => resolveClose()))
      if (!fixture) return
      const absolute = resolve(fixture)
      if (dirname(absolute) !== resolve(root, '.e2e-tmp') || !basename(absolute).startsWith(`thinking-mode-${mode}-`)) throw new Error('Unsafe thinking fixture cleanup')
      rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })

    test('运行中切 Off 如实提示下一次生效，后续 Off/High 透传到 provider', async () => {
      const original = await send(0)
      expect(original.reasoning_effort).toBe('medium')
      expect(original.enable_thinking).not.toBe(false)
      await chooseThinking('Off')
      expect(captured).toHaveLength(1)
      await finish(0)

      const disabled = await send(1)
      expect(disabled.enable_thinking).toBe(false)
      expect(disabled.reasoning_effort).toBe('low')
      await finish(1)

      await chooseThinking('High')
      const enabled = await send(2)
      expect(enabled.reasoning_effort).toBe('medium')
      expect(enabled.enable_thinking).not.toBe(false)
      await finish(2)
    })
    test('手动思考档位只属于当前会话，刷新恢复且新会话采用默认参数', async () => {
      await chooseThinking('Off')
      await page.reload()
      await expect(page.locator('.model-picker__trigger')).toBeEnabled()
      await page.getByRole('button', { name: '对话偏好', exact: true }).click()
      await expect(page.getByTitle('选择思考档位', { exact: true }).locator('span').first()).toHaveText('Off')
      await page.getByRole('button', { name: '对话偏好', exact: true }).click()
      const restored = await send(3)
      expect(restored.enable_thinking).toBe(false)
      expect(restored.reasoning_effort).toBe('low')
      await finish(3)
      await page.getByTitle('新建会话（开一条全新对话）', { exact: true }).click()
      await expect(page.locator('.model-picker__trigger')).toBeEnabled()
      await page.getByRole('button', { name: '对话偏好', exact: true }).click()
      await expect(page.getByTitle('选择思考档位', { exact: true }).locator('span').first()).toHaveText('High')
      await page.getByRole('button', { name: '对话偏好', exact: true }).click()
      const fresh = await send(4)
      expect(fresh.reasoning_effort).toBe('medium')
      expect(fresh.enable_thinking).not.toBe(false)
      await finish(4)
      await page.evaluate(({ mode, url, sessionId }) => {
        if (mode === 'remote') localStorage.setItem(`aether:lastSessionId:${encodeURIComponent(`remote:${url}`)}`, sessionId)
        return window.aether.settings.update({ lastSessionId: sessionId })
      }, { mode, url: (await page.evaluate(() => window.aether.engine.getSnapshot())).baseUrl, sessionId: `thinking-mode-${mode}` })
      await page.reload()
      await expect(page.locator('.model-picker__trigger')).toBeEnabled()
      const returned = await send(5)
      expect(returned.enable_thinking).toBe(false)
      expect(returned.reasoning_effort).toBe('low')
      await finish(5)
    })
  })
}
