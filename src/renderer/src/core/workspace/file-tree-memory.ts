import type { FsEntry } from '@shared/ipc'

export const FILE_TREE_MEMORY_KEY = 'aether.fileTreeMemory.v1'

export interface FileTreeScope { key: string; root: string }
export interface FileTreeMemory {
  expanded: string[]
  selection: string[]
  cursorPath: string | null
  activeFilePath: string | null
  scrollTop: number
  scrollLeft: number
  filter: string
}
export interface TreeMemoryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}
const memoryListeners = new Set<(key: string) => void>()
export function onFileTreeMemoryChanged(listener: (key: string) => void): () => void {
  memoryListeners.add(listener)
  return () => { memoryListeners.delete(listener) }
}

/** Preserve POSIX case and UNC prefixes; only Windows paths ignore case. */
export function fileTreePathKey(path: string): string {
  const slash = path.replace(/\\/g, '/')
  const prefix = slash.startsWith('//') ? '//' : ''
  const normalized = `${prefix}${slash.slice(prefix.length).replace(/\/{2,}/g, '/')}`.replace(/\/+$/, '') || '/'
  return /^(?:[A-Za-z]:|\/\/)/.test(normalized) ? normalized.toLowerCase() : normalized
}

export function isFileTreePathWithin(root: string, candidate: string): boolean {
  if (candidate.replace(/\\/g, '/').split('/').some(part => part === '.' || part === '..')) return false
  const base = fileTreePathKey(root), path = fileTreePathKey(candidate)
  return path === base || (base === '/' ? path.startsWith('/') && !path.startsWith('//') : path.startsWith(`${base}/`))
}

/** Runtime generations expire on reconnect. Preferences belong to the stable
 * engine/account, session and actual root, independently of the Code selection. */
export function createFileTreeScope(mode: 'code' | 'work', source: string, sessionId: string, root: string): FileTreeScope {
  return { key: JSON.stringify([mode, source, sessionId, fileTreePathKey(root)]), root }
}

function defaultMemory(root: string): FileTreeMemory {
  return { expanded: [root], selection: [], cursorPath: null, activeFilePath: null, scrollTop: 0, scrollLeft: 0, filter: '' }
}

function sanitizeMemory(scope: FileTreeScope, raw: unknown): FileTreeMemory {
  const fallback = defaultMemory(scope.root)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback
  const value = raw as Record<string, unknown>
  const path = (candidate: unknown): string | null => {
    if (typeof candidate !== 'string' || !candidate.length || !isFileTreePathWithin(scope.root, candidate)) return null
    // Windows directory entries use forward slashes even when the binding root
    // uses backslashes. Deduplication must never replace the actual root with
    // its alias when a child directory adds its ancestor chain.
    return fileTreePathKey(candidate) === fileTreePathKey(scope.root) ? scope.root : candidate
  }
  const paths = (items: unknown, defaults: string[]): string[] => Array.isArray(items)
    ? [...new Map(items.flatMap(item => { const valid = path(item); return valid ? [[fileTreePathKey(valid), valid] as const] : [] })).values()]
    : defaults
  const offset = (candidate: unknown): number => typeof candidate === 'number' && Number.isFinite(candidate) ? Math.max(0, candidate) : 0
  return {
    expanded: paths(value.expanded, fallback.expanded), selection: paths(value.selection, []),
    cursorPath: path(value.cursorPath), activeFilePath: path(value.activeFilePath),
    scrollTop: offset(value.scrollTop), scrollLeft: offset(value.scrollLeft),
    filter: typeof value.filter === 'string' ? value.filter : ''
  }
}

function browserStorage(): TreeMemoryStorage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage } catch { return undefined }
}

function readTable(storage?: TreeMemoryStorage): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(FILE_TREE_MEMORY_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}

export function readFileTreeMemory(scope: FileTreeScope, storage = browserStorage()): FileTreeMemory {
  return sanitizeMemory(scope, readTable(storage)[scope.key])
}

export function writeFileTreeMemory(scope: FileTreeScope, patch: Partial<FileTreeMemory>, storage = browserStorage()): FileTreeMemory {
  const table = readTable(storage)
  const next = sanitizeMemory(scope, { ...sanitizeMemory(scope, table[scope.key]), ...patch })
  delete table[scope.key]
  table[scope.key] = next
  // Keep recent scopes bounded without ever rewriting Code's legacy expandedDirs.
  for (const key of Object.keys(table).slice(0, Math.max(0, Object.keys(table).length - 80))) delete table[key]
  try { storage?.setItem(FILE_TREE_MEMORY_KEY, JSON.stringify(table)) } catch { /* A full/disabled store must not block browsing. */ }
  for (const listener of memoryListeners) listener(scope.key)
  return next
}

/** Both explorers restore parent-first from real directory entries. A saved
 * path is a preference, never authority to read a deleted or unrelated path. */
export async function restoreFileTreeExpansion({ root, expanded, rootEntries, readChildren, current = () => true, keepRootExpanded = true }: {
  root: string
  expanded: readonly string[]
  rootEntries: readonly FsEntry[] | null
  readChildren: (directory: string) => Promise<readonly FsEntry[] | null>
  current?: () => boolean
  keepRootExpanded?: boolean
}): Promise<Set<string>> {
  const rootKey = fileTreePathKey(root)
  const rootExpanded = keepRootExpanded || expanded.some(path => fileTreePathKey(path) === rootKey)
  const restored = new Set<string>(rootExpanded ? [root] : [])
  const candidates = [...new Map(expanded.filter(path => isFileTreePathWithin(root, path)).map(path => [fileTreePathKey(path), path])).values()]
    .filter(path => fileTreePathKey(path) !== rootKey)
    .sort((left, right) => left.replace(/\\/g, '/').split('/').length - right.replace(/\\/g, '/').split('/').length)
  if (!rootExpanded || !current()) return restored
  if (!rootEntries) return new Set([...restored, ...candidates])
  const loaded = new Map<string, readonly FsEntry[]>([[rootKey, rootEntries]])
  const unavailable = new Set<string>()
  for (const candidate of candidates) {
    if (!current()) break
    const key = fileTreePathKey(candidate)
    const parentKey = key.slice(0, key.lastIndexOf('/')) || '/'
    // A failed read says nothing about whether a descendant was deleted. Keep
    // its preference, but never authorize another read from that preference.
    if (unavailable.has(parentKey)) {
      restored.add(candidate)
      unavailable.add(key)
      continue
    }
    const entry = loaded.get(parentKey)?.find(item => item.isDirectory && fileTreePathKey(item.path) === key)
    if (!entry) continue
    const children = await readChildren(entry.path)
    if (!current()) break
    restored.add(entry.path)
    if (!children) { unavailable.add(key); continue }
    loaded.set(key, children)
  }
  return restored
}
