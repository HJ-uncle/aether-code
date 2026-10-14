import type { EngineRequestInput, EngineRequestResult } from '@shared/ipc'
import type { EngineHistoryRow } from '@renderer/core/engine/chat-history'
import { normalizeSubagentRun } from '@renderer/core/engine/subagent-state'

export const SUBAGENT_TRANSCRIPT_PAGE_SIZE = 50
export const SUBAGENT_TRANSCRIPT_TEXT_STEP = 4000
export const SUBAGENT_TRANSCRIPT_WINDOW_PAGES = 3
export const SUBAGENT_TRANSCRIPT_WINDOW_BYTES = 512 * 1024

export interface WorkTranscriptIdentity {
  source: number
  parentSessionId: string
  childSessionId: string
  runId: string
  subagentProtocol?: 1 | 2
}
export interface WorkTranscriptWindow {
  identity: WorkTranscriptIdentity
  endpoint: '/conversation/archive' | '/conversation/history'
  rows: EngineHistoryRow[]
  firstPage: number
  lastPage: number
  total: number
  revision?: string
  backend?: string
  compressed: boolean
  residentBytes?: number
  windowed?: boolean
}
export type WorkTranscriptRequest = (input: EngineRequestInput) => Promise<EngineRequestResult<unknown>>
export class WorkTranscriptSupersededError extends Error {
  constructor() { super('子代理或引擎连接已切换') }
}

