/** Actual Electron -> actual Fastify engine -> SQLite, with authentication enabled.
 * Only the external identity provider is a fixture. Verifies identity/data preservation,
 * tenant boundaries, refresh and revoked sessions rather than just matching mock envelopes. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AccountUser } from '../src/shared/account'
import type { AetherIdeApi } from '../src/preload'
declare global { interface Window { aether: AetherIdeApi } }
const root = resolve(__dirname, '..')
const engineRoot = resolve(root, '../ai-agent-engine')
let app: ElectronApplication | undefined
let page: Page
let engine: ChildProcess | undefined
let provider: Server
let fixture = ''
let url = ''
let original: AccountUser
let recoveryKey = ''
let modelId = ''
const instance = 'real-account-integration-instance'
const enterpriseCredential = 'real-account-integration-enterprise'
const rendererErrors: string[] = []
const engineErrors: string[] = []

async function freePort(): Promise<number> {
  const temporary = createServer()
  await new Promise<void>(done => temporary.listen(0, '127.0.0.1', done))
  const port = (temporary.address() as AddressInfo).port
  await new Promise<void>(done => temporary.close(() => done()))
  return port
}
async function rawAccount(path: string, body?: unknown, accessToken?: string): Promise<Response> {
  return fetch(url + '/auth/account' + path, {
    method: body ? 'POST' : 'GET', headers: {
      'X-Aether-Instance-Token': instance,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    }, body: body ? JSON.stringify(body) : undefined
  })
}

test.describe.serial('完整引擎账号认证', () => {
  test.beforeAll(async () => {
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
    fixture = mkdtempSync(join(root, '.e2e-tmp', 'account-real-'))
    provider = createServer(async (request, response) => {
      let body = ''
      for await (const part of request) body += part.toString()
      const valid = JSON.parse(body).credential === enterpriseCredential
      response.writeHead(valid ? 200 : 401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ active: valid, user: { id: 'employee-001', name: '企业用户', email: 'employee@example.test', avatar: 'https://example.test/avatar.png', data: { department: '研发', custom: { level: 3 }, token: 'must-not-be-stored' } } }))
    })
    await new Promise<void>(done => provider.listen(0, '127.0.0.1', done))
    const providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`
    const port = await freePort()
    url = `http://127.0.0.1:${port}`
    const environment = { ...process.env }
    for (const key of Object.keys(environment)) {
      if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN'].includes(key.toUpperCase())) delete environment[key]
    }
    const engineEnv = {
      ...environment, AUTH_ENABLED: 'true', AETHER_INSTANCE_TOKEN: instance,
      ENCRYPTION_KEY: 'c'.repeat(64), AETHER_ACCOUNT_REGISTRATION: 'true',
      PORT: String(port), HOST: '127.0.0.1', DATA_DIR: join(fixture, 'engine.db'),
      MEMORY_DB_PATH: join(fixture, 'memory.db'), AETHER_GLOBAL_DIR: join(fixture, 'global'),
      WORKSPACE_ROOT: join(fixture, 'workspace'), MCP_CONFIG_PATH: join(fixture, 'mcp.json'),
      SKILLS_ROOT: join(fixture, 'skills'), ENABLE_LONG_TERM_MEMORY: 'false',
      AETHER_ACCOUNT_PROVIDERS_JSON: JSON.stringify([{ id: 'company', name: '企业登录', type: 'credential', verificationUrl: providerUrl + '/verify', mapping: { subject: 'user.id', name: 'user.name', email: 'user.email', avatarUrl: 'user.avatar', userData: 'user.data' } }])
    }
    engine = spawn(process.execPath, [join(engineRoot, 'dist/main.js')], { cwd: fixture, env: engineEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    engine.stderr?.on('data', value => engineErrors.push(String(value)))
    await expect.poll(async () => {
      if (engine?.exitCode !== null) throw new Error('Fixture engine exited: ' + engineErrors.join('').slice(-2000))
      return fetch(url + '/health').then(response => response.status).catch(() => 0)
    }, { timeout: 90000 }).toBe(200)
    const appData = join(fixture, 'desktop')
    mkdirSync(appData)
    writeFileSync(join(appData, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: url, autoStartEngine: false, lastSessionId: 'account-real-session' }))
    app = await electron.launch({ args: ['.', `--user-data-dir=${appData}`], cwd: root, env: { ...environment, AETHER_IDE_REMOTE_INSTANCE_TOKEN: instance } })
    page = await app.firstWindow()
    page.on('pageerror', error => rendererErrors.push(error.message))
    await expect(page.locator('.status-bar')).toBeVisible()
  })
  test.afterAll(async () => {
    await app?.close()
    if (engine && engine.exitCode === null) {
      const exited = new Promise<void>(done => engine!.once('exit', () => done()))
      engine.kill()
      await exited
    }
    provider?.closeAllConnections()
    await new Promise<void>(done => provider?.close(() => done()))
    if (dirname(fixture) !== join(root, '.e2e-tmp') || !basename(fixture).startsWith('account-real-')) throw new Error('Unsafe account integration fixture cleanup')
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  test('一键登录通过真实实例与用户双重认证，恢复凭证仅由原生备份导出', async () => {
    expect((await fetch(url + '/auth/account/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401)
    expect((await rawAccount('/me')).status).toBe(401)
    const state = await page.evaluate(() => window.aether.account.register())
    expect(state.status).toBe('authenticated')
    original = state.user!
    expect(original.tenantId).not.toBe('default')
    const snapshot = await page.evaluate(() => window.aether.engine.getSnapshot())
    expect(snapshot.phase, snapshot.error ?? '').toBe('ready')
    expect(snapshot.accountId).toBe(original.id)
    const result = await page.evaluate(() => window.aether.engine.request({ method: 'GET', path: '/tools' }))
    expect(result.ok, result.message).toBe(true)
    const backup = join(fixture, 'recovery.json')
    await app!.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, backup)
    expect(await page.evaluate(() => window.aether.account.exportRecovery())).toBe(true)
    recoveryKey = JSON.parse(readFileSync(backup, 'utf8')).recoveryKey
    expect(recoveryKey.startsWith('aether_recovery_')).toBe(true)
    expect(JSON.stringify(state)).not.toContain(recoveryKey)
  })

  test('绑定第三方保持原账号和实际业务数据，扩展资料不会授予服务器权限', async () => {
    await page.evaluate(() => window.aether.account.updateProfile({ name: '需要重置的自定义姓名' }))
    const randomized = await page.evaluate(() => window.aether.account.updateProfile({ name: '' }))
    expect(randomized.user!.name).toMatch(/^用户 [0-9a-f]{6}$/)
    expect(randomized.user!.name).not.toBe('需要重置的自定义姓名')
    await page.evaluate(() => window.aether.account.updateProfile({ name: '原有账号', bio: '保留我的资料', userData: { project: 'original-project' } }))
    const created = await page.evaluate(() => window.aether.engine.request<{ id: string }>({ method: 'POST', path: '/models', body: { provider: 'openai', modelId: 'account-test', apiKey: 'synthetic-model-api-key', baseUrl: 'https://example.test/v1', displayName: '绑定前模型' } }))
    expect(created.ok, created.message).toBe(true)
    modelId = created.data!.id
    const linked = await page.evaluate(key => window.aether.account.externalLogin('company', 'link', key), enterpriseCredential)
    expect(linked.user).toMatchObject({ id: original.id, tenantId: original.tenantId, name: '原有账号', bio: '保留我的资料' })
    expect(linked.user!.identities[0]).toMatchObject({ name: '企业用户', email: 'employee@example.test', avatarUrl: 'https://example.test/avatar.png' })
    expect(linked.user!.identities[0].userData).toMatchObject({ department: '研发', custom: { level: 3 } })
    expect(JSON.stringify(linked)).not.toContain('must-not-be-stored')
    const denied = await page.evaluate(() => window.aether.engine.request({ method: 'PUT', path: '/security/mode', body: { mode: 'full-access', sessionId: 'account-real-session' } }))
    expect(denied.ok).toBe(false)
  })

  test('账号切换拒绝旧请求；第三方重新登录恢复同一份数据库记录', async () => {
    const before = await page.evaluate(() => window.aether.engine.getSnapshot())
    await page.evaluate(() => window.aether.account.logout())
    const different = await page.evaluate(() => window.aether.account.register())
    expect(different.user!.id).not.toBe(original.id)
    const stale = await page.evaluate(expectedEngine => window.aether.engine.request({ method: 'GET', path: '/models', expectedEngine }), before)
    expect(stale.code).toBe(409)
    const empty = await page.evaluate(() => window.aether.engine.request<Array<{ id: string }>>({ method: 'GET', path: '/models' }))
    expect(empty.ok, empty.message).toBe(true)
    expect(empty.data!.some(model => model.id === modelId)).toBe(false)
    await page.evaluate(() => window.aether.account.logout())
    const restored = await page.evaluate(key => window.aether.account.externalLogin('company', 'login', key), enterpriseCredential)
    expect(restored.user).toMatchObject({ id: original.id, name: '原有账号', bio: '保留我的资料', userData: { project: 'original-project' } })
    const models = await page.evaluate(() => window.aether.engine.request<Array<{ id: string }>>({ method: 'GET', path: '/models' }))
    expect(models.data!.some(model => model.id === modelId)).toBe(true)
  })

  test('主进程会话自动刷新后持续访问，服务端撤销后不能继续认证', async () => {
    await app!.evaluate(() => {
      const originalNow = Date.now
      Object.assign(globalThis, { __accountOriginalNow: originalNow })
      Date.now = () => originalNow() + 15 * 60_000
    })
    try {
      const state = await page.evaluate(() => window.aether.account.getState())
      expect(state.status, state.message ?? '').toBe('authenticated')
      expect(state.user!.id).toBe(original.id)
    } finally {
      await app!.evaluate(() => {
        const holder = globalThis as typeof globalThis & { __accountOriginalNow?: typeof Date.now }
        if (holder.__accountOriginalNow) Date.now = holder.__accountOriginalNow
        delete holder.__accountOriginalNow
      })
    }
    const sessions = await page.evaluate(() => window.aether.account.sessions())
    const current = sessions.find(session => session.current)!
    expect(current.id).toBeTruthy()
    await page.evaluate(id => window.aether.account.revokeSession(id), current.id)
    const expired = await page.evaluate(() => window.aether.account.getState())
    expect(expired.status).toBe('expired')
    const restored = await page.evaluate(key => window.aether.account.login(key), recoveryKey)
    expect(restored.user!.id).toBe(original.id)
    expect(rendererErrors).toEqual([])
  })
})
