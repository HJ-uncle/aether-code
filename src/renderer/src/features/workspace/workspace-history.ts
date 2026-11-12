import { sessionStorageKey } from '@renderer/core/engine/source'
import { hasEncodedPathTraversal } from '@shared/path-safety'
import type { SessionTask } from '../sessions/state'

export interface SessionWorkspaceHistoryEntry { path: string; updatedAt: number }
export const SESSION_WORKSPACE_HISTORY_KEY = 'aether.work.workspace-history.v1'
const HISTORY_LIMIT = 30

/** Validate the stored spelling before any bridge or authenticated binding sees it. */
export function validSessionWorkspacePath(path: string): boolean {
  return Boolean(path && path === path.trim() && /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/.test(path)
    && !/[\u0000-\u001f\u007f]/.test(path) && !hasEncodedPathTraversal(path)
    && !path.replace(/\\/g, '/').split('/').some(part => part === '.' || part === '..'))
}

export function sessionWorkspacePathKey(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return /^(?:[A-Za-z]:|\/\/)/.test(normalized) ? normalized.toLowerCase() : normalized
}

/** Generated task sandboxes are not projects the user deliberately picked. */
export function isSessionScratchPath(path: string): boolean {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean)
  const name = segments.at(-1) ?? ''
  return /^work-(?:home-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)
}

export function readSessionWorkspaceHistory(source: string): SessionWorkspaceHistoryEntry[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(sessionStorageKey(SESSION_WORKSPACE_HISTORY_KEY, source)) ?? '[]')
    if (!Array.isArray(value)) return []
    return mergeSessionWorkspaceHistory(value.flatMap(item => item && typeof item === 'object'
      && typeof item.path === 'string' && typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt)
      ? [{ path: item.path, updatedAt: item.updatedAt }] : []))
  } catch { return [] }
}

export function mergeSessionWorkspaceHistory(entries: readonly SessionWorkspaceHistoryEntry[]): SessionWorkspaceHistoryEntry[] {
  const paths = new Map<string, SessionWorkspaceHistoryEntry>()
  for (const entry of entries) {
    if (!validSessionWorkspacePath(entry.path) || isSessionScratchPath(entry.path) || !Number.isFinite(entry.updatedAt)) continue
    const key = sessionWorkspacePathKey(entry.path)
    if (!paths.has(key) || paths.get(key)!.updatedAt < entry.updatedAt) paths.set(key, entry)
  }
  return [...paths.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path)).slice(0, HISTORY_LIMIT)
}

export function rememberSessionWorkspace(source: string, path: string): void {
  const entries = mergeSessionWorkspaceHistory([{ path, updatedAt: Date.now() }, ...readSessionWorkspaceHistory(source)])
  try { localStorage.setItem(sessionStorageKey(SESSION_WORKSPACE_HISTORY_KEY, source), JSON.stringify(entries)) }
  catch { /* A full preferences store must not prevent using a selected directory. */ }
}

export function sessionWorkspaceChoices(source: string, tasks: readonly SessionTask[], currentPath: string | null, configuredPath?: string): SessionWorkspaceHistoryEntry[] {
  return mergeSessionWorkspaceHistory([
    ...readSessionWorkspaceHistory(source),
    ...tasks.flatMap(task => task.workspacePath ? [{ path: task.workspacePath, updatedAt: task.updatedAt }] : []),
    ...(currentPath ? [{ path: currentPath, updatedAt: 0 }] : []),
    ...(configuredPath ? [{ path: configuredPath, updatedAt: 0 }] : []),
  ])
}
