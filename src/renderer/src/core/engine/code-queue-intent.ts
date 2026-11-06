import type { CodeQueueAction } from '@shared/code-next-turn-api'
import type { NextTurnQueueScope } from '@shared/next-turn-queue'
import { assertQueueJsonValue, assertQueueScope, queueScopeIdentity, sameQueueScope } from '@shared/next-turn-queue-state'

export type CodeQueueCommand = Extract<CodeQueueAction, { operationId: string }>
export interface CodeQueueIntent {
  version: 1
  scope: NextTurnQueueScope
  action: CodeQueueCommand
  status: 'pending' | 'rejected' | 'confirmed'
  createdAt: number
  rejection?: { code: string; message: string }
  confirmation?: { operationId: string; revision: number }
}
type StoragePort = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>
const prefix = (scope: NextTurnQueueScope) => 'aether.code-queue-command.v1:' + queueScopeIdentity(scope) + ':'
const key = (intent: CodeQueueIntent) => prefix(intent.scope) + intent.action.operationId
const definiteRejection = new Set(['INVALID', 'CAS', 'CAPACITY', 'CONFLICT', 'SCOPE'])
export const isQueueCommand = (action: CodeQueueAction): action is CodeQueueCommand => 'operationId' in action

/** Each operation owns a separate key: a late ACK can never erase a newer command. */
export function readCodeQueueIntents(storage: StoragePort, scope: NextTurnQueueScope): CodeQueueIntent[] {
  const result: CodeQueueIntent[] = [], starts = prefix(scope)
  for (let index = 0; index < storage.length; index++) {
    const name = storage.key(index)
    if (!name?.startsWith(starts)) continue
    const raw = storage.getItem(name)
    if (!raw) continue
    let intent: CodeQueueIntent
    try {
      intent = JSON.parse(raw); assertQueueJsonValue(intent); assertQueueScope(intent.scope)
      if (intent.version !== 1 || intent.scope.owner !== 'code' || !sameQueueScope(intent.scope, scope) || !isQueueCommand(intent.action)
        || !intent.action.operationId || !Number.isSafeInteger(intent.action.expectedRevision) || intent.action.expectedRevision < 0
        || !['pending', 'rejected', 'confirmed'].includes(intent.status) || !Number.isSafeInteger(intent.createdAt) || key(intent) !== name) throw new Error('invalid command')
      if (intent.status === 'confirmed' && (intent.action.kind !== 'enqueue' || intent.confirmation?.operationId !== intent.action.operationId
        || intent.confirmation?.revision !== intent.action.expectedRevision + 1)) throw new Error('invalid acknowledgement')
    } catch { throw new Error('待发操作的本地恢复记录损坏，原记录已保留，请核对队列后再操作') }
    result.push(intent)
  }
  return result.sort((a, b) => a.action.expectedRevision - b.action.expectedRevision || a.createdAt - b.createdAt)
}
export function saveCodeQueueIntent(storage: StoragePort, scope: NextTurnQueueScope, action: CodeQueueCommand): CodeQueueIntent {
  const records = readCodeQueueIntents(storage, scope)
  const previous = records.find(intent => intent.status === 'pending')
  if (previous) {
    if (JSON.stringify(previous.action) === JSON.stringify(action)) return previous
    throw new Error('上一项队列操作尚未确认，请先核对原请求；本次内容已保留')
  }
  const intent: CodeQueueIntent = { version: 1, scope: structuredClone(scope), action: structuredClone(action), status: 'pending', createdAt: Date.now() }
  assertQueueJsonValue(intent)
  // Storage failure must happen before the first IPC mutation.
  storage.setItem(key(intent), JSON.stringify(intent))
  // Only a durably saved, newer authored draft can retire its predecessors.
  // Keep the ACK through composer clearing/reloads; matching it is read-only.
  if (action.kind === 'enqueue') for (const record of records) {
    if (record.status === 'confirmed' && record.action.kind === 'enqueue'
      && record.action.submission.draft.revision < action.submission.draft.revision
      && storage.getItem(key(record)) === JSON.stringify(record)) storage.removeItem(key(record))
  }
  return intent
}
export function acknowledgeCodeQueueIntent(storage: StoragePort, intent: CodeQueueIntent, result: unknown): void {
  const receipt = result && typeof result === 'object' && 'receipt' in result ? result.receipt : null
  if (!receipt || typeof receipt !== 'object' || !('operationId' in receipt) || receipt.operationId !== intent.action.operationId
    || !('revision' in receipt) || receipt.revision !== intent.action.expectedRevision + 1) throw new Error('队列提交回执不完整，原操作已保留，等待准确核对')
  if (storage.getItem(key(intent)) !== JSON.stringify(intent)) return
  if (intent.action.kind === 'enqueue') storage.setItem(key(intent), JSON.stringify({ ...intent, status: 'confirmed',
    confirmation: { operationId: receipt.operationId, revision: receipt.revision } }))
  else storage.removeItem(key(intent))
}
/** Match an acknowledged enqueue without deleting it: a crash may occur before
 * the composer clears. A new authored revision is a distinct intent. */
export function consumeCodeQueueEnqueueReceipt(storage: StoragePort, scope: NextTurnQueueScope, submission: Extract<CodeQueueCommand, { kind: 'enqueue' }>['submission']): boolean {
  const intent = readCodeQueueIntents(storage, scope).find(item => item.status === 'confirmed' && item.action.kind === 'enqueue'
    && JSON.stringify(item.action.submission) === JSON.stringify(submission))
  if (!intent || storage.getItem(key(intent)) !== JSON.stringify(intent)) return false
  return true
}
export function rejectCodeQueueIntent(storage: StoragePort, intent: CodeQueueIntent, cause: unknown): boolean {
  const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : ''
  if (!definiteRejection.has(code)) return false
  if (storage.getItem(key(intent)) === JSON.stringify(intent)) storage.setItem(key(intent), JSON.stringify({ ...intent, status: 'rejected',
    rejection: { code, message: cause instanceof Error ? cause.message : '操作未提交' } }))
  return true
}
/** Only an explicit noncommit CAS permits changing the revision of an append.
 * Persist the rebased identity before IPC so a lost ACK/reload replays that revision. */
export function rebaseCodeQueueEnqueueIntent(storage: StoragePort, intent: CodeQueueIntent, expectedRevision: number): CodeQueueIntent {
  const records = readCodeQueueIntents(storage, intent.scope), current = records.find(record => record.action.operationId === intent.action.operationId)
  if (intent.action.kind !== 'enqueue' || !current || current.status !== 'rejected' || current.rejection?.code !== 'CAS'
    || JSON.stringify(current.action) !== JSON.stringify(intent.action) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new Error('原入队操作尚未确认未提交，不能自动重试，草稿已保留')
  if (records.some(record => record.status === 'pending')) throw new Error('另一项队列操作尚未确认，原稿已保留')
  const next: CodeQueueIntent = { version: 1, scope: structuredClone(intent.scope),
    action: { ...structuredClone(intent.action), expectedRevision }, status: 'pending', createdAt: intent.createdAt }
  assertQueueJsonValue(next)
  storage.setItem(key(next), JSON.stringify(next))
  return next
}
export function sameCodeQueueIntent(left: CodeQueueCommand, right: CodeQueueCommand): boolean {
  const content = (action: CodeQueueCommand) => {
    const { operationId: _operation, expectedRevision: _revision, ...value } = action
    if (value.kind === 'enqueue' || value.kind === 'merge-pending') { const { id: _id, ...rest } = value; return rest }
    return value
  }
  return JSON.stringify(content(left)) === JSON.stringify(content(right))
}
