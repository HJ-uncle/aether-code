import type { EngineRequestInput, EngineRequestResult } from '@shared/ipc'
import type { EngineHistoryRow } from '@renderer/core/engine/chat-history'
import { normalizeSubagentRun } from '@renderer/core/engine/subagent-state'

export const SUBAGENT_TRANSCRIPT_PAGE_SIZE = 50
export const SUBAGENT_TRANSCRIPT_TEXT_STEP = 4000

export interface WorkTranscriptIdentity {
  source: number
  parentSessionId: string
  childSessionId: string
  runId: string
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
  const ownership = await checkedRequest({ method: 'GET', path: `/subagent/runs/${encodeURIComponent(identity.runId)}` })
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
  const lastPage = Math.max(1, Math.ceil(header.total / SUBAGENT_TRANSCRIPT_PAGE_SIZE))
  const prior = previous && sameChild(previous.identity, identity) && previous.endpoint === endpoint ? previous : undefined
  const firstPage = prior ? Math.max(1, Math.min(lastPage, prior.firstPage - (action === 'older' ? 1 : 0))) : lastPage
  const unchanged = prior && header.revision !== undefined && header.revision === prior.revision && header.total === prior.total && lastPage === prior.lastPage
  const rows: EngineHistoryRow[] = []
  if (header.total > 0) {
    // A changed archive refreshes the selected window, preserving the earlier
    // pages the user already opened. An unchanged archive reads only new pages.
    const endPage = unchanged ? prior.firstPage - 1 : lastPage
    for (let current = firstPage; current <= endPage; current++) {
      const page = checkedPage(await pageRequest(current, SUBAGENT_TRANSCRIPT_PAGE_SIZE), current, SUBAGENT_TRANSCRIPT_PAGE_SIZE)
      if (page.total !== header.total || page.revision !== header.revision) throw new Error('子代理对话在读取期间有更新，请重试')
      rows.push(...page.rows)
    }
    if (unchanged) rows.push(...prior.rows)
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
    compressed: headerResult.metadata?.compressed === true
  }
}

/** Bound initial rendering without ever replacing the original long output. */
export function workTranscriptText(text: string, limit = SUBAGENT_TRANSCRIPT_TEXT_STEP): { text: string; remaining: number; nextLimit: number } {
  let end = Math.min(text.length, Math.max(SUBAGENT_TRANSCRIPT_TEXT_STEP, limit))
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
  return { text: text.slice(0, end), remaining: text.length - end, nextLimit: end + SUBAGENT_TRANSCRIPT_TEXT_STEP }
}
