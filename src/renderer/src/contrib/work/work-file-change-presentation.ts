import type { EngineFileChange } from '@shared/ipc'
import { previewKindFor } from '../../core/editor/preview'
import { documentKindFor } from '../documents/document-kind'
import { computeLineDiff, diffForDeletedFile, diffForNewFile, diffStats, type DiffStats } from '../chat/diff'

export function workFileIsNew(change: EngineFileChange): boolean {
  // Binary receipts omit text snapshots, but their byte versions still prove
  // whether a file existed. Snapshot truncation must not hide a new file.
  return change.kind === 'write' && (change.isNew ?? (change.oldHash === 'missing' ||
    (change.oldContent === null && !change.truncated && !change.oldHash)))
}

export function workFileChangeCode(change: EngineFileChange): 'U' | 'M' | 'D' {
  return change.kind === 'delete' ? 'D' : workFileIsNew(change) ? 'U' : 'M'
}

/** Share the real preview registry; adding a renderer also enables it here. */
export function workFilePrefersPreview(path: string): boolean {
  return previewKindFor(path) !== 'hex' || documentKindFor(path) !== null
}

/** Missing snapshots are unknown counts; an actual empty file still has zero lines. */
export function workFileChangeStats(change: EngineFileChange): DiffStats | null {
  if (workFilePrefersPreview(change.path) || change.truncated) return null
  if (change.kind === 'delete') return typeof change.oldContent === 'string' ? diffStats(diffForDeletedFile(change.oldContent)) : null
  if (typeof change.newContent !== 'string') return null
  if (workFileIsNew(change)) return diffStats(diffForNewFile(change.newContent))
  if (typeof change.oldContent !== 'string') return null
  return diffStats(computeLineDiff(change.oldContent, change.newContent))
}
