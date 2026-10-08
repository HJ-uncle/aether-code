/** Real Electron/IPC/HTTP coverage for explicitly trusted LAN account services.
 * Both HTTP servers bind a local non-loopback interface on random ports; no real
 * remote account is created. Only the native confirmation response is simulated. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AccountUser } from '../src/shared/account'
import type { AetherIdeApi } from '../src/preload'

declare global { interface Window { aether: AetherIdeApi } }
const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
const instance = 'account-http-trust-fixture-instance'
const access = 'account-http-trust-fixture-access'
const refresh = 'account-http-trust-fixture-refresh'
const recovery = 'account-http-trust-fixture-recovery'
const user: AccountUser = { id: 'http-trust-user', tenantId: 'http-trust-tenant', name: '内网用户4826', email: null, bio: null, avatarUrl: null, userData: {}, createdAt: new Date().toISOString(), identities: [] }
const requests: Array<{ origin: string; path: string; method: string }> = []
const pageErrors: string[] = []
let app: ElectronApplication | undefined
let page: Page
let fixture = ''
let remoteUrl = ''
let otherUrl = ''
let validSession = false
const servers: Server[] = []

function accountRequests(origin = remoteUrl): typeof requests {
  return requests.filter(request => request.origin === origin && request.path.startsWith('/auth/account/'))
}
function trustPath(): string { return join(fixture, 'accounts', 'trusted-http-services.json') }
function storedTrust(): { version: number; services: string[] } { return JSON.parse(readFileSync(trustPath(), 'utf8')) }

async function serve(address: string): Promise<string> {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture').pathname
    requests.push({ origin: `http://${request.headers.host}`, path, method: request.method ?? '' })
    for await (const _chunk of request) { /* Consume the real request body before responding. */ }
    const reply = (data: unknown, status = 200, message = 'ok'): void => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: status === 200 ? 200 : 40100, message, data }))
    }
    if (path === '/health') return reply({ status: 'ok' })
    if (path === '/meta') return reply({ version: '1.0.0', buildId: `sha256:${'a'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'account-http-trust-fixture' })
    if (request.headers['x-aether-instance-token'] !== instance) return reply(null, 401, 'Invalid or missing instance token')
    if (path === '/auth/account/providers') return reply({ providers: [], registrationEnabled: true })
    if (path === '/auth/account/register') {
      validSession = true
      return reply({ user, accessToken: access, refreshToken: refresh, recoveryKey: recovery, expiresAt: new Date(Date.now() + 3600000).toISOString() })
    }
    const authenticated = validSession && request.headers.authorization === `Bearer ${access}`
    if (path === '/auth/account/me') return authenticated ? reply(user) : reply(null, 401, '登录已失效')
    if (path.startsWith('/auth/account/')) return reply(null, 401, '未开放此测试账号接口')
    if (path.startsWith('/api/')) {
      if (!authenticated) return reply(null, 401, 'Authentication required')
      if (path === '/api/v1/chat/snapshot') return reply({ schemaVersion: 1, source: 'persisted', sessionId: 'http-trust-session', finished: true, projection: [], runs: [], history: [], todos: [], changes: [], commandJobs: [] })
      if (path === '/api/v1/chat/runs') return reply({ runs: [] })
      if (path === '/api/v1/workspace/directory') return reply({ root: '/fixture/workspace', entries: [] })
      return reply([])
    }
    return reply({})
  })
  servers.push(server)
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, address, () => { server.removeListener('error', reject); resolveListen() })
  })
  return `http://${address}:${(server.address() as AddressInfo).port}`
}

async function launch(): Promise<void> {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (['ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
  }
  app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env: { ...env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: instance } })
  page = await app.firstWindow()
  page.on('pageerror', error => pageErrors.push(error.message))
  await expect(page.locator('.status-bar')).toBeVisible()
  await page.getByRole('button', { name: '登录账号', exact: true }).click()
  await expect(page.locator('.account-settings')).toBeVisible()
}

