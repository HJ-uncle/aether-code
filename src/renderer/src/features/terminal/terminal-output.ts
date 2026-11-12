import type { IBuffer } from '@xterm/xterm'

/** Snapshot retained, rendered text; escape sequences have already been interpreted by xterm. */
export function readTerminalOutput(buffer: IBuffer): string {
  const lines: string[] = []
  for (let index = 0; index < buffer.length; index++) {
    const line = buffer.getLine(index)
    if (!line) continue
    // xterm's circular scrollback may expose the first row again at length.
    const next = index + 1 < buffer.length ? buffer.getLine(index + 1) : undefined
    const wraps = next?.isWrapped === true
    let endColumn = line.length
    if (wraps && endColumn > 0) {
      const last = line.getCell(endColumn - 1)
      // A wide glyph cannot occupy the final single column. xterm leaves a
      // null padding cell before wrapping it; that cell is not an output space.
      if (last?.getCode() === 0 && last.getWidth() === 1 && next?.getCell(0)?.getWidth() === 2) endColumn--
    }
    // Wrapped rows must retain spacing produced by cursor movement or tabs.
    // On hard line endings xterm trims empty cells, preserving printed spaces.
    const text = line.translateToString(!wraps, 0, endColumn)
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text
    else lines.push(text)
  }
  // Unused viewport rows should not inflate copied output or chat attachments.
  // Keep internal blank lines and spacing on the final nonblank logical line.
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines.join('\n')
}
