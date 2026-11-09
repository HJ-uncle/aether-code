import { fileTreePathKey } from '../workspace/file-tree-memory'

/** Explicit opens and file decisions request a fresh read; tab switching and
 * background ledger polls retain their cache. */
const revisions = new Map<string, number>()
const sessionRevisions = new Map<string, number>()
const MAX_REVISIONS = 128
const listeners = new Set<() => void>()
let nextRevision = 0
const sessionKey = (source: number, sessionId: string | undefined) => JSON.stringify([source, sessionId])

function requestSessionPreview(source: number, sessionId: string, revision: number): void {
  const id = sessionKey(source, sessionId)
  const next = Math.max(sessionRevisions.get(id) ?? 0, revision)
  sessionRevisions.delete(id)
  sessionRevisions.set(id, next)
  if (sessionRevisions.size > MAX_REVISIONS) sessionRevisions.delete(sessionRevisions.keys().next().value!)
}

function previewPath(path: string | undefined, workspaceRoot?: string | null): string | undefined {
  if (!path) return path
  let value = path.replace(/\\/g, '/')
  if (!/^(?:[a-z]:\/|\/)/i.test(value) && workspaceRoot) value = `${workspaceRoot.replace(/\\/g, '/')}/${value}`
  const prefix = value.startsWith('//') ? '//' : value.startsWith('/') ? '/' : ''
  const parts: string[] = []
  for (const part of value.split('/')) {
    if (!part || part === '.') continue
    if (part === '..' && parts.length && parts.at(-1) !== '..' && !/^[a-z]:$/i.test(parts.at(-1)!)) parts.pop()
    else if (part !== '..' || !prefix) parts.push(part)
  }
  return fileTreePathKey(prefix + parts.join('/'))
}

const key = (source: number, sessionId: string | undefined, path: string | undefined, workspaceRoot?: string | null) =>
  JSON.stringify([source, sessionId, previewPath(path, workspaceRoot)])

/** One completion may affect several paths; publish one revision so retained
 * previews reread once even when receipts use different spellings of a path. */
export function requestWorkPreviews(source: number, sessionId: string, paths: readonly string[], workspaceRoot?: string | null): number {
  const targets = paths.filter(Boolean)
  const ids = new Set(targets.map(path => key(source, sessionId, path, workspaceRoot)))
  if (!ids.size) return nextRevision
  const revision = ++nextRevision
  // Private workspaces may report relative receipts before their root is
  // known. A bounded session revision also covers batches larger than the
  // per-path cache, without refreshing unrelated tasks or engine sources.
  if (ids.size > MAX_REVISIONS || !workspaceRoot && targets.some(path => !/^(?:[a-z]:[\\/]|[\\/])/i.test(path))) {
    requestSessionPreview(source, sessionId, revision)
  } else {
    for (const id of ids) {
      revisions.delete(id)
      revisions.set(id, revision)
      if (revisions.size > MAX_REVISIONS) {
        const oldest = revisions.keys().next().value!
        const [oldSource, oldSession] = JSON.parse(oldest) as [number, string, string]
        requestSessionPreview(oldSource, oldSession, revisions.get(oldest)!)
        revisions.delete(oldest)
      }
    }
  }
  for (const listener of listeners) listener()
  return revision
}
export function requestWorkPreview(source: number, sessionId: string, path: string, workspaceRoot?: string | null): number {
  return requestWorkPreviews(source, sessionId, [path], workspaceRoot)
}
/** Rollback can affect files not mounted in the tree and command-created
 * directories. Invalidate the entire owning session, including retained tabs. */
export function requestWorkSessionRefresh(source: number, sessionId: string): number {
  const revision = ++nextRevision
  requestSessionPreview(source, sessionId, revision)
  for (const listener of listeners) listener()
  return revision
}
export function workPreviewRevision(source: number, sessionId: string | undefined, path: string | undefined, workspaceRoot?: string | null): number {
  // Existing callers may issue an unrooted request; retain its exact-path
  // lookup while also matching relative receipts to absolute file previews.
  return Math.max(sessionRevisions.get(sessionKey(source, sessionId)) ?? 0,
    revisions.get(key(source, sessionId, path)) ?? 0, revisions.get(key(source, sessionId, path, workspaceRoot)) ?? 0)
}
export function subscribeWorkPreview(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
