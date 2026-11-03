import type { PreviewRetentionEntry } from '@renderer/core/editor/preview-retention'

export interface ResourcePreviewSize { id: string; externalFile?: { size: number } }

/** Retain only the active and most recently used document surfaces. Other open
 * files keep lightweight tabs and the separate bounded read cache. This bounds
 * iframe/canvas/worker memory even after every resource has been opened. */
export function resourcePreviewEntries(files: readonly ResourcePreviewSize[]): PreviewRetentionEntry[] {
  return files.map(file => ({ id: file.id, size: file.externalFile?.size, version: file }))
}
