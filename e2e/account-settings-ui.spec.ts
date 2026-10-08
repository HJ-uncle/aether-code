/** Account UI through real Electron/preload/IPC/HTTP: register, profile, credentials,
 * provider linking, sessions and logout. Only HTTP and native file/browser pickers
 * are fixtures. OS encryption may use the supported in-memory session fallback. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AccountSession, AccountUser } from '../src/shared/account'
import type { AetherIdeApi } from '../src/preload'

declare global { interface Window { aether: AetherIdeApi } }
const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
const instance = 'account-ui-instance-fixture-2026'
const access = 'account-ui-access-fixture-2026'
const refresh = 'account-ui-refresh-fixture-2026'
const recovery = 'account-ui-recovery-fixture-2026'
const providerCredential = 'account-ui-provider-fixture-2026'
const rotatedAccess = 'account-ui-access-rotated-fixture-2026'
const rotatedRefresh = 'account-ui-refresh-rotated-fixture-2026'
const secrets = [instance, access, refresh, recovery, providerCredential, rotatedAccess, rotatedRefresh]
let app: ElectronApplication | undefined
let page: Page
let server: Server
let fixture = ''
let remoteUrl = ''
let user: AccountUser = { id: 'account-ui-user', tenantId: 'account-ui-tenant', name: '云雀4826', email: null, bio: null, avatarUrl: null, userData: {}, createdAt: new Date().toISOString(), identities: [] }
let sessionValid = false
let nextMe: 'normal' | 'malformed' | 'hold-unauthorized' | 'hold-success' = 'normal'
let releaseStaleMe: (() => void) | null = null
let holdRefresh = false
let releaseRefresh: (() => void) | null = null
let holdProfile = false
let releaseProfile: (() => void) | null = null
let activeAccess = access
let activeRefresh = refresh
let credentialLifetimeMs = 3600000
let rotatedAuthenticatedRequests = 0
let sessions: AccountSession[] = [
  { id: 'session-current', current: true, createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() },
  { id: 'session-other', current: false, createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() }
]
const requests: Array<{ path: string; method: string; authenticated: boolean; body: Record<string, unknown> }> = []
const pageErrors: string[] = []
const credential = (otherScope = false) => ({ user, accessToken: otherScope ? access : activeAccess, refreshToken: otherScope ? refresh : activeRefresh, recoveryKey: recovery, expiresAt: new Date(Date.now() + credentialLifetimeMs).toISOString() })

function launchEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (['ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete environment[key]
  }
  return { ...environment, AETHER_IDE_REMOTE_INSTANCE_TOKEN: instance }
}

async function assertPublicState(): Promise<void> {
  const values = await page.evaluate(async () => JSON.stringify({
    account: await window.aether.account.getState(), settings: await window.aether.settings.get(),
    snapshot: await window.aether.engine.getSnapshot(), text: document.body.textContent
  }))
  for (const secret of secrets) expect(values.includes(secret), 'Credential must not enter public state').toBe(false)
  expect(pageErrors).toEqual([])
}

test.describe.serial('个人账号真实界面闭环', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'account-ui-'))
    server = createServer(async (request, response) => {
      const path = new URL(request.url ?? '/', 'http://fixture').pathname
      let raw = ''
      for await (const chunk of request) raw += chunk.toString()
      const body: Record<string, unknown> = raw ? JSON.parse(raw) : {}
      const otherScope = request.headers.host?.startsWith('localhost:') ?? false
      const authenticated = sessionValid && request.headers.authorization === `Bearer ${otherScope ? access : activeAccess}`
      if (!otherScope && authenticated && activeAccess === rotatedAccess) rotatedAuthenticatedRequests++
      requests.push({ path, method: request.method ?? '', authenticated, body })
      const reply = (data: unknown, status = 200, message = 'ok'): void => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: status === 200 ? 200 : 40100, message, data }))
      }
      if (path === '/health') return reply({ status: 'ok' })
      if (path === '/meta') return reply({ version: '1.0.0', buildId: `sha256:${'a'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'account-ui-engine' })
      if (request.headers['x-aether-instance-token'] !== instance) return reply(null, 401, 'Invalid or missing instance token')
      if (path === '/auth/account/providers') return reply({ providers: [{ id: 'fixture', name: '企业账号', type: 'credential' }, { id: 'browser', name: '浏览器账号', type: 'oidc' }], registrationEnabled: true })
      if (path === '/auth/account/register') { sessionValid = true; return reply(credential(otherScope)) }
      if (path === '/auth/account/login') {
        if (body.recoveryKey !== recovery) return reply(null, 401, '恢复码无效')
        sessionValid = true; return reply(credential(otherScope))
      }
      if (path === '/auth/account/refresh') {
        if (body.refreshToken !== (otherScope ? refresh : activeRefresh)) return reply(null, 401, '刷新凭证已轮换')
        if (!otherScope && holdRefresh) {
          holdRefresh = false
          // Rotation commits before its response reaches the client, just like
          // the real engine; withholding the response must not keep old access valid.
          activeAccess = rotatedAccess
          activeRefresh = rotatedRefresh
          releaseRefresh = () => { reply(credential()) }
          return
        }
        return reply(credential(otherScope))
      }
      if (path === '/auth/account/external/start') return reply({ authorizationUrl: remoteUrl + '/authorize', flowId: 'flow-fixture', pollToken: 'poll-fixture-private' })
      if (path === '/auth/account/external/poll') return reply({ status: 'pending' })
      if (path.startsWith('/auth/account/')) {
        if (!authenticated) return reply(null, 401, '登录已失效')
        if (path === '/auth/account/me') {
          const mode = nextMe
          nextMe = 'normal'
          if (mode === 'malformed') return reply({ ...user, userData: undefined })
          if (mode === 'hold-unauthorized') { releaseStaleMe = () => reply(null, 401, '旧会话已过期'); return }
          if (mode === 'hold-success') { const capturedUser = structuredClone(user); releaseStaleMe = () => reply(capturedUser); return }
          return reply(user)
        }
        if (path === '/auth/account/profile') {
          const saveProfile = (): void => {
            user = { ...user, name: String(body.name || '云雀随机姓名'), email: body.email ? String(body.email) : null, bio: body.bio ? String(body.bio) : null }
            reply(user)
          }
          if (holdProfile) { holdProfile = false; releaseProfile = saveProfile; return }
          return saveProfile()
        }
        if (path === '/auth/account/sessions') return reply(sessions)
        if (path.startsWith('/auth/account/sessions/') && request.method === 'DELETE') {
          sessions = sessions.filter(value => value.id !== path.split('/').at(-1)); return reply({ revoked: true })
        }
        if (path === '/auth/account/external/credential') {
          if (body.mode !== 'link' || body.credential !== providerCredential) return reply(null, 401, '第三方凭证无效')
          user = { ...user, identities: [{ providerId: 'fixture', subject: 'provider-user', name: '企业用户', email: 'third@example.test', userData: { team: '<img src=x onerror=alert(1)>' } }] }
          return reply(user)
        }
        if (path === '/auth/account/identities/fixture' && request.method === 'DELETE') { user = { ...user, identities: [] }; return reply(user) }
        if (path === '/auth/account/logout') { sessionValid = false; return reply({ loggedOut: true }) }
        return reply({})
      }
      if (path.startsWith('/api/')) {
        if (!authenticated) return reply(null, 401, 'Authentication required')
        if (path === '/api/v1/chat/snapshot') return reply({ schemaVersion: 1, source: 'persisted', sessionId: 'account-ui-session', finished: true, projection: [], runs: [], history: [], todos: [], changes: [], commandJobs: [] })
        if (path === '/api/v1/chat/runs') return reply({ runs: [] })
        if (path === '/api/v1/workspace/directory') return reply({ root: '/account/workspace', entries: [] })
        return reply([])
      }
      return reply({})
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    remoteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: remoteUrl, autoStartEngine: false, lastSessionId: 'account-ui-session', lastFolder: '' }))
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env: launchEnvironment() })
    page = await app.firstWindow()
    page.on('pageerror', error => pageErrors.push(error.message))
    await expect(page.locator('.status-bar')).toBeVisible()
  })
  test.afterAll(async () => {
    releaseStaleMe?.()
    releaseStaleMe = null
    releaseRefresh?.()
    releaseRefresh = null
    releaseProfile?.()
    releaseProfile = null
    await app?.close()
    server?.closeAllConnections()
    await new Promise<void>(resolve => server?.close(() => resolve()))
    if (dirname(fixture) !== fixtureRoot || !basename(fixture).startsWith('account-ui-')) throw new Error('Unsafe account fixture cleanup')
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  test('设置旁登录入口支持键盘资料提示并进入个人账号分区', async () => {
    const login = page.getByRole('button', { name: '登录账号', exact: true })
    await login.focus()
    await expect(page.getByRole('tooltip')).toContainText('个人账号')
    await login.click()
    await expect(page.getByRole('tab', { name: '个人账号', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('button', { name: '一键登录', exact: true })).toBeEnabled()
    await expect(page.locator('.account-settings')).toContainText('其他登录方式')
  })

  test('一键登录真实创建账号，资料弹窗可跳过且键盘焦点不会逃出', async () => {
    await page.evaluate(() => {
      const statuses: string[] = []
      Reflect.set(window, '__accountRegistrationStates', statuses)
      window.aether.account.onChanged(state => { statuses.push(state.status) })
    })
    await page.getByRole('button', { name: '一键登录', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '完善个人资料', exact: true })
    await expect(dialog).toBeVisible()
    const statuses = await page.evaluate(() => Reflect.get(window, '__accountRegistrationStates') as string[])
    expect(statuses, 'Creating a session must not broadcast a stale signed-out snapshot').not.toContain('signed-out')
    expect(requests.filter(value => value.path === '/auth/account/register' && value.method === 'POST')).toHaveLength(1)
    expect((await page.evaluate(() => window.aether.account.getState())).user?.name).toBe('云雀4826')
    // Restart intentionally clears the renderer's account snapshot. The pending
    // first-login interaction belongs to this user, not the mounted settings view.
    const restarted = await page.evaluate(() => window.aether.engine.restart())
    expect(restarted.phase, restarted.error ?? '').toBe('ready')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('姓名', { exact: true })).toHaveValue('云雀4826')
    expect(await page.evaluate(() => Reflect.get(window, '__accountRegistrationStates') as string[])).not.toContain('signed-out')
    await dialog.getByRole('button', { name: '保存并继续' }).focus()
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: '个人账号', exact: true })).toBeVisible()
    const state = await page.evaluate(() => window.aether.account.getState())
    if (state.persistence === 'session') await expect(page.locator('.account-message--warning')).toContainText('本次应用运行期间')
    expect(['encrypted', 'session']).toContain(state.persistence)
    await assertPublicState()
  })

  test('资料修改落到服务端，头像悬停同步显示基础资料', async () => {
    await page.getByLabel('姓名', { exact: true }).fill('林同学')
    await page.getByLabel('邮箱', { exact: true }).fill('lin@example.test')
    await page.getByLabel('简介', { exact: true }).fill('专注完成每一项工作。')
    await page.getByRole('button', { name: '保存资料', exact: true }).click()
    await expect.poll(() => user.name).toBe('林同学')
    expect(user.email).toBe('lin@example.test')
    expect(requests.filter(value => value.path === '/auth/account/profile').at(-1)?.authenticated).toBe(true)
    await page.getByRole('button', { name: '个人账号', exact: true }).hover()
    await expect(page.getByRole('tooltip')).toContainText('lin@example.test')
    await expect(page.getByRole('tooltip')).toContainText('专注完成每一项工作。')
    await assertPublicState()
  })

  test('第三方凭证绑定保留账号，扩展资料只渲染文本', async () => {
    const originalId = user.id
    const row = page.locator('.sg__row').filter({ has: page.locator('.sg__row-label', { hasText: /^企业账号$/ }) })
    await row.getByLabel('企业账号登录凭证').fill(providerCredential)
    await row.getByRole('button', { name: '继续', exact: true }).click()
    await expect(row).toContainText('已绑定到当前账号')
    expect(user.id).toBe(originalId)
    expect(user.identities[0].providerId).toBe('fixture')
    expect(requests.filter(value => value.path === '/auth/account/external/credential').at(-1)?.body.mode).toBe('link')
    await page.locator('.account-settings summary').filter({ hasText: '账号详情' }).click()
    await expect(page.locator('.account-identity pre')).toContainText('<img src=x onerror=alert(1)>')
    await expect(page.locator('.account-identity img')).toHaveCount(0)
    await assertPublicState()
  })

  test('登录设备撤销调用真实接口并刷新列表', async () => {
    await page.locator('.account-settings summary').filter({ hasText: '登录设备' }).click()
    await page.getByRole('button', { name: '刷新登录设备', exact: true }).click()
    const other = page.locator('.account-session').filter({ hasText: '其他设备' })
    await expect(other).toBeVisible()
    await other.getByRole('button', { name: '撤销登录', exact: true }).click()
    await page.getByRole('dialog', { name: '撤销登录', exact: true }).getByRole('button', { name: '撤销登录', exact: true }).click()
    await expect.poll(() => sessions.length).toBe(1)
    await expect(other).toHaveCount(0)
    expect(requests.some(value => value.path === '/auth/account/sessions/session-other' && value.method === 'DELETE' && value.authenticated)).toBe(true)
  })

  test('浏览器第三方授权可以取消，未完成不会绑定新身份', async () => {
    await app!.evaluate(({ shell }) => { shell.openExternal = async () => undefined })
    const row = page.locator('.sg__row').filter({ has: page.locator('.sg__row-label', { hasText: /^浏览器账号$/ }) })
    await row.getByRole('button', { name: '继续', exact: true }).click()
    await expect(page.locator('.account-external-pending')).toBeVisible()
    await expect.poll(() => requests.some(value => value.path === '/auth/account/external/start')).toBe(true)
    await page.getByRole('button', { name: '取消登录', exact: true }).click()
    await expect(page.locator('.account-external-pending')).toHaveCount(0)
    expect(user.identities.map(value => value.providerId)).toEqual(['fixture'])
  })

  test('备份和导入经过主进程文件选择，退出后可恢复原账号', async () => {
    const backupPath = join(fixture, 'account-backup.json')
    await app!.evaluate(({ dialog }, path) => {
      Object.defineProperty(dialog, 'showSaveDialog', { configurable: true, value: async () => ({ canceled: false, filePath: path }) })
      Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [path] }) })
    }, backupPath)
    await page.getByRole('button', { name: '备份恢复凭证', exact: true }).click()
    await expect.poll(() => existsSync(backupPath)).toBe(true)
    const backup = JSON.parse(readFileSync(backupPath, 'utf8'))
    expect(backup.userId).toBe(user.id)
    expect(backup.recoveryKey === recovery).toBe(true)
    expect(backup.serviceUrl).toBe(remoteUrl)
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByRole('dialog', { name: '退出账号', exact: true }).getByRole('button', { name: '退出登录', exact: true }).click()
    await expect(page.getByRole('button', { name: '登录账号', exact: true })).toBeVisible()
    expect(sessionValid).toBe(false)
    await expect(page.locator('.account-summary')).not.toContainText('林同学')
    await page.getByRole('button', { name: '导入恢复凭证', exact: true }).click()
    await expect(page.locator('.account-summary')).toContainText('林同学')
    await expect(page.getByRole('dialog', { name: '完善个人资料', exact: true })).toHaveCount(0)
    expect(requests.filter(value => value.path === '/auth/account/login').length).toBeGreaterThan(0)
    await assertPublicState()
  })

  test('姓名留空交给服务端生成，页面重载后保持账号状态', async () => {
    await page.getByLabel('姓名', { exact: true }).fill('')
    await page.getByRole('button', { name: '保存资料', exact: true }).click()
    await expect.poll(() => user.name).toBe('云雀随机姓名')
    await page.reload()
    await expect(page.locator('.status-bar')).toBeVisible()
    await page.getByRole('button', { name: '个人账号', exact: true }).click()
    await expect(page.getByLabel('姓名', { exact: true })).toHaveValue('云雀随机姓名')
    await assertPublicState()
  })

  test('账号接口缺少资料字段时保留原资料并显示离线，不造成渲染异常', async () => {
    const before = await page.evaluate(() => window.aether.account.getState())
    nextMe = 'malformed'
    const malformed = await page.evaluate(() => window.aether.account.getState())
    expect(malformed.status).toBe('offline')
    expect(malformed.user).toEqual(before.user)
    await expect(page.locator('.account-status')).toContainText('离线')
    await expect(page.getByLabel('姓名', { exact: true })).toHaveValue(user.name)
    expect(pageErrors).toEqual([])
    await page.getByRole('button', { name: '刷新账号状态', exact: true }).click()
    await expect(page.locator('.account-status')).toContainText('已登录')
  })

  test('旧资料读取的401在重新登录之后到达，不能覆盖新登录状态', async () => {
    nextMe = 'hold-unauthorized'
    const staleRead = page.evaluate(() => window.aether.account.getState())
    try {
      await expect.poll(() => releaseStaleMe !== null).toBe(true)
      const relogged = await page.evaluate(key => window.aether.account.login(key), recovery)
      expect(relogged.status).toBe('authenticated')
      releaseStaleMe!()
      releaseStaleMe = null
      const staleResult = await staleRead
      expect(staleResult.status).toBe('authenticated')
      expect(staleResult.user?.id).toBe(user.id)
      await expect(page.locator('.account-status')).toContainText('已登录')
      expect(pageErrors).toEqual([])
    } finally {
      releaseStaleMe?.()
      releaseStaleMe = null
      await staleRead
    }
  })

  test('引擎仍连接A时保存B地址不转移账号操作，资料继续写到A', async () => {
    const otherRequests: string[] = []
    const other = createServer((request, response) => {
      otherRequests.push(request.url ?? '')
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 40100, message: 'B must not receive this account request', data: null }))
    })
    await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve))
    const otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}`
    const beforeProfile = requests.filter(value => value.path === '/auth/account/profile').length
    try {
      const original = await page.evaluate(() => window.aether.engine.getSnapshot())
      expect(original.phase).toBe('ready')
      expect(original.baseUrl).toBe(remoteUrl)
      await page.evaluate(url => window.aether.settings.update({ remoteBaseUrl: url }), otherUrl)
      const state = await page.evaluate(() => window.aether.account.getState())
      expect(state.serviceUrl).toBe(remoteUrl)
      expect(state.user?.id).toBe(user.id)
      await page.getByLabel('简介', { exact: true }).fill('仍在服务A更新个人资料')
      await page.getByRole('button', { name: '保存资料', exact: true }).click()
      await expect.poll(() => user.bio).toBe('仍在服务A更新个人资料')
      expect(requests.filter(value => value.path === '/auth/account/profile')).toHaveLength(beforeProfile + 1)
      expect(otherRequests).toEqual([])
      expect((await page.evaluate(() => window.aether.engine.getSnapshot())).baseUrl).toBe(remoteUrl)
    } finally {
      await page.evaluate(url => window.aether.settings.update({ remoteBaseUrl: url }), remoteUrl)
      other.closeAllConnections()
      await new Promise<void>(resolve => other.close(() => resolve()))
    }
    await assertPublicState()
  })

  test('旧资料读取成功在保存新资料后到达，不能覆盖已确认的新姓名', async () => {
    const oldName = user.name
    nextMe = 'hold-success'
    const staleRead = page.evaluate(() => window.aether.account.getState())
    try {
      await expect.poll(() => releaseStaleMe !== null).toBe(true)
      const updated = await page.evaluate(() => window.aether.account.updateProfile({ name: '迟到响应保护后的姓名', email: 'lin@example.test', bio: '专注完成每一项工作。' }))
      expect(updated.user?.name).toBe('迟到响应保护后的姓名')
      expect(user.name).not.toBe(oldName)
      releaseStaleMe!()
      releaseStaleMe = null
      const staleResult = await staleRead
      expect(staleResult.user?.name).toBe('迟到响应保护后的姓名')
      await expect(page.getByLabel('姓名', { exact: true })).toHaveValue('迟到响应保护后的姓名')
      await expect(page.locator('.account-summary')).toContainText('迟到响应保护后的姓名')
      expect(pageErrors).toEqual([])
    } finally {
      releaseStaleMe?.()
      releaseStaleMe = null
      await staleRead
    }
  })

  test('A刷新在切B登录后完成仍保存A轮换凭证，返回A使用新令牌', async () => {
    const otherUrl = remoteUrl.replace('127.0.0.1', 'localhost')
    credentialLifetimeMs = 4 * 3600000
    holdRefresh = true
    await app!.evaluate(() => {
      const original = Date.now
      Object.defineProperty(globalThis, '__accountFixtureDateNow', { configurable: true, value: original })
      Date.now = () => original() + 61 * 60000
    })
    const refreshingA = page.evaluate(() => window.aether.account.getState())
    try {
      await expect.poll(() => releaseRefresh !== null).toBe(true)
      const loggedInB = await page.evaluate(async ({ url, key }) => {
        await window.aether.engine.stop()
        await window.aether.settings.update({ remoteBaseUrl: url })
        return window.aether.account.login(key)
      }, { url: otherUrl, key: recovery })
      expect(loggedInB.status).toBe('authenticated')
      expect(loggedInB.serviceUrl).toBe(otherUrl)
      releaseRefresh!()
      releaseRefresh = null
      await refreshingA
      const beforeRotatedRequest = rotatedAuthenticatedRequests
      const connectedA = await page.evaluate(async url => {
        await window.aether.engine.stop()
        await window.aether.settings.update({ remoteBaseUrl: url })
        return window.aether.engine.start()
      }, remoteUrl)
      expect(connectedA.phase, connectedA.error ?? '').toBe('ready')
      const state = await page.evaluate(() => window.aether.account.getState())
      expect(state.status).toBe('authenticated')
      expect(state.serviceUrl).toBe(remoteUrl)
      expect(rotatedAuthenticatedRequests).toBeGreaterThan(beforeRotatedRequest)
      expect(requests.filter(value => value.path === '/auth/account/refresh' && value.body.refreshToken === refresh)).toHaveLength(1)
    } finally {
      releaseRefresh?.()
      releaseRefresh = null
      holdRefresh = false
      await refreshingA.catch(() => undefined)
      await app!.evaluate(() => {
        const original: unknown = Reflect.get(globalThis, '__accountFixtureDateNow')
        if (typeof original === 'function') Date.now = original as typeof Date.now
        Reflect.deleteProperty(globalThis, '__accountFixtureDateNow')
      })
      await page.evaluate(async url => {
        await window.aether.engine.stop()
        await window.aether.settings.update({ remoteBaseUrl: url })
        await window.aether.engine.start()
      }, remoteUrl)
    }
    await assertPublicState()
    await page.getByRole('button', { name: '个人账号', exact: true }).click()
    await expect(page.locator('.account-summary')).toContainText('迟到响应保护后的姓名')
    await page.locator('.app-settings__body').evaluate(element => { element.scrollTop = 0 })
    await page.screenshot({ path: join(fixtureRoot, 'account-settings-preview.png'), fullPage: true })
  })

  test('A排队的恢复码、第三方凭证和备份导入在切到B后全部取消，不向B发送凭证', async () => {
    const otherRequests: Array<{ path: string; method: string }> = []
    const other = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://fixture').pathname
      otherRequests.push({ path, method: request.method ?? '' })
      const providers = path === '/auth/account/providers'
      response.writeHead(providers ? 200 : 401, { 'content-type': 'application/json' })
      response.end(JSON.stringify(providers
        ? { code: 200, message: 'ok', data: { providers: [], registrationEnabled: false } }
        : { code: 40100, message: 'B must not receive credentials from A', data: null }))
    })
    await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve))
    const otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}`
    const originalUser = structuredClone(user)
    const requestStart = requests.length
    const backupPath = join(fixture, 'queued-account-backup.json')
    writeFileSync(backupPath, JSON.stringify({ version: 1, scope: 'remote', serviceUrl: remoteUrl, userId: user.id, recoveryKey: recovery }))
    await app!.evaluate(({ dialog }, path) => {
      Reflect.set(globalThis, '__accountQueuePickerOpened', false)
      Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => {
        Reflect.set(globalThis, '__accountQueuePickerOpened', true)
        return { canceled: false, filePaths: [path] }
      } })
    }, backupPath)
    holdProfile = true
    // The no-op profile write occupies the real main-process mutation queue;
    // all three credential operations must bind to A before that queue resumes.
    const heldProfile = page.evaluate(input => window.aether.account.updateProfile(input).then(
      () => ({ ok: true, error: '' }),
      cause => ({ ok: false, error: String(cause) })
    ), { name: user.name, email: user.email, bio: user.bio })
    try {
      await expect.poll(() => releaseProfile !== null).toBe(true)
      await page.evaluate(async ({ key, externalCredential }) => {
        const settle = (task: Promise<unknown>) => task.then(
          () => ({ ok: true, error: '' }),
          cause => ({ ok: false, error: String(cause) })
        )
        Reflect.set(window, '__queuedAccountCredentials', [
          settle(window.aether.account.login(key)),
          settle(window.aether.account.externalLogin('fixture', 'login', externalCredential)),
          settle(window.aether.account.importRecovery())
        ])
        // A subsequent IPC round-trip lets main dispatch the queued operations
        // and the immediately resolved native picker before switching services.
        await window.aether.settings.get()
      }, { key: recovery, externalCredential: providerCredential })
      await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, '__accountQueuePickerOpened'))).toBe(true)
      expect((await page.evaluate(() => window.aether.account.getState())).serviceUrl).toBe(remoteUrl)
      const stateB = await page.evaluate(async url => {
        await window.aether.engine.stop()
        await window.aether.settings.update({ remoteBaseUrl: url })
        return window.aether.account.getState()
      }, otherUrl)
      expect(stateB.serviceUrl).toBe(otherUrl)
      expect(stateB.status).toBe('signed-out')
      releaseProfile!()
      releaseProfile = null
      const results = await page.evaluate(async () => {
        const pending = Reflect.get(window, '__queuedAccountCredentials') as Array<Promise<{ ok: boolean; error: string }>>
        return Promise.all(pending)
      })
      expect(results).toHaveLength(3)
      for (const result of results) {
        expect(result.ok, result.error).toBe(false)
        expect(result.error).toMatch(/连接已切换|账号已切换|已取消/)
      }
      expect((await heldProfile).ok).toBe(false)
      expect(otherRequests.filter(value => value.method === 'POST' && value.path.startsWith('/auth/account/'))).toEqual([])
      expect(requests.slice(requestStart).filter(value => value.method === 'POST' && ['/auth/account/login', '/auth/account/external/credential'].includes(value.path))).toEqual([])
      expect(user).toEqual(originalUser)
      expect((await page.evaluate(() => window.aether.account.getState())).user).toBeNull()
    } finally {
      releaseProfile?.()
      releaseProfile = null
      holdProfile = false
      await heldProfile.catch(() => undefined)
      await page.evaluate(async () => {
        const pending = Reflect.get(window, '__queuedAccountCredentials') as Array<Promise<unknown>> | undefined
        if (pending) await Promise.allSettled(pending)
        Reflect.deleteProperty(window, '__queuedAccountCredentials')
      })
      await app!.evaluate(() => { Reflect.deleteProperty(globalThis, '__accountQueuePickerOpened') })
      await page.evaluate(async url => {
        await window.aether.engine.stop()
        await window.aether.settings.update({ remoteBaseUrl: url })
        await window.aether.engine.start()
      }, remoteUrl)
      other.closeAllConnections()
      await new Promise<void>(resolve => other.close(() => resolve()))
    }
    const restored = await page.evaluate(() => window.aether.account.getState())
    expect(restored.status).toBe('authenticated')
    expect(restored.user).toEqual(originalUser)
    await assertPublicState()
  })

  test('恢复时钟时仍等待已提交的凭证轮换，登录设备请求只携带新令牌', async () => {
    activeAccess = access
    activeRefresh = refresh
    credentialLifetimeMs = 3600000
    const loggedIn = await page.evaluate(key => window.aether.account.login(key), recovery)
    expect(loggedIn.status).toBe('authenticated')
    holdRefresh = true
    await app!.evaluate(() => {
      const original = Date.now
      Reflect.set(globalThis, '__accountClockRestoreNow', original)
      Date.now = () => original() + 61 * 60000
      const originalFetch = globalThis.fetch
      Reflect.set(globalThis, '__accountClockOriginalFetch', originalFetch)
      Reflect.set(globalThis, '__accountClockSessionFetches', 0)
      // Observe dispatch only: every response still comes from the real HTTP fixture.
      globalThis.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (new URL(url).pathname === '/auth/account/sessions') {
          const count = Reflect.get(globalThis, '__accountClockSessionFetches') as number
          Reflect.set(globalThis, '__accountClockSessionFetches', count + 1)
        }
        return originalFetch(input, init)
      }
    })
    const refreshingState = page.evaluate(() => window.aether.account.getState())
    try {
      await expect.poll(() => releaseRefresh !== null).toBe(true)
      expect(activeAccess).toBe(rotatedAccess)
      const beforeSessions = requests.filter(value => value.path === '/auth/account/sessions').length
      await app!.evaluate(() => {
        const original = Reflect.get(globalThis, '__accountClockRestoreNow') as typeof Date.now
        Date.now = original
      })
      await page.evaluate(async () => {
        Reflect.set(window, '__accountClockSessionsSettled', false)
        const pending = window.aether.account.sessions().then(
          value => { Reflect.set(window, '__accountClockSessionsSettled', true); return { value, error: '' } },
          cause => { Reflect.set(window, '__accountClockSessionsSettled', true); return { value: [], error: String(cause) } }
        )
        Reflect.set(window, '__accountClockSessions', pending)
        // This ordered IPC round-trip lets main enter sessions() and its refresh
        // gate. No fixed delay or timing-sensitive network-idle assumption is needed.
        await window.aether.settings.get()
      })
      const dispatched = await app!.evaluate(() => Reflect.get(globalThis, '__accountClockSessionFetches') as number)
      expect(dispatched, 'An in-flight rotation must gate sessions even after the clock is restored').toBe(0)
      expect(await page.evaluate(() => Reflect.get(window, '__accountClockSessionsSettled'))).toBe(false)
      expect(requests.filter(value => value.path === '/auth/account/sessions')).toHaveLength(beforeSessions)
      releaseRefresh!()
      releaseRefresh = null
      expect((await refreshingState).status).toBe('authenticated')
      const result = await page.evaluate(async () => {
        return await Reflect.get(window, '__accountClockSessions') as { value: AccountSession[]; error: string }
      })
      expect(result.error).toBe('')
      expect(result.value).toEqual(sessions)
      const sent = requests.filter(value => value.path === '/auth/account/sessions').slice(beforeSessions)
      expect(sent).toHaveLength(1)
      expect(sent[0].authenticated).toBe(true)
      expect(await app!.evaluate(() => Reflect.get(globalThis, '__accountClockSessionFetches'))).toBe(1)
    } finally {
      releaseRefresh?.()
      releaseRefresh = null
      holdRefresh = false
      await app!.evaluate(() => {
        const originalNow = Reflect.get(globalThis, '__accountClockRestoreNow') as typeof Date.now | undefined
        const originalFetch = Reflect.get(globalThis, '__accountClockOriginalFetch') as typeof fetch | undefined
        if (originalNow) Date.now = originalNow
        if (originalFetch) globalThis.fetch = originalFetch
        for (const key of ['__accountClockRestoreNow', '__accountClockOriginalFetch', '__accountClockSessionFetches']) Reflect.deleteProperty(globalThis, key)
      })
      await refreshingState.catch(() => undefined)
      await page.evaluate(async () => {
        const pending = Reflect.get(window, '__accountClockSessions') as Promise<unknown> | undefined
        if (pending) await pending
        Reflect.deleteProperty(window, '__accountClockSessions')
        Reflect.deleteProperty(window, '__accountClockSessionsSettled')
      })
    }
    await assertPublicState()
  })
})
