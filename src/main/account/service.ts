import { dialog, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import type { AccountProfileInput, AccountProvider, AccountSession, AccountState, AccountUser } from '../../shared/account'
import { readAccountCredential, saveAccountCredential, validAccountUser, validCredential, type AccountCredential } from './credential-store'
import { getAccountTransport, saveHttpTrust } from './transport-trust'
import { remoteAuthTarget } from '../engine/remote-auth-contract'

export interface AccountTarget { scope: string; url: string; headers: Record<string, string> }
interface Dependencies { target(): AccountTarget; identityChanged(): Promise<void>; changed(state: AccountState): void }
class AccountHttpError extends Error { constructor(readonly status: number, message: string) { super(message) } }
const initial = (url = ''): AccountState => ({ status: 'signed-out', user: null, providers: [], serviceUrl: url, persistence: 'none', message: null, registrationEnabled: false })
let dependencies: Dependencies | null = null
let state = initial()
let stateScope = ''
let mutation: Promise<unknown> = Promise.resolve()
let generation = 0
let externalAbort: AbortController | null = null
const refreshing = new Map<string, Promise<void>>()
const profileRevisions = new Map<string, number>()
function changedProfile(scope: string): void { profileRevisions.set(scope, (profileRevisions.get(scope) ?? 0) + 1) }
let stateFlight: Promise<AccountState> | null = null
let stateFlightScope = ''

function dep(): Dependencies { if (!dependencies) throw new Error('账号服务尚未就绪'); return dependencies }
function target(): AccountTarget {
  const t = dep().target()
  if (!t.url) throw new Error('请先启动本地引擎，或在引擎设置中保存远端服务地址。')
  return t
}
function assertTarget(t: AccountTarget): void {
  const current = target()
  if (current.scope !== t.scope || current.url !== t.url) throw new Error('连接已切换，本次账号操作已取消。')
}
function assertUser(t: AccountTarget, user: unknown): asserts user is AccountUser {
  const current = readAccountCredential(t.scope).credential?.user
  if (!validAccountUser(user) || !current || current.id !== user.id || current.tenantId !== user.tenantId) throw new Error('账号服务返回了不匹配的个人资料，已保留原登录信息。')
}
export function assertAccountTransport(value: string): void {
  if (getAccountTransport(value) !== 'http-untrusted') return
  throw new Error('此服务使用 HTTP。请先确认它属于可信内网，或改用 HTTPS 地址。')
}
function publish(t: AccountTarget, next: Partial<AccountState>): AccountState {
  if (dep().target().scope !== t.scope) return state
  if (stateScope !== t.scope) { state = initial(t.url); stateScope = t.scope }
  state = { ...state, ...next, serviceUrl: t.url, transport: getAccountTransport(t.url) }
  dep().changed(state)
  return state
}
async function request<T>(t: AccountTarget, path: string, method = 'GET', body?: unknown, authenticated = false, signal?: AbortSignal): Promise<T> {
  assertAccountTransport(t.url)
  const headers: Record<string, string> = { ...t.headers, Accept: 'application/json' }
  if (authenticated) {
    await ensureAccountSession(t)
    const credential = readAccountCredential(t.scope).credential
    if (!credential) throw new AccountHttpError(401, '请先登录账号。')
    headers.Authorization = `Bearer ${credential.accessToken}`
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(`${t.url}/auth/account${path}`, {
    method, headers, redirect: 'error', body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])])
  })
  if (Number(response.headers.get('content-length') ?? 0) > 1024 * 1024) throw new Error('账号服务响应过大。')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('账号服务返回空响应。')
  const parts: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 1024 * 1024) throw new Error('账号服务响应过大。')
      parts.push(chunk.value)
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  const raw = Buffer.concat(parts).toString('utf8')
  let envelope: { code?: number; message?: string; data?: T }
  try { envelope = JSON.parse(raw) } catch { throw new AccountHttpError(response.status, '服务端未提供账号接口，请部署支持登录的引擎版本。') }
  if (!response.ok || (envelope.code !== 0 && envelope.code !== 200)) {
    throw new AccountHttpError(response.status, envelope.message || `账号服务返回 HTTP ${response.status}`)
  }
  if (envelope.data === undefined || envelope.data === null) throw new Error('账号服务响应缺少数据。')
  return envelope.data
}
function exclusive<T>(action: (t: AccountTarget) => Promise<T>): Promise<T> {
  let t: AccountTarget
  try { t = target() } catch (error) { return Promise.reject(error) }
  const identityVersion = generation
  // A queued action belongs to the service selected when the user invoked it.
  // Selecting the target at dequeue time could send A's recovery key to B.
  const run = (): Promise<T> => {
    assertTarget(t)
    if (identityVersion !== generation) throw new Error('账号已切换，本次账号操作已取消。')
    return action(t)
  }
  const next = mutation.then(run, run)
  mutation = next.catch(() => undefined)
  return next
}
async function accept(t: AccountTarget, result: AccountCredential): Promise<AccountState> {
  assertTarget(t)
  if (!validCredential(result)) throw new Error('登录服务返回的会话无效。')
  generation++
  const previous = readAccountCredential(t.scope).credential
  const recoveryKey = result.recoveryKey || (previous?.user.id === result.user.id ? previous.recoveryKey : undefined)
  const entry = saveAccountCredential(t.scope, { ...result, recoveryKey })
  await dep().identityChanged()
  return publish(t, { status: 'authenticated', user: result.user, persistence: entry.persistence, message: entry.persistence === 'session' ? '系统安全存储不可用，当前登录仅在本次运行有效。请备份登录凭证。' : null })
}
export function configureAccountService(value: Dependencies): void {
  dependencies = value
  let lastValidation = 0
  const timer = setInterval(() => {
    let t: AccountTarget
    try { t = target() } catch { return }
    void ensureAccountSession(t).catch(() => undefined)
    if (Date.now() - lastValidation >= 60000) {
      lastValidation = Date.now()
      try {
        if (readAccountCredential(t.scope).credential && state.status !== 'expired') void accountService.getState().catch(() => undefined)
      } catch { /* A locked OS key store remains recoverable through the account UI. */ }
    }
  }, 30000)
  timer.unref()
}
/** Used by all HTTP/SSE/PTY paths before attaching an account access token. */
export async function ensureAccountSession(t: AccountTarget): Promise<void> {
  // A clock correction can make the cached token look fresh while the server
  // has already rotated it. Always join that rotation before trusting expiry.
  const running = refreshing.get(t.scope)
  if (running) return running
  const entry = readAccountCredential(t.scope)
  const credential = entry.credential
  if (credential) assertAccountTransport(t.url)
  if (credential?.accessToken === 'expired_account_session') throw new AccountHttpError(401, '登录已过期，请重新登录。')
  if (!credential || Date.parse(credential.expiresAt) > Date.now() + 60000) return
  assertAccountTransport(t.url)
  const flight = (async () => {
    try {
      const refreshRequestId = credential.refreshRequestId || randomUUID()
      // Persist before sending: after a lost response/restart the same request can be recovered.
      const pendingCredential = { ...credential, refreshRequestId }
      saveAccountCredential(t.scope, pendingCredential)
      const refreshed = await request<AccountCredential>(t, '/refresh', 'POST', { refreshToken: credential.refreshToken, requestId: refreshRequestId })
      const current = readAccountCredential(t.scope).credential
      if (!current || current.user.id !== credential.user.id || current.user.tenantId !== credential.user.tenantId || current.refreshToken !== credential.refreshToken) return
      if (!validCredential(refreshed) || refreshed.user.id !== credential.user.id || refreshed.user.tenantId !== credential.user.tenantId) throw new Error('服务端刷新了不匹配的账号。')
      const user = { ...current.user, sessionId: refreshed.user.sessionId }
      const saved = saveAccountCredential(t.scope, { ...refreshed, user, recoveryKey: current.recoveryKey })
      publish(t, { status: 'authenticated', user, persistence: saved.persistence, message: saved.persistence === 'session' ? '当前登录仅在本次运行有效，请备份登录凭证。' : null })
    } catch (error) {
      const current = readAccountCredential(t.scope).credential
      if (!current || current.user.id !== credential.user.id || current.user.tenantId !== credential.user.tenantId || current.refreshToken !== credential.refreshToken) return
      const rejected = error instanceof AccountHttpError && error.status === 401
      // A network interruption must not destroy the only recoverable credential.
      if (rejected) {
        saveAccountCredential(t.scope, { ...current, accessToken: 'expired_account_session', expiresAt: new Date(0).toISOString() })
      }
      publish(t, { status: rejected ? 'expired' : 'offline', user: current.user, message: rejected ? '登录已过期或被撤销，请使用备份凭证或已绑定的第三方账号重新登录。' : '暂时无法校验登录，凭证已保留，连接恢复后会重试。' })
      throw error
    }
  })().finally(() => refreshing.delete(t.scope))
  refreshing.set(t.scope, flight)
  return flight
}
async function readState(): Promise<AccountState> {
  const version = generation
  let t: AccountTarget
  try { t = target() } catch (error) { state = { ...initial(), status: 'unavailable', message: (error as Error).message }; return state }
  if (stateScope !== t.scope) { state = initial(t.url); stateScope = t.scope }
  let providerState: Pick<AccountState, 'providers' | 'registrationEnabled'> | undefined
  try {
    const providers = await request<AccountProvider[] | { providers: AccountProvider[]; registrationEnabled: boolean }>(t, '/providers')
    assertTarget(t)
    if (version !== generation) return state
    const list = Array.isArray(providers) ? providers : providers.providers
    if (!Array.isArray(list) || !list.every(p => p && typeof p.id === 'string' && typeof p.name === 'string' && ['oidc', 'oauth2', 'credential'].includes(p.type))) throw new Error('第三方登录列表格式无效。')
    // Provider discovery does not validate the session. Broadcasting the previous
    // signed-out snapshot here can race registration and dismiss its onboarding.
    providerState = { providers: list, registrationEnabled: Array.isArray(providers) ? true : providers.registrationEnabled }
    const entry = readAccountCredential(t.scope)
    if (!entry.credential) return publish(t, { ...providerState, status: 'signed-out', user: null, persistence: 'none', message: null })
    const profileRevision = profileRevisions.get(t.scope) ?? 0
    const user = await request<AccountUser>(t, '/me', 'GET', undefined, true)
    assertTarget(t)
    if (version !== generation) return state
    if (profileRevision !== (profileRevisions.get(t.scope) ?? 0)) return state
    assertUser(t, user)
    const latest = readAccountCredential(t.scope).credential
    if (!latest) return state
    const saved = saveAccountCredential(t.scope, { ...latest, user })
    return publish(t, { ...providerState, status: 'authenticated', user, persistence: saved.persistence, message: saved.persistence === 'session' ? '当前登录仅在本次运行有效，请备份登录凭证。' : null })
  } catch (error) {
    if (version !== generation) return state
    let user: AccountUser | null = null
    try { user = readAccountCredential(t.scope).credential?.user ?? null } catch { /* Preserve unreadable encrypted data. */ }
    const unauthorized = error instanceof AccountHttpError && error.status === 401
    return publish(t, { ...providerState, status: user ? (unauthorized ? 'expired' : 'offline') : 'unavailable', user, message: error instanceof Error ? error.message : '账号服务不可用。' })
  }
}
export const accountService = {
  async setHttpTrust(serviceUrl: string, trusted: boolean): Promise<AccountState> {
    if (typeof serviceUrl !== 'string' || typeof trusted !== 'boolean') throw new Error('服务信任设置无效。')
    const t = target()
    if (remoteAuthTarget(serviceUrl) !== remoteAuthTarget(t.url)) throw new Error('连接已切换，请在当前服务重新确认。')
    if (trusted && getAccountTransport(t.url) === 'http-untrusted') {
      const confirmed = await dialog.showMessageBox({
        type: 'warning', title: '信任内网 HTTP 服务',
        message: '仅在你信任此网络和服务器时继续',
        detail: `${t.url}\n\nHTTP 会明文传输登录凭证及工作数据。此次确认只对这个服务地址生效。`,
        buttons: ['取消', '信任此服务'], defaultId: 0, cancelId: 0, noLink: true
      })
      if (confirmed.response !== 1) return accountService.getState()
    }
    assertTarget(t)
    saveHttpTrust(t.url, trusted)
    generation++
    stateFlight = null
    if (!trusted) { externalAbort?.abort(); await dep().identityChanged() }
    return accountService.getState()
  },
  getState(): Promise<AccountState> {
    let scope = ''
    try { scope = target().scope } catch { /* readState supplies the actionable error */ }
    if (stateFlight && stateFlightScope === scope) return stateFlight
    stateFlightScope = scope
    const next = readState().finally(() => { if (stateFlight === next) stateFlight = null })
    stateFlight = next
    return next
  },
  register(): Promise<AccountState> { return exclusive(async t => {
    if (readAccountCredential(t.scope).credential && state.status !== 'expired') throw new Error('请先退出当前账号，避免重复创建账号。')
    return accept(t, await request<AccountCredential>(t, '/register', 'POST', {}))
  }) },
  login(recoveryKey: string): Promise<AccountState> { return exclusive(async t => {
    if (typeof recoveryKey !== 'string' || !recoveryKey.trim() || recoveryKey.length > 16384) throw new Error('请输入有效登录凭证。')
    const result = await request<AccountCredential>(t, '/login', 'POST', { recoveryKey: recoveryKey.trim() })
    return accept(t, { ...result, recoveryKey: recoveryKey.trim() })
  }) },
  updateProfile(input: AccountProfileInput): Promise<AccountState> { return exclusive(async t => {
    const user = await request<AccountUser>(t, '/profile', 'PATCH', input, true)
    assertTarget(t)
    assertUser(t, user)
    const credential = readAccountCredential(t.scope).credential
    if (!credential) throw new Error('当前登录已结束。')
    saveAccountCredential(t.scope, { ...credential, user })
    changedProfile(t.scope)
    return publish(t, { user })
  }) },
  logout(all = false): Promise<AccountState> {
    externalAbort?.abort()
    return exclusive(async t => {
    let message: string | null = null
    try { await request(t, '/logout', 'POST', { all: all === true }, true) } catch (error) {
      if (all && !(error instanceof AccountHttpError && error.status === 401)) throw error
      if (!(error instanceof AccountHttpError && error.status === 401)) message = '本机已退出；连接中断，远端会话尚未确认撤销。可从其他设备的登录设备列表撤销。'
    }
    assertTarget(t)
    generation++
    externalAbort?.abort()
    saveAccountCredential(t.scope, null)
    await dep().identityChanged()
    return publish(t, { status: 'signed-out', user: null, persistence: 'none', message })
  }) },
  sessions(): Promise<AccountSession[]> { return request(target(), '/sessions', 'GET', undefined, true) },
  async revokeSession(id: string): Promise<void> {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('会话标识无效。')
    await request(target(), `/sessions/${encodeURIComponent(id)}`, 'DELETE', undefined, true)
  },
  exportRecovery(): Promise<boolean> { return exclusive(async t => {
    const credential = readAccountCredential(t.scope).credential
    if (!credential) throw new Error('请先登录再备份。')
    const picked = await dialog.showSaveDialog({ title: '备份登录凭证（请勿分享此文件）', defaultPath: 'aether-account.json', filters: [{ name: 'Aether 账号备份', extensions: ['json'] }] })
    if (picked.canceled || !picked.filePath) return false
    assertTarget(t)
    let recoveryKey = credential.recoveryKey
    if (!recoveryKey) {
      const result = await request<{ recoveryKey: string }>(t, '/recovery', 'POST', {}, true)
      recoveryKey = result.recoveryKey
      const latest = readAccountCredential(t.scope).credential
      if (!latest) throw new Error('当前登录已结束。')
      saveAccountCredential(t.scope, { ...latest, recoveryKey })
    }
    writeFileSync(picked.filePath, JSON.stringify({ version: 1, scope: t.scope === 'embedded' ? 'embedded' : 'remote', serviceUrl: t.url, userId: credential.user.id, recoveryKey }, null, 2), { mode: 0o600 })
    return true
  }) },
  async importRecovery(): Promise<AccountState | null> {
    const t = target()
    const picked = await dialog.showOpenDialog({ title: '导入账号备份', properties: ['openFile'], filters: [{ name: 'Aether 账号备份', extensions: ['json'] }] })
    if (picked.canceled || !picked.filePaths[0]) return null
    assertTarget(t)
    const path = picked.filePaths[0]
    if (statSync(path).size > 65536) throw new Error('备份文件过大。')
    const backup = JSON.parse(readFileSync(path, 'utf8'))
    const sameLocal = backup.scope === 'embedded' && t.scope === 'embedded'
    if (backup.version !== 1 || typeof backup.recoveryKey !== 'string' || (!sameLocal && backup.serviceUrl !== t.url)) throw new Error('备份与当前服务地址不匹配，请先连接备份对应的服务。')
    return accountService.login(backup.recoveryKey)
  },
  externalLogin(providerId: string, mode: 'login' | 'link', credential?: string): Promise<AccountState> { return exclusive(async t => {
    if (typeof providerId !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(providerId) || !['login', 'link'].includes(mode)) throw new Error('第三方登录参数无效。')
    const finish = async (result: AccountCredential | AccountUser): Promise<AccountState> => {
      assertTarget(t)
      if (mode === 'login') return accept(t, result as AccountCredential)
      const previous = readAccountCredential(t.scope).credential
      const user = result as AccountUser
      assertUser(t, user)
      if (!previous || user.id !== previous.user.id || user.tenantId !== previous.user.tenantId) throw new Error('绑定结果与当前账号不匹配。')
      saveAccountCredential(t.scope, { ...previous, user })
      changedProfile(t.scope)
      return publish(t, { user })
    }
    if (credential !== undefined) {
      if (typeof credential !== 'string' || !credential.trim() || credential.length > 16384) throw new Error('第三方凭证无效。')
      return finish(await request(t, '/external/credential', 'POST', { providerId, mode, credential }, mode === 'link'))
    }
    externalAbort = new AbortController()
    const signal = externalAbort.signal
    try {
      const started = await request<{ authorizationUrl: string; flowId: string; pollToken: string }>(t, '/external/start', 'POST', { providerId, mode }, mode === 'link', signal)
      const url = new URL(started.authorizationUrl)
      if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('第三方授权地址必须使用 HTTPS。')
      await shell.openExternal(url.toString())
      const deadline = Date.now() + 5 * 60_000
      while (Date.now() < deadline) {
        assertTarget(t)
        signal.throwIfAborted()
        const result = await request<{ status: 'pending' | 'complete'; result?: AccountCredential | AccountUser }>(t, '/external/poll', 'POST', { flowId: started.flowId, pollToken: started.pollToken }, false, signal)
        if (result.status === 'complete' && result.result) return finish(result.result)
        await new Promise<void>((resolve, reject) => {
          const aborted = (): void => { clearTimeout(timer); reject(new Error('已取消第三方登录。')) }
          const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve() }, 1500)
          signal.addEventListener('abort', aborted, { once: true })
        })
      }
      throw new Error('第三方登录已超时，请重新发起。')
    } finally { externalAbort = null }
  }) },
  async cancelExternalLogin(): Promise<void> { externalAbort?.abort() },
  unlink(providerId: string): Promise<AccountState> { return exclusive(async t => {
    if (typeof providerId !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(providerId)) throw new Error('第三方标识无效。')
    const user = await request<AccountUser>(t, `/identities/${encodeURIComponent(providerId)}`, 'DELETE', undefined, true)
    const previous = readAccountCredential(t.scope).credential
    assertTarget(t)
    assertUser(t, user)
    if (!previous) throw new Error('请先登录。')
    saveAccountCredential(t.scope, { ...previous, user })
    changedProfile(t.scope)
    return publish(t, { user })
  }) }
}
