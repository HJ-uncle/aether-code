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
import type {
  SubagentRun, SubagentRunsPage, SubagentToolsPage, SubagentToolDetailPage, SubagentEventsPage,
  SubagentCapabilities, SubagentDiscoveryPage
} from '@shared/subagent'
import { getExpectedEngine, getEngineSource } from './source'
import { getAppMode } from '@renderer/core/platform/app-mode'
import { parseSubagentDiscoveryPage } from './subagent-discovery'
import { withSubagentReadPermit } from './subagent-refresh'

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
  return bridge().engine.request<T>({
    ...input,
    toolProfile: input.toolProfile ?? (getAppMode() === 'work' ? 'general' : 'code'),
    expectedEngine: input.expectedEngine ?? getExpectedEngine()
  })
}

export function upload<T = unknown>(input: Omit<EngineUploadInput, 'expectedEngine'>): Promise<EngineRequestResult<T>> {
  return bridge().engine.upload<T>({ ...input, expectedEngine: getExpectedEngine() })
}

/** 上传附件到远程引擎当前会话工作区。 */
export function uploadAttachment(input: Omit<RemoteAttachmentInput, 'expectedEngine'>): Promise<RemoteAttachmentResult> {
  return bridge().engine.uploadAttachment({ ...input, expectedEngine: getExpectedEngine() })
}

