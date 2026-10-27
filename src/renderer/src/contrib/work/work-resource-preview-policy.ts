export interface ResourcePreviewSize { id: string; externalFile?: { size: number } }

/** Retain only the active and most recently used document surfaces. Other open
 * files keep lightweight tabs and the separate bounded read cache. This bounds
 * iframe/canvas/worker memory even after every resource has been opened. */
export function retainedResourceIds(files: readonly ResourcePreviewSize[], selected: string | null, recent: readonly string[]): Set<string> {
  const available = new Set(files.map(file => file.id))
  const recentIds = [selected, ...recent].filter((id): id is string => Boolean(id && available.has(id)))
  return new Set([...new Set(recentIds)].slice(0, 2))
}
