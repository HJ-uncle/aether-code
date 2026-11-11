import { sessionStorageKey } from '@renderer/core/engine/source'
import { hasEncodedPathTraversal } from '@shared/path-safety'
import type { WorkTask } from './work-state'

export interface WorkWorkspaceHistoryEntry { path: string; updatedAt: number }
export const WORK_WORKSPACE_HISTORY_KEY = 'aether.work.workspace-history.v1'
const HISTORY_LIMIT = 30

/** Validate the stored spelling before any bridge or authenticated binding sees it. */
export function validWorkWorkspacePath(path: string): boolean {
  return Boolean(path && path === path.trim() && /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/.test(path)
    && !/[\u0000-\u001f\u007f]/.test(path) && !hasEncodedPathTraversal(path)
    && !path.replace(/\\/g, '/').split('/').some(part => part === '.' || part === '..'))
}

export function workWorkspacePathKey(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return /^(?:[A-Za-z]:|\/\/)/.test(normalized) ? normalized.toLowerCase() : normalized
}

/** Generated task sandboxes are not projects the user deliberately picked. */
export function isWorkScratchPath(path: string): boolean {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean)
  const name = segments.at(-1) ?? ''
  return /^work-(?:home-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)
}

export function readWorkWorkspaceHistory(source: string): WorkWorkspaceHistoryEntry[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(sessionStorageKey(WORK_WORKSPACE_HISTORY_KEY, source)) ?? '[]')
    if (!Array.isArray(value)) return []
    return mergeWorkWorkspaceHistory(value.flatMap(item => item && typeof item === 'object'
      && typeof item.path === 'string' && typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt)
      ? [{ path: item.path, updatedAt: item.updatedAt }] : []))
  } catch { return [] }
}

export function mergeWorkWorkspaceHistory(entries: readonly WorkWorkspaceHistoryEntry[]): WorkWorkspaceHistoryEntry[] {
  const paths = new Map<string, WorkWorkspaceHistoryEntry>()
  for (const entry of entries) {
    if (!validWorkWorkspacePath(entry.path) || isWorkScratchPath(entry.path) || !Number.isFinite(entry.updatedAt)) continue
    const key = workWorkspacePathKey(entry.path)
    if (!paths.has(key) || paths.get(key)!.updatedAt < entry.updatedAt) paths.set(key, entry)
  }
  return [...paths.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path)).slice(0, HISTORY_LIMIT)
}

export function rememberWorkWorkspace(source: string, path: string): void {
  const entries = mergeWorkWorkspaceHistory([{ path, updatedAt: Date.now() }, ...readWorkWorkspaceHistory(source)])
  try { localStorage.setItem(sessionStorageKey(WORK_WORKSPACE_HISTORY_KEY, source), JSON.stringify(entries)) }
  catch { /* A full preferences store must not prevent using a selected directory. */ }
}

export function workWorkspaceChoices(source: string, tasks: readonly WorkTask[], currentPath: string | null, configuredPath?: string): WorkWorkspaceHistoryEntry[] {
  return mergeWorkWorkspaceHistory([
    ...readWorkWorkspaceHistory(source),
    ...tasks.flatMap(task => task.workspacePath ? [{ path: task.workspacePath, updatedAt: task.updatedAt }] : []),
    ...(currentPath ? [{ path: currentPath, updatedAt: 0 }] : []),
    ...(configuredPath ? [{ path: configuredPath, updatedAt: 0 }] : []),
  ])
}
