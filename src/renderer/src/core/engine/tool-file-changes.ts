import type { EngineFileChange } from '@shared/ipc'

/** One command can create many files. Preserve all receipts, while retaining the legacy primary change. */
export function mergeFileChanges(...values: unknown[]): EngineFileChange[] {
  const changes = new Map<string, EngineFileChange>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return }
    if (!value || typeof value !== 'object') return
    const item = value as Partial<EngineFileChange>
    if (typeof item.id !== 'string' || !item.id || typeof item.path !== 'string' || !item.path ||
      !['write', 'delete'].includes(item.kind ?? '') || !['pending', 'kept', 'reverted'].includes(item.status ?? '') ||
      typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt)) return
    const previous = changes.get(item.id)
    if (previous && (previous.path !== item.path || previous.kind !== item.kind ||
      (previous.sessionId && item.sessionId && previous.sessionId !== item.sessionId))) return
    // Late job snapshots carry pending receipts; they cannot undo an acknowledged decision.
    const status = previous && previous.status !== 'pending' && item.status === 'pending' ? previous.status : item.status
    changes.set(item.id, { ...previous, ...item, status, oldContent: item.oldContent ?? previous?.oldContent ?? null,
      newContent: item.newContent ?? previous?.newContent ?? null,
      truncated: previous?.truncated === false ? false : item.truncated ?? previous?.truncated ?? true } as EngineFileChange)
  }
  for (const value of values) visit(value)
  return [...changes.values()]
}
