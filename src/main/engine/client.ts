/** Main-process HTTP bridge: shared transport identity and strict response envelopes. */
import { engineHost } from './host'
import { engineIdentityOf, engineTargetError, isAccountRequestPath, normalizeEnginePath, remoteRequestError, remoteWorkspacePathError, subagentProtocolHeaders } from './protocol'
import { prepareRemoteChatBody } from './remote-workspace'
import { managementRequestSignal } from './request-timeout'
import { engineTransportFailure } from './request-error'
import type { EngineRequestInput, EngineRequestResult, EngineUploadInput } from '../../shared/ipc'

function buildQuery(query: EngineRequestInput['query']): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

export async function engineRequest<T = unknown>(
  input: EngineRequestInput,
  ownedSignal?: AbortSignal
): Promise<EngineRequestResult<T>> {
  let protocolHeaders: Record<string, string>
  try { protocolHeaders = subagentProtocolHeaders(input.subagentProtocol) }
  catch { return { ok: false, code: 400, message: '子 Agent 协议版本无效', data: null } }
  if (isAccountRequestPath(input.path)) return { ok: false, code: 403, message: '请通过账号入口操作认证。', data: null }
  const snapshot = engineHost.getSnapshot()
  // Bind even legacy callers that omitted expectedEngine to the instance that
  // was current when this request entered the main process.  This closes the
  // delayed-request gap while preserving the existing renderer API shape.
  const expectedEngine = input.expectedEngine ?? engineIdentityOf(snapshot)
  // Keep this check local to the transport as a defense in depth: callers
  // must never be able to send a client-local absolute path to a remote
  // workspace endpoint, even if a future route is added to the allowlist.
  if (snapshot.mode === 'remote' && input.method === 'POST' && /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(String((input.body as Record<string, unknown> | undefined)?.path ?? '')) && /\/workspace\/file(?:\/|$)/.test(input.path)) {
    return { ok: false, code: 409, message: '远端工作区请求必须使用相对路径，不能携带本机绝对路径', data: null }
  }
  const unsupported = engineTargetError(snapshot, expectedEngine) ?? remoteRequestError(snapshot.mode, input.method, input.path) ?? remoteWorkspacePathError(snapshot.mode, input.method, input.path, input.body)
  if (unsupported) return { ok: false, code: 409, message: unsupported, data: null }
  const baseUrl = engineHost.baseUrl
  if (!baseUrl) return { ok: false, code: -1, message: '引擎未就绪', data: null }
  const path = normalizeEnginePath(input.path)
  const url = `${baseUrl}${path}${buildQuery(input.query)}`
  const managementSignal = managementRequestSignal(input, engineHost.requestSignal)
  const signal = ownedSignal ? AbortSignal.any([managementSignal, ownedSignal]) : managementSignal
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...protocolHeaders,
    ...await engineHost.prepareRequestHeaders(baseUrl, input.toolProfile)
  }
  const requestBody = snapshot.mode === 'remote' && input.method === 'POST' && path.split('?')[0] === '/api/v1/chat'
    ? await prepareRemoteChatBody(input.body, { baseUrl, headers, signal, configuredRoot: engineHost.remoteWorkspaceRoot, target: snapshot })
    : input.body
  // An empty DELETE with application/json is rejected by Fastify before it reaches the route.
  if (requestBody !== undefined) headers['Content-Type'] = 'application/json'
  const transportFailure = (error: unknown): EngineRequestResult<never> =>
    engineTransportFailure(error, signal, input.method, engineTargetError(engineHost.getSnapshot(), expectedEngine))
  let res: Response
  try {
    signal.throwIfAborted()
    res = await fetch(url, {
      redirect: 'error',
      method: input.method,
      headers,
      body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
      signal
    })
  } catch (error) { return transportFailure(error) }
  let payload: unknown
  try {
    payload = await res.json()
  } catch (error) {
    // A severed response body is a transport failure, not invalid JSON. For a
    // mutation its outcome remains unknown even after HTTP headers arrived.
    if (signal.aborted || !(error instanceof SyntaxError)) return transportFailure(error)
    return {
      ok: false,
      code: res.ok ? -1 : res.status,
      message: `响应不是合法 JSON（HTTP ${res.status}）${input.method === 'GET' ? '' : '，操作结果尚未确认，请先检查当前状态。'}`,
      data: null
    }
  }
  const staleResponse = engineTargetError(engineHost.getSnapshot(), expectedEngine)
  if (staleResponse) return { ok: false, code: 409, message: staleResponse, data: null }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      ok: false,
      code: res.ok ? -1 : res.status,
      message: `引擎响应信封无效（HTTP ${res.status}）`,
      data: null
    }
  }
  const body = payload as {
    code?: unknown
    message?: unknown
    data?: T
    pagination?: EngineRequestResult<T>['pagination']
    metadata?: EngineRequestResult<T>['metadata']
  }
  if (typeof body.code !== 'number') {
    return {
      ok: false,
      code: res.ok ? -1 : res.status,
      message:
        typeof body.message === 'string'
          ? body.message
          : `引擎响应缺少状态码（HTTP ${res.status}）`,
      data: null
    }
  }
  return {
    ok: res.ok && (body.code === 200 || body.code === 0),
    code: res.ok ? body.code : res.status,
    message: typeof body.message === 'string' ? body.message : res.ok ? '' : `HTTP ${res.status}`,
    data: body.data ?? null,
    pagination: body.pagination,
    metadata: body.metadata
  }
}

