/** Isolated candidate handshake. No active host, connection preferences or mutation of account state. */
import type { RemoteAuthCredential } from '../../shared/ipc'
import { readAccountCredential } from '../account/credential-store'
import { ensureAccountSession } from '../account/service'
import { assertTrustedCredentialTransport, CredentialTransportError } from '../account/transport-trust'
import { getEnvironmentRemoteInstanceToken, getRemoteInstanceToken } from './remote-token'
import { getEnvironmentRemoteAuth, getRemoteAuth } from './remote-auth'
import { remoteAuthHeaders, remoteAuthTarget } from './remote-auth-contract'
import { assertEngineHealth, classifyEngineProbeAuthFailure, engineHeaders, parseEngineMeta, remoteInstanceToken,
  validateRemoteInstanceToken, type EngineMeta } from './protocol'

type AccountIssue = 'authentication-required' | 'http-trust-required'
export class ConnectionProbeError extends Error {
  constructor(readonly issue: AccountIssue | 'instance-token' | null, message: string, readonly retryable = false) { super(message) }
}
const accountRequired = '请前往「个人账号」登录，或更新此服务的高级认证。'
const instanceRequired = '引擎拒绝了实例令牌。请在高级设置中填写与服务端匹配的令牌，再试一次。'
interface DraftCredentials { instanceToken?: string; userCredential?: RemoteAuthCredential | null }
/** Main-process only. The negotiation token must never enter a renderer snapshot. */
export interface RemoteConnectionProof {
  url: string
  meta: EngineMeta
  instanceToken: string
  issue: AccountIssue | null
  message: string | null
  accountId: string | null
  advanced: RemoteAuthCredential | null
  /** Present when the stored token was rejected and the URL-bound environment override verified instead. */
  rejectedStoredToken?: string
  /** Only used to rotate the exact rejected session after committing this destination. */
  rejectedAccessToken?: string
}

function httpError(path: string, status: number): ConnectionProbeError {
  return new ConnectionProbeError(null, `引擎 ${path} 返回 HTTP ${status}`, status >= 500 || status === 429 || status === 408)
}
async function probeFetch(url: string, signal: AbortSignal, headers?: Record<string, string>): Promise<Response> {
  try { return await fetch(url, { signal, redirect: 'error', headers }) }
  catch (error) {
    signal.throwIfAborted()
    if (error instanceof Error && /redirect/i.test(String(error.cause))) throw new ConnectionProbeError(null, '引擎地址发生跳转，请直接填写服务的最终地址。')
    throw new ConnectionProbeError(null, '无法连接到引擎，请检查服务地址、网络，以及服务是否已启动。', true)
  }
}
async function probeJson(response: Response, signal: AbortSignal): Promise<unknown> {
  try { return await response.json() }
  catch (error) { signal.throwIfAborted(); if (error instanceof SyntaxError) throw new ConnectionProbeError(null, '服务未返回有效的引擎协议数据，请检查服务地址。'); throw error }
}
/** Public endpoints are always read with no credential or automatic redirect. */
export async function probeEngineMeta(url: string, signal: AbortSignal, buildId?: string): Promise<EngineMeta> {
  const health = await probeFetch(`${url}/health`, signal)
  if (!health.ok) { void health.body?.cancel().catch(() => {}); throw httpError('/health', health.status) }
  assertEngineHealth(await probeJson(health, signal))
  const result = await probeFetch(`${url}/meta`, signal)
  if (!result.ok) { void result.body?.cancel().catch(() => {}); throw httpError('/meta', result.status) }
  return parseEngineMeta(await probeJson(result, signal), buildId)
}
export async function probeEngineTools(url: string, signal: AbortSignal, headers: Record<string, string>, advanced: boolean): Promise<void> {
  assertTrustedCredentialTransport(url, !!(headers['X-Aether-Instance-Token'] || headers['X-API-Key'] || headers.Authorization))
  const result = await probeFetch(`${url}/api/v1/tools`, signal, headers)
  if (result.status === 401 || result.status === 403) {
    const body = await result.json().catch(() => null) as { message?: unknown } | null
    signal.throwIfAborted()
    if (classifyEngineProbeAuthFailure(body?.message) === 'user-credential') {
      if (advanced) throw new ConnectionProbeError(null, '引擎拒绝了高级用户凭据，请检查 API Key 或 JWT 后再连接。')
      throw new ConnectionProbeError('authentication-required', accountRequired)
    }
    throw new ConnectionProbeError('instance-token', instanceRequired)
  }
  if (!result.ok) { void result.body?.cancel().catch(() => {}); throw httpError('/api/v1/tools', result.status) }
  const body = await probeJson(result, signal) as { code?: unknown } | null
  if (body?.code !== 200 && body?.code !== 0) throw new ConnectionProbeError(null, '引擎工具探测未成功，请确认填写的是配套引擎地址。')
}

