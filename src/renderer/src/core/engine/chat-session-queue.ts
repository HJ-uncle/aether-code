export interface SessionQueueEntry { id: string; options: { sessionId: string } }

export interface SessionQueueSelection<T extends SessionQueueEntry> {
  sessionId: string | null
  selected: T[]
  remaining: T[]
  original: readonly T[]
}

const belongsTo = (entry: SessionQueueEntry, sessionId: string | null): boolean =>
  Boolean(sessionId) && entry.options.sessionId === sessionId
const sameEntry = (left: SessionQueueEntry, right: SessionQueueEntry): boolean =>
  left.id === right.id && left.options.sessionId === right.options.sessionId

/** A detached session keeps its draft queue, but another session cannot drain it. */
export function sessionQueue<T extends SessionQueueEntry>(entries: readonly T[], sessionId: string | null): T[] {
  return entries.filter(entry => belongsTo(entry, sessionId))
}

export function takeSessionQueue<T extends SessionQueueEntry>(entries: readonly T[], sessionId: string | null,
  mode: 'serial' | 'batch'): SessionQueueSelection<T> {
  const scoped = sessionQueue(entries, sessionId)
  const selected = mode === 'batch' ? scoped : scoped.slice(0, 1)
  const ids = new Set(selected.map(entry => entry.id))
  return { sessionId, selected, original: [...entries],
    remaining: entries.filter(entry => !belongsTo(entry, sessionId) || !ids.has(entry.id)) }
}

/** Preserve later edits/enqueues and the relative order of unrelated sessions.
 * The caller still owns its engine-source and admission guards before restoring. */
export function restoreSessionQueue<T extends SessionQueueEntry>(current: readonly T[], selection: SessionQueueSelection<T>): T[] {
  const result = [...current]
  for (const entry of selection.selected) {
    if (!belongsTo(entry, selection.sessionId) || result.some(item => sameEntry(item, entry))) continue
    const originalIndex = selection.original.findIndex(item => sameEntry(item, entry))
    const next = selection.original.slice(originalIndex + 1).find(item => result.some(candidate => sameEntry(candidate, item)))
    if (next) result.splice(result.findIndex(item => sameEntry(item, next)), 0, entry)
    else {
      const previous = selection.original.slice(0, originalIndex).reverse().find(item => result.some(candidate => sameEntry(candidate, item)))
      result.splice(previous ? result.findIndex(item => sameEntry(item, previous)) + 1 : 0, 0, entry)
    }
  }
  return result
}

export function clearSessionQueue<T extends SessionQueueEntry>(entries: readonly T[], sessionId: string | null): T[] {
  return entries.filter(entry => !belongsTo(entry, sessionId))
}

export function removeSessionQueue<T extends SessionQueueEntry>(entries: readonly T[], sessionId: string | null, id: string): T[] {
  return entries.filter(entry => !belongsTo(entry, sessionId) || entry.id !== id)
}

export function updateSessionQueue<T extends SessionQueueEntry>(entries: readonly T[], sessionId: string | null,
  id: string, update: (entry: T) => T): T[] {
  return entries.map(entry => belongsTo(entry, sessionId) && entry.id === id ? update(entry) : entry)
}

/** Drag indices belong to the visible session list, not the shared queue. */
export function moveSessionQueue<T extends SessionQueueEntry>(entries: readonly T[], sessionId: string | null,
  from: number, to: number): T[] {
  const scoped = sessionQueue(entries, sessionId)
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= scoped.length || to >= scoped.length || from === to)
    return [...entries]
  const [moved] = scoped.splice(from, 1)
  scoped.splice(to, 0, moved)
  let index = 0
  return entries.map(entry => belongsTo(entry, sessionId) ? scoped[index++] : entry)
}
