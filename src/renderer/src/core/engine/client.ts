/**
 * 渲染层引擎客户端
 *
 * 所有引擎访问都经 window.aether（preload 暴露），不直接 fetch localhost：
 *   - 引擎未启用 CORS，渲染进程直连会被拦截
 *   - 主进程统一处理路径归一化与 200-错误码契约
 *   - 远程模式下渲染层代码完全不用改
 */
import type {
  AppSettings,
  EngineRequestInput,
  EngineRequestResult,
  EngineSnapshot,
  StreamEvent,
  StreamStartInput
} from '@shared/ipc'

function bridge(): Window['aether'] {
  const api = window.aether
  if (!api) {
    throw new Error('IPC 桥未就绪：preload 未加载')
  }
  return api
}

// ==================== 引擎生命周期 ====================

export function getSnapshot(): Promise<EngineSnapshot> {
  return bridge().engine.getSnapshot()
}

export function startEngine(): Promise<EngineSnapshot> {
  return bridge().engine.start()
}

export function stopEngine(): Promise<EngineSnapshot> {
  return bridge().engine.stop()
}

export function restartEngine(): Promise<EngineSnapshot> {
  return bridge().engine.restart()
}

export function onSnapshot(listener: (snapshot: EngineSnapshot) => void): () => void {
  return bridge().engine.onSnapshot(listener)
}

export function onEngineLog(
  listener: (entry: { level: 'info' | 'warn' | 'error'; line: string; ts: number }) => void
): () => void {
  return bridge().engine.onLog(listener)
}

// ==================== 业务请求 ====================

/**
 * 发起引擎请求。
 *
 * 注意：这里**不抛异常**。引擎把业务错误放在 body.code 里，
 * 调用方需要显式判断 ok，避免把「模型未配置」这类可预期错误当成崩溃。
 */
export function request<T = unknown>(input: EngineRequestInput): Promise<EngineRequestResult<T>> {
  return bridge().engine.request<T>(input)
}

/** 发起请求并在业务失败时抛错，适合「失败即中断」的调用场景 */
export async function requestOrThrow<T = unknown>(input: EngineRequestInput): Promise<T> {
  const result = await request<T>(input)
  if (!result.ok) throw new Error(result.message || `请求失败（code ${result.code}）`)
  return result.data as T
}

// ==================== 流式 ====================

export function startStream(input: StreamStartInput): Promise<{ ok: boolean }> {
  return bridge().engine.stream.start(input)
}

export function abortStream(streamId: string): Promise<{ ok: boolean }> {
  return bridge().engine.stream.abort(streamId)
}

export function onStreamEvent(listener: (event: StreamEvent) => void): () => void {
  return bridge().engine.onStreamEvent(listener)
}

// ==================== 设置 ====================

export function getSettings(): Promise<AppSettings> {
  return bridge().settings.get()
}

export function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  return bridge().settings.update(patch)
}
