import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { NextTurnQueueError, type NextTurnQueueEnvelope, type NextTurnQueueScope, type QueueAttachmentReceipt } from '../shared/next-turn-queue'
import { assertQueueEnvelope, assertQueueJsonValue, queueScopeIdentity } from '../shared/next-turn-queue-state'
import type { WorkQueueDraft, WorkQueueTarget } from '../shared/work-next-turn-api'
import type { EngineSnapshot } from '../shared/ipc'
import type { TrustedQueueAuthorityLease } from './next-turn-queue-service'
import type { QueueDispatchGateway } from './next-turn-dispatcher'
import { engineHost } from './engine/host'
import { engineRequest } from './engine/client'
import { engineTargetError, subagentProtocolHeaders } from './engine/protocol'
import { prepareRemoteChatBody } from './engine/remote-workspace'
import { remoteAttachmentsForRequest } from './engine/remote-attachments'
import { PREVIEW_FORMATS, WORKBENCH_ACTIONS } from '../renderer/src/core/workbench/capabilities'
import { assertAllowed } from './fs/file-service'
import { ATTACHMENTS_DIRECTORY } from '../shared/attachments'
import { buildAgentMentionMessage } from '../renderer/src/contrib/chat/agent-references'
import { canonicalAdmissionJson, parseAdmissionContext, parseExactAdmission, type AdmissionContext } from './next-turn-admission-protocol'

