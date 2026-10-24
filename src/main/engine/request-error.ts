import type { EngineRequestResult } from '../../shared/ipc'

/** Transport errors carry no confirmed operation outcome and must not trigger
 * automatic mutation retries or expose internal fetch/IPC exception strings. */
export function engineTransportFailure(
  error: unknown, signal: AbortSignal, method: string, staleMessage: string | null
): EngineRequestResult<never> {
  if (staleMessage) return { ok: false, code: 409, message: staleMessage, data: null }
  const name = (value: unknown): string | undefined => value && typeof value === 'object' && 'name' in value && typeof value.name === 'string' ? value.name : undefined
  const timeout = name(error) === 'TimeoutError' || signal.aborted && name(signal.reason) === 'TimeoutError'
  const readOnly = method === 'GET' || method === 'HEAD'
  if (timeout) return { ok: false, code: 408, data: null, message: readOnly
    ? '读取引擎数据超时，后台任务可能仍在运行。请稍后重试。'
    : '引擎请求超时，操作结果尚未确认。请先检查当前状态，避免重复操作。' }
  if (signal.aborted || name(error) === 'AbortError') return { ok: false, code: 499, data: null, message: readOnly
    ? '已取消读取引擎数据。'
    : '请求已中断，操作结果尚未确认。请先检查当前状态。' }
  return { ok: false, code: 503, data: null, message: readOnly
    ? '暂时无法连接引擎，请检查连接后重试。'
    : '引擎连接中断，操作结果尚未确认。请先检查当前状态，避免重复操作。' }
}
