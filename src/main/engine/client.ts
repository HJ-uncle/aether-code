/** Main-process HTTP bridge: shared transport identity and strict response envelopes. */
import { engineHost } from './host'
import { normalizeEnginePath, remoteRequestError } from './protocol'
import type { EngineRequestInput, EngineRequestResult } from '../../shared/ipc'

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
  const unsupported = remoteRequestError(engineHost.getSnapshot().mode, input.method, input.path)
  if (unsupported) return { ok: false, code: 409, message: unsupported, data: null }
  const baseUrl = engineHost.baseUrl
  if (!baseUrl) return { ok: false, code: -1, message: '引擎未就绪', data: null }
  const url = `${baseUrl}${normalizeEnginePath(input.path)}${buildQuery(input.query)}`
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...engineHost.requestHeaders()
  }
  // An empty DELETE with application/json is rejected by Fastify before it reaches the route.
  if (input.body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(url, {
    method: input.method,
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    signal: AbortSignal.any([engineHost.requestSignal, AbortSignal.timeout(120000)])
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
