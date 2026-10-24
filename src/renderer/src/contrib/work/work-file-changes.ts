import type { EngineFileChange } from '@shared/ipc'

/** The HTTP change log includes ownership; streamed tool receipts have a smaller shape. */
export type SessionFileChange = EngineFileChange & { sessionId: string }

/** Compare full paths, never basenames: departments may produce identically named files. */
export function workChangePathKey(value: string, root?: string | null): string {
  let path = value.replace(/\\/g, '/')
  if (!/^(?:[A-Za-z]:\/|\/)/.test(path) && root) path = `${root.replace(/\\/g, '/')}/${path}`
  const prefix = path.startsWith('//') ? '//' : path.startsWith('/') ? '/' : ''
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..' && parts.length && parts.at(-1) !== '..' && !/^[A-Za-z]:$/.test(parts.at(-1)!)) parts.pop()
    else if (part !== '..' || !prefix) parts.push(part)
  }
  const normalized = prefix + parts.join('/')
  return /^(?:[A-Za-z]:\/|\/\/)/.test(normalized) ? normalized.toLowerCase() : normalized
}

export function changesForWorkFile(changes: SessionFileChange[], sessionId: string, path: string, root?: string | null): EngineFileChange[] {
  const key = workChangePathKey(path, root)
  if (!key) return []
  return changes.filter(change => change.sessionId === sessionId && change.status === 'pending' && workChangePathKey(change.path, root) === key)
}
