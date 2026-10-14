import type { PublishedChildReference } from '@shared/published-child'
import type { SubagentRun } from '@shared/subagent'

export const PUBLISHED_VISIBLE_CARDS = 64
const MAX_DETAIL_BYTES = 8 * 1024 * 1024
const size = (value: SubagentRun): number => new TextEncoder().encode(JSON.stringify(value)).byteLength

export function publishedDetailKey(reference: PublishedChildReference): string {
  return JSON.stringify([reference.source, reference.sessionId, reference.snapshotId, reference.fence,
    reference.identity, reference.atSeq])
}

/** A loaded detail is optional; a different lease or watermark cannot reuse it. */
export function rememberPublishedDetail(previous: ReadonlyMap<string, SubagentRun>, run: SubagentRun,
  reference: PublishedChildReference, scope: { source: number; sessionId: string | null }): Map<string, SubagentRun> {
  const next = new Map(previous)
  if (reference.source !== scope.source || reference.sessionId !== scope.sessionId || run.lastSeq !== reference.atSeq ||
    Object.entries(reference.identity).some(([key, value]) => run[key as keyof SubagentRun] !== value)) return next
  const key = publishedDetailKey(reference)
  next.delete(key); next.set(key, run)
  let bytes = 0
  for (const value of next.values()) bytes += size(value)
  while (next.size > PUBLISHED_VISIBLE_CARDS || bytes > MAX_DETAIL_BYTES) {
    const oldest = next.keys().next().value
    if (!oldest) break
    bytes -= size(next.get(oldest)!); next.delete(oldest)
  }
  return next
}

export function publishedVisibleWindow<T>(items: readonly T[], requestedEnd: number): { items: T[]; start: number; end: number } {
  const end = Math.max(PUBLISHED_VISIBLE_CARDS, Math.ceil(requestedEnd / PUBLISHED_VISIBLE_CARDS) * PUBLISHED_VISIBLE_CARDS)
  const start = Math.min(Math.max(0, end - PUBLISHED_VISIBLE_CARDS), Math.floor(Math.max(0, items.length - 1) / PUBLISHED_VISIBLE_CARDS) * PUBLISHED_VISIBLE_CARDS)
  return { items: items.slice(start, start + PUBLISHED_VISIBLE_CARDS), start, end: Math.min(items.length, start + PUBLISHED_VISIBLE_CARDS) }
}
