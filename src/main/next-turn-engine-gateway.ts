import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { NextTurnQueueError, type NextTurnQueueEnvelope, type NextTurnQueueScope, type QueueAttachmentReceipt } from '../shared/next-turn-queue'
import { assertQueueEnvelope, assertQueueJsonValue, queueResourcesAfterDraftEdit, queueDraftRemovesToolkit } from '../shared/next-turn-queue-state'
import { parseSessionToolkits } from '../shared/toolkits'
import type { WorkQueueDraft, WorkQueueTarget } from '../shared/work-next-turn-api'
import type { EngineSnapshot } from '../shared/ipc'
import type { TrustedQueueAuthorityLease } from './next-turn-queue-service'
import type { QueueDispatchGateway } from './next-turn-dispatcher'
import { engineHost } from './engine/host'
import { engineRequest } from './engine/client'
import { engineTargetError, subagentProtocolHeaders } from './engine/protocol'
import { prepareRemoteChatBody } from './engine/remote-workspace'
import { assertAllowed } from './fs/file-service'
import { ATTACHMENTS_DIRECTORY } from '../shared/attachments'
import { buildAgentMentionMessage } from '../renderer/src/contrib/chat/agent-references'
import { collaboratorIdentity } from '../shared/builtin-agents'
import { canonicalAdmissionJson, parseAdmissionContext, parseExactAdmission, type AdmissionContext } from './next-turn-admission-protocol'
import { remapQueueAttachmentReferences } from '../shared/queue-attachment-references'

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
  private get profile(): 'general' { return 'general' }
  private readonly leases = new WeakMap<TrustedQueueAuthorityLease, LeaseFacts>()
  private readonly controller = new AbortController()
  close(): void { this.controller.abort() }
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
  async recoveryEnvelope(scope: NextTurnQueueScope, runId: string): Promise<NextTurnQueueEnvelope> {
    const { facts, context } = await this.scoped(scope)
    if (scope.owner !== 'work' || !context.root || context.root.runId !== runId || !['failed', 'interrupted'].includes(context.root.status))
      fail('只能继续当前失败或中断的任务，请先同步任务状态')
    const value = await this.request<unknown>(facts, 'GET', '/chat/runs', undefined, { sessionId: scope.taskId })
    const runs = value && typeof value === 'object' && 'runs' in value ? value.runs : undefined
    if (!Array.isArray(runs)) fail('未取得原任务的运行配置，请同步后重试')
    const matches = runs.filter(item => item && typeof item === 'object' && item.runId === runId)
    if (matches.length !== 1) fail('原任务的运行记录不存在或不唯一')
    const run = matches[0] as Record<string, unknown>
    if (!Array.isArray(run.workspacePaths) || run.workspacePaths.some(path => typeof path !== 'string')) fail('原任务的工作区配置无效')
    if (run.sessionId !== scope.taskId || run.version !== context.root.version || run.status !== context.root.status
      || run.modelId !== context.root.modelId || canonicalAdmissionJson(run.workspacePaths) !== canonicalAdmissionJson(context.root.workspacePaths))
      fail('原任务的运行配置已变化，请同步后重试')
    const rawConfig = run.requestConfig
    if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) fail('引擎未保留原任务配置，未猜测恢复设置')
    const config = rawConfig as Record<string, unknown>
    if ((config.agentId ?? null) !== (context.root.agentId ?? null)) fail('原任务的 Agent 绑定已变化')
    const resource = (name: string): NextTurnQueueEnvelope['resources']['skills'] => {
      const selection = config[name]
      if (selection === undefined) return { kind: 'inherit' }
      if (!Array.isArray(selection) || selection.some(id => typeof id !== 'string')) fail('原任务的资源配置无效')
      return selection.length ? { kind: 'override', ids: [...selection] } : { kind: 'none' }
    }
    const thinking = config.thinkingMode
    if (thinking !== undefined && typeof thinking !== 'boolean' && !['low', 'medium', 'high'].includes(String(thinking))) fail('原任务的思考配置无效')
    const memory = config.memoryScope
    if (memory !== undefined && !['off', 'session', 'global'].includes(String(memory))) fail('原任务的记忆配置无效')
    const root = context.root.workspacePaths[0]
    const envelope: NextTurnQueueEnvelope = {
      recovery: { runId },
      draft: { revision: 1, mentions: [], text: '继续本会话中尚未完成的任务，保留已经完成的工作。先检查现有文件、任务计划和已保存结果；中断前缺少结果回执的工具可能已经执行，请先核实实际状态，再决定是否重试。只补充未完成的操作，避免重复写入、启动命令、创建协作任务或执行外部操作。完成后交付本次任务的最终结果。' },
      model: context.root.modelId ? { kind: 'explicit', modelId: context.root.modelId } : { kind: 'engine-default' },
      workspace: { kind: scope.source.mode === 'remote' ? 'remote-session' : root ? 'local-workspace' : 'local-scratch', identity: root || 'session:' + scope.taskId },
      agent: { primaryAgentId: context.root.agentId ?? null, collaborators: [] },
      resources: { skills: resource('skills'), mcpServers: resource('mcpServers'), knowledgeBases: resource('knowledgeBases'), toolkits: resource('toolkits') },
      thinking: thinking === undefined ? { kind: 'inherit' } : thinking === false ? { kind: 'off' } : thinking === true ? { kind: 'on' }
        : { kind: 'effort', effort: thinking as 'low' | 'medium' | 'high' },
      memory: memory === undefined ? { kind: 'inherit' } : { kind: 'override', scope: memory as 'off' | 'session' | 'global', version: 'work-recovery-v1' },
      security: { policy: 'engine-session' }, attachments: [],
    }
    for (const key of ['subagentModel', 'utilityModel'] as const) {
      if (config[key] !== undefined && typeof config[key] !== 'string') fail('原任务的模型配置无效')
      if (typeof config[key] === 'string' && config[key]) envelope[key] = config[key]
    }
    assertQueueEnvelope(envelope, scope)
    const current = await this.scoped(scope)
    if (canonicalAdmissionJson(current.context.predecessor) !== canonicalAdmissionJson(context.predecessor)) fail('当前任务已变化，未创建恢复请求')
    this.assertFacts(facts)
    return envelope
  }
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
    const source = file.path
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
    return { scope: structuredClone(scope), kind, path: name, name: file.name, mime: file.type, bytes: bytes.length, receiptId: randomUUID(), sha256: hash(bytes),
      ...(file.attachmentId ? { attachmentId: file.attachmentId } : {}),
      ...(file.referenceLabel ? { referenceLabel: file.referenceLabel } : {}) }
  }
  async editDraft(envelope: NextTurnQueueEnvelope, draft: WorkQueueDraft['draft'], scope?: NextTurnQueueScope): Promise<NextTurnQueueEnvelope> {
    let inheritedToolkits: string[] | undefined
    const selected = envelope.resources.toolkits
    if ((!selected || selected.kind === 'inherit') && queueDraftRemovesToolkit(envelope.draft, draft)) {
      if (!scope) fail('读取继承的工具包需要可信会话范围')
      const { facts } = await this.scoped(scope)
      inheritedToolkits = parseSessionToolkits(await this.request(facts, 'GET', `/sessions/${encodeURIComponent(scope.taskId)}/toolkits`))
    }
    const resources = queueResourcesAfterDraftEdit(envelope.draft, draft, envelope.resources, inheritedToolkits)
    const prepared = buildAgentMentionMessage(draft.text, draft.mentions)
    const collaborators = structuredClone(envelope.agent.collaborators)
    for (const selector of prepared.collaborators) if (!collaborators.some(item => collaboratorIdentity(item) === collaboratorIdentity(selector))) collaborators.push(selector)
    return { ...structuredClone(envelope), draft: structuredClone(draft), resources: structuredClone(resources), agent: { ...envelope.agent, collaborators } }
  }
  async envelope(scope: NextTurnQueueScope, submission: WorkQueueDraft): Promise<NextTurnQueueEnvelope> {
    assertQueueJsonValue(submission)
    const { context } = await this.scoped(scope)
    if (!context.root) fail('先启动任务，再排下一轮；首页草稿不会被自动启动')
    const paths = context.root.workspacePaths
    if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !path)) fail('工作区路径无效')
    if (scope.source.mode === 'embedded') for (const path of paths) this.port.allowed(path)
    else if (canonicalAdmissionJson(paths) !== canonicalAdmissionJson(context.root.workspacePaths)) fail('远端工作区必须与会话已绑定的完整路径一致')
    const root = paths[0], kind = scope.source.mode === 'remote' ? 'remote-session' : root ? 'local-workspace' : 'local-scratch'
    const envelope: NextTurnQueueEnvelope = await this.editDraft({ draft: submission.draft, model: submission.model,
      workspace: { kind, identity: root || 'session:' + scope.taskId }, agent: { primaryAgentId: context.root.agentId ?? null, collaborators: [] },
      resources: submission.resources, thinking: submission.thinking, memory: { kind: 'inherit' }, security: { policy: 'engine-session' }, attachments: [],
      ...(submission.subagentModel ? { subagentModel: submission.subagentModel } : {}), ...(submission.utilityModel ? { utilityModel: submission.utilityModel } : {}) }, submission.draft, scope)
    // Validate text/options before creating any immutable attachment snapshots.
    if (envelope.model.kind !== 'explicit' && !envelope.model.observedModelId && context.root.modelId) envelope.model.observedModelId = context.root.modelId
    const preflight = !envelope.draft.text.trim() && Array.isArray(submission.attachments) && submission.attachments.length
      ? { ...envelope, draft: { ...envelope.draft, text: 'attachment validation', mentions: [] } } : envelope
    if (!envelope.draft.text.trim() && envelope.draft.mentions.length) fail('空正文不能保留引用标签')
    assertQueueEnvelope(preflight, scope)
    if (!Array.isArray(submission.attachments) || submission.attachments.length > 32) fail('最多添加 32 个队列附件')
    let budget = 100 * 1024 * 1024
    const frozenPaths = new Map<string, string>()
    for (const file of submission.attachments) {
      if (!file || typeof file.path !== 'string' || typeof file.name !== 'string' || typeof file.type !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0) fail('附件选择无效')
      const receipt = await this.stageAttachment(scope, file, budget, paths); budget -= receipt.bytes; envelope.attachments.push(receipt)
      const finalPath = receipt.kind === 'local-workspace' ? join(envelope.workspace.identity, receipt.path) : receipt.path
      frozenPaths.set(file.path, finalPath)
    }
    envelope.draft = remapQueueAttachmentReferences(envelope.draft, frozenPaths)
    assertQueueEnvelope(envelope, scope); return envelope
  }
  async prepare(scope: NextTurnQueueScope, envelope: NextTurnQueueEnvelope, context: AdmissionContext): Promise<Record<string, unknown>> {
    assertQueueEnvelope(envelope, scope)
    const { facts, context: current } = await this.scoped(scope)
    if (!current.root || canonicalAdmissionJson(current.predecessor) !== canonicalAdmissionJson(context.predecessor)) fail('上一轮状态已变化，稍后重试')
    if (envelope.recovery && (current.root.runId !== envelope.recovery.runId || !['failed', 'interrupted'].includes(current.root.status)))
      fail('待恢复的任务已变化，请同步当前任务后重试')
    if (scope.owner === 'work' && ((current.root.agentId ?? null) !== envelope.agent.primaryAgentId || (current.root.workspacePaths[0] || 'session:' + scope.taskId) !== envelope.workspace.identity)) fail('任务的 Agent 或工作区绑定已变化，未投递队列消息')
    const paths = current.root.workspacePaths
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
    if (envelope.agent.collaborators.length) body.collaborators = structuredClone(envelope.agent.collaborators)
    if (paths.length) body.workspacePaths = [...paths]
    for (const key of ['skills', 'mcpServers', 'knowledgeBases', 'toolkits'] as const) {
      const selection = envelope.resources[key]
      if (!selection) continue
      if (selection.kind !== 'inherit') body[key] = selection.kind === 'none' ? [] : [...selection.ids]
    }
    if (envelope.thinking.kind === 'off') body.thinkingMode = false
    else if (envelope.thinking.kind === 'on') body.thinkingMode = true
    else if (envelope.thinking.kind === 'effort') body.thinkingMode = envelope.thinking.effort
    if (envelope.memory.kind === 'override') body.memoryScope = envelope.memory.scope
    if (envelope.subagentModel) body.subagentModel = envelope.subagentModel
    if (envelope.utilityModel) body.utilityModel = envelope.utilityModel
    if (envelope.attachments.length) body.attachments = envelope.attachments.map(file => ({
      name: file.kind === 'local-workspace' ? join(envelope.workspace.identity, file.path) : file.path, type: file.mime,
      displayName: file.name, size: file.bytes,
      ...(file.attachmentId ? { attachmentId: file.attachmentId } : {}),
      ...(file.referenceLabel ? { referenceLabel: file.referenceLabel } : {})
    }))
    const final = scope.source.mode === 'remote' ? await this.port.remoteBody(body, { baseUrl: facts.target.baseUrl,
      headers: await this.port.headers(facts.target.baseUrl, this.profile), signal: AbortSignal.any([facts.signal, this.controller.signal]), configuredRoot: '', target: facts.target }) : body
    // The remote renderer sanitizer intentionally drops metadata. Install only
    // this main-owned recovery evidence after it, before freezing the digest.
    if (envelope.recovery) { final.inheritContext = true; final.metadata = { workRecovery: { runId: envelope.recovery.runId } } }
    if (canonicalAdmissionJson(final.workspacePaths ?? []) !== canonicalAdmissionJson(paths)) fail('远端工作区已变化，未发送排队消息')
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
