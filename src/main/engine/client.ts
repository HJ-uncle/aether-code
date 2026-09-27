/**
 * 主进程侧引擎 HTTP 客户端
 *
 * 统一处理两件容易出错的事：
 *   1. 路径归一化 —— 引擎的 health/models/metrics/auth 挂在根路径，
 *      业务路由在 /api/v1 下（见引擎侧 server.ts）
 *   2. 错误契约 —— 引擎对业务错误同样返回 HTTP 200，成败要看 body.code
 *
 * 因此本函数**永不**因业务错误抛异常，而是返回 ok/code/message 结构，
 * 由调用方（渲染层）按业务语义处理；只有网络层故障才 reject。
 */
import { engineHost } from './host'
import type { EngineRequestInput, EngineRequestResult } from '../../shared/ipc'

/** 成功码：引擎混用 200 与 0 */
function isSuccessCode(code: number): boolean {
  return code === 200 || code === 0
}

/**
 * 只有这几个端点在根路径，其余全部挂在 /api/v1 下。
 *
 * 实测确认（非推测）：/models 在 /api/v1/models 而非根路径。
 */
function isRootLevelPath(path: string): boolean {
  return /^\/(health|metrics|openapi\.json)(\/|$)/.test(path)
}

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
  const baseUrl = engineHost.baseUrl
  if (!baseUrl) {
    return { ok: false, code: -1, message: '引擎未就绪', data: null }
  }

  const trimmed = input.path.startsWith('/') ? input.path : `/${input.path}`
  const isRootPath = isRootLevelPath(trimmed)
  const url = `${baseUrl}${isRootPath ? '' : '/api/v1'}${trimmed}${buildQuery(input.query)}`

  const headers: Record<string, string> = { Accept: 'application/json' }
  // 有请求体时才带 Content-Type，否则 Fastify 会拒绝空 body 的 DELETE
  if (input.body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(url, {
    method: input.method,
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    signal: AbortSignal.timeout(120000)
  })

  let payload: unknown
  try {
    payload = await res.json()
  } catch {
    return {
      ok: false,
      code: -1,
      message: `响应不是合法 JSON（HTTP ${res.status}）`,
      data: null
    }
  }

  const body = payload as {
    code?: number
    message?: string
    data?: T
    pagination?: EngineRequestResult<T>['pagination']
  }

  // 非标准响应（例如引擎未捕获异常时的兜底）按失败处理
  if (typeof body?.code !== 'number') {
    return {
      ok: res.ok,
      code: res.ok ? 200 : res.status,
      message: res.ok ? 'ok' : `HTTP ${res.status}`,
      data: (body?.data ?? null) as T | null
    }
  }

  return {
    ok: isSuccessCode(body.code),
    code: body.code,
    message: body.message ?? '',
    data: (body.data ?? null) as T | null,
    pagination: body.pagination
  }
}
