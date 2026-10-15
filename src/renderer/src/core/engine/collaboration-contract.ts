import type { EngineRequestInput } from '@shared/ipc'

export const CONTROLLER_MESSAGE_BYTES = 32768
export const CONTROLLER_OUTBOX_COUNT = 16
export const CONTROLLER_OUTBOX_BYTES = 393216
export const CONTROLLER_OUTBOX_KEY = 'aether.collaboration-controller-outbox.v1'
export const CONTROLLER_HISTORY_KEY = 'aether.collaboration-controller-results.v1'
export const CONTROLLER_HISTORY_COUNT = 64
export const CONTROLLER_HISTORY_BYTES = 2097152

export interface ControllerScope { rootRunId: string; rootAttemptId: string; rootSessionId: string }
export interface ControllerParticipant {
  participantId: string; parentParticipantId?: string; kind: 'root' | 'child'
  sessionId: string; invocationRunId: string; admittedSeq: number; admittedAt: number
}
export interface ControllerTarget { rootRunId: string; rootSessionId: string; childSessionId: string; invocationRunId: string }
export interface ControllerContext { scope: ControllerScope; recipient: ControllerParticipant }
export interface ControllerReceipt {
  messageId: string; rootRunId: string; rootAttemptId: string; senderParticipantId: string; senderInvocationRunId: string
  recipientParticipantId: string; requestKey: string; payloadHash: string; payloadBytes: number
  acceptedSeq: number; acceptedAt: number; state: 'queued' | 'rejected' | 'interrupted'; reason?: string
}
export interface ControllerPending extends ControllerScope {
  version: 1; expectedEngine: NonNullable<EngineRequestInput['expectedEngine']>; storageIdentity: string
  childSessionId: string; recipientParticipantId: string; recipientInvocationRunId: string
  requestKey: string; message: string; payloadBytes: number; createdAt: number
}
export type ControllerSavedRecord = ControllerPending & { draftDismissed?: boolean } & (
  { kind: 'accepted'; receipt: ControllerReceipt }
  | { kind: 'refused'; rejection: { code: number; message: string; recordedAt: number } }
)

export function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
export function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength }
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && utf8Bytes(value) <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
}
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function scope(value: unknown): value is ControllerScope {
  return record(value) && identifier(value.rootRunId) && identifier(value.rootAttemptId) && identifier(value.rootSessionId)
}
export function validateControllerTarget(value: ControllerTarget): void {
  if (![value.rootRunId, value.rootSessionId, value.childSessionId, value.invocationRunId].every(identifier))
    throw new Error('协作代理标识无效，请刷新代理状态')
}
export function validateControllerMessage(value: string): void {
  if (!value.trim() || utf8Bytes(value) > CONTROLLER_MESSAGE_BYTES) throw new Error('补充要求不能为空，且不能超过 32 KB')
}
export function parseControllerCapability(value: unknown): boolean {
  if (!record(value) || typeof value.userControllerMutation !== 'boolean') throw new Error('协作能力响应无效')
  return value.userControllerMutation
}
function participant(value: unknown): value is ControllerParticipant {
  return record(value) && identifier(value.participantId) && (value.parentParticipantId === undefined || identifier(value.parentParticipantId))
    && (value.kind === 'root' || value.kind === 'child') && identifier(value.sessionId) && identifier(value.invocationRunId)
    && integer(value.admittedSeq) && integer(value.admittedAt)
}
/** The exact owner lookup is authoritative even when the participant list is paginated. */
export function parseControllerContext(value: unknown, target: ControllerTarget): ControllerContext {
  validateControllerTarget(target)
  if (!record(value) || value.outcome !== 'ready' || !scope(value.scope) || !record(value.participants)
    || !Array.isArray(value.participants.entries) || value.participants.entries.length > 64
    || !value.participants.entries.every(participant) || !integer(value.participants.revision)
    || typeof value.participants.hasMore !== 'boolean'
    || (value.participants.nextCursor !== undefined && (typeof value.participants.nextCursor !== 'string' || value.participants.nextCursor.length > 8192))
    || !participant(value.recipient)) throw new Error('协作上下文响应无效，请刷新代理状态')
  const result = { scope: value.scope, recipient: value.recipient }
  if (result.scope.rootRunId !== target.rootRunId || result.scope.rootSessionId !== target.rootSessionId
    || result.recipient.kind !== 'child' || result.recipient.participantId !== `child:${target.childSessionId}`
    || result.recipient.sessionId !== target.childSessionId || result.recipient.invocationRunId !== target.invocationRunId)
    throw new Error('子代理已切换工作轮次，请刷新后重新确认补充要求')
  return result
}
/** Public receipt reads contain immutable acceptance evidence, never message bodies. */
export function parseControllerReceiptEvidence(value: unknown): ControllerReceipt {
  if (!record(value) || !identifier(value.messageId) || !identifier(value.rootRunId) || !identifier(value.rootAttemptId) || !identifier(value.senderParticipantId)
    || !identifier(value.senderInvocationRunId) || !identifier(value.recipientParticipantId) || !identifier(value.requestKey)
    || typeof value.payloadHash !== 'string' || !/^[a-f0-9]{64}$/i.test(value.payloadHash)
    || !integer(value.payloadBytes) || !integer(value.acceptedSeq) || !integer(value.acceptedAt)
    || typeof value.state !== 'string' || !['queued', 'rejected', 'interrupted'].includes(value.state)
    || (value.reason !== undefined && (typeof value.reason !== 'string' || utf8Bytes(value.reason) > 4096)))
    throw new Error('排队回执无效，已拒绝显示，请核对原记录')
  // Do not retain unknown body/detail fields from a nominally scalar receipt page.
  return { messageId: value.messageId, rootRunId: value.rootRunId, rootAttemptId: value.rootAttemptId,
    senderParticipantId: value.senderParticipantId, senderInvocationRunId: value.senderInvocationRunId,
    recipientParticipantId: value.recipientParticipantId, requestKey: value.requestKey, payloadHash: value.payloadHash,
    payloadBytes: value.payloadBytes, acceptedSeq: value.acceptedSeq, acceptedAt: value.acceptedAt,
    state: value.state as ControllerReceipt['state'], ...(typeof value.reason === 'string' ? { reason: value.reason } : {}) }
}
export function parseControllerReceipt(value: unknown, pending: ControllerPending): ControllerReceipt {
  const receipt = parseControllerReceiptEvidence(value)
  if (receipt.rootRunId !== pending.rootRunId || receipt.rootAttemptId !== pending.rootAttemptId
    || receipt.recipientParticipantId !== pending.recipientParticipantId || receipt.requestKey !== pending.requestKey
    || receipt.payloadBytes !== pending.payloadBytes)
    throw new Error('排队回执与原请求不符，已保留原要求，请核对结果')
  return receipt
}

