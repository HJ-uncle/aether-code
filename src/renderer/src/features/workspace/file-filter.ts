import type { FsEntry } from '@shared/ipc'

// Dependency and Git internals are not project files. In particular, do not
// exclude output/build folders: Work deliverables often live there.
export const SESSION_FILTER_SKIP_DIRS = new Set(['.git', 'node_modules'])

export interface SessionFileScan {
  directories: number
  entries: number
  failed: number
  limited: boolean
}

/** Populate the existing directory cache, never file contents or a second
 * index. Batches bound in-flight requests and yield between disk responses. */
export async function scanSessionFileDirectories({ root, readDirectory, current, onProgress,
  maxDirectories = 2000, maxEntries = 50_000 }: {
  root: string
  readDirectory(path: string): Promise<FsEntry[] | null>
  current(): boolean
  onProgress?(progress: SessionFileScan): void
  maxDirectories?: number
  maxEntries?: number
}): Promise<SessionFileScan | null> {
  const pending = [root], seen = new Set([root])
  const result: SessionFileScan = { directories: 0, entries: 0, failed: 0, limited: false }
  let next = 0
  while (current() && next < pending.length) {
    const batch = pending.slice(next, Math.min(next + 4, maxDirectories))
    if (!batch.length || result.entries >= maxEntries) { result.limited = true; break }
    next += batch.length
    const listings = await Promise.all(batch.map(async directory => {
      try { return await readDirectory(directory) } catch { return null }
    }))
    if (!current()) return null
    for (const entries of listings) {
      result.directories++
      if (!entries) { result.failed++; continue }
      result.entries += entries.length
      if (result.entries > maxEntries) result.limited = true
      for (const entry of entries) {
        if (!entry.isDirectory || SESSION_FILTER_SKIP_DIRS.has(entry.name) || seen.has(entry.path)) continue
        if (pending.length >= maxDirectories || result.entries >= maxEntries) { result.limited = true; continue }
        seen.add(entry.path)
        pending.push(entry.path)
      }
    }
    onProgress?.({ ...result })
  }
  return current() ? result : null
}

/** Search expansion is temporary; collapsing a result must not rewrite the
 * user's ordinary tree preferences. Descendants remain cached for clearing. */
export function collapseSessionFilterRows<T extends { entry: FsEntry; depth: number; isExpanded: boolean }>(
  rows: readonly T[], collapsed: ReadonlySet<string>, key: (path: string) => string
): T[] {
  const result: T[] = []
  let hiddenBelow: number | null = null
  for (const row of rows) {
    if (hiddenBelow !== null && row.depth > hiddenBelow) continue
    hiddenBelow = null
    if (row.entry.isDirectory && collapsed.has(key(row.entry.path))) {
      result.push({ ...row, isExpanded: false })
      hiddenBelow = row.depth
    } else result.push(row)
  }
  return result
}