async function setConfirmation(response: number): Promise<void> {
  await app!.evaluate(({ dialog }, nextResponse) => {
    Reflect.set(globalThis, '__accountHttpTrustDialog', null)
    Object.defineProperty(dialog, 'showMessageBox', { configurable: true, value: async (options: { title?: string; detail?: string; defaultId?: number; cancelId?: number; buttons?: string[] }) => {
      Reflect.set(globalThis, '__accountHttpTrustDialog', options)
      return { response: nextResponse, checkboxChecked: false }
    } })
  }, response)
}

test.describe.serial('可信内网 HTTP 登录真实界面闭环', () => {
  test.beforeAll(async () => {
    const address = Object.values(networkInterfaces()).flatMap(value => value ?? []).find(value => value.family === 'IPv4' && !value.internal)?.address
    test.skip(!address, '环境未提供可绑定的非回环 IPv4 地址，无法验证可信内网 HTTP 边界。')
    if (!address) return
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'account-http-trust-'))
    try {
      remoteUrl = await serve(address)
      otherUrl = await serve(address)
    } catch (cause) {
      const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : ''
      test.skip(['EACCES', 'EPERM', 'EADDRNOTAVAIL'].includes(code), `环境禁止绑定内网 HTTP 测试端口：${code}`)
      throw cause
    }
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: remoteUrl, autoStartEngine: false, lastSessionId: 'http-trust-session', lastFolder: '' }))
    await launch()
  })
  test.afterAll(async () => {
    await app?.close()
    for (const server of servers) {
      server.closeAllConnections()
      if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()))
    }
    if (fixture) {
      if (dirname(fixture) !== fixtureRoot || !basename(fixture).startsWith('account-http-trust-')) throw new Error('Unsafe HTTP trust fixture cleanup')
      rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })

  test('未确认地址时禁止账号请求，界面提供准确地址和信任入口', async () => {
    const state = await page.evaluate(() => window.aether.account.getState())
    expect(state.transport).toBe('http-untrusted')
    expect(state.status).toBe('unavailable')
    await expect(page.getByRole('region', { name: '内网 HTTP 连接' })).toContainText(remoteUrl)
    await expect(page.getByRole('button', { name: '信任此内网服务', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: '导入恢复凭证', exact: true })).toBeDisabled()
    const error = await page.evaluate(() => window.aether.account.register().then(() => '', cause => String(cause)))
    expect(error).toContain('可信内网')
    expect(error).not.toContain('Error invoking remote method')
    expect(accountRequests()).toEqual([])
    expect(existsSync(trustPath())).toBe(false)
  })

  test('取消原生信任确认不会保存信任或发送账号请求', async () => {
    await setConfirmation(0)
    await page.getByRole('button', { name: '信任此内网服务', exact: true }).click()
    await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, '__accountHttpTrustDialog'))).not.toBeNull()
    await expect(page.getByRole('button', { name: '信任此内网服务', exact: true })).toBeEnabled()
    const shown = await app!.evaluate(() => Reflect.get(globalThis, '__accountHttpTrustDialog') as { title: string; detail: string; defaultId: number; cancelId: number })
    expect(shown.title).toBe('信任内网 HTTP 服务')
    expect(shown.detail).toContain(remoteUrl)
    expect(shown.detail).toContain('明文')
    expect(shown.defaultId).toBe(0)
    expect(shown.cancelId).toBe(0)
    expect((await page.evaluate(() => window.aether.account.getState())).transport).toBe('http-untrusted')
    expect(existsSync(trustPath())).toBe(false)
    expect(accountRequests()).toEqual([])
  })

  test('明确确认后只持久化当前服务并放行账号发现', async () => {
    await setConfirmation(1)
    await page.getByRole('button', { name: '信任此内网服务', exact: true }).click()
    await expect(page.getByRole('button', { name: '撤销信任', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: '一键登录', exact: true })).toBeEnabled()
    expect((await page.evaluate(() => window.aether.account.getState())).transport).toBe('http-trusted')
    expect(storedTrust()).toEqual({ version: 1, services: [remoteUrl] })
    expect(accountRequests().some(request => request.path === '/auth/account/providers')).toBe(true)
    expect(accountRequests(otherUrl)).toEqual([])
  })

  test('重启保留服务信任，同一地址的其他端口仍需单独确认', async () => {
    await app!.close()
    app = undefined
    await launch()
    await expect(page.getByRole('button', { name: '撤销信任', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: '一键登录', exact: true })).toBeEnabled()
    expect((await page.evaluate(() => window.aether.account.getState())).transport).toBe('http-trusted')
    const stateB = await page.evaluate(async url => {
      await window.aether.engine.stop()
      await window.aether.settings.update({ remoteBaseUrl: url })
      return window.aether.account.getState()
    }, otherUrl)
    expect(stateB.serviceUrl).toBe(otherUrl)
    expect(stateB.transport).toBe('http-untrusted')
    await expect(page.getByRole('region', { name: '内网 HTTP 连接' })).toContainText(otherUrl)
    await expect(page.getByRole('button', { name: '信任此内网服务', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: '一键登录', exact: true })).toHaveCount(0)
    const error = await page.evaluate(key => window.aether.account.login(key).then(() => '', cause => String(cause)), recovery)
    expect(error).toContain('可信内网')
    expect(accountRequests(otherUrl)).toEqual([])
    expect(storedTrust().services).toEqual([remoteUrl])
    const stateA = await page.evaluate(async url => {
      await window.aether.settings.update({ remoteBaseUrl: url })
      return window.aether.account.getState()
    }, remoteUrl)
    expect(stateA.transport).toBe('http-trusted')
    await expect(page.getByRole('button', { name: '一键登录', exact: true })).toBeEnabled()
  })

  test('可信内网一键登录实际创建账号并弹出选填资料，凭证不进入界面', async () => {
    await page.getByRole('button', { name: '一键登录', exact: true }).click()
    const profile = page.getByRole('dialog', { name: '完善个人资料', exact: true })
    await expect(profile).toBeVisible()
    await expect(profile.getByLabel('姓名', { exact: true })).toHaveValue(user.name)
    expect(accountRequests().filter(request => request.path === '/auth/account/register' && request.method === 'POST')).toHaveLength(1)
    const state = await page.evaluate(() => window.aether.account.getState())
    expect(state.status).toBe('authenticated')
    expect(state.transport).toBe('http-trusted')
    expect(state.user?.id).toBe(user.id)
    await profile.getByRole('button', { name: '暂时跳过', exact: true }).click()
    await expect(profile).toHaveCount(0)
    const publicData = await page.evaluate(async () => JSON.stringify({ state: await window.aether.account.getState(), text: document.body.textContent }))
    for (const secret of [instance, access, refresh, recovery]) expect(publicData).not.toContain(secret)
    expect(pageErrors).toEqual([])
  })

  test('撤销信任持久生效，已有会话也不能继续发送账号凭证', async () => {
    await page.getByRole('button', { name: '撤销信任', exact: true }).click()
    await expect(page.getByRole('button', { name: '信任此内网服务', exact: true })).toBeEnabled()
    const before = accountRequests().length
    const state = await page.evaluate(() => window.aether.account.getState())
    expect(state.transport).toBe('http-untrusted')
    expect(state.status).not.toBe('authenticated')
    await expect(page.getByRole('button', { name: '一键登录', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '导入恢复凭证', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '保存资料', exact: true })).toBeDisabled()
    const errors = await page.evaluate(async key => {
      const actions = [() => window.aether.account.login(key), () => window.aether.account.updateProfile({ name: '不能发送' }), () => window.aether.account.sessions()]
      return Promise.all(actions.map(action => action().then(() => '', cause => String(cause))))
    }, recovery)
    for (const error of errors) {
      expect(error).toContain('可信内网')
      expect(error).not.toContain('Error invoking remote method')
    }
    expect(accountRequests()).toHaveLength(before)
    expect(storedTrust()).toEqual({ version: 1, services: [] })
    await page.reload()
    await expect(page.locator('.status-bar')).toBeVisible()
    await page.getByRole('button', { name: '个人账号', exact: true }).click()
    await expect(page.getByRole('button', { name: '信任此内网服务', exact: true })).toBeEnabled()
    expect((await page.evaluate(() => window.aether.account.getState())).transport).toBe('http-untrusted')
    expect(accountRequests()).toHaveLength(before)
    expect(pageErrors).toEqual([])
  })
})