function sameChild(a: WorkTranscriptIdentity, b: WorkTranscriptIdentity): boolean {
  return a.source === b.source && a.parentSessionId === b.parentSessionId && a.childSessionId === b.childSessionId
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function optionalString(value: unknown): boolean { return value === undefined || typeof value === 'string' }
function displayRow(value: unknown): value is EngineHistoryRow {
  if (!object(value) || typeof value.id !== 'string' || !value.id || typeof value.role !== 'string' || !['user', 'assistant', 'tool', 'system'].includes(value.role)) return false
  if (value.createdAt !== undefined && (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || !Number.isFinite(new Date(value.createdAt).getTime()))) return false
  if (!optionalString(value.modelId) || !optionalString(value.conversationId) || (value.isSidechain !== undefined && typeof value.isSidechain !== 'boolean')) return false
  if (value.toolCall !== undefined && value.toolCall !== null && (!object(value.toolCall) || !optionalString(value.toolCall.id) || !optionalString(value.toolCall.name))) return false
  if (value.metadata !== undefined) {
    if (!object(value.metadata)) return false
    const attachments = value.metadata.attachments
    if (attachments !== undefined && (!Array.isArray(attachments) || attachments.some(file => !object(file) || typeof file.name !== 'string' || !optionalString(file.type) || (file.size !== undefined && (typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size < 0))))) return false
  }
  return true
}
function checkedPage(result: EngineRequestResult<unknown>, current: number, pageSize: number): { rows: EngineHistoryRow[]; total: number; revision?: string } {
  if (!result.ok || !Array.isArray(result.data)) throw new Error(result.message || '读取子代理对话失败，请重试')
  const pagination = result.pagination
  if (!pagination || pagination.current !== current || pagination.pageSize !== pageSize || !Number.isSafeInteger(pagination.total) || pagination.total < 0 || pagination.totalPages !== Math.ceil(pagination.total / pageSize)) throw new Error('子代理对话分页信息无效，请重试')
  if (result.metadata?.archiveMessageCount !== undefined && result.metadata.archiveMessageCount !== pagination.total) throw new Error('子代理归档数量不一致，请重试')
  if (result.data.length !== Math.max(0, Math.min(pageSize, pagination.total - (current - 1) * pageSize))) throw new Error('子代理对话页不完整，请重试')
  const ids = new Set<string>()
  for (const row of result.data) {
    if (!displayRow(row)) throw new Error('子代理对话内容格式无效，请重试')
    if (ids.has(row.id!)) throw new Error('子代理对话出现重复的消息 ID，请重试')
    ids.add(row.id!)
  }
  return { rows: result.data, total: pagination.total, ...(typeof result.metadata?.archiveRevision === 'string' ? { revision: result.metadata.archiveRevision } : {}) }
}

/** Verify the parent relationship before using a durable child ID to read history. */
export async function loadWorkSubagentTranscript(
  identity: WorkTranscriptIdentity,
  request: WorkTranscriptRequest,
  isCurrent: () => boolean,
  previous?: WorkTranscriptWindow,
  action: 'older' | 'refresh' = 'refresh'
): Promise<WorkTranscriptWindow> {
  const checkedRequest = async (input: EngineRequestInput): Promise<EngineRequestResult<unknown>> => {
    if (!isCurrent()) throw new WorkTranscriptSupersededError()
    const result = await request(input)
    if (!isCurrent()) throw new WorkTranscriptSupersededError()
    return result
  }
  const ownership = await checkedRequest({ method: 'GET', path: `/subagent/runs/${encodeURIComponent(identity.runId)}`,
    ...(identity.subagentProtocol === 2 ? { subagentProtocol: 2, query: { view: 'summary', parentSessionId: identity.parentSessionId } } : {}) })
  if (!ownership.ok) throw new Error(ownership.message || '无法验证子代理对话，请重试')
  const run = normalizeSubagentRun(ownership.data)
  if (!run || run.runId !== identity.runId || run.parentSessionId !== identity.parentSessionId || !run.childSessionId || run.childSessionId !== identity.childSessionId) throw new Error('子代理不属于当前任务，无法读取对话')

  let endpoint: WorkTranscriptWindow['endpoint'] = '/conversation/archive'
  const pageRequest = (current: number, pageSize: number): Promise<EngineRequestResult<unknown>> => checkedRequest({ method: 'GET', path: endpoint, query: { sessionId: run.childSessionId, current: String(current), pageSize: String(pageSize) } })
  let headerResult = await pageRequest(1, 1)
  // Old engines/backends can lack archive support. Other failures must remain
  // visible rather than silently reading a different projection.
  if (!headerResult.ok && [404, 40401, 501, 50101].includes(headerResult.code)) {
    endpoint = '/conversation/history'
    headerResult = await pageRequest(1, 1)
  }
  const header = checkedPage(headerResult, 1, 1)
  // Each archive page is internally coherent, but the legacy offset API does
  // not pin a revision across separate requests. While a child appends, fall
  // back to one authoritative page rather than rejecting normal streaming or
  // combining records from different revisions. Pagination stays bounded.
  const livePageWindow = async (result: EngineRequestResult<unknown>, current: number): Promise<WorkTranscriptWindow> => {
    let page = checkedPage(result, current, SUBAGENT_TRANSCRIPT_PAGE_SIZE)
    for (let attempt = 0; attempt < 2; attempt++) {
      const newest = Math.max(1, Math.ceil(page.total / SUBAGENT_TRANSCRIPT_PAGE_SIZE))
      if (current === newest) break
      current = newest
      result = await pageRequest(current, SUBAGENT_TRANSCRIPT_PAGE_SIZE)
      page = checkedPage(result, current, SUBAGENT_TRANSCRIPT_PAGE_SIZE)
    }
    if (!page.rows.length && page.total > 0) throw new Error('子代理对话在读取期间有更新，请重试')
    const residentBytes = new TextEncoder().encode(JSON.stringify(page.rows)).byteLength
    if (residentBytes > SUBAGENT_TRANSCRIPT_WINDOW_BYTES) throw new Error('此对话页正文较大，请在工具记录中按段读取原始详情')
    return {
      identity: { ...identity }, endpoint, rows: page.rows, firstPage: current, lastPage: current, total: page.total,
      ...(page.revision !== undefined ? { revision: page.revision } : {}),
      ...(typeof result.metadata?.backend === 'string' ? { backend: result.metadata.backend } : {}),
      compressed: result.metadata?.compressed === true, residentBytes, windowed: page.rows.length < page.total
    }
  }
  const archiveLastPage = Math.max(1, Math.ceil(header.total / SUBAGENT_TRANSCRIPT_PAGE_SIZE))
  const prior = previous && sameChild(previous.identity, identity) && previous.endpoint === endpoint ? previous : undefined
  let firstPage = prior ? Math.max(1, Math.min(archiveLastPage, prior.firstPage - (action === 'older' ? 1 : 0))) : archiveLastPage
  let lastPage = action === 'older' ? Math.min(archiveLastPage, firstPage + SUBAGENT_TRANSCRIPT_WINDOW_PAGES - 1) : archiveLastPage
  firstPage = Math.max(firstPage, lastPage - SUBAGENT_TRANSCRIPT_WINDOW_PAGES + 1)
  const unchanged = prior && header.revision !== undefined && header.revision === prior.revision && header.total === prior.total && lastPage === prior.lastPage
  const rows: EngineHistoryRow[] = []
  let residentBytes = 0
  const encoder = new TextEncoder()
  if (header.total > 0) {
    // Read only a bounded page window; preserving every page ever opened recreates the long-run leak.
    const pages: { current: number; rows: EngineHistoryRow[]; bytes: number }[] = []
    const endPage = unchanged ? prior.firstPage - 1 : lastPage
    for (let current = firstPage; current <= endPage; current++) {
      const result = await pageRequest(current, SUBAGENT_TRANSCRIPT_PAGE_SIZE)
      const page = checkedPage(result, current, SUBAGENT_TRANSCRIPT_PAGE_SIZE)
      if (page.total !== header.total || page.revision !== header.revision) {
        if (action === 'refresh') return livePageWindow(result, current)
        throw new Error('子代理对话在读取期间有更新，请重试')
      }
      const bytes = encoder.encode(JSON.stringify(page.rows)).byteLength
      if (bytes > SUBAGENT_TRANSCRIPT_WINDOW_BYTES) throw new Error('此对话页正文较大，请在工具记录中按段读取原始详情')
      pages.push({ current, rows: page.rows, bytes })
    }
    if (unchanged) {
      for (let current = prior.firstPage; current <= prior.lastPage; current++) {
        const offset = (current - prior.firstPage) * SUBAGENT_TRANSCRIPT_PAGE_SIZE
        const pageRows = prior.rows.slice(offset, offset + SUBAGENT_TRANSCRIPT_PAGE_SIZE)
        pages.push({ current, rows: pageRows, bytes: encoder.encode(JSON.stringify(pageRows)).byteLength })
      }
    }
    const ordered = action === 'older' ? pages : [...pages].reverse()
    const selected: typeof pages = []
    for (const page of ordered) {
      if (residentBytes + page.bytes > SUBAGENT_TRANSCRIPT_WINDOW_BYTES) break
      residentBytes += page.bytes
      selected.push(page)
    }
    selected.sort((a, b) => a.current - b.current)
    firstPage = selected[0]?.current ?? firstPage
    lastPage = selected.at(-1)?.current ?? lastPage
    for (const page of selected) rows.push(...page.rows)
  }
  const ids = new Set<string>()
  for (const row of rows) {
    if (!row.id || ids.has(row.id)) throw new Error('子代理对话跨页消息 ID 重复，请重试')
    ids.add(row.id)
  }
  return {
    identity: { ...identity }, endpoint, rows, firstPage, lastPage, total: header.total,
    ...(header.revision !== undefined ? { revision: header.revision } : {}),
    ...(typeof headerResult.metadata?.backend === 'string' ? { backend: headerResult.metadata.backend } : {}),
    compressed: headerResult.metadata?.compressed === true, residentBytes,
    windowed: rows.length < header.total
  }
}

/** Bound initial rendering without ever replacing the original long output. */
export function workTranscriptText(text: string, limit = SUBAGENT_TRANSCRIPT_TEXT_STEP): { text: string; remaining: number; nextLimit: number } {
  let end = Math.min(text.length, Math.max(SUBAGENT_TRANSCRIPT_TEXT_STEP, limit))
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
  return { text: text.slice(0, end), remaining: text.length - end, nextLimit: end + SUBAGENT_TRANSCRIPT_TEXT_STEP }
}