export function controllerConnectionIdentity(value: NonNullable<EngineRequestInput['expectedEngine']>): string {
  return JSON.stringify([value.mode, value.baseUrl.replace(/\/+$/, ''), value.instanceId ?? null, value.accountId ?? null])
}
export function controllerStorageIdentity(value: NonNullable<EngineRequestInput['expectedEngine']>): string {
  return JSON.stringify([value.mode, value.mode === 'embedded' ? '' : value.baseUrl.replace(/\/+$/, ''), value.accountId ?? null])
}
export function parseControllerPending(value: unknown): ControllerPending {
  if (!record(value) || value.version !== 1 || !scope(value) || !record(value.expectedEngine)
    || (value.expectedEngine.mode !== 'embedded' && value.expectedEngine.mode !== 'remote')
    || typeof value.expectedEngine.baseUrl !== 'string' || value.expectedEngine.baseUrl.length > 4096
    || (value.expectedEngine.instanceId !== undefined && !identifier(value.expectedEngine.instanceId))
    || (value.expectedEngine.accountId !== undefined && value.expectedEngine.accountId !== null && !identifier(value.expectedEngine.accountId))
    || !identifier(value.childSessionId) || value.recipientParticipantId !== `child:${value.childSessionId}`
    || !identifier(value.recipientParticipantId) || !identifier(value.recipientInvocationRunId) || !identifier(value.requestKey)
    || typeof value.message !== 'string' || !value.message.trim() || utf8Bytes(value.message) > CONTROLLER_MESSAGE_BYTES
    || value.payloadBytes !== utf8Bytes(value.message) || !integer(value.createdAt)
    || !value.expectedEngine.instanceId) throw new Error('待核对记录损坏；为避免重复发送，暂时不能提交新的补充要求')
  const pending = value as unknown as ControllerPending
  if (pending.storageIdentity !== controllerStorageIdentity(pending.expectedEngine)) throw new Error('待核对记录所属连接无效')
  return pending
}
export function parseControllerOutbox(raw: string | null): ControllerPending[] {
  if (raw === null) return []
  if (utf8Bytes(raw) > CONTROLLER_OUTBOX_BYTES) throw new Error('待核对记录已超出本地容量，请先处理已有记录')
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value) || value.length > CONTROLLER_OUTBOX_COUNT) throw new Error('待核对记录格式或数量无效')
  const result = value.map(parseControllerPending)
  if (new Set(result.map(item => item.requestKey)).size !== result.length) throw new Error('待核对记录存在重复标识')
  return result
}
export function appendControllerPending(records: ControllerPending[], pending: ControllerPending): ControllerPending[] {
  parseControllerPending(pending)
  const existing = records.find(item => item.requestKey === pending.requestKey)
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(pending)) throw new Error('不能修改已冻结的补充要求')
    return records
  }
  const next = [...records, pending]
  parseControllerOutbox(JSON.stringify(next))
  return next
}