/** Multipart bridge used by Skill/knowledge import UIs. */
export async function engineUpload<T = unknown>(input: EngineUploadInput): Promise<EngineRequestResult<T>> {
  if (isAccountRequestPath(input.path)) return { ok: false, code: 403, message: '请通过账号入口操作认证。', data: null }
  const snapshot = engineHost.getSnapshot()
  const expectedEngine = input.expectedEngine ?? engineIdentityOf(snapshot)
  const unsupported = engineTargetError(snapshot, expectedEngine) ?? remoteRequestError(snapshot.mode, 'POST', input.path)
  if (unsupported) return { ok: false, code: 409, message: unsupported, data: null }
  const baseUrl = engineHost.baseUrl
  if (!baseUrl) return { ok: false, code: -1, message: '引擎未就绪', data: null }
  if (!(input.data instanceof Uint8Array) || input.data.byteLength === 0) return { ok: false, code: 400, message: '上传文件为空', data: null }
  if (!input.fileName.trim() || input.fileName.includes('\\') || input.fileName.includes('/')) return { ok: false, code: 400, message: '文件名无效', data: null }
  const path = normalizeEnginePath(input.path)
  const form = new FormData()
  for (const [key, value] of Object.entries(input.fields ?? {})) form.set(key, value)
  form.set('file', new Blob([Uint8Array.from(input.data)], { type: input.type || 'application/octet-stream' }), input.fileName)
  const signal = AbortSignal.any([engineHost.requestSignal, AbortSignal.timeout(120000)])
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: await engineHost.prepareRequestHeaders(baseUrl), body: form, signal, redirect: 'error' })
  let payload: unknown
  try { payload = await res.json() } catch { return { ok: false, code: res.status, message: `响应不是合法 JSON（HTTP ${res.status}）`, data: null } }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, code: res.status, message: '引擎响应信封无效', data: null }
  const body = payload as { code?: unknown; message?: unknown; data?: T; pagination?: EngineRequestResult<T>['pagination']; metadata?: EngineRequestResult<T>['metadata'] }
  const code = typeof body.code === 'number' ? body.code : res.status
  return { ok: res.ok && (code === 200 || code === 0), code, message: typeof body.message === 'string' ? body.message : '', data: body.data ?? null, pagination: body.pagination, metadata: body.metadata }
}
