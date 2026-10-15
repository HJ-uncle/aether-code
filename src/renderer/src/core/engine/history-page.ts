import type { EngineRequestResult } from '@shared/ipc'
import type { EngineHistoryRow } from './chat-history'

export interface CheckedHistoryPage {
  rows: EngineHistoryRow[]
  total: number
  revision?: string
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function optionalString(value: unknown): boolean { return value === undefined || typeof value === 'string' }

/** Both archive readers accept the same display contract before caching a row. */
export function isHistoryDisplayRow(value: unknown): value is EngineHistoryRow {
  if (!record(value) || typeof value.id !== 'string' || !value.id || typeof value.role !== 'string' || !['user', 'assistant', 'tool', 'system'].includes(value.role)) return false
  if (value.createdAt !== undefined && (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || !Number.isFinite(new Date(value.createdAt).getTime()))) return false
  if (!optionalString(value.modelId) || !optionalString(value.conversationId) || (value.isSidechain !== undefined && typeof value.isSidechain !== 'boolean')) return false
  if (value.toolCall !== undefined && value.toolCall !== null && (!record(value.toolCall) || !optionalString(value.toolCall.id) || !optionalString(value.toolCall.name))) return false
  if (value.metadata !== undefined) {
    if (!record(value.metadata)) return false
    const attachments = value.metadata.attachments
    if (attachments !== undefined && (!Array.isArray(attachments) || attachments.some(file => !record(file) || typeof file.name !== 'string' || !optionalString(file.type) || (file.size !== undefined && (typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size < 0))))) return false
  }
  return true
}

/** Offset pages cannot claim a stable revision merely because counts match. */
export function checkHistoryPage(result: EngineRequestResult<unknown>, current: number, pageSize: number, label: string): CheckedHistoryPage {
  if (!Number.isSafeInteger(current) || current < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new Error(`${label}分页请求无效，请重试`)
  if (!result.ok || !Array.isArray(result.data)) throw new Error(result.message || `读取${label}失败，请重试`)
  const pagination = result.pagination
  if (!pagination || pagination.current !== current || pagination.pageSize !== pageSize || !Number.isSafeInteger(pagination.total) || pagination.total < 0 || pagination.totalPages !== Math.ceil(pagination.total / pageSize)) throw new Error(`${label}分页信息无效，请重试`)
  if (result.metadata?.archiveMessageCount !== undefined && result.metadata.archiveMessageCount !== pagination.total) throw new Error(`${label}数量不一致，请重试`)
  if (result.data.length !== Math.max(0, Math.min(pageSize, pagination.total - (current - 1) * pageSize))) throw new Error(`${label}页不完整，请重试`)
  const revision = result.metadata?.archiveRevision
  if (revision !== undefined && (typeof revision !== 'string' || !revision || revision.length > 1024)) throw new Error(`${label}版本信息无效，请重试`)
  const ids = new Set<string>()
  for (const row of result.data) {
    if (!isHistoryDisplayRow(row)) throw new Error(`${label}内容格式无效，请重试`)
    if (ids.has(row.id!)) throw new Error(`${label}出现重复的消息 ID，请重试`)
    ids.add(row.id!)
  }
  return { rows: result.data, total: pagination.total, ...(typeof revision === 'string' ? { revision } : {}) }
}

export interface CheckedCursorPage<T> { entries: T[]; revision: number; hasMore: boolean; nextCursor?: string }
/** A server cursor is opaque; its revision and progress still need verification. */
export function checkCursorPage<T>(raw: unknown, options: {
  limit: number; label: string; parse: (item: unknown) => T; key: (item: T) => string; sequence: (item: T) => number
  cursor?: string; revision?: number; after?: number
}): CheckedCursorPage<T> {
  const invalid = (): never => { throw new Error(`${options.label}分页信息无效，请重新读取`) }
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 64 || !record(raw) || !Array.isArray(raw.entries)
    || raw.entries.length > options.limit || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0 || typeof raw.hasMore !== 'boolean') return invalid()
  if (options.revision !== undefined && raw.revision !== options.revision) return invalid()
  if (raw.hasMore ? typeof raw.nextCursor !== 'string' || !raw.nextCursor || raw.nextCursor.length > 8192 || raw.nextCursor === options.cursor || raw.entries.length !== options.limit : raw.nextCursor !== undefined) return invalid()
  const entries = raw.entries.map(options.parse), ids = new Set<string>()
  let after = options.after ?? 0
  for (const entry of entries) {
    const id = options.key(entry), sequence = options.sequence(entry)
    if (!id || ids.has(id) || !Number.isSafeInteger(sequence) || sequence <= after || sequence > (raw.revision as number)) return invalid()
    ids.add(id); after = sequence
  }
  // The revision is the final sequence for this filtered receipt stream. Gaps
  // between rows are valid, but a terminal page cannot silently omit its tail.
  if (raw.hasMore ? after >= (raw.revision as number) : after !== raw.revision) return invalid()
  return { entries, revision: raw.revision as number, hasMore: raw.hasMore, ...(typeof raw.nextCursor === 'string' ? { nextCursor: raw.nextCursor } : {}) }
}