/** Known results keep their original text and scope separately from ambiguous
 * sends. A queued ACK is not evidence that the child has consumed the message. */
export function parseControllerHistory(raw: string | null): ControllerSavedRecord[] {
  if (raw === null) return []
  if (utf8Bytes(raw) > CONTROLLER_HISTORY_BYTES) throw new Error('补充要求记录已超出本地容量，请先手动清理已有记录')
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value) || value.length > CONTROLLER_HISTORY_COUNT) throw new Error('补充要求记录格式或数量无效，请先手动清理已有记录')
  const records = value.map((item: unknown): ControllerSavedRecord => {
    const pending = parseControllerPending(item)
    if (!record(item) || (item.draftDismissed !== undefined && typeof item.draftDismissed !== 'boolean')) throw new Error('补充要求记录无效')
    if (item.kind === 'accepted') return { ...pending, kind: 'accepted', receipt: parseControllerReceipt(item.receipt, pending) }
    if (item.kind === 'refused' && record(item.rejection) && typeof item.rejection.code === 'number'
      && [400, 403, 404, 409, 413, 429].includes(item.rejection.code) && typeof item.rejection.message === 'string'
      && utf8Bytes(item.rejection.message) <= 4096 && integer(item.rejection.recordedAt))
      return { ...pending, kind: 'refused', rejection: { code: item.rejection.code, message: item.rejection.message, recordedAt: item.rejection.recordedAt } }
    throw new Error('补充要求记录的结果无效')
  })
  if (new Set(records.map(item => item.requestKey)).size !== records.length) throw new Error('补充要求记录存在重复标识')
  return records
}

export function sameControllerPending(a: ControllerPending, b: ControllerPending): boolean {
  return controllerConnectionIdentity(a.expectedEngine) === controllerConnectionIdentity(b.expectedEngine)
    && (['version', 'storageIdentity', 'rootRunId', 'rootAttemptId', 'rootSessionId', 'childSessionId', 'recipientParticipantId',
      'recipientInvocationRunId', 'requestKey', 'message', 'payloadBytes', 'createdAt'] as const).every(key => a[key] === b[key])
}
/** A late queued response must never roll back a terminal result learned by a
 * different window. The accepted identity itself cannot change under one key. */
export function mergeControllerSaved(previous: ControllerSavedRecord, next: ControllerSavedRecord): ControllerSavedRecord {
  if (!sameControllerPending(previous, next) || previous.kind !== next.kind) throw new Error('原补充要求的结果身份已变化，请保留记录核对')
  if (previous.kind === 'refused' || next.kind === 'refused') {
    if (JSON.stringify(previous) !== JSON.stringify(next)) throw new Error('原拒绝记录已变化，请保留记录核对')
    return previous
  }
  const a = previous.receipt, b = next.receipt
  if ((['messageId', 'rootRunId', 'rootAttemptId', 'senderParticipantId', 'senderInvocationRunId', 'recipientParticipantId',
    'requestKey', 'payloadHash', 'payloadBytes', 'acceptedSeq', 'acceptedAt'] as const).some(key => a[key] !== b[key]))
    throw new Error('原排队回执的身份已变化，请保留记录核对')
  if (a.state !== 'queued') {
    if (b.state === 'queued') return previous
    if (a.state !== b.state || a.reason !== b.reason) throw new Error('原补充要求出现不一致的结束结果，请保留记录核对')
    return previous
  }
  return previous.draftDismissed ? { ...next, draftDismissed: true } : next
}
export function isControllerDraft(record: ControllerSavedRecord): boolean { return !record.draftDismissed && (record.kind === 'refused' || record.receipt.state !== 'queued') }
export function controllerSavedStatus(record: ControllerSavedRecord): string {
  if (record.kind === 'refused') return '未被接纳，原文已保留'
  if (record.receipt.state === 'queued') return '已接纳（不代表已执行）'
  if (record.receipt.state === 'interrupted') return record.receipt.reason === 'target_invocation_finished_before_consumption'
    ? '本轮结束前未读取，原文已保留' : '已中断，未确认执行；原文已保留'
  return '未被接受，原文已保留'
}
