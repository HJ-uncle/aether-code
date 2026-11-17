import { createHash, randomUUID } from 'node:crypto'
import { NextTurnQueueError, type FrozenQueueSubmission, type NextTurnQueueScope, type QueueAdmissionReceipt } from '../shared/next-turn-queue'

export const SESSION_QUEUE_TRANSPORT = Object.freeze({ toolProfile: 'general', runLifetime: 'durable', subagentProtocol: 2 })
export function queueTransport(owner: NextTurnQueueScope['owner']): typeof SESSION_QUEUE_TRANSPORT {
  // Keep old journal scopes distinguishable; never reinterpret their frozen
  // requests as work requests or send them through the remaining owner.
  if (owner !== 'work') fail('此队列属于已移除的 Code 界面，原记录保留且不会自动投递')
  return SESSION_QUEUE_TRANSPORT
}
export interface AdmissionOutcomeRoot {
  runId: string; version: number
  attemptId?: string; turnId?: string
  startedAt?: number
  status: 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
  workspacePaths: string[]; modelId?: string; agentId?: string
}
export interface AdmissionRoot extends AdmissionOutcomeRoot { attemptId: string }
export interface AdmissionContext {
  protocolVersion: 1; tenantId: string; sessionId: string
  namespace: NextTurnQueueScope['namespace']; predecessor: FrozenQueueSubmission['anchor']
  root: AdmissionRoot | null; transport: typeof SESSION_QUEUE_TRANSPORT
}
function fail(message: string): never { throw new NextTurnQueueError('AUTHORITY', message) }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : fail('Admission response is not an object')
const identity = (value: unknown): string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value)
  ? value : fail('Admission identity is invalid')