interface LeaseFacts { target: WorkQueueTarget; signal: AbortSignal }
export interface QueueEnginePort {
  snapshot(): EngineSnapshot
  signal(): AbortSignal
  headers(baseUrl: string, profile: 'general' | 'code'): Promise<Record<string, string>>
  request: typeof engineRequest
  fetch: typeof fetch
  remoteBody: typeof prepareRemoteChatBody
  allowed: typeof assertAllowed
}
const enginePort: QueueEnginePort = {
  snapshot: () => engineHost.getSnapshot(), signal: () => engineHost.requestSignal,
  headers: (baseUrl, profile) => engineHost.prepareRequestHeaders(baseUrl, profile),
  request: engineRequest, fetch: (input, init) => fetch(input, init), remoteBody: prepareRemoteChatBody, allowed: assertAllowed
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const sourceOf = (target: WorkQueueTarget): NextTurnQueueScope['source'] => ({ mode: target.mode,
  endpoint: target.mode === 'embedded' ? '' : new URL(target.baseUrl).href.replace(/\/+$/, ''), accountId: target.accountId ?? null })
const sameSource = (scope: NextTurnQueueScope, target: WorkQueueTarget): boolean => canonicalAdmissionJson(scope.source) === canonicalAdmissionJson(sourceOf(target))
function fail(message: string): never { throw new NextTurnQueueError('AUTHORITY', message) }
const relativeFile = (value: string): string => {
  const normalized = value.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || /[\x00-\x1f\x7f]/.test(normalized)
    || normalized.split('/').some(part => !part || part === '..' || part === '.')) fail('附件必须属于当前会话，不能跨工作区读取')
  return normalized
}
/** Actual authenticated transport authority. Renderer scope, tenant and permission claims never enter it. */
export class EngineQueueGateway implements QueueDispatchGateway {
  constructor(private readonly port: QueueEnginePort = enginePort, private readonly owner: NextTurnQueueScope['owner'] = 'work') {}
  private get profile(): 'general' | 'code' { return this.owner === 'code' ? 'code' : 'general' }
  private readonly connections = new Map<string, Map<{ isDestroyed(): boolean }, LeaseFacts>>()
  async setConnected(taskId: string, sender: { isDestroyed(): boolean }, connected: boolean): Promise<void> {
    const lease = await this.capture(taskId), key = queueScopeIdentity(lease.scope)
    if (!connected) { const bindings = this.connections.get(key); bindings?.delete(sender); if (!bindings?.size) this.connections.delete(key); return }
    const bindings = this.connections.get(key) ?? new Map()
    bindings.set(sender, this.leases.get(lease)!); this.connections.set(key, bindings)
  }
  private connected(scope: NextTurnQueueScope): boolean {
    const bindings = this.connections.get(queueScopeIdentity(scope))
    if (!bindings) return false
    for (const [sender, facts] of bindings) {
      try { this.assertFacts(facts); if (sender.isDestroyed()) bindings.delete(sender) } catch { bindings.delete(sender) }
    }
    if (!bindings.size) this.connections.delete(queueScopeIdentity(scope))
    return bindings.size > 0
  }
  private readonly leases = new WeakMap<TrustedQueueAuthorityLease, LeaseFacts>()
  private readonly controller = new AbortController()
  close(): void { this.controller.abort(); this.connections.clear() }
  private target(): LeaseFacts {
    const snapshot = this.port.snapshot()
    if (this.controller.signal.aborted) fail('队列所有者已关闭')
    if (snapshot.phase !== 'ready' || !snapshot.baseUrl || !snapshot.instanceId || this.port.signal().aborted) fail('引擎连接尚未就绪')
    return { target: { mode: snapshot.mode, baseUrl: snapshot.baseUrl, instanceId: snapshot.instanceId, accountId: snapshot.accountId ?? null }, signal: this.port.signal() }
  }
  private assertFacts(facts: LeaseFacts): void {
    if (this.controller.signal.aborted || facts.signal.aborted || facts.signal !== this.port.signal() || engineTargetError(this.port.snapshot(), facts.target)) fail('引擎或账号已变化，未发送消息')
  }
  private async request<T>(facts: LeaseFacts, method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    this.assertFacts(facts)
    const result = await this.port.request<T>({ method, path, ...(body === undefined ? {} : { body }), ...(query ? { query } : {}),
      expectedEngine: facts.target, toolProfile: this.profile, subagentProtocol: 2 }, this.controller.signal)
    this.assertFacts(facts)
    if (!result.ok || result.data === null) fail(result.message || '引擎未提供准确的队列接纳回执')
    return result.data
  }
  async capture(taskId: string): Promise<TrustedQueueAuthorityLease> {
    const facts = this.target(), context = parseAdmissionContext(await this.request(facts, 'GET', '/chat/admission/context', undefined, { sessionId: taskId }), taskId, this.owner)
    const lease = { scope: { source: sourceOf(facts.target), tenantId: context.tenantId, namespace: context.namespace, owner: this.owner, taskId }, generation: facts.target.instanceId! }
    this.leases.set(lease, facts); this.assertCurrent(lease); return lease
  }
  assertCurrent(lease: TrustedQueueAuthorityLease): void {
    const facts = this.leases.get(lease)
    if (!facts) fail('Queue authority lease is not owned by main')
    this.assertFacts(facts)
  }
  private async scoped(scope: NextTurnQueueScope): Promise<{ facts: LeaseFacts; context: AdmissionContext }> {
    const facts = this.target()
    if (scope.owner !== this.owner || !sameSource(scope, facts.target)) fail('此队列属于另一个模式、引擎或账号')
    const context = parseAdmissionContext(await this.request(facts, 'GET', '/chat/admission/context', undefined, { sessionId: scope.taskId }), scope.taskId, this.owner)
    if (context.tenantId !== scope.tenantId || canonicalAdmissionJson(context.namespace) !== canonicalAdmissionJson(scope.namespace)) fail('引擎数据库或任务所属空间已变化，旧队列保留且不会自动投递')
    return { facts, context }
  }
  async context(scope: NextTurnQueueScope): Promise<AdmissionContext> { return (await this.scoped(scope)).context }
  private async fileBytes(scope: NextTurnQueueScope, path: string, maximum: number, paths?: string[]): Promise<Buffer> {
    const { facts, context } = await this.scoped(scope), roots = paths ?? context.root?.workspacePaths ?? [], root = roots[0]
    if (scope.source.mode === 'embedded' && root) {
      const localPath = isAbsolute(path) ? path : join(root, relativeFile(path))
      const safePath = await fs.realpath(this.port.allowed(localPath))
      let inside = false
      for (const candidate of roots) {
        const safeRoot = await fs.realpath(this.port.allowed(candidate)), rel = relative(safeRoot, safePath)
        if (rel !== '..' && !rel.startsWith('..' + sep) && resolve(safeRoot, rel) === safePath) { inside = true; break }
      }
      if (!inside) fail('附件不属于任务的固定工作区')
      const handle = await fs.open(safePath, 'r')
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > maximum) fail('附件不存在、不是普通文件或超过容量限制')
        const bytes = await handle.readFile()
        if (bytes.length > maximum) fail('附件超过容量限制')
        this.assertFacts(facts); return bytes
      } finally { await handle.close() }
    }
    const name = relativeFile(path), headers = await this.port.headers(facts.target.baseUrl, this.profile)
    this.assertFacts(facts)
    const response = await this.port.fetch(`${facts.target.baseUrl}/api/v1/workspace/file/download?${new URLSearchParams({ sessionId: scope.taskId, path: name })}`,
      { headers, signal: AbortSignal.any([facts.signal, this.controller.signal, AbortSignal.timeout(30000)]), redirect: 'error' })
    if (!response.ok || !response.body) fail('无法读取已上传附件，请重新选择文件')
    const chunks: Buffer[] = []; let size = 0
    const reader = response.body.getReader()
    try {
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength
        if (size > maximum) fail('附件超过容量限制'); chunks.push(Buffer.from(part.value)) }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    this.assertFacts(facts); return Buffer.concat(chunks)
  }
  private async stageAttachment(scope: NextTurnQueueScope, file: WorkQueueDraft['attachments'][number], budget: number, paths?: string[]): Promise<QueueAttachmentReceipt> {
    const { facts, context } = await this.scoped(scope)
    const source = scope.owner === 'code' && scope.source.mode === 'remote' && file.remoteUploadId
      ? remoteAttachmentsForRequest([{ remoteUploadId: file.remoteUploadId }], facts.target, scope.taskId)[0]?.name : file.path
    if (!source) fail('远端附件回执无效，请重新上传')
    const bytes = await this.fileBytes(scope, source, budget, paths)
    if (bytes.length !== file.size) fail('附件大小已改变，请重新选择文件')
    const extension = extname(basename(file.name)).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 16)
    const name = `${ATTACHMENTS_DIRECTORY}/next-turn-${randomUUID()}${extension}`, root = (paths ?? context.root?.workspacePaths)?.[0]
    if (scope.source.mode === 'embedded' && root) {
      const path = join(this.port.allowed(root), name)
      // A grant for another open project must not let a redirected .ae directory escape this task's fixed workspace.
      for (const part of ['.ae', ATTACHMENTS_DIRECTORY]) {
        const directory = this.port.allowed(join(root, part))
        await fs.mkdir(directory, { recursive: false }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
        const stat = await fs.lstat(directory)
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail('队列附件目录必须是当前工作区内的普通目录')
      }
      const target = await fs.open(this.port.allowed(path), 'wx')
      try { await target.writeFile(bytes); await target.sync() } finally { await target.close() }
    } else {
      await this.request(facts, 'POST', '/workspace/file', { sessionId: scope.taskId, path: name, content: bytes.toString('base64'), encoding: 'base64' })
    }
    this.assertFacts(facts)
    const kind = scope.source.mode === 'remote' ? 'remote-session' : root ? 'local-workspace' : 'local-scratch'
    return { scope: structuredClone(scope), kind, path: name, name: file.name, mime: file.type, bytes: bytes.length, receiptId: randomUUID(), sha256: hash(bytes) }
  }
  editDraft(envelope: NextTurnQueueEnvelope, draft: WorkQueueDraft['draft']): NextTurnQueueEnvelope {
    const prepared = buildAgentMentionMessage(draft.text, draft.mentions)
    const collaborators = structuredClone(envelope.code?.collaborators ?? [])
    for (const selector of prepared.collaborators) if (!collaborators.some(item => item.agentId === selector.agentId)) collaborators.push(selector)
    return { ...structuredClone(envelope), draft: structuredClone(draft), agent: { ...envelope.agent, collaborators } }
  }
  async envelope(scope: NextTurnQueueScope, submission: WorkQueueDraft): Promise<NextTurnQueueEnvelope> {
    assertQueueJsonValue(submission)
    const { context } = await this.scoped(scope)
    if (!context.root) fail('先启动任务，再排下一轮；首页草稿不会被自动启动')
    if (scope.owner === 'code' && !submission.code || scope.owner === 'work' && submission.code) fail('队列提交配置与模式不一致')
    const paths = scope.owner === 'code' ? submission.code?.workspacePaths ?? context.root.workspacePaths : context.root.workspacePaths
    if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !path)) fail('工作区路径无效')
    if (scope.source.mode === 'embedded') for (const path of paths) this.port.allowed(path)
    else if (canonicalAdmissionJson(paths) !== canonicalAdmissionJson(context.root.workspacePaths)) fail('远端工作区必须与会话已绑定的完整路径一致')
    const root = paths[0], kind = scope.source.mode === 'remote' ? 'remote-session' : root ? 'local-workspace' : 'local-scratch'
    const envelope: NextTurnQueueEnvelope = this.editDraft({ draft: submission.draft, model: submission.model,
      ...(submission.code ? { code: { ...structuredClone(submission.code), workspacePaths: [...paths] } } : {}),
      workspace: { kind, identity: root || 'session:' + scope.taskId }, agent: { primaryAgentId: submission.code?.agentId ?? context.root.agentId ?? null, collaborators: [] },
      resources: submission.resources, thinking: submission.thinking, memory: submission.code?.memoryScope ? { kind: 'override', scope: submission.code.memoryScope, version: 'code-draft-v1' } : { kind: 'inherit' }, security: { policy: 'engine-session' }, attachments: [],
      ...(submission.subagentModel ? { subagentModel: submission.subagentModel } : {}), ...(submission.utilityModel ? { utilityModel: submission.utilityModel } : {}) }, submission.draft)
    // Validate text/options before creating any immutable attachment snapshots.
    if (envelope.model.kind !== 'explicit' && !envelope.model.observedModelId && context.root.modelId) envelope.model.observedModelId = context.root.modelId
    const preflight = !envelope.draft.text.trim() && Array.isArray(submission.attachments) && submission.attachments.length
      ? { ...envelope, draft: { ...envelope.draft, text: 'attachment validation', mentions: [] } } : envelope
    if (!envelope.draft.text.trim() && envelope.draft.mentions.length) fail('空正文不能保留引用标签')
    assertQueueEnvelope(preflight, scope)
    if (!Array.isArray(submission.attachments) || submission.attachments.length > 32) fail('最多添加 32 个队列附件')
    let budget = 100 * 1024 * 1024
    for (const file of submission.attachments) {
      if (!file || typeof file.path !== 'string' || typeof file.name !== 'string' || typeof file.type !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0) fail('附件选择无效')
      const receipt = await this.stageAttachment(scope, file, budget, paths); budget -= receipt.bytes; envelope.attachments.push(receipt)
    }
    assertQueueEnvelope(envelope, scope); return envelope
  }
  async prepare(scope: NextTurnQueueScope, envelope: NextTurnQueueEnvelope, context: AdmissionContext): Promise<Record<string, unknown>> {
    assertQueueEnvelope(envelope, scope)
    const { facts, context: current } = await this.scoped(scope)
    if (!current.root || canonicalAdmissionJson(current.predecessor) !== canonicalAdmissionJson(context.predecessor)) fail('上一轮状态已变化，稍后重试')
    if (scope.owner === 'work' && ((current.root.agentId ?? null) !== envelope.agent.primaryAgentId || (current.root.workspacePaths[0] || 'session:' + scope.taskId) !== envelope.workspace.identity)) fail('任务的 Agent 或工作区绑定已变化，未投递队列消息')
    const paths = envelope.code?.workspacePaths ?? current.root.workspacePaths
    if (scope.source.mode === 'embedded') for (const path of paths) this.port.allowed(path)
    const selectedModel = envelope.model.kind === 'explicit' ? envelope.model.modelId : envelope.model.observedModelId
    if (selectedModel) {
      const models = await this.request<unknown>(facts, 'GET', '/models')
      const list = Array.isArray(models) ? models : models && typeof models === 'object' && 'models' in models ? (models as { models: unknown }).models : null
      if (!Array.isArray(list) || !list.some(item => item && typeof item === 'object' && (!('isEnabled' in item) || item.isEnabled !== false) && ('id' in item && item.id === selectedModel || 'modelId' in item && item.modelId === selectedModel))) fail('排队时选择的模型已不可用，请删除该消息并重新选择模型后排队')
    }
    for (const file of envelope.attachments) {
      const bytes = await this.fileBytes(scope, file.path, file.bytes, paths)
      if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) fail('队列附件丢失或已改变，未发送消息')
    }
    const prepared = buildAgentMentionMessage(envelope.draft.text, envelope.draft.mentions)
    const body: Record<string, unknown> = { sessionId: scope.taskId, message: prepared.message }
    if (selectedModel) body.model = selectedModel
    if (envelope.agent.primaryAgentId) body.agentId = envelope.agent.primaryAgentId
    if (envelope.agent.collaborators.length || envelope.code?.collaborators) body.collaborators = structuredClone(envelope.agent.collaborators)
    if (paths.length || envelope.code?.workspacePaths) body.workspacePaths = [...paths]
    for (const key of ['skills', 'mcpServers', 'knowledgeBases'] as const) {
      const selection = envelope.resources[key]
      if (selection.kind !== 'inherit') body[key] = selection.kind === 'none' ? [] : [...selection.ids]
    }
    if (envelope.thinking.kind === 'off') body.thinkingMode = false
    else if (envelope.thinking.kind === 'on') body.thinkingMode = true
    else if (envelope.thinking.kind === 'effort') body.thinkingMode = envelope.thinking.effort
    if (envelope.memory.kind === 'override') body.memoryScope = envelope.memory.scope
    if (envelope.subagentModel) body.subagentModel = envelope.subagentModel
    if (envelope.utilityModel) body.utilityModel = envelope.utilityModel
    if (envelope.attachments.length) body.attachments = envelope.attachments.map(file => ({
      name: file.kind === 'local-workspace' ? join(envelope.workspace.identity, file.path) : file.path, type: file.mime
    }))
    const final = scope.source.mode === 'remote' ? await this.port.remoteBody(body, { baseUrl: facts.target.baseUrl,
      headers: await this.port.headers(facts.target.baseUrl, this.profile), signal: AbortSignal.any([facts.signal, this.controller.signal]), configuredRoot: '', target: facts.target }) : body
    if (scope.owner === 'code') {
      if (canonicalAdmissionJson(final.workspacePaths ?? []) !== canonicalAdmissionJson(paths)) fail('远端工作区已变化，未发送排队消息')
      final.clientCapabilities = { version: 1, application: 'aether', mode: 'code', platform: process.platform,
        previewFormats: [...PREVIEW_FORMATS], actions: [...WORKBENCH_ACTIONS], connected: this.connected(scope) }
    }
    this.assertFacts(facts); return final
  }
  async submit(scope: NextTurnQueueScope, wireBody: string, signal: AbortSignal): Promise<void> {
    const { facts } = await this.scoped(scope), headers = await this.port.headers(facts.target.baseUrl, this.profile)
    this.assertFacts(facts)
    // Body is already authenticated, adapted, and frozen. Never pass this through the generic remote sanitizer again.
    const response = await this.port.fetch(`${facts.target.baseUrl}/api/v1/chat`, { method: 'POST', redirect: 'error', body: wireBody,
      headers: { ...headers, ...subagentProtocolHeaders(2), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      signal: AbortSignal.any([facts.signal, this.controller.signal, signal, AbortSignal.timeout(30000)]) })
    await response.body?.cancel().catch(() => {})
    this.assertFacts(facts)
    if (!response.ok) fail(`接纳请求返回 HTTP ${response.status}；必须核对准确回执`)
  }
  async receipt(scope: NextTurnQueueScope, entry: Exclude<import('../shared/next-turn-queue').NextTurnQueueEntry, { phase: 'pending' }>) {
    const { facts } = await this.scoped(scope)
    return parseExactAdmission(await this.request(facts, 'POST', '/chat/admission/receipt', { sessionId: scope.taskId, namespace: scope.namespace,
      requestKey: entry.frozen.requestKey, bodyDigest: entry.frozen.bodyDigest }), scope, entry.frozen)
  }
}
