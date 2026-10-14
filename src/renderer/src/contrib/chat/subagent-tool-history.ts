import type { SubagentRunView, SubagentToolsPage, SubagentToolSummary } from '@shared/subagent'

export const SUBAGENT_TOOL_PAGE_SIZE = 50
export const SUBAGENT_TOOL_WINDOW_COUNT = 128
export const SUBAGENT_TOOL_WINDOW_BYTES = 512 * 1024
export const SUBAGENT_DETAIL_CHUNK_BYTES = 32 * 1024
export const SUBAGENT_DETAIL_OFFSET_COUNT = 64

/** Keep navigation metadata bounded just like the detail text itself. */
export function subagentDetailOffsetTrail(previous: number[], currentOffset: number, nextOffset: number): number[] {
  if (nextOffset === 0) return []
  if (nextOffset > currentOffset) return [...previous, currentOffset].slice(-SUBAGENT_DETAIL_OFFSET_COUNT)
  if (nextOffset < currentOffset) {
    const index = previous.lastIndexOf(nextOffset)
    return index < 0 ? [] : previous.slice(0, index)
  }
  return previous
}

export interface SubagentHistoryScope {
  source: number
  runId: string
  tenantId: string
  rootSessionId: string
  parentSessionId: string
  parentConversationId: string
  parentMessageId: string
  parentToolCallId: string
  childSessionId: string
  atSeq: number
}
export interface SubagentToolWindow {
  scope: SubagentHistoryScope
  items: SubagentToolSummary[]
  totalCount: number
  loadedCount: number
  droppedCount: number
  residentBytes: number
  hasMore: boolean
  nextCursor?: string
}
export class SubagentHistorySupersededError extends Error {
  constructor() { super('代理或引擎连接已切换') }
}
export function subagentHistoryScope(run: SubagentRunView, source: number): SubagentHistoryScope {
  return { source, runId: run.runId, tenantId: run.tenantId, rootSessionId: run.rootSessionId,
    parentSessionId: run.parentSessionId, parentConversationId: run.parentConversationId,
    parentMessageId: run.parentMessageId, parentToolCallId: run.parentToolCallId,
    childSessionId: run.childSessionId, atSeq: run.lastSeq }
}
export function sameSubagentHistoryScope(a: SubagentHistoryScope, b: SubagentHistoryScope): boolean {
  return (Object.keys(a) as (keyof SubagentHistoryScope)[]).every(key => a[key] === b[key])
}

/** Cursor progress is scalar; evicted pages never require an unbounded set of fetched IDs. */
export async function loadSubagentToolWindow(
  scope: SubagentHistoryScope,
  fetchPage: (scope: SubagentHistoryScope, cursor?: string) => Promise<SubagentToolsPage>,
  isCurrent: () => boolean,
  previous?: SubagentToolWindow
): Promise<SubagentToolWindow> {
  if (!isCurrent()) throw new SubagentHistorySupersededError()
  if (previous && !sameSubagentHistoryScope(scope, previous.scope)) throw new SubagentHistorySupersededError()
  if (previous && !previous.hasMore) return previous
  const page = await fetchPage(scope, previous?.nextCursor)
  if (!isCurrent()) throw new SubagentHistorySupersededError()
  if (page.schemaVersion !== 2 || page.runId !== scope.runId || page.asOfSeq !== scope.atSeq ||
    !Number.isSafeInteger(page.totalCount) || page.totalCount < 0 || !Array.isArray(page.items) ||
    page.items.length > SUBAGENT_TOOL_PAGE_SIZE || (previous && page.totalCount !== previous.totalCount) ||
    typeof page.hasMore !== 'boolean' || (page.hasMore && (!page.nextCursor || page.nextCursor === previous?.nextCursor || !page.items.length)))
    throw new Error('工具记录分页不一致，请更新记录后重试')
  const start = previous?.loadedCount ?? 0
  const ids = new Set(previous?.items.map(call => call.id))
  for (const [index, call] of page.items.entries()) {
    if (!call || typeof call.id !== 'string' || !call.id || ids.has(call.id) || typeof call.name !== 'string' ||
      !['running', 'succeeded', 'failed', 'cancelled'].includes(call.status) || call.ordinal !== start + index + 1 ||
      !Number.isSafeInteger(call.revisionSeq) || call.revisionSeq < 1 || call.revisionSeq > scope.atSeq ||
      typeof call.detailRef !== 'string' || typeof call.detailTruncated !== 'boolean')
      throw new Error('工具记录顺序或水位不一致，请更新记录后重试')
    ids.add(call.id)
  }
  const loadedCount = start + page.items.length
  if (loadedCount > page.totalCount || page.hasMore !== (loadedCount < page.totalCount))
    throw new Error('工具记录数量不一致，请更新记录后重试')
  const encoder = new TextEncoder()
  const entries = [...(previous?.items ?? []), ...page.items].map(call => ({ call, bytes: encoder.encode(JSON.stringify(call)).byteLength }))
  if (entries.some(entry => entry.bytes > SUBAGENT_TOOL_WINDOW_BYTES)) throw new Error('单条工具摘要过大，请重试读取')
  let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  while (entries.length > SUBAGENT_TOOL_WINDOW_COUNT || bytes > SUBAGENT_TOOL_WINDOW_BYTES) bytes -= entries.shift()!.bytes
  return { scope: { ...scope }, items: entries.map(entry => entry.call), totalCount: page.totalCount, loadedCount,
    droppedCount: loadedCount - entries.length, residentBytes: bytes, hasMore: page.hasMore, nextCursor: page.nextCursor }
}
