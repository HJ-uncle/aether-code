import type { EngineFileChange } from '@shared/ipc'
import { sessionChangePathKey } from './file-changes'

const version = (value: string | null | undefined): string | undefined => value?.trim() || undefined
function sameBoundary(before: EngineFileChange, after: EngineFileChange): boolean {
  const left = version(before.newHash) ?? (before.kind === 'delete' ? 'missing' : undefined)
  const right = version(after.oldHash) ?? (after.isNew === true ? 'missing' : undefined)
  if (left !== undefined && right !== undefined) return left === right
  if (before.truncated || after.truncated) return false
  if (before.kind === 'delete') return after.isNew === true
  return typeof before.newContent === 'string' && typeof after.oldContent === 'string' && before.newContent === after.oldContent
}

/** A turn summary compares immutable endpoints. Never bridge a missing version,
 * another turn or an external edit just because the path is the same. */
export function turnFileChangeSummaries(sessionId: string, turnId: string, records: readonly EngineFileChange[]): EngineFileChange[] {
  if (!sessionId || !turnId || records.some(change => change.sessionId && change.sessionId !== sessionId || change.turnId && change.turnId !== turnId)) return []
  const sorted = records.filter(change => change.status !== 'reverted').sort((a, b) =>
    typeof a.seq === 'number' && typeof b.seq === 'number' && a.seq !== b.seq ? a.seq - b.seq : a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const segments: EngineFileChange[][] = []
  for (const change of sorted) {
    const current = segments.at(-1), previous = current?.at(-1)
    if (previous && sessionChangePathKey(previous.path) === sessionChangePathKey(change.path) && sameBoundary(previous, change)) current!.push(change)
    else segments.push([change])
  }
  return segments.map(changes => {
    const first = changes[0], last = changes.at(-1)!
    const missingBefore = first.oldHash === 'missing' || first.isNew === true
    const sameProducer = changes.every(change => change.producerChildSessionId === first.producerChildSessionId && change.producerRunId === first.producerRunId)
    return { ...last, id: JSON.stringify(['turn', turnId, first.id, last.id]), sessionId, turnId,
      changeIds: changes.map(change => change.id), oldContent: first.oldContent, oldHash: first.oldHash,
      producerChildSessionId: sameProducer ? first.producerChildSessionId : undefined,
      producerRunId: sameProducer ? first.producerRunId : undefined,
      isNew: last.kind === 'write' && missingBefore,
      truncated: first.truncated || last.truncated,
      status: changes.some(change => change.status === 'pending') ? 'pending' as const : 'kept' as const,
      requiresExplicitRevert: changes.some(change => change.requiresExplicitRevert),
      ...(segments.length > 1 ? { projectionIssue: 'discontinuous-history' as const } : {}) }
  }).reverse()
}
