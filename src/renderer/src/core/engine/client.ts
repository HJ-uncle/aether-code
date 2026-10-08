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
  EngineUploadInput,
  EngineRequestInput,
  EngineRequestResult,
  EngineSnapshot,
  RemoteAttachmentInput,
  RemoteAttachmentResult,
  RemoteAuthCredential,
  StreamEvent,
  StreamStartInput
} from '@shared/ipc'
import type { SubagentRun } from '@shared/subagent'
import { getExpectedEngine } from './source'

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
  return bridge().engine.request<T>({ ...input, expectedEngine: input.expectedEngine ?? getExpectedEngine() })
}

export function upload<T = unknown>(input: Omit<EngineUploadInput, 'expectedEngine'>): Promise<EngineRequestResult<T>> {
  return bridge().engine.upload<T>({ ...input, expectedEngine: getExpectedEngine() })
}

/** 上传附件到远程引擎当前会话工作区。 */
export function uploadAttachment(input: Omit<RemoteAttachmentInput, 'expectedEngine'>): Promise<RemoteAttachmentResult> {
  return bridge().engine.uploadAttachment({ ...input, expectedEngine: getExpectedEngine() })
}

/** 发起请求并在业务失败时抛错，适合「失败即中断」的调用场景 */
export async function requestOrThrow<T = unknown>(input: EngineRequestInput): Promise<T> {
  const result = await request<T>(input)
  if (!result.ok) throw new Error(result.message || `请求失败（code ${result.code}）`)
  return result.data as T
}

/** 单独停止一个正在运行的子代理（不影响主会话与其余并行子代理） */
export function stopSubagent(input: { sessionId: string; toolCallId: string }): Promise<EngineRequestResult<{ sessionId: string; toolCallId: string; cancelled: boolean }>> {
  return request<{ sessionId: string; toolCallId: string; cancelled: boolean }>({
    method: 'POST',
    path: '/subagent/cancel',
    body: input
  })
}

export function listSubagentRuns(parentSessionId: string): Promise<SubagentRun[]> {
  return requestOrThrow<SubagentRun[]>({ method: 'GET', path: '/subagent/runs', query: { parentSessionId } })
}

export function getSubagentRun(runId: string): Promise<SubagentRun> {
  return requestOrThrow<SubagentRun>({ method: 'GET', path: `/subagent/runs/${encodeURIComponent(runId)}` })
}

/** Acknowledgement contains the real current state; accepting cancel does not mean it has finished. */
export function cancelSubagentRun(runId: string): Promise<SubagentRun> {
  return requestOrThrow<SubagentRun>({ method: 'POST', path: `/subagent/runs/${encodeURIComponent(runId)}/cancel`, body: {} })
}

// ==================== 流式 ====================

export function startStream(input: StreamStartInput): Promise<{ ok: boolean }> {
  return bridge().engine.stream.start({ ...input, expectedEngine: input.expectedEngine ?? getExpectedEngine() })
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

export function updateSettings(patch: Partial<AppSettings>, remoteToken?: string, remoteAuth?: RemoteAuthCredential | null): Promise<AppSettings> {
  return remoteToken === undefined && remoteAuth === undefined
    ? bridge().settings.update(patch)
    : bridge().settings.saveEngine(patch, remoteToken, remoteAuth)
}
