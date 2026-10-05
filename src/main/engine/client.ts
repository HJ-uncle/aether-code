/** Main-process HTTP bridge: shared transport identity and strict response envelopes. */
import { engineHost } from './host'
import { engineTargetError, normalizeEnginePath, remoteRequestError } from './protocol'
import { prepareRemoteChatBody } from './remote-workspace'
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
  input: EngineRequestInput
): Promise<EngineRequestResult<T>> {
  const snapshot = engineHost.getSnapshot()
  const unsupported = engineTargetError(snapshot, input.expectedEngine) ?? remoteRequestError(snapshot.mode, input.method, input.path)
  if (unsupported) return { ok: false, code: 409, message: unsupported, data: null }
  const baseUrl = engineHost.baseUrl
  if (!baseUrl) return { ok: false, code: -1, message: '引擎未就绪', data: null }
  const path = normalizeEnginePath(input.path)
  const url = `${baseUrl}${path}${buildQuery(input.query)}`
  const signal = AbortSignal.any([engineHost.requestSignal, AbortSignal.timeout(120000)])
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...engineHost.requestHeaders()
  }
  const requestBody = snapshot.mode === 'remote' && input.method === 'POST' && path.split('?')[0] === '/api/v1/chat'
    ? await prepareRemoteChatBody(input.body, { baseUrl, headers, signal, configuredRoot: engineHost.remoteWorkspaceRoot, target: snapshot })
    : input.body
  signal.throwIfAborted()
  // An empty DELETE with application/json is rejected by Fastify before it reaches the route.
  if (requestBody !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(url, {
    redirect: 'error',
    method: input.method,
    headers,
    body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
    signal
  })
  let payload: unknown
  try {
    payload = await res.json()
  } catch {
    return {
      ok: false,
      code: res.ok ? -1 : res.status,
      message: `响应不是合法 JSON（HTTP ${res.status}）`,
      data: null
    }
  }
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
  const snapshot = engineHost.getSnapshot()
  const unsupported = engineTargetError(snapshot, input.expectedEngine) ?? remoteRequestError(snapshot.mode, 'POST', input.path)
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
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: engineHost.requestHeaders(), body: form, signal, redirect: 'error' })
  let payload: unknown
  try { payload = await res.json() } catch { return { ok: false, code: res.status, message: `响应不是合法 JSON（HTTP ${res.status}）`, data: null } }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, code: res.status, message: '引擎响应信封无效', data: null }
  const body = payload as { code?: unknown; message?: unknown; data?: T; pagination?: EngineRequestResult<T>['pagination']; metadata?: EngineRequestResult<T>['metadata'] }
  const code = typeof body.code === 'number' ? body.code : res.status
  return { ok: res.ok && (code === 200 || code === 0), code, message: typeof body.message === 'string' ? body.message : '', data: body.data ?? null, pagination: body.pagination, metadata: body.metadata }
}