async function withProbeDeadline<T>(signal: AbortSignal, action: (active: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = AbortSignal.timeout(5000), active = AbortSignal.any([signal, deadline])
  try { active.throwIfAborted(); return await action(active) }
  catch (error) {
    signal.throwIfAborted()
    if (deadline.aborted) throw new ConnectionProbeError(null, '连接引擎超时，请检查网络和服务状态。', true)
    throw error
  }
}

export async function probeRemoteConnection(value: string, draft: DraftCredentials, signal: AbortSignal): Promise<RemoteConnectionProof> {
  const url = remoteAuthTarget(value)
  return withProbeDeadline(signal, async requestSignal => {
    const meta = await probeEngineMeta(url, requestSignal)
    const stored = draft.instanceToken === undefined ? getRemoteInstanceToken(url) : validateRemoteInstanceToken(draft.instanceToken)
    const env = getEnvironmentRemoteInstanceToken(url)
    let token: string
    try { token = remoteInstanceToken(url, stored || env) }
    catch (error) { throw new ConnectionProbeError('instance-token', error instanceof Error ? error.message : instanceRequired) }
    const account = readAccountCredential(url)
    if (account.credential && draft.userCredential) throw new ConnectionProbeError(null, '目前正在使用个人账号。请先退出该账号，再使用高级用户凭据。')
    const advanced = account.credential ? null : draft.userCredential ??
      (account.managed ? null : (draft.userCredential === null ? getEnvironmentRemoteAuth(url) : getRemoteAuth(url)).credential)
    const proof: RemoteConnectionProof = { url, meta, instanceToken: token, issue: null, message: null, accountId: account.credential?.user.id ?? null, advanced }
    const tools = async (): Promise<void> => {
      assertTrustedCredentialTransport(url, !!(token || account.credential || advanced))
      const credential = account.credential
      const headers = { ...engineHeaders(token), ...(credential ? { Authorization: `Bearer ${credential.accessToken}` } : remoteAuthHeaders(advanced)) }
      await probeEngineTools(url, requestSignal, headers, !!draft.userCredential)
    }
    try {
      try { await tools() }
      catch (error) {
        if (!(error instanceof ConnectionProbeError && error.issue === 'instance-token') || draft.instanceToken !== undefined || !stored || !env || stored === env) throw error
        token = remoteInstanceToken(url, env); proof.instanceToken = token; proof.rejectedStoredToken = stored
        await tools()
      }
    } catch (error) {
      if (error instanceof CredentialTransportError || error instanceof ConnectionProbeError && error.issue === 'authentication-required') {
        proof.issue = error instanceof CredentialTransportError ? 'http-trust-required' : 'authentication-required'
        proof.message = error.message
        if (proof.issue === 'authentication-required') proof.rejectedAccessToken = account.credential?.accessToken
      } else { throw error }
    }
    // The coordinator may persist drafts only after this check; never commit late work after cancellation.
    requestSignal.throwIfAborted()
    return proof
  })
}

/** Only a selected target can rotate an account. Reuse its public handshake and the
 * proven instance token; a wrong instance token must never invalidate a personal login. */
export async function recoverCommittedAccount(proof: RemoteConnectionProof, signal: AbortSignal): Promise<RemoteConnectionProof> {
  if (proof.issue !== 'authentication-required' || !proof.rejectedAccessToken) return proof
  return withProbeDeadline(signal, async active => {
    const { url, instanceToken, accountId } = proof
    assertTrustedCredentialTransport(url)
    const accountChanged = (): ConnectionProbeError => new ConnectionProbeError(null, '账号已变化，请重新连接。')
    if (readAccountCredential(url).credential?.user.id !== accountId) throw accountChanged()
    const headers = engineHeaders(instanceToken)
    try {
      await ensureAccountSession({ scope: url, url, headers }, active, proof.rejectedAccessToken)
      active.throwIfAborted()
      const account = readAccountCredential(url).credential
      if (!account || account.user.id !== accountId) throw accountChanged()
      await probeEngineTools(url, active, { ...headers, Authorization: 'Bearer ' + account.accessToken }, false)
      return { ...proof, rejectedAccessToken: undefined, issue: null, message: null }
    } catch (error) {
      active.throwIfAborted()
      if (error instanceof ConnectionProbeError) { if (error.issue === 'authentication-required') return proof; throw error }
      const status = error instanceof Error && 'status' in error ? error.status : undefined
      if (status === 401 && error instanceof Error && classifyEngineProbeAuthFailure(error.message) === 'instance-token') throw new ConnectionProbeError('instance-token', instanceRequired)
      if (status === 401) return proof
      if (typeof status === 'number') throw httpError('账号续期', status)
      if (error instanceof TypeError || error instanceof Error && error.name === 'TimeoutError') throw new ConnectionProbeError(null, '无法连接账号服务，暂时无法续期登录。', true)
      throw error
    }
  })
}

/** Recheck local permissions and durable credential identity after saving/while releasing the old host. */
export function remoteProofCurrent(proof: RemoteConnectionProof): boolean {
  const { url, accountId, advanced, instanceToken, issue } = proof
  const account = readAccountCredential(url)
  if ((account.credential?.user.id ?? null) !== accountId) return false
  if (!account.credential) {
    const effective = account.managed ? null : getRemoteAuth(url).credential
    if (effective?.type !== advanced?.type || effective?.value !== advanced?.value) return false
  }
  const stored = getRemoteInstanceToken(url), environment = getEnvironmentRemoteInstanceToken(url)
  if (instanceToken !== (stored || environment) && !(proof.rejectedStoredToken === stored && instanceToken === environment)) return false
  try { assertTrustedCredentialTransport(url, !!(instanceToken || accountId || advanced)); return issue !== 'http-trust-required' }
  catch (error) { if (error instanceof CredentialTransportError) return issue === 'http-trust-required'; throw error }
}
