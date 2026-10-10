/**
 * Real Electron + real engine coverage for composer defaults in embedded and
 * remote mode. No chat/model requests: verify confirmed engine state, explicit
 * choices, renderer reloads, and session switching against isolated databases.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AetherIdeApi } from '../src/preload'
import type { MemorySettings } from '../src/renderer/src/core/engine/memory'

declare global { interface Window { aether: AetherIdeApi } }

const root = resolve(__dirname, '..')
const engineRoot = resolve(root, '..', 'ai-agent-engine')
const firstSession = 'composer-defaults-A'
const secondSession = 'composer-defaults-B'
const token = 'composer-defaults-owned-fixture-token'

for (const mode of ['embedded', 'remote'] as const) {
  test.describe.serial(`对话偏好默认值 ${mode}`, () => {
    let fixture = ''
    let app: ElectronApplication | undefined
    let page: Page
    let remoteEngine: ChildProcess | undefined
    let storageSuffix = ''

    async function openPreferences(): Promise<void> {
      if (!await page.locator('.composer-options__popup').isVisible()) {
        await page.getByRole('button', { name: '对话偏好', exact: true }).click()
      }
    }

    async function closePreferences(): Promise<void> {
      if (await page.locator('.composer-options__popup').isVisible()) {
        await page.getByRole('button', { name: '对话偏好', exact: true }).click()
      }
    }

    async function readPreferences(sessionId: string): Promise<{ memory: MemorySettings; security: string }> {
      const [memory, security] = await page.evaluate(async id => Promise.all([
        window.aether.engine.request<MemorySettings>({ method: 'GET', path: '/memory/settings', query: { sessionId: id } }),
        window.aether.engine.request<{ sessionId: string; mode: string }>({ method: 'GET', path: '/security/mode', query: { sessionId: id } })
      ]), sessionId)
      expect(memory.ok, memory.message).toBe(true)
      expect(security.ok, security.message).toBe(true)
      expect(memory.data?.sessionId).toBe(sessionId)
      expect(security.data?.sessionId).toBe(sessionId)
      if (!memory.data || !security.data) throw new Error('Missing confirmed composer settings')
      return { memory: memory.data, security: security.data.mode }
    }

    async function currentSession(): Promise<string> {
      return page.evaluate(async suffix => suffix
        ? localStorage.getItem(`aether:lastSessionId${suffix}`) ?? ''
        : (await window.aether.settings.get()).lastSessionId, storageSuffix)
    }

    async function expectLabels(memory: string, security: string, thinking = 'High'): Promise<void> {
      await openPreferences()
      await expect(page.getByTitle('选择长期记忆范围', { exact: true })).toContainText(memory)
      await expect(page.getByTitle('选择安全模式', { exact: true })).toContainText(security)
      await expect(page.getByTitle('选择思考档位', { exact: true })).toContainText(thinking)
    }

    async function selectSession(name: string, id: string): Promise<void> {
      await closePreferences()
      if (!await page.locator('.history-view').isVisible()) {
        await page.getByRole('button', { name: '会话历史', exact: true }).click()
      }
      await page.locator('.history-view__item').filter({ hasText: name }).click()
      await expect.poll(currentSession).toBe(id)
    }

    async function choose(title: string, label: string): Promise<void> {
      await openPreferences()
      await page.getByTitle(title, { exact: true }).click()
      await page.getByRole('menuitem').filter({ has: page.locator('.composer-options__dd-label', { hasText: new RegExp(`^${label}$`) }) }).click()
    }

    test.beforeAll(async () => {
      mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
      fixture = mkdtempSync(join(root, '.e2e-tmp', `composer-defaults-${mode}-`))
      const entry = join(fixture, 'entry', 'main.mjs')
      const dataFile = join(fixture, 'engine', 'state', 'agent.db')
      mkdirSync(join(fixture, 'workspace'), { recursive: true })
      mkdirSync(join(fixture, 'entry', 'runtime'), { recursive: true })
      // The host runs an override with its entry directory as cwd. A tiny real
      // import wrapper prevents a developer's dist/.env or project config from
      // silently supplying a default; no engine API or policy is mocked.
      writeFileSync(entry, `import ${JSON.stringify(pathToFileURL(join(engineRoot, 'dist/main.js')).href)};\n`)
      copyFileSync(join(engineRoot, 'dist/runtime/build-manifest.json'), join(fixture, 'entry/runtime/build-manifest.json'))
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AETHER_IDE_ENGINE_ENTRY: entry,
        AUTH_ENABLED: 'false', ENABLE_LONG_TERM_MEMORY: 'true', HISTORY_BACKEND: 'jsonl',
        DATA_DIR: dataFile, MEMORY_DB_PATH: join(fixture, 'engine/state/memory/memory.db'),
        AETHER_GLOBAL_DIR: join(fixture, 'global'), PROGRAMDATA: join(fixture, 'managed'),
        WORKSPACE_ROOT: join(fixture, 'sandboxes'), AETHER_ALLOWED_WORKSPACE_ROOTS: join(fixture, 'workspace'),
        MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills'),
        AETHER_IDE_REMOTE_INSTANCE_TOKEN: token
      }
      // Test the absent-setting contract, rather than supplying the expected
      // default ourselves or inheriting a developer's explicit override.
      delete env.DEFAULT_SECURITY_MODE
      delete env.ELECTRON_RUN_AS_NODE
      let remoteUrl = ''
      if (mode === 'remote') {
        const probe = createServer()
        await new Promise<void>(done => probe.listen(0, '127.0.0.1', done))
        const address = probe.address()
        if (!address || typeof address === 'string') throw new Error('Missing fixture engine port')
        const port = address.port
        await new Promise<void>(done => probe.close(() => done()))
        remoteUrl = `http://127.0.0.1:${port}`
        storageSuffix = ':' + encodeURIComponent(`remote:${remoteUrl}`)
        let startupLog = ''
        let startupError: Error | undefined
        remoteEngine = spawn(process.execPath, [entry], {
          cwd: dirname(entry), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...env, PORT: String(port), HOST: '127.0.0.1', ENCRYPTION_KEY: 'c'.repeat(64), AETHER_INSTANCE_TOKEN: token }
        })
        remoteEngine.on('error', error => { startupError = error })
        const remember = (chunk: Buffer): void => { startupLog = (startupLog + chunk.toString()).slice(-4000) }
        remoteEngine.stdout?.on('data', remember)
        remoteEngine.stderr?.on('data', remember)
        await expect.poll(async () => {
          if (startupError) throw startupError
          if (remoteEngine?.exitCode !== null) throw new Error(`Owned remote fixture exited: ${remoteEngine?.exitCode}\n${startupLog}`)
          try { return (await fetch(`${remoteUrl}/health`, { signal: AbortSignal.timeout(2000) })).status } catch { return 0 }
        }, { timeout: 90_000 }).toBe(200)
      }
      // Deliberately omit thinkingMode to verify the installation default.
      writeFileSync(join(fixture, 'settings.json'), JSON.stringify({
        engineMode: mode, preferredPort: 12449, autoStartEngine: true,
        lastSessionId: firstSession, lastFolder: join(fixture, 'workspace'),
        remoteBaseUrl: remoteUrl, remoteWorkspaceRoot: join(fixture, 'workspace')
      }))
      app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env })
      page = await app.firstWindow()
      await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
      const snapshot = await page.evaluate(() => window.aether.engine.getSnapshot())
      expect(snapshot).toMatchObject({ mode, phase: 'ready' })
      if (mode === 'embedded') expect(snapshot).toMatchObject({ adopted: false, entryPath: entry, dataDir: dataFile })
      expect(existsSync(dataFile)).toBe(true)
      expect(existsSync(join(fixture, 'engine/state/memory/memory.db'))).toBe(true)
      // Empty conversations have no server history. Seed only ordinary history
      // placeholders; preference reads/writes and user selection stay real.
      await page.evaluate(({ suffix, first, second }) => {
        const now = Date.now()
        sessionStorage.setItem(`aether-pending-sessions${suffix}`, JSON.stringify([
          { sessionId: first, createdAt: now - 1, lastAt: now - 1 },
          { sessionId: second, createdAt: now, lastAt: now }
        ]))
        localStorage.setItem(`aether:sessionMeta${suffix}`, JSON.stringify({
          [first]: { name: 'Defaults session A' }, [second]: { name: 'Defaults session B' }
        }))
        if (suffix) localStorage.setItem(`aether:lastSessionId${suffix}`, first)
      }, { suffix: storageSuffix, first: firstSession, second: secondSession })
      await page.reload()
      await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 30_000 })
      await expect.poll(currentSession).toBe(firstSession)
    })

    test.afterAll(async () => {
      await app?.close()
      if (remoteEngine && remoteEngine.exitCode === null && remoteEngine.signalCode === null) {
        const child = remoteEngine
        await new Promise<void>((done, reject) => {
          const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Owned fixture engine did not exit')) }, 15_000)
          child.once('exit', () => { clearTimeout(timer); done() })
          child.kill('SIGTERM')
        })
      }
      if (!fixture) return
      const absolute = resolve(fixture)
      if (dirname(absolute) !== resolve(root, '.e2e-tmp') || !basename(absolute).startsWith(`composer-defaults-${mode}-`)) throw new Error('Unsafe composer fixture cleanup')
      rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    })

    test('未保存偏好时显示仅本会话 / High / 标准模式，且与真实引擎一致', async () => {
      await expectLabels('仅本会话', '标准模式')
      expect(await readPreferences(firstSession)).toEqual({
        memory: { sessionId: firstSession, memoryScope: 'session', effectiveScope: 'session', enabled: true },
        security: 'standard'
      })
      expect((await page.evaluate(() => window.aether.settings.get())).thinkingMode).toBe('high')
      await expect(page.locator('.composer-options__popup')).toContainText('只在当前会话中读取和写入')
    })

    test('显式关闭/全局记忆和安全/完全访问模式在刷新、切会话后不被默认值覆盖', async () => {
      await choose('选择长期记忆范围', '关闭记忆')
      await choose('选择安全模式', '安全模式')
      await expect.poll(async () => readPreferences(firstSession)).toMatchObject({ memory: { memoryScope: 'off', effectiveScope: 'off' }, security: 'safe' })
      await page.reload()
      await expectLabels('关闭记忆', '安全模式')

      await selectSession('Defaults session B', secondSession)
      await expectLabels('仅本会话', '标准模式')
      await choose('选择长期记忆范围', '全局记忆')
      await choose('选择安全模式', '完全访问')
      await expect.poll(async () => readPreferences(secondSession)).toMatchObject({ memory: { memoryScope: 'global', effectiveScope: 'global' }, security: 'full-access' })
      await selectSession('Defaults session A', firstSession)
      await expectLabels('关闭记忆', '安全模式')
      await selectSession('Defaults session B', secondSession)
      await expectLabels('全局记忆', '完全访问')
      await choose('选择思考档位', 'Low')
      await expectLabels('全局记忆', '完全访问', 'Low')
      expect((await page.evaluate(() => window.aether.settings.get())).thinkingMode).toBe('high')
      await page.reload()
      await expectLabels('全局记忆', '完全访问', 'Low')
      await selectSession('Defaults session A', firstSession)
      await expectLabels('关闭记忆', '安全模式', 'High')
      await selectSession('Defaults session B', secondSession)
      await expectLabels('全局记忆', '完全访问', 'Low')
      expect((await page.evaluate(() => window.aether.settings.get())).thinkingMode).toBe('high')
    })

    test('新建会话采用记忆、安全和全局思考默认值，不继承其他会话的手选档位', async () => {
      await closePreferences()
      await page.getByTitle('新建会话（开一条全新对话）', { exact: true }).click()
      await expect.poll(currentSession).not.toBe(secondSession)
      const created = await currentSession()
      expect(created).not.toBe('')
      expect(created).not.toBe(firstSession)
      await expectLabels('仅本会话', '标准模式', 'High')
      expect((await page.evaluate(() => window.aether.settings.get())).thinkingMode).toBe('high')
      expect(await readPreferences(created)).toEqual({
        memory: { sessionId: created, memoryScope: 'session', effectiveScope: 'session', enabled: true },
        security: 'standard'
      })
      expect(await readPreferences(firstSession)).toMatchObject({ memory: { memoryScope: 'off' }, security: 'safe' })
      expect(await readPreferences(secondSession)).toMatchObject({ memory: { memoryScope: 'global' }, security: 'full-access' })
    })
  })
}
