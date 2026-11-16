import { abortStream, acknowledgeStream, onStreamEvent, requestOrThrow, startStream } from './client'
import { getEngineSource, getExpectedEngine, subscribeEngineSource } from './source'
import type { PluginContributions } from '@shared/plugin-contributions'
import type { RootPending } from '@shared/root-run'

export interface PluginTool { name: string; description: string; inputSchema: Record<string, unknown>; entry: string }
export interface PluginManifest {
  apiVersion: 1; id: string; name: string; version: string; description: string; runtime: 'node'; tools: PluginTool[]; contributes?: PluginContributions
}
export interface PluginRecord {
  id: string; name: string; description: string; enabled: boolean; revision: number; publishedRevision?: number
  manifest: PluginManifest; files?: Record<string, string>; revisions: Array<{ revision: number; hash: string; createdAt: number }>
  source?: unknown; createdAt: number; updatedAt: number
  agentDisabledTools?: string[]
}
export interface PluginImport { jobId: string; status: string; manifest?: PluginManifest; source?: unknown; requirements?: unknown; error?: string; failureStage?: 'prepare' | 'install' }
export interface PluginTemplateSummary { id: string; name: string; description: string }
export interface PluginProtocol { apiVersion: 1; runtime: 'node'; [key: string]: string | number }
export interface PluginTemplate extends PluginTemplateSummary { manifest: PluginManifest; files: Record<string, string>; protocol: PluginProtocol }
export interface PluginApplication {
  id: string; name: string; description: string; revision: number; hash: string; manifest: PluginManifest
  examples: Array<{ name: string; tool: string; args: Record<string, unknown> }>
  execution: { allowed: boolean; reason?: string }
  uiDocuments?: Record<string, string>
}
export interface PluginInvocation {
  result: unknown; artifacts: Array<{ path: string; content: string; encoding?: 'utf8' | 'base64' }>; stderr: string; stderrTruncated?: boolean; durationMs: number
  plugin: { id: string; revision: number; hash: string }
}
/** A transient source directory opened in developer mode. It is intentionally
 * separate from PluginRecord: editing the directory must never create or
 * delete an installed plugin until the user explicitly imports it. */
export interface PluginDevelopmentSession {
  devSessionId: string
  path: string
  manifest: PluginManifest
  revision: number
  hash: string
  files?: string[]
  changedAt?: number
  permissionGrants?: string[]
  agentDisabledTools?: string[]
}
export interface PluginDevelopmentOpenResult {
  session: PluginDevelopmentSession
  examples?: Array<{ name: string; tool: string; args: Record<string, unknown> }>
  application?: PluginApplication
}
function validatePluginDevelopment(value: PluginDevelopmentOpenResult): PluginDevelopmentOpenResult {
  const session = value?.session, application = value?.application
  if (!session?.devSessionId || !session.manifest?.id || !Array.isArray(session.manifest.tools) ||
    !Number.isInteger(session.revision) || session.revision < 1 || typeof session.hash !== 'string' || !session.hash || typeof session.path !== 'string')
    throw new Error('开发模式返回的数据无效，请检查引擎版本。')
  if (application && (application.id !== session.manifest.id || application.manifest?.id !== session.manifest.id ||
    application.hash !== session.hash || application.revision !== session.revision || typeof application.execution?.allowed !== 'boolean'))
    throw new Error('开发页面与当前源码版本不一致，请重新打开工程。')
  return value
}
export const pluginDevelopmentPath = (devSessionId: string): string => `/plugins/dev/${encodeURIComponent(devSessionId)}`
export async function openPluginDevelopment(path: string): Promise<PluginDevelopmentOpenResult> {
  const value = await requestOrThrow<PluginDevelopmentOpenResult>({ method: 'POST', path: '/plugins/dev/open', body: { path: path.trim(), watch: false } })
  return validatePluginDevelopment(value)
}
export async function refreshPluginDevelopment(session: PluginDevelopmentSession): Promise<PluginDevelopmentOpenResult> {
  const value = await requestOrThrow<PluginDevelopmentOpenResult>({ method: 'POST', path: `${pluginDevelopmentPath(session.devSessionId)}/refresh`, body: {} })
  if (!value?.session || value.session.devSessionId !== session.devSessionId) throw new Error('开发模式会话已失效，请重新打开目录。')
  return validatePluginDevelopment(value)
}
export async function invokePluginDevelopment(session: PluginDevelopmentSession, tool: string, args: Record<string, unknown>, sessionId?: string | null, hostContext?: Record<string, string>): Promise<PluginInvocation> {
  const value = await requestOrThrow<PluginInvocation>({ method: 'POST', path: `${pluginDevelopmentPath(session.devSessionId)}/invoke`, body: { tool, args, revision: session.revision, hash: session.hash, ...(sessionId ? { sessionId } : {}), ...(hostContext && Object.keys(hostContext).length ? { hostContext } : {}) } })
  if (!value?.plugin || value.plugin.id !== session.manifest.id || value.plugin.revision !== session.revision || value.plugin.hash !== session.hash) throw new Error('开发模式运行回执与当前目录版本不一致，请先刷新。')
  return value
}
export async function closePluginDevelopment(session: PluginDevelopmentSession): Promise<void> {
  await requestOrThrow({ method: 'POST', path: `${pluginDevelopmentPath(session.devSessionId)}/close`, body: {} })
}
export interface PluginCapabilityInput { pluginId: string; revision: number; hash?: string; devSessionId?: string; sessionId?: string | null; capability: string; method: string; args: Record<string, unknown> }
export async function invokePluginCapability(input: PluginCapabilityInput): Promise<unknown> {
  const base = input.devSessionId ? pluginDevelopmentPath(input.devSessionId) : pluginPath(input.pluginId)
  const value = await requestOrThrow<{ result: unknown }>({ method: 'POST', path: `${base}/capabilities/invoke`, body: { capability: input.capability, method: input.method, args: input.args, expectedRevision: input.revision, ...(input.devSessionId ? { hash: input.hash } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}) } })
  return value.result
}
export type PluginCapabilityStreamEvent =
  | { type: 'started'; runId?: string; childSessionId?: string; model?: string }
  | { type: 'text-delta'; text: string; runId?: string }
  | { type: 'tool-start' | 'tool-end'; toolName: string; toolCallId?: string; runId?: string; success?: boolean; durationMs?: number }
  | { type: 'pending'; runId: string; childSessionId?: string; pending: Omit<RootPending, 'pendingAction'> }
  | { type: 'complete'; result: unknown }
  | { type: 'error'; error: { code: string; message: string } }

