/** Explicit AI opens request a fresh read, while ordinary tab switching retains its cache. */
const revisions = new Map<string, number>()
const listeners = new Set<() => void>()
let nextRevision = 0
const key = (source: number, sessionId: string | undefined, path: string | undefined) => JSON.stringify([source, sessionId, path])
export function requestWorkPreview(source: number, sessionId: string, path: string): number {
  const id = key(source, sessionId, path), revision = ++nextRevision
  revisions.delete(id)
  revisions.set(id, revision)
  if (revisions.size > 128) revisions.delete(revisions.keys().next().value!)
  for (const listener of listeners) listener()
  return revision
}
export function workPreviewRevision(source: number, sessionId: string | undefined, path: string | undefined): number {
  return revisions.get(key(source, sessionId, path)) ?? 0
}
export function subscribeWorkPreview(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
