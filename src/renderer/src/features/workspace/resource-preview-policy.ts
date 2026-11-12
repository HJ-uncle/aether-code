import type { PreviewRetentionEntry } from '@renderer/core/editor/preview-retention'
import { documentKindFor } from '../documents/document-kind'

export interface ResourcePreviewSize { id: string; name: string; externalFile?: { size: number } }

/** Plain text has a cheap viewport and a separate read cache. Counting it as a
 * live Office surface would evict decoded iframes during a mixed-file tour. */
export function resourcePreviewEntries(files: readonly ResourcePreviewSize[]): PreviewRetentionEntry[] {
  return files.filter(file => documentKindFor(file.name)).map(file => ({ id: file.id, size: file.externalFile?.size, version: file }))
}