function streamEvent(value: unknown): PluginCapabilityStreamEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('插件流式事件格式无效。')
  const event = value as Record<string, unknown>
  const runId = typeof event.runId === 'string' ? event.runId : undefined
  if (event.type === 'pending' && runId && event.pending && typeof event.pending === 'object' && !Array.isArray(event.pending)) {
    const pending = event.pending as Record<string, unknown>
    if (typeof pending.requestId !== 'string' || !pending.requestId || typeof pending.toolCallId !== 'string' || !pending.toolCallId || typeof pending.toolName !== 'string' || !['ask', 'permission'].includes(String(pending.kind))) throw new Error('插件待确认事件格式无效。')
    return { type: 'pending', runId, ...(typeof event.childSessionId === 'string' ? { childSessionId: event.childSessionId } : {}), pending: {
      requestId: pending.requestId, kind: pending.kind as 'ask' | 'permission', toolCallId: pending.toolCallId, toolName: pending.toolName,
      args: pending.args && typeof pending.args === 'object' && !Array.isArray(pending.args) ? pending.args as Record<string, unknown> : {}, status: 'pending',
      ...(typeof pending.question === 'string' ? { question: pending.question } : {}), ...(typeof pending.description === 'string' ? { description: pending.description } : {}),
      ...(Array.isArray(pending.options) ? { options: pending.options } : {}),
      ...(pending.sourceChangeWait && typeof pending.sourceChangeWait === 'object' && !Array.isArray(pending.sourceChangeWait) ? { sourceChangeWait: pending.sourceChangeWait as Record<string, unknown> } : {})
    } }
  }
  if (event.type === 'started') return { type: 'started', ...(runId ? { runId } : {}), ...(typeof event.childSessionId === 'string' ? { childSessionId: event.childSessionId } : {}), ...(typeof event.model === 'string' ? { model: event.model } : {}) }
  if (event.type === 'text-delta' && typeof event.text === 'string') return { type: event.type, text: event.text, ...(runId ? { runId } : {}) }
  if ((event.type === 'tool-start' || event.type === 'tool-end') && typeof event.toolName === 'string')
    return { type: event.type, toolName: event.toolName, ...(typeof event.toolCallId === 'string' ? { toolCallId: event.toolCallId } : {}), ...(runId ? { runId } : {}),
      ...(event.type === 'tool-end' && typeof event.success === 'boolean' ? { success: event.success } : {}), ...(event.type === 'tool-end' && typeof event.durationMs === 'number' && Number.isFinite(event.durationMs) && event.durationMs >= 0 ? { durationMs: event.durationMs } : {}) }
  if (event.type === 'complete' && Object.hasOwn(event, 'result')) return { type: event.type, result: event.result }
  if (event.type === 'error' && event.error && typeof event.error === 'object' && 'code' in event.error && 'message' in event.error && typeof event.error.code === 'string' && typeof event.error.message === 'string')
    return { type: event.type, error: { code: event.error.code, message: event.error.message } }
  throw new Error('插件流式事件格式无效。')
}

