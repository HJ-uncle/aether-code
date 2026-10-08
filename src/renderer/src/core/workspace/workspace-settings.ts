import type { FilesExclude } from '@shared/ipc'

/** 工作区级设置：与 VS Code 的 .vscode/settings.json 作用域相同。 */
export interface WorkspaceSettings {
  filesExclude?: FilesExclude
  searchExclude?: FilesExclude
}

const STORAGE_KEY = 'aether.workspace.settings'
const EMPTY: Readonly<WorkspaceSettings> = Object.freeze({})
let table: Record<string, WorkspaceSettings> = load()
const listeners = new Set<() => void>()

function load(): Record<string, WorkspaceSettings> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const output: Record<string, WorkspaceSettings> = {}
    for (const [root, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const raw = value as Record<string, unknown>
      const next: WorkspaceSettings = {}
      if (isExcludeTable(raw.filesExclude)) next.filesExclude = raw.filesExclude
      if (isExcludeTable(raw.searchExclude)) next.searchExclude = raw.searchExclude
      if (next.filesExclude || next.searchExclude) output[root] = next
    }
    return output
  } catch {
    return {}
  }
}

function isExcludeTable(value: unknown): value is FilesExclude {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((item) => typeof item === 'boolean'))
}

function persist(): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(table)) } catch { /* 工作区偏好仅影响当前会话 */ }
}

export function getWorkspaceSettings(root: string | null): Readonly<WorkspaceSettings> {
  return root ? table[root] ?? EMPTY : EMPTY
}

export function setWorkspaceSettings(root: string, patch: WorkspaceSettings): void {
  if (!root) return
  const previous = table[root] ?? EMPTY
  const next: WorkspaceSettings = { ...previous, ...patch }
  if (JSON.stringify(previous) === JSON.stringify(next)) return
  if (next.filesExclude || next.searchExclude) table = { ...table, [root]: next }
  else {
    const rest = { ...table }
    delete rest[root]
    table = rest
  }
  persist()
  for (const listener of listeners) listener()
}

export function clearWorkspaceSetting(root: string, key: keyof WorkspaceSettings): void {
  const current = table[root]
  if (!current || current[key] === undefined) return
  const next = { ...current }
  delete next[key]
  if (next.filesExclude || next.searchExclude) table = { ...table, [root]: next }
  else {
    const rest = { ...table }
    delete rest[root]
    table = rest
  }
  persist()
  for (const listener of listeners) listener()
}

export function onWorkspaceSettingsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
