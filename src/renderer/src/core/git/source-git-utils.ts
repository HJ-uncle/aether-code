import type { editor } from 'monaco-editor'

export interface BufferReplacement { startOffset: number; endOffset: number; text: string }

/** Restrict the undo entry to the changed characters, preserving selections outside the hunk. */
export function minimalReplacement(before: string, after: string): BufferReplacement {
  let startOffset = 0
  while (startOffset < before.length && startOffset < after.length && before[startOffset] === after[startOffset]) startOffset++
  let beforeEnd = before.length
  let afterEnd = after.length
  while (beforeEnd > startOffset && afterEnd > startOffset && before[beforeEnd - 1] === after[afterEnd - 1]) { beforeEnd--; afterEnd-- }
  return { startOffset, endOffset: beforeEnd, text: after.slice(startOffset, afterEnd) }
}

export function hunkLine(change: editor.ILineChange): number {
  return Math.max(1, change.modifiedStartLineNumber)
}

/** Monaco represents an empty side with end=0 and start=the preceding line. */
export function revertLineChange(original: string, modified: string, change: editor.ILineChange): BufferReplacement {
  const oldLines = original.split(/\r\n|\n|\r/)
  const newLines = modified.split(/\r\n|\n|\r/)
  const oldStart = change.originalEndLineNumber === 0 ? change.originalStartLineNumber : change.originalStartLineNumber - 1
  const oldEnd = change.originalEndLineNumber || oldStart
  const newStart = change.modifiedEndLineNumber === 0 ? change.modifiedStartLineNumber : change.modifiedStartLineNumber - 1
  const newEnd = change.modifiedEndLineNumber || newStart
  const eol = modified.includes('\r\n') ? '\r\n' : '\n'
  newLines.splice(newStart, newEnd - newStart, ...oldLines.slice(oldStart, oldEnd))
  return minimalReplacement(modified, newLines.join(eol))
}

/** Blame is based on HEAD. Changed lines have no committed owner; later unchanged lines retain theirs. */
export function originalLineForModified(line: number, changes: readonly editor.ILineChange[]): number | null {
  let delta = 0
  for (const change of changes) {
    const oldCount = change.originalEndLineNumber === 0 ? 0 : change.originalEndLineNumber - change.originalStartLineNumber + 1
    const newCount = change.modifiedEndLineNumber === 0 ? 0 : change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1
    if (newCount > 0 && line >= change.modifiedStartLineNumber && line <= change.modifiedEndLineNumber) return null
    if (newCount === 0 ? line > change.modifiedStartLineNumber : line > change.modifiedEndLineNumber) delta += oldCount - newCount
  }
  return line + delta
}
