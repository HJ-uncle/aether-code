/** Isolated Electron -> real account service -> real engine/SQLite contract.
 * Build both repositories first. Only the OS save dialog is stubbed; no real
 * user profile, credentials, clipboard or model provider is accessed. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AccountUser } from '../src/shared/account'

const root = resolve(__dirname, '..'), temporaryRoot = join(root, '.e2e-tmp/account-simplify')
const engineEntry = resolve(root, '../ai-agent-engine/dist/main.js')
const instanceToken = randomBytes(32).toString('hex')
let directory = '', origin = '', engineLog = '', runner: ChildProcess | undefined, stopped: Promise<void> | undefined
let app: ElectronApplication | undefined, page: Page
const errors: string[] = []
function cleanEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ||
    /^AETHER_|^ELECTRON_|^ENCRYPTION_KEY$|^DATA_DIR$|^MEMORY_|^HISTORY_|^WORKSPACE_|^SKILLS_|^MCP_|^LLM_|^AUTH_|^OSM_|^QA_|^LOG_|^OPENAI_|^ANTHROPIC_|^DEEPSEEK_|^DEFAULT_SECURITY_MODE$|^ENABLE_LONG_TERM_MEMORY$/i.test(key) ? [] : [[key, value]]))
}
async function direct<T>(path: string, body: unknown, access?: string): Promise<{ code: number; data: T }> {
  const response = await fetch(origin + '/auth/account' + path, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aether-instance-token': instanceToken, ...(access ? { Authorization: `Bearer ${access}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000) })
  return response.json() as Promise<{ code: number; data: T }>
}

test.describe('真实账号集成', () => {
  test.beforeAll(async () => {
    expect(existsSync(engineEntry), '先 build 引擎').toBe(true)
    mkdirSync(temporaryRoot, { recursive: true }); directory = mkdtempSync(join(temporaryRoot, 'integration-'))
    const profile = join(directory, 'profile'), workspace = join(directory, 'workspace')
    mkdirSync(profile); mkdirSync(workspace)
    const listener = createServer(); await new Promise<void>(done => listener.listen(0, '127.0.0.1', done))
    const address = listener.address(); if (!address || typeof address === 'string') throw new Error('No test port')
    const port = address.port; await new Promise<void>(done => listener.close(() => done()))
    origin = `http://127.0.0.1:${port}`
    const host = join(directory, 'engine-host.mjs')
    writeFileSync(host, `process.on('message', m => { if (m?.command === 'shutdown') process.emit('SIGTERM') });\nawait import(${JSON.stringify(pathToFileURL(engineEntry).href)});\n`)
    runner = spawn(process.execPath, [host], { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {
      ...cleanEnv(), AUTH_ENABLED: 'false', DATA_DIR: join(directory, 'engine/state/agent.db'), MEMORY_DB_PATH: join(directory, 'engine/state/memory.db'),
      ENCRYPTION_KEY: randomBytes(32).toString('hex'), WORKSPACE_ROOT: workspace, AETHER_GLOBAL_DIR: join(directory, 'engine/global'),
      SKILLS_ROOT: join(directory, 'engine/skills'), MCP_CONFIG_PATH: join(directory, 'engine/mcp.json'), PROGRAMDATA: join(directory, 'managed'),
      AETHER_ENGINE_HOST: '127.0.0.1', AETHER_ENGINE_PORT: String(port), AETHER_INSTANCE_TOKEN: instanceToken, AETHER_DESKTOP_OWNED: '1',
      DEFAULT_SECURITY_MODE: 'standard', HISTORY_BACKEND: 'jsonl', OSM_MODE: 'balanced', ENABLE_LONG_TERM_MEMORY: 'false',
      QA_LOG_ENABLED: 'false', QA_LOG_DIR: join(directory, 'engine/qa'), LOG_LEVEL: 'warn', NODE_ENV: 'development' } })
    stopped = new Promise<void>(done => runner!.once('close', () => done()))
    for (const stream of [runner.stdout, runner.stderr]) stream?.on('data', bytes => {
      engineLog = (engineLog + String(bytes)).slice(-100000); writeFileSync(join(directory, 'engine.log'), engineLog)
    })
    await expect.poll(async () => {
      if (runner!.exitCode !== null) throw new Error('Fixture engine exited: ' + engineLog.slice(-1500))
      try { return (await fetch(origin + '/auth/account/providers', { headers: { 'x-aether-instance-token': instanceToken }, signal: AbortSignal.timeout(2000) })).ok }
      catch { return false }
    }, { timeout: 90000, intervals: [250, 500, 1000] }).toBe(true)
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, remoteWorkspaceRoot: workspace,
      autoStartEngine: true, lastFolder: '', lastSessionId: '', appearance: 'light' }))
    app = await electron.launch({ args: [join(root, 'out/main/index.js'), '--user-data-dir=' + profile], cwd: root,
      env: { ...cleanEnv(), AETHER_IDE_REMOTE_INSTANCE_TOKEN: instanceToken, AETHER_GLOBAL_DIR: join(directory, 'desktop-global') } })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90000 })
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
    }, join(directory, 'recovery.json'))
  })
  test.afterAll(async () => {
    await app?.close()
    if (runner?.connected) runner.send({ command: 'shutdown' })
    if (stopped) await Promise.race([stopped, new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Fixture engine shutdown timeout')), 20000))])
    // Preserve the isolated fixture and failure evidence in ignored storage.
  })
  test('创建、无副作用备份、原地重验、权限提示与退出后恢复同一账号', async () => {
    const account = await page.evaluate(() => window.aether.account.register())
    expect(account.status).toBe('authenticated'); expect(account.user?.roles).toEqual(['tenant-admin'])
    expect(account.user?.authenticatedAt).toBeTruthy(); expect(account.recovery?.exportedAt).toBeNull()
    const identity = await page.evaluate(() => window.aether.engine.getSnapshot())
    expect(identity.accountId).toBe(account.user!.id)
    expect(await page.evaluate(() => window.aether.account.exportRecovery())).toBe(true)
    const recovery = JSON.parse(readFileSync(join(directory, 'recovery.json'), 'utf8')) as { recoveryKey: string; userId: string }
    expect(recovery.userId).toBe(account.user!.id)
    const other = await direct<{ accessToken: string; user: AccountUser }>('/login', { recoveryKey: recovery.recoveryKey })
    expect(other.code).toBe(200)
    expect(await page.evaluate(() => window.aether.account.exportRecovery())).toBe(true)
    expect(JSON.parse(readFileSync(join(directory, 'recovery.json'), 'utf8')).recoveryKey).toBe(recovery.recoveryKey)
    expect(await page.evaluate(() => window.aether.account.sessions())).toHaveLength(2)
    const bad = await page.evaluate(async () => {
      try { await window.aether.account.reauthenticate('invalid-recovery'); return '' } catch (error) { return String(error) }
    })
    expect(bad).not.toBe('')
    const verified = await page.evaluate(key => window.aether.account.reauthenticate(key), recovery.recoveryKey)
    expect(verified.user!.id).toBe(account.user!.id); expect(verified.user!.sessionId).toBe(account.user!.sessionId)
    const identityAfter = await page.evaluate(() => window.aether.engine.getSnapshot())
    expect(identityAfter.accountId).toBe(identity.accountId); expect(identityAfter.instanceId).toBe(identity.instanceId)
    const capabilities = await page.evaluate(async () => ({
      skills: await window.aether.engine.request<{ permissions: { canManage: boolean } }>({ method: 'GET', path: '/skills', query: { available: 1 } }),
      settings: await window.aether.engine.request<{ permissions: { canManage: boolean } }>({ method: 'GET', path: '/settings' }),
      write: await window.aether.engine.request({ method: 'PUT', path: '/settings', body: { SUBAGENT_CONCURRENCY_LIMIT: 3 } })
    }))
    expect(capabilities.skills.ok).toBe(true); expect(capabilities.skills.data?.permissions.canManage).toBe(false)
    expect(capabilities.settings.data?.permissions.canManage).toBe(false); expect(capabilities.write.code).toBe(41015)
    await page.locator('.menu-bar').getByRole('button', { name: '个人账号', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('tab', { name: '技能', exact: true }).click()
    await expect(settings.getByRole('list', { name: '可用技能', exact: true })).toBeVisible()
    await expect(settings.getByRole('button', { name: '创建技能', exact: true })).toHaveCount(0)
    await expect(settings.getByRole('alert')).toHaveCount(0)
    await settings.getByRole('tab', { name: '模型', exact: true }).click()
    await expect(settings).toContainText('此数量由服务管理员管理')
    await expect(settings.getByRole('button', { name: '子代理并发数量', exact: true })).toBeDisabled()
    await page.screenshot({ path: join(directory, 'permissions.png') })
    await page.evaluate(() => window.aether.account.regenerateRecovery())
    expect(await page.evaluate(() => window.aether.account.sessions())).toHaveLength(1)
    expect((await direct('/login', { recoveryKey: recovery.recoveryKey })).code).not.toBe(200)
    expect(await page.evaluate(() => window.aether.account.exportRecovery())).toBe(true)
    const rotated = JSON.parse(readFileSync(join(directory, 'recovery.json'), 'utf8')) as { recoveryKey: string }
    expect(rotated.recoveryKey).not.toBe(recovery.recoveryKey)
    await page.evaluate(() => window.aether.account.logout())
    expect((await page.evaluate(() => window.aether.engine.getSnapshot())).accountId).toBeNull()
    const restored = await page.evaluate(key => window.aether.account.login(key), rotated.recoveryKey)
    expect(restored.user!.id).toBe(account.user!.id); expect(restored.user!.tenantId).toBe(account.user!.tenantId)
    expect(errors).toEqual([])
  })
})
