/** Bound the initial DOM without removing content the user explicitly opens. */
export const WORK_TASK_PAGE_SIZE = 40
export const WORK_MESSAGE_PAGE_SIZE = 60
/** Explicit history browsing keeps at most three pages mounted, even when a
 * live task continues appending while the reader stays on an older page. */
export const WORK_MESSAGE_WINDOW_SIZE = WORK_MESSAGE_PAGE_SIZE * 3
export const WORK_ACTIVITY_PAGE_SIZE = 80

export interface WorkToolSnapshot<T> { sources: T[][]; tools: T[] }

/** Text-only frames keep tool arrays unchanged; reuse derived tool lists until
 * a receipt actually changes instead of scanning every historic tool again. */
export function workToolSnapshot<T>(messages: ReadonlyArray<{ tools: T[] }>, previous?: WorkToolSnapshot<T>): WorkToolSnapshot<T> {
  const sources = messages.map(message => message.tools)
  if (previous && sources.length === previous.sources.length && sources.every((source, index) => source === previous.sources[index])) return previous
  return { sources, tools: sources.flat() }
}

export function workPageRange(total: number, page: number, size: number): {
  page: number; pages: number; start: number; end: number
} {
  const count = Math.max(0, Math.floor(total))
  const pageSize = Math.max(1, Math.floor(size))
  const pages = Math.max(1, Math.ceil(count / pageSize))
  const current = Math.max(0, Math.min(pages - 1, Math.floor(page)))
  const start = current * pageSize
  return { page: current, pages, start, end: Math.min(count, start + pageSize) }
}

/** Absolute drag coordinates avoid accumulating stale React state between frames. */
export function workPaneRatio(startRatio: number, startX: number, currentX: number, width: number): number {
  return Math.max(35, Math.min(62, startRatio + (currentX - startX) / Math.max(1, width) * 100))
}

/** Keep the oldest mounted message stable as new replies arrive while reading. */
export function workMessageStart(messages: ReadonlyArray<{ id: string }>, firstId: string | null, size = WORK_MESSAGE_PAGE_SIZE): number {
  if (firstId) {
    const index = messages.findIndex(message => message.id === firstId)
    if (index >= 0) return index
  }
  return Math.max(0, messages.length - size)
}

export function workMessageRange(messages: ReadonlyArray<{ id: string }>, firstId: string | null): { start: number; end: number; newer: number } {
  const start = workMessageStart(messages, firstId)
  const end = Math.min(messages.length, start + WORK_MESSAGE_WINDOW_SIZE)
  return { start, end, newer: messages.length - end }
}