export function cancelAttachmentUpload(requestId: string): Promise<void> {
  return bridge().engine.cancelAttachmentUpload(requestId)
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

export interface SubagentConnection {
  source: number
  expectedEngine: EngineRequestInput['expectedEngine']
  toolProfile: EngineRequestInput['toolProfile']
}
type SubagentScope = { parentSessionId?: string; rootSessionId?: string; parentConversationId?: string }
type SubagentPageOptions = { cursor?: string; limit?: number }
let subagentCapabilities: { key: string; promise: Promise<SubagentCapabilities> } | undefined

export function captureSubagentConnection(): SubagentConnection {
  return { source: getEngineSource(), expectedEngine: getExpectedEngine(), toolProfile: getAppMode() === 'work' ? 'general' : 'code' }
}
export function assertSubagentConnection(connection: SubagentConnection): void {
  if (connection.source !== getEngineSource() || JSON.stringify(connection.expectedEngine) !== JSON.stringify(getExpectedEngine()))
    throw new Error('引擎连接已变化，请在当前会话重试')
}

/** Recovery distinguishes an expired login from a transient connection failure. */
export class SubagentCapabilityError extends Error {
  readonly status: number
  constructor(message: string, readonly code: number) {
    super(message)
    this.name = 'SubagentCapabilityError'
    this.status = code >= 10_000 ? Math.floor(code / 100) : code
  }
}

function subagentSourceKey(connection = captureSubagentConnection()): string {
  return JSON.stringify([connection.source, connection.expectedEngine])
}

/** A capability miss on an older engine is different from an authentication or transport failure. */
export function getSubagentCapabilities(connection = captureSubagentConnection()): Promise<SubagentCapabilities> {
  assertSubagentConnection(connection)
  const key = subagentSourceKey(connection)
  if (subagentCapabilities?.key === key) return subagentCapabilities.promise
  const operation: { key: string; promise: Promise<SubagentCapabilities> } = { key, promise: Promise.resolve({ protocol: 1, discovery: false }) }
  const promise = (async (): Promise<SubagentCapabilities> => {
    const response = await withSubagentReadPermit(() => {
      assertSubagentConnection(connection)
      return request<unknown>({ method: 'GET', path: '/subagent/capabilities',
        expectedEngine: connection.expectedEngine, toolProfile: connection.toolProfile })
    })
    assertSubagentConnection(connection)
    if (!response.ok) {
      if ([404, 40400, 501, 50100].includes(response.code)) return { protocol: 1, discovery: false }
      throw new SubagentCapabilityError(response.message || `子代理协议协商失败（code ${response.code}）`, response.code)
    }
    const value = response.data
    if (!record(value) || value.schemaVersion !== 2 || !Array.isArray(value.eventVersions)
      || !value.eventVersions.includes(2) || !Array.isArray(value.views) || !value.views.includes('summary')
      || value.toolPagination !== true || value.eventPagination !== true || value.detailChunks !== true || value.exactWatermarks !== true) {
      throw new Error('子代理能力协议无效')
    }
    const discovery = value.activeDiscovery === true && value.lifecycleChanges === true && value.discoveryProtocol === 1
    if (['activeDiscovery', 'lifecycleChanges'].some(field => value[field] !== undefined && typeof value[field] !== 'boolean') ||
      value.discoveryProtocol !== undefined && (!Number.isSafeInteger(value.discoveryProtocol) || (value.discoveryProtocol as number) < 1))
      throw new Error('子代理发现能力协议无效')
    const fields = ['boundedSnapshotChildren', 'publishedChildRecovery', 'authoritativeChildUsage'] as const
    if (fields.some(field => value[field] !== undefined && value[field] !== false && value[field] !== 0 && value[field] !== 1)) throw new Error('子代理恢复能力协议无效')
    return { protocol: 2, discovery, childRecovery: fields.every(field => value[field] === 1) }
  })().catch((error: unknown) => {
    if (subagentCapabilities === operation) subagentCapabilities = undefined
    throw error
  })
  operation.promise = promise
  subagentCapabilities = operation
  return promise
}

export async function getSubagentProtocol(): Promise<1 | 2> {
  return (await getSubagentCapabilities()).protocol
}

export class SubagentDiscoveryError extends Error {
  readonly status: number
  constructor(message: string, readonly code: number, readonly discoveryRequired = false, readonly reason?: string) {
    super(message)
    this.name = 'SubagentDiscoveryError'
    this.status = code >= 10000 ? Math.floor(code / 100) : code
  }
}

export async function listSubagentDiscovery(scope: { parentSessionId: string; rootSessionId?: string; parentConversationId?: string },
  options: { mode: 'active' | 'changes'; cursor?: string; afterRevision?: number; limit?: number },
  connection = captureSubagentConnection()): Promise<SubagentDiscoveryPage> {
  const limit = options.limit ?? 64
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('子代理发现分页预算无效')
  assertSubagentConnection(connection)
  if (!(await getSubagentCapabilities(connection)).discovery) throw new Error('当前引擎不支持活跃子代理发现')
  assertSubagentConnection(connection)
  const response = await withSubagentReadPermit(() => {
    assertSubagentConnection(connection)
    return request<unknown>({ method: 'GET', path: '/subagent/discovery', query: { ...scope, ...options },
      expectedEngine: connection.expectedEngine, toolProfile: connection.toolProfile, subagentProtocol: 2 })
  })
  assertSubagentConnection(connection)
  if (!response.ok) {
    const recovery = record(response.data) ? response.data : undefined
    throw new SubagentDiscoveryError(response.message || '子代理发现失败', response.code,
      recovery?.discoveryRequired === true, typeof recovery?.reason === 'string' ? recovery.reason : undefined)
  }
  const page = parseSubagentDiscoveryPage(response.data)
  if (page.includedCount > limit || page.scannedCount > limit) throw new Error('子代理发现响应超过请求分页预算')
  if (page.mode !== options.mode || page.scope.parentSessionId !== scope.parentSessionId ||
    page.scope.rootSessionId !== scope.rootSessionId || page.scope.parentConversationId !== scope.parentConversationId)
    throw new Error('子代理发现响应归属不一致')
  return page
}

async function subagentV2Request() {
  if (await getSubagentProtocol() !== 2) throw new Error('当前引擎不支持子代理分页协议')
  return { subagentProtocol: 2 as const }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function wireRun(value: unknown): value is SubagentRun {
  return record(value) && (value.schemaVersion === 1 || value.schemaVersion === 2)
    && typeof value.runId === 'string'
    && (value.schemaVersion === 1 || value.view === 'summary')
}

/** A legacy array really is the old complete collection; a v2 page never inherits that claim. */
export function parseSubagentRunsPage(value: unknown): SubagentRunsPage {
  if (Array.isArray(value)) {
    if (!value.every((run) => wireRun(run) && run.schemaVersion === 1)) throw new Error('旧版子代理列表协议无效')
    return { schemaVersion: 1, runs: value, listComplete: true, hasMore: false }
  }
  if (!record(value) || value.schemaVersion !== 2 || !Array.isArray(value.runs)
    || !value.runs.every((run) => wireRun(run) && run.schemaVersion === 2)
    || typeof value.hasMore !== 'boolean' || typeof value.listComplete !== 'boolean'
    || (value.listComplete && value.hasMore)
    || (value.hasMore && (typeof value.nextCursor !== 'string' || !value.nextCursor.length || typeof value.revision !== 'string'))
    || (value.nextCursor !== undefined && typeof value.nextCursor !== 'string')
    || (value.revision !== undefined && typeof value.revision !== 'string')) {
    throw new Error('子代理分页协议无效')
  }
  return value as unknown as SubagentRunsPage
}

export async function listSubagentRuns(parentSessionId: string, options: SubagentPageOptions = {}): Promise<SubagentRunsPage> {
  const connection = captureSubagentConnection()
  const protocol = (await getSubagentCapabilities(connection)).protocol
  assertSubagentConnection(connection)
  if (protocol === 1 && (options.cursor !== undefined || options.limit !== undefined)) throw new Error('当前引擎不支持子代理分页协议')
  const page = parseSubagentRunsPage(await withSubagentReadPermit(() => {
    assertSubagentConnection(connection)
    return requestOrThrow<unknown>({
    ...(protocol === 2 ? { subagentProtocol: 2 as const } : {}),
    method: 'GET', path: '/subagent/runs', query: { parentSessionId, view: protocol === 2 ? 'summary' : 'legacy', ...options },
    expectedEngine: connection.expectedEngine, toolProfile: connection.toolProfile
  })
  }))
  assertSubagentConnection(connection)
  if (page.schemaVersion !== protocol) throw new Error('子代理响应与协商协议不一致')
  return page
}

export const listSubagentRunsPage = listSubagentRuns

export async function getSubagentRun(runId: string, options: SubagentScope & { atSeq?: number; connection?: SubagentConnection; verify?: () => void } = {}): Promise<SubagentRun> {
  const { connection = captureSubagentConnection(), verify, ...query } = options
  assertSubagentConnection(connection)
  const protocol = (await getSubagentCapabilities(connection)).protocol
  assertSubagentConnection(connection)
  verify?.()
  if (protocol === 1 && options.atSeq !== undefined) throw new Error('当前引擎不支持子代理准确水位协议')
  const run = await withSubagentReadPermit(() => {
    assertSubagentConnection(connection)
    verify?.()
    return requestOrThrow<unknown>({ ...(protocol === 2 ? { subagentProtocol: 2 as const } : {}),
    method: 'GET', path: `/subagent/runs/${encodeURIComponent(runId)}`, query: { view: protocol === 2 ? 'summary' : 'legacy', ...query },
    expectedEngine: connection.expectedEngine, toolProfile: connection.toolProfile })
  })
  assertSubagentConnection(connection)
  if (!wireRun(run) || run.schemaVersion !== protocol || run.runId !== runId || (options.atSeq !== undefined && run.lastSeq !== options.atSeq)
    || (options.parentSessionId && run.parentSessionId !== options.parentSessionId)
    || (options.rootSessionId && run.rootSessionId !== options.rootSessionId)
    || (options.parentConversationId && run.parentConversationId !== options.parentConversationId)) throw new Error('子代理摘要协议无效')
  return run
}

/** Acknowledgement contains the real current state; accepting cancel does not mean it has finished. */
export async function cancelSubagentRun(runId: string, options: SubagentScope & { connection?: SubagentConnection; verify?: () => void } = {}): Promise<SubagentRun> {
  const { connection = captureSubagentConnection(), verify, ...query } = options
  assertSubagentConnection(connection)
  const protocol = (await getSubagentCapabilities(connection)).protocol
  assertSubagentConnection(connection)
  verify?.()
  const run = await requestOrThrow<unknown>({ ...(protocol === 2 ? { subagentProtocol: 2 as const } : {}),
    method: 'POST', path: `/subagent/runs/${encodeURIComponent(runId)}/cancel`, query: { view: protocol === 2 ? 'summary' : 'legacy', ...query }, body: {},
    expectedEngine: connection.expectedEngine, toolProfile: connection.toolProfile })
  assertSubagentConnection(connection)
  if (!wireRun(run) || run.schemaVersion !== protocol || run.runId !== runId || (options.parentSessionId && run.parentSessionId !== options.parentSessionId)
    || (options.rootSessionId && run.rootSessionId !== options.rootSessionId)
    || (options.parentConversationId && run.parentConversationId !== options.parentConversationId)) throw new Error('子代理取消响应协议无效')
  return run
}

/** Pages remain at the caller's published watermark even while the child keeps working. */
export async function listSubagentToolCalls(runId: string, options: SubagentScope & SubagentPageOptions & { atSeq: number }): Promise<SubagentToolsPage> {
  const page = await requestOrThrow<SubagentToolsPage>({
    ...await subagentV2Request(),
    method: 'GET', path: `/subagent/runs/${encodeURIComponent(runId)}/tools`, query: options
  })
  if (!page || page.schemaVersion !== 2 || page.runId !== runId || page.asOfSeq !== options.atSeq
    || !Array.isArray(page.items) || !Number.isSafeInteger(page.totalCount) || page.totalCount < page.items.length
    || typeof page.hasMore !== 'boolean' || (page.hasMore && !page.nextCursor)) throw new Error('子代理工具分页协议无效')
  return page
}

/** Full arguments/output are explicit UTF-8 detail chunks, never the resident activity sample. */
export async function getSubagentToolDetail(runId: string, toolCallId: string,
  options: SubagentScope & { atSeq: number; offset?: number; limitBytes?: number }): Promise<SubagentToolDetailPage> {
  const page = await requestOrThrow<SubagentToolDetailPage>({
    ...await subagentV2Request(),
    method: 'GET', path: `/subagent/runs/${encodeURIComponent(runId)}/tools/${encodeURIComponent(toolCallId)}`, query: options
  })
  const detail = page?.detail
  const chunkBytes = typeof detail?.text === 'string' ? new TextEncoder().encode(detail.text).byteLength : 0
  if (!page || page.schemaVersion !== 2 || page.runId !== runId || page.asOfSeq !== options.atSeq || page.tool?.id !== toolCallId
    || !detail || detail.encoding !== 'json-utf8' || typeof detail.text !== 'string'
    || detail.offset !== (options.offset ?? 0) || !Number.isSafeInteger(detail.totalBytes) || detail.totalBytes < detail.offset
    || chunkBytes > (options.limitBytes ?? 128 * 1024) || detail.offset + chunkBytes > detail.totalBytes
    || typeof detail.hasMore !== 'boolean'
    || (detail.hasMore && (!Number.isSafeInteger(detail.nextOffset) || chunkBytes === 0 || detail.nextOffset !== detail.offset + chunkBytes))
    || (!detail.hasMore && detail.offset + chunkBytes !== detail.totalBytes)) {
    throw new Error('子代理工具详情分页协议无效')
  }
  return page
}

export async function listSubagentEvents(runId: string, options: SubagentScope & { afterSeq?: number; limit?: number } = {}): Promise<SubagentEventsPage> {
  const page = await requestOrThrow<SubagentEventsPage>({
    ...await subagentV2Request(),
    method: 'GET', path: `/subagent/runs/${encodeURIComponent(runId)}/events`, query: { format: 'delta', ...options }
  })
  if (!page || page.schemaVersion !== 2 || page.runId !== runId || !Array.isArray(page.events)
    || !Number.isSafeInteger(page.nextSeq) || page.nextSeq < (options.afterSeq ?? 0)
    || typeof page.hasMore !== 'boolean' || typeof page.checkpointRequired !== 'boolean'
    || page.events.some((event) => (event.schemaVersion !== 1 && event.schemaVersion !== 2) || event.runId !== runId)) {
    throw new Error('子代理增量分页协议无效')
  }
  return page
}

// ==================== 流式 ====================

export function startStream(input: StreamStartInput): Promise<{ ok: boolean }> {
  return bridge().engine.stream.start({
    ...input,
    toolProfile: input.toolProfile ?? (getAppMode() === 'work' ? 'general' : 'code'),
    expectedEngine: input.expectedEngine ?? getExpectedEngine()
  })
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