const version = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 1 ? Number(value) : fail('Admission revision is invalid')
const namespace = (value: unknown): NextTurnQueueScope['namespace'] => { const item = record(value); return { id: identity(item.id), generation: identity(item.generation) } }
function parseAdmissionOutcomeRoot(value: unknown): AdmissionOutcomeRoot {
  const item = record(value), status = item.status
  if (!['running', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(String(status))) fail('Root outcome is unknown')
  if (!Array.isArray(item.workspacePaths) || item.workspacePaths.some(path => typeof path !== 'string')) fail('Root workspace is unavailable')
  if (item.startedAt !== undefined && (!Number.isSafeInteger(item.startedAt) || Number(item.startedAt) < 1)) fail('Root execution start is invalid')
  return { runId: identity(item.runId), version: version(item.version),
    ...(item.attemptId === undefined ? {} : { attemptId: identity(item.attemptId) }),
    ...(item.turnId === undefined ? {} : { turnId: identity(item.turnId) }),
    ...(item.startedAt === undefined ? {} : { startedAt: Number(item.startedAt) }),
    status: status as AdmissionRoot['status'], workspacePaths: [...item.workspacePaths],
    ...(item.modelId === undefined ? {} : { modelId: identity(item.modelId) }),
    ...(item.agentId === undefined ? {} : { agentId: identity(item.agentId) }) }
}
export function parseAdmissionRoot(value: unknown): AdmissionRoot {
  return { ...parseAdmissionOutcomeRoot(value), attemptId: identity(record(value).attemptId) }
}
export function parseAdmissionContext(value: unknown, taskId: string, owner: NextTurnQueueScope['owner'] = 'work'): AdmissionContext {
  const item = record(value), transport = record(item.transport)
  if (item.protocolVersion !== 1 || item.sessionId !== taskId || transport.toolProfile !== queueTransport(owner).toolProfile
    || transport.runLifetime !== 'durable' || transport.subagentProtocol !== 2) fail('引擎尚未提供当前会话的下一轮接纳协议，未发送消息')
  const root = item.root === null ? null : parseAdmissionRoot(item.root)
  const predecessor = item.predecessor === null ? null : (() => {
    const anchor = record(item.predecessor)
    return { runId: identity(anchor.runId), attemptId: identity(anchor.attemptId), version: version(anchor.version) }
  })()
  if ((root === null) !== (predecessor === null) || root && predecessor &&
    (root.runId !== predecessor.runId || root.attemptId !== predecessor.attemptId || root.version !== predecessor.version)) fail('Root authority and predecessor disagree')
  return { protocolVersion: 1, tenantId: identity(item.tenantId), sessionId: taskId, namespace: namespace(item.namespace), predecessor, root, transport: queueTransport(owner) }
}
/** This encoder deliberately mirrors admission v1: undefined is not an omitted JSON field. */
export function canonicalAdmissionJson(value: unknown): string {
  const ancestors = new Set<object>(); let nodes = 0, size = 0
  const add = (text: string) => { size += Buffer.byteLength(text); if (size > 2 * 1024 * 1024) fail('Admission body exceeds its byte budget'); return text }
  const walk = (item: unknown, depth: number): string => {
    if (++nodes > 40000 || depth > 24) fail('Admission body exceeds its structural budget')
    if (item === null || typeof item === 'boolean') return add(String(item))
    if (typeof item === 'string' || typeof item === 'number' && Number.isFinite(item)) return add(JSON.stringify(item))
    if (!item || typeof item !== 'object' || !Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) fail('Admission body must be plain JSON')
    if (ancestors.has(item)) fail('Admission body cannot contain cycles')
    ancestors.add(item)
    const descriptors = Object.getOwnPropertyDescriptors(item)
    if (Object.getOwnPropertySymbols(item).length || Object.values(descriptors).some(field => field.get || field.set)) fail('Admission body cannot contain accessors')
    if (Array.isArray(item)) {
      if (Object.keys(descriptors).length !== item.length + 1 || Object.keys(descriptors).some(key => key !== 'length' &&
        (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length || !descriptors[key].enumerable))) fail('Admission array cannot contain holes or hidden fields')
    } else if (Object.values(descriptors).some(field => !field.enumerable)) fail('Admission body cannot contain hidden fields')
    const join = (parts: string[]) => parts.map((part, index) => (index ? add(',') : '') + part).join('')
    const encoded = Array.isArray(item) ? add('[') + join(item.map(part => walk(part, depth + 1))) + add(']')
      : add('{') + join(Object.keys(item).sort().map(key => add(JSON.stringify(key)) + add(':') + walk((item as Record<string, unknown>)[key], depth + 1))) + add('}')
    ancestors.delete(item); return encoded
  }
  return walk(value, 0)
}
export function freezeQueueRequest(scope: NextTurnQueueScope, body: Record<string, unknown>, entryRevision: number, anchor: FrozenQueueSubmission['anchor']): FrozenQueueSubmission {
  if (body.sessionId !== scope.taskId || body.admission !== undefined) fail('Queue request belongs to another task')
  if (body.continuation !== undefined) {
    const selector = continuationSelector(scope, body.continuation, anchor)
    if (Object.keys(body).some(key => !['sessionId', 'continuation'].includes(key))) fail('Continuation cannot replay a user message or settings')
    const bodyDigest = createHash('sha256').update(canonicalAdmissionJson({ selector, transport: queueTransport(scope.owner), body: { sessionId: scope.taskId } })).digest('hex')
    const requestKey = randomUUID()
    return { requestKey, bodyDigest, entryRevision, anchor,
      wireBody: canonicalAdmissionJson({ sessionId: scope.taskId, continuation: { ...selector, requestKey, bodyDigest } }) }
  }
  const selector = { protocolVersion: 1, namespace: scope.namespace, owner: scope.owner, predecessor: anchor }
  const bodyDigest = createHash('sha256').update(canonicalAdmissionJson({ selector, transport: queueTransport(scope.owner), body })).digest('hex')
  const requestKey = randomUUID()
  return { requestKey, bodyDigest, entryRevision, anchor, wireBody: canonicalAdmissionJson({ ...body, admission: { ...selector, requestKey, bodyDigest } }) }
}
export function assertFrozenQueueRequest(scope: NextTurnQueueScope, frozen: FrozenQueueSubmission): string {
  if (!frozen.wireBody) fail('旧队列项缺少完整请求，需人工核对；不会自动重发')
  const body = record(JSON.parse(frozen.wireBody))
  if (body.continuation !== undefined) {
    const continuation = record(body.continuation)
    const { requestKey, bodyDigest, ...source } = continuation
    const selector = continuationSelector(scope, source, frozen.anchor)
    const digest = createHash('sha256').update(canonicalAdmissionJson({ selector, transport: queueTransport(scope.owner), body: { sessionId: scope.taskId } })).digest('hex')
    if (Object.keys(body).some(key => !['sessionId', 'continuation'].includes(key)) || body.sessionId !== scope.taskId ||
      requestKey !== frozen.requestKey || bodyDigest !== frozen.bodyDigest || digest !== frozen.bodyDigest) fail('Frozen continuation integrity failed')
    return frozen.wireBody
  }
  const admission = record(body.admission)
  const { admission: _admission, ...request } = body
  const selector = { protocolVersion: 1, namespace: scope.namespace, owner: scope.owner, predecessor: frozen.anchor }
  const digest = createHash('sha256').update(canonicalAdmissionJson({ selector, transport: queueTransport(scope.owner), body: request })).digest('hex')
  if (body.sessionId !== scope.taskId || admission.requestKey !== frozen.requestKey || admission.bodyDigest !== frozen.bodyDigest
    || digest !== frozen.bodyDigest || canonicalAdmissionJson(admission) !== canonicalAdmissionJson({ ...selector, requestKey: frozen.requestKey, bodyDigest: frozen.bodyDigest })) fail('Frozen queue request integrity failed')
  return frozen.wireBody
}
function continuationSelector(scope: NextTurnQueueScope, value: unknown, anchor: FrozenQueueSubmission['anchor']) {
  const item = record(value)
  const selector = { protocolVersion: 1, namespace: scope.namespace, owner: scope.owner, predecessor: anchor, turnId: identity(item.turnId),
    ...(item.childRunId === undefined ? {} : { childRunId: identity(item.childRunId) }) }
  if (!anchor || canonicalAdmissionJson(selector) !== canonicalAdmissionJson(item)) fail('Continuation does not match its exact source attempt')
  return selector
}
export function isFrozenContinuation(frozen: FrozenQueueSubmission): boolean {
  return Boolean(frozen.wireBody && record(JSON.parse(frozen.wireBody)).continuation)
}
export type ExactAdmission = { status: 'absent' } | { status: 'accepted'; root: AdmissionOutcomeRoot; receipt: QueueAdmissionReceipt }
export function parseExactContinuation(value: unknown, scope: NextTurnQueueScope, frozen: FrozenQueueSubmission): ExactAdmission {
  assertFrozenQueueRequest(scope, frozen)
  const source = record(record(JSON.parse(frozen.wireBody!)).continuation)
  const item = record(value)
  if (item.protocolVersion !== 1) fail('Continuation receipt protocol is unsupported')
  if (item.status === 'absent') {
    if (item.sessionId !== scope.taskId || item.requestKey !== frozen.requestKey || canonicalAdmissionJson(namespace(item.namespace)) !== canonicalAdmissionJson(scope.namespace)) fail('Continuation absence belongs to another scope')
    return { status: 'absent' }
  }
  if (item.status !== 'accepted') fail('Continuation result is unavailable')
  const receipt = record(item.receipt), run = record(item.run), root = parseAdmissionRoot(run)
  for (const key of ['protocolVersion', 'namespace', 'owner', 'predecessor', 'turnId', 'requestKey', 'bodyDigest'])
    if (canonicalAdmissionJson(receipt[key]) !== canonicalAdmissionJson(source[key])) fail('Continuation receipt does not match this exact request')
  if (receipt.childRunId !== source.childRunId) fail('Continuation receipt targets another child')
  if (!frozen.anchor || receipt.sessionId !== scope.taskId || run.sessionId !== scope.taskId || receipt.rootRunId !== frozen.anchor.runId ||
    root.runId !== receipt.rootRunId || root.attemptId !== receipt.attemptId || receipt.previousAttemptId !== frozen.anchor.attemptId ||
    receipt.attemptId === receipt.previousAttemptId || run.turnId !== source.turnId ||
    receipt.assistantIdentityKind !== 'continuation-segment' || receipt.assistantMessageId !== run.assistantMessageId ||
    receipt.userMessageId !== run.userMessageId || root.version < version(receipt.rootVersion)) fail('Continuation attempt/transcript identity mismatch')
  identity(receipt.assistantAnchorId)
  return { status: 'accepted', root, receipt: { runId: root.runId, turnId: identity(receipt.turnId),
    userMessageId: identity(receipt.userMessageId), assistantMessageId: identity(receipt.assistantMessageId), attemptId: root.attemptId } }
}
export function parseExactAdmission(value: unknown, scope: NextTurnQueueScope, frozen: FrozenQueueSubmission): ExactAdmission {
  const item = record(value)
  if (item.protocolVersion !== 1) fail('Receipt protocol is unsupported')
  if (item.status === 'absent') {
    if (item.sessionId !== scope.taskId || item.requestKey !== frozen.requestKey || canonicalAdmissionJson(namespace(item.namespace)) !== canonicalAdmissionJson(scope.namespace)) fail('Absence receipt belongs to another scope')
    return { status: 'absent' }
  }
  if (item.status !== 'accepted') fail('Admission result is unavailable')
  const receipt = record(item.receipt), publicRun = record(item.run), root = parseAdmissionOutcomeRoot(publicRun)
  if (receipt.protocolVersion !== 1 || receipt.owner !== scope.owner || receipt.sessionId !== scope.taskId || receipt.requestKey !== frozen.requestKey
    || receipt.bodyDigest !== frozen.bodyDigest || canonicalAdmissionJson(namespace(receipt.namespace)) !== canonicalAdmissionJson(scope.namespace)
    || canonicalAdmissionJson(receipt.predecessor) !== canonicalAdmissionJson(frozen.anchor) || receipt.rootRunId !== root.runId) fail('Accepted receipt does not match this exact submission')
  if (publicRun.sessionId !== scope.taskId || publicRun.turnId !== receipt.turnId || publicRun.userMessageId !== receipt.userMessageId) fail('Accepted root transcript scope does not match this receipt')
  const projection = record(item.projection), user = record(projection.user), assistant = record(projection.assistant)
  identity(projection.rootAttemptId)
  if (projection.rootVersion !== root.version || user.messageId !== receipt.userMessageId || !['pending', 'projected'].includes(String(user.state))
    || assistant.anchorMessageId !== receipt.assistantMessageId || !['unwritten', 'persisted'].includes(String(assistant.state))
    || (assistant.state === 'persisted' ? assistant.messageId !== identity(publicRun.assistantMessageId) : assistant.messageId !== undefined)) fail('Accepted projection does not match the observed root revision')
  return { status: 'accepted', root, receipt: { runId: root.runId, turnId: identity(receipt.turnId), userMessageId: identity(receipt.userMessageId), assistantMessageId: identity(receipt.assistantMessageId) } }
}
