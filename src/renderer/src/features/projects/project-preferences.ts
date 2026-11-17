import type { SessionTask } from '../sessions/state'
import { sortSessionSidebarTasks } from '../sessions/sidebar-task'

export const PROJECT_PREFERENCES_KEY = 'aether.work.projects.v1'
const preferencesEvent = 'aether:project-preferences'

export interface ProjectPreferences {
  pinnedPaths: string[]
  archivedPaths: string[]
  names: Record<string, string>
  selectedPath: string | null
  selectedCollection: 'projects' | 'independent'
  sort: 'recent' | 'name'
}
export type ProjectPreferencesChange = Partial<ProjectPreferences> | ((current: ProjectPreferences) => Partial<ProjectPreferences>)
export interface ProjectGroup {
  path: string
  name: string
  tasks: SessionTask[]
  updatedAt: number
  pinned: boolean
  /** Project-level archive remains separate from each session's archive flag. */
  archived: boolean
}

export function normalizeProjectPath(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/\/$/, '') || '/'
}

function normalizePreferences(value: unknown): ProjectPreferences {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const paths = (items: unknown): string[] => Array.isArray(items)
    ? [...new Set(items.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(normalizeProjectPath))] : []
  return {
    pinnedPaths: paths(Array.isArray(value) ? value : record.pinnedPaths),
    archivedPaths: paths(record.archivedPaths),
    names: record.names && typeof record.names === 'object' && !Array.isArray(record.names)
      ? Object.fromEntries(Object.entries(record.names)
        .filter((entry): entry is [string, string] => Boolean(entry[0].trim()) && typeof entry[1] === 'string' && Boolean(entry[1].trim()))
        .map(([path, name]) => [normalizeProjectPath(path), name.trim()])) : {},
    selectedPath: typeof record.selectedPath === 'string' && record.selectedPath.trim() ? normalizeProjectPath(record.selectedPath) : null,
    selectedCollection: record.selectedCollection === 'independent' ? 'independent' : 'projects',
    sort: record.sort === 'name' ? 'name' : 'recent'
  }
}

// Stable snapshots let both surfaces subscribe without a render loop. Keeping
// the last snapshot also makes a storage failure a persistence issue only.
const snapshots = new Map<string, { raw: string | null; preferences: ProjectPreferences }>()

export function readProjectPreferences(storageKey: string): ProjectPreferences {
  const previous = snapshots.get(storageKey)
  let raw: string | null
  try { raw = localStorage.getItem(storageKey) } catch {
    if (previous) return previous.preferences
    const preferences = normalizePreferences(null)
    snapshots.set(storageKey, { raw: null, preferences })
    return preferences
  }
  if (previous && previous.raw === raw) return previous.preferences
  let value: unknown = null
  try { value = JSON.parse(raw ?? 'null') } catch { /* Malformed preferences fall back to an empty collection. */ }
  const preferences = normalizePreferences(value)
  snapshots.set(storageKey, { raw, preferences })
  return preferences
}

export function patchProjectPreferences(storageKey: string, change: ProjectPreferencesChange): ProjectPreferences {
  const current = readProjectPreferences(storageKey)
  const preferences = normalizePreferences({ ...current, ...(typeof change === 'function' ? change(current) : change) })
  let raw = snapshots.get(storageKey)?.raw ?? null
  try {
    const serialized = JSON.stringify(preferences)
    localStorage.setItem(storageKey, serialized)
    raw = serialized
  } catch { /* Retain the in-memory edit until storage changes or a later write succeeds. */ }
  snapshots.set(storageKey, { raw, preferences })
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(preferencesEvent, { detail: { storageKey } }))
  return preferences
}

export function subscribeProjectPreferences(storageKey: string, listener: () => void): () => void {
  const onPreferences = (event: Event): void => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : undefined
    if (detail && typeof detail === 'object' && 'storageKey' in detail && detail.storageKey !== storageKey) return
    listener()
  }
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== storageKey) return
    // sessionStorage events must not invalidate local project preferences.
    if (event.storageArea) {
      try { if (event.storageArea !== localStorage) return } catch { return }
    }
    snapshots.delete(storageKey)
    listener()
  }
  window.addEventListener(preferencesEvent, onPreferences)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(preferencesEvent, onPreferences)
    window.removeEventListener('storage', onStorage)
  }
}

export function projectDisplayName(path: string, preferences: ProjectPreferences): string {
  const normalized = normalizeProjectPath(path)
  return preferences.names[normalized] || normalized.split('/').filter(Boolean).at(-1) || normalized
}

export function isProjectTaskArchived(task: Pick<SessionTask, 'workspacePath' | 'archived'>, preferences: ProjectPreferences): boolean {
  return Boolean(task.archived || task.workspacePath && preferences.archivedPaths.includes(normalizeProjectPath(task.workspacePath)))
}

export function buildProjectGroups(tasks: readonly SessionTask[], preferences: ProjectPreferences, scope: 'current' | 'archived' | 'all'): ProjectGroup[] {
  const byPath = new Map<string, SessionTask[]>()
  for (const task of tasks) {
    if (!task.workspacePath || scope !== 'all' && isProjectTaskArchived(task, preferences) !== (scope === 'archived')) continue
    const path = normalizeProjectPath(task.workspacePath)
    const group = byPath.get(path)
    if (group) group.push(task)
    else byPath.set(path, [task])
  }
  const pinned = new Set(preferences.pinnedPaths), archived = new Set(preferences.archivedPaths)
  return [...byPath].map(([path, items]): ProjectGroup => ({
    path, name: projectDisplayName(path, preferences), tasks: sortSessionSidebarTasks(items),
    // A pinned old session must not make its project appear older than its
    // other sessions; this also matches the sidebar's run-start ordering.
    updatedAt: items.reduce((latest, task) => Math.max(latest, task.updatedAt, task.runStartedAt ?? 0), 0),
    pinned: pinned.has(path), archived: archived.has(path)
  })).sort((a, b) => Number(b.pinned) - Number(a.pinned) ||
    (preferences.sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : b.updatedAt - a.updatedAt) || a.path.localeCompare(b.path))
}
