import type { EngineFileChange } from '@shared/ipc'

export type WorkChangeReviewMode = 'single' | 'batch' | 'turn'
export type WorkChangeReviewAction = 'keep' | 'revert'

/** Batch decisions cover pending receipts; reverting a kept receipt is explicit. */
export function workChangeReviewTargets(sessionId: string, changes: readonly EngineFileChange[], action: WorkChangeReviewAction, mode: WorkChangeReviewMode): EngineFileChange[] {
  if (!sessionId || mode === 'turn' && action !== 'revert') return []
  const targets = changes.filter(change => (change.sessionId === sessionId || mode !== 'turn' && !change.sessionId) &&
    (change.status === 'pending' || action === 'revert' && mode !== 'batch' && change.status === 'kept'))
  // Turn cards already received individually owned receipts. A net projection's
  // changeIds can include earlier turns, so never expand it for this action.
  return mode === 'turn' ? targets.map(change => ({ ...change, changeIds: [change.id] })) : targets
}

/** A dialog cannot authorize a newly replaced record merely because its row stayed mounted. */
export function workChangeReviewIdentity(changes: readonly EngineFileChange[]): string {
  return JSON.stringify(changes.map(change => [change.id, change.changeIds, change.sessionId, change.path,
    change.kind, change.status, change.seq, change.oldHash, change.newHash, change.turnId, change.runId,
    change.toolCallId, change.requiresExplicitRevert]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
}