/** The existing IPC transport owns authentication and remote routing. No event history is retained here. */
export interface PluginStreamOptions { onEvent?: (event: PluginCapabilityStreamEvent) => void | Promise<void>; signal?: AbortSignal }
export function streamPluginCapability(input: PluginCapabilityInput, options: PluginStreamOptions = {}): Promise<unknown> {
  const base = input.devSessionId ? pluginDevelopmentPath(input.devSessionId) : pluginPath(input.pluginId)
  return streamPluginRequest(`${base}/capabilities/stream`, { capability: input.capability, method: 'stream', args: input.args, expectedRevision: input.revision,
    ...(input.devSessionId ? { hash: input.hash } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}) }, options)
}
/** Host UI only. Never expose this operation through the page/Node capability catalogue. */
export function respondPluginAgent(input: Pick<PluginCapabilityInput, 'pluginId' | 'revision' | 'hash' | 'devSessionId' | 'sessionId'> & { runId: string; requestId: string; toolCallId: string; output: string }, options: PluginStreamOptions): Promise<unknown> {
  const base = input.devSessionId ? pluginDevelopmentPath(input.devSessionId) : pluginPath(input.pluginId)
  return streamPluginRequest(`${base}/agents/${encodeURIComponent(input.runId)}/respond`, {
    ...(input.devSessionId ? { revision: input.revision, hash: input.hash } : { expectedRevision: input.revision }),
    requestId: input.requestId, toolCallId: input.toolCallId, output: input.output, sessionId: input.sessionId
  }, options)
}
function streamPluginRequest(path: string, body: Record<string, unknown>, options: PluginStreamOptions): Promise<unknown> {
  const streamId = `plugin-capability-${crypto.randomUUID()}`, source = getEngineSource(), expectedEngine = getExpectedEngine()
  return new Promise((resolve, reject) => {
    let settled = false, started = false, completing = false, eventsOff = (): void => {}, sourceOff = (): void => {}
    const stopTransport = (): void => { if (started) void abortStream(streamId).catch(() => {}) }
    const finish = (error?: Error, result?: unknown): void => {
      if (settled) return
      settled = true; eventsOff(); sourceOff(); options.signal?.removeEventListener('abort', cancelled); window.removeEventListener('pagehide', unloaded)
      if (error) { stopTransport(); reject(error) } else resolve(result)
    }
    const cancelled = (): void => { const error = new Error('插件任务已取消。'); error.name = 'AbortError'; finish(error) }
    const unloaded = (): void => finish(new Error('插件页面已关闭。'))
    if (options.signal?.aborted) { cancelled(); return }
    eventsOff = onStreamEvent(event => { void (async () => {
      if (settled || completing || event.streamId !== streamId) return
      if (source !== getEngineSource()) { finish(new Error('引擎连接已变化。')); return }
      if (event.type !== 'payload') { finish(new Error(event.type === 'error' ? event.message : '插件连接已结束，未收到完整结果。')); return }
      try {
        const value = streamEvent(event.payload)
        await options.onEvent?.(value)
        if (settled) return
        completing = value.type === 'complete'
        if (event.ackId && !(await acknowledgeStream(streamId, event.ackId)).ok) throw new Error('插件流式消费确认已失效。')
        if (settled) return
        if (value.type === 'complete') finish(undefined, value.result)
        else if (value.type === 'error') finish(new Error(value.error.message))
      } catch (error) { finish(error instanceof Error ? error : new Error('插件事件处理失败。')) }
    })() })
    sourceOff = subscribeEngineSource(() => finish(new Error('引擎连接已变化。')))
    options.signal?.addEventListener('abort', cancelled, { once: true }); window.addEventListener('pagehide', unloaded, { once: true })
    started = true
    try { void startStream({ streamId, method: 'POST', flowControl: 'ack', path, expectedEngine, body
    }).then(result => { if (!result.ok) finish(new Error(result.rejection?.message || '插件流式请求未被接受。')) }).catch(error => finish(error instanceof Error ? error : new Error('插件连接失败。'))) }
    catch (error) { finish(error instanceof Error ? error : new Error('插件连接失败。')) }
  })
}
export const pluginApplicationPath = (id: string): string => `/plugins/runtime/apps/${encodeURIComponent(id)}`
export async function getPluginApplication(id: string, revision: number): Promise<PluginApplication> {
  const data = await requestOrThrow<{ application: PluginApplication }>({ method: 'GET', path: `${pluginApplicationPath(id)}?revision=${revision}` })
  const application = data?.application
  if (!application || application.id !== id || application.revision !== revision || application.manifest?.id !== id ||
    !Array.isArray(application.manifest.tools) || !application.manifest.tools.length || !Array.isArray(application.examples) || typeof application.execution?.allowed !== 'boolean')
    throw new Error('插件运行信息无效，请刷新插件列表后重试。')
  return application
}
export async function invokePluginApplication(application: PluginApplication, tool: string, args: Record<string, unknown>, sessionId?: string | null, hostContext?: Record<string, string>): Promise<PluginInvocation> {
  const result = await requestOrThrow<PluginInvocation>({ method: 'POST', path: `${pluginApplicationPath(application.id)}/invoke`, body: { revision: application.revision, tool, args, ...(sessionId ? { sessionId } : {}), ...(hostContext && Object.keys(hostContext).length ? { hostContext } : {}) } })
  if (!result?.plugin || result.plugin.id !== application.id || result.plugin.revision !== application.revision || result.plugin.hash !== application.hash)
    throw new Error('插件运行回执与打开的版本不一致，请重新打开插件。')
  return result
}
export const pluginPath = (id: string): string => `/plugins/${encodeURIComponent(id)}`
export async function listPlugins(): Promise<PluginRecord[]> {
  const data = await requestOrThrow<{ plugins: PluginRecord[] }>({ method: 'GET', path: '/plugins' })
  if (!Array.isArray(data?.plugins)) throw new Error('插件目录格式无效，请检查引擎版本。')
  return data.plugins
}
export async function listPluginTemplates(): Promise<PluginTemplateSummary[]> {
  const data = await requestOrThrow<{ templates: PluginTemplateSummary[] }>({ method: 'GET', path: '/plugins/project/templates' })
  if (!Array.isArray(data?.templates) || !data.templates.length) throw new Error('引擎没有可用的插件模板，请更新引擎后重试。')
  return data.templates
}
export async function getPluginTemplate(id: string): Promise<PluginTemplate> {
  const data = await requestOrThrow<{ template: PluginTemplate }>({ method: 'GET', path: `/plugins/project/templates/${encodeURIComponent(id)}` })
  if (!data?.template?.manifest || !data.template.files || !data.template.protocol) throw new Error('插件模板格式无效，请检查引擎版本。')
  return data.template
}
/** Keep editor JSON as authored; syntax errors remain visible without discarding buffers. */
export function parsePluginDraft(manifest: string, files: Record<string, string>): { manifest: PluginManifest; files: Record<string, string> } {
  const value: unknown = JSON.parse(manifest)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('插件清单必须为 JSON 对象。')
  const item = value as Record<string, unknown>
  if (item.apiVersion !== 1 || item.runtime !== 'node' || typeof item.id !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(item.id) ||
    typeof item.name !== 'string' || !item.name.trim() || typeof item.version !== 'string' || typeof item.description !== 'string' || !Array.isArray(item.tools))
    throw new Error('请检查清单中的标识、名称、版本、用途与工具列表。')
  if (!Object.keys(files).length || Object.entries(files).some(([path, content]) => !path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || typeof content !== 'string'))
    throw new Error('插件文件必须使用安全的相对路径。')
  return { manifest: value as PluginManifest, files: { ...files } }
}

/** Examples are authored files; malformed/incomplete drafts remain editable. */
export function pluginExampleArgs(files: Record<string, string>, tool: string): string {
  try {
    const value: unknown = JSON.parse(files['examples/cases.json'] ?? '{}')
    if (!value || typeof value !== 'object' || !('cases' in value) || !Array.isArray(value.cases)) return '{}'
    const example = value.cases.find(item => item && typeof item === 'object' && item.tool === tool && item.args && typeof item.args === 'object' && !Array.isArray(item.args))
    return example ? JSON.stringify(example.args, null, 2) : '{}'
  } catch { return '{}' }
}
