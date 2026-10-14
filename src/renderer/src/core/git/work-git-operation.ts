import type { GitResult } from '@shared/git-types'
import type { GitRepositoryOperation, GitRepositorySnapshot } from './git-repository-operation'

export interface WorkGitOperation {
  readonly owner: string
  readonly kind: 'mutation' | 'suggestion'
  readonly remoteAction?: 'fetch' | 'pull' | 'push' | 'publish'
  readonly startedAt: number
}
const pending = new Map<string, WorkGitOperation>()
const listeners = new Map<string, Set<() => void>>()
const completionListeners = new Map<string, Set<(message: string) => void>>()
export interface WorkGitDraft {
  readonly message: string
  readonly proposal: string
  readonly revision: number
}
interface OwnerRecord {
  touched: number
  draft: WorkGitDraft
  controller: GitRepositoryOperation | null
  unsubscribe?: () => void
}
const EMPTY_DRAFT: WorkGitDraft = Object.freeze({ message: '', proposal: '', revision: 0 })
const records = new Map<string, OwnerRecord>()
const MAX_INACTIVE_OWNERS = 64
let sequence = 0
function prune(): void {
  const inactive = [...records].filter(([owner, record]) => !pending.has(owner)
    && !listeners.get(owner)?.size && !completionListeners.get(owner)?.size
    && !record.controller?.getSnapshot().pending && record.controller?.getSnapshot().phase !== 'running')
    .sort((a, b) => a[1].touched - b[1].touched)
  for (const [owner, record] of inactive.slice(0, Math.max(0, inactive.length - MAX_INACTIVE_OWNERS))) {
    record.unsubscribe?.(); records.delete(owner)
  }
}
function recordFor(owner: string): OwnerRecord {
  let record = records.get(owner)
  if (!record) { record = { touched: ++sequence, draft: EMPTY_DRAFT, controller: null }; records.set(owner, record) }
  else record.touched = ++sequence
  return record
}
export function getWorkGitDraft(owner: string): WorkGitDraft { return records.get(owner)?.draft ?? EMPTY_DRAFT }
export function editWorkGitDraft(owner: string, message: string): void {
  const record = recordFor(owner)
  record.draft = Object.freeze({ ...record.draft, message, revision: record.draft.revision + 1 })
  notify(owner); prune()
}
export function setWorkGitProposal(owner: string, proposal: string): void {
  const record = recordFor(owner)
  record.draft = Object.freeze({ ...record.draft, proposal }); notify(owner); prune()
}
/** A completed old command can clear only the draft revision it captured. */
export function clearWorkGitDraft(owner: string, revision: number): void {
  if (getWorkGitDraft(owner).revision !== revision) return
  editWorkGitDraft(owner, ''); setWorkGitProposal(owner, '')
}
export function publishWorkGitSuccess(owner: string, message: string): void {
  for (const listener of completionListeners.get(owner) ?? []) {
    try { listener(message) } catch { /* A view cannot change an already completed Git effect. */ }
  }
}
export function subscribeWorkGitSuccess(owner: string, listener: (message: string) => void): () => void {
  const subscribers = completionListeners.get(owner) ?? new Set<(message: string) => void>()
  subscribers.add(listener); completionListeners.set(owner, subscribers)
  return () => { subscribers.delete(listener); if (!subscribers.size) completionListeners.delete(owner); prune() }
}
export function getWorkGitRepositoryOperation(owner: string): GitRepositoryOperation | null { return records.get(owner)?.controller ?? null }
export function workGitOwnerKey(source: number, sessionId: string | null | undefined, cwd: string | null | undefined): string {
  return JSON.stringify([source, sessionId ?? '', cwd ?? ''])
}
export function getWorkGitOperation(owner: string): WorkGitOperation | undefined { return pending.get(owner) }
function notify(owner: string): void { for (const listener of listeners.get(owner) ?? []) listener() }
export function subscribeWorkGitOperation(owner: string, listener: () => void): () => void {
  const subscribers = listeners.get(owner) ?? new Set<() => void>()
  subscribers.add(listener); listeners.set(owner, subscribers)
  return () => { subscribers.delete(listener); if (!subscribers.size) listeners.delete(owner); prune() }
}
/** Effects belong to a task rather than a mounted view. Hide/remount and A→B→A
 * must keep the reservation until its original asynchronous work settles. */
export function beginWorkGitOperation(owner: string, kind: WorkGitOperation['kind'], remoteAction?: WorkGitOperation['remoteAction']): WorkGitOperation | undefined {
  if (pending.has(owner)) return undefined
  const operation = Object.freeze({ owner, kind, remoteAction, startedAt: Date.now() })
  pending.set(owner, operation); notify(owner); return operation
}
export function finishWorkGitOperation(operation: WorkGitOperation): void {
  if (pending.get(operation.owner) !== operation) return
  pending.delete(operation.owner); notify(operation.owner); prune()
}
/** Retained controllers keep the frozen target/command but never a mounted view.
 * Every recovery action owns the same reservation as ordinary writes and AI. */
export function retainWorkGitRepositoryOperation(
  owner: string,
  controller: GitRepositoryOperation,
  initialReservation: WorkGitOperation
): GitRepositoryOperation {
  if (initialReservation.owner !== owner || pending.get(owner) !== initialReservation)
    throw new Error('Git 操作不属于当前任务预约')
  const record = recordFor(owner)
  record.unsubscribe?.()
  let cached: GitRepositorySnapshot = controller.getSnapshot(), observed = cached, observedPending: WorkGitOperation | undefined
  const getSnapshot = (): GitRepositorySnapshot => {
    const value = controller.getSnapshot(), external = pending.get(owner)
    if (observed !== value || observedPending !== external) {
      observed = value; observedPending = external
      cached = external && !value.pending ? Object.freeze({ ...value, pending: 'check', retryAllowed: false }) : value
    }
    return cached
  }
  const exclusive = async <T>(action: () => Promise<T>, blocked: T, initial?: WorkGitOperation): Promise<T> => {
    const reservation = initial && pending.get(owner) === initial
      ? initial : initial ? undefined : beginWorkGitOperation(owner, 'mutation', initialReservation.remoteAction)
    if (!reservation) return blocked
    try { return await action() }
    finally { finishWorkGitOperation(reservation) }
  }
  const wrapper: GitRepositoryOperation = Object.freeze({
    target: controller.target,
    getSnapshot,
    subscribe: (listener: () => void) => {
      const detachController = controller.subscribe(listener), detachOwner = subscribeWorkGitOperation(owner, listener)
      return () => { detachController(); detachOwner() }
    },
    start: () => exclusive(() => controller.start(), { success: false, error: '原任务的 Git 操作预约已结束' } as GitResult, initialReservation),
    inspect: () => exclusive(() => controller.inspect(), undefined),
    recover: () => exclusive(() => controller.recover(), undefined),
    retry: () => exclusive(() => controller.retry(), { success: false, error: '当前任务还有 Git 操作或 AI 建议正在处理' } as GitResult)
  })
  record.controller = wrapper
  record.unsubscribe = controller.subscribe(() => { if (records.get(owner)?.controller === wrapper) { record.touched = ++sequence; notify(owner); prune() } })
  notify(owner); prune()
  return wrapper
}
