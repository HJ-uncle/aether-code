import { dirname, join, resolve } from 'node:path'

/** Fresh build snapshots may be replaced; user work belongs to the desktop profile. */
export function developmentRuntimeEnvironment(entryPath: string, userData: string, workspaceOverride?: string): { cwd: string; env: Record<string, string> } {
  const cwd = dirname(entryPath)
  // Preserve the engine's existing interpretation of explicit relative roots:
  // they are relative to its runtime cwd, not the desktop launch directory.
  const workspace = workspaceOverride?.trim()
    ? resolve(cwd, workspaceOverride)
    : join(userData, 'engine', 'state', 'workspace')
  return { cwd, env: { WORKSPACE_ROOT: workspace } }
}
