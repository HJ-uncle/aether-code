import type { EngineRequestResult } from '@shared/ipc'
import type { EngineHistoryRow } from './chat-history'

export const ARCHIVE_PAGE_SIZE = 200
export interface ArchiveWindow {
  sessionId: string
  rows: EngineHistoryRow[]
  firstPage: number
  lastPage: number
  total: number
  revision?: string
}
export type ArchivePageRequest = (current: number, pageSize: number) => Promise<EngineRequestResult<EngineHistoryRow[]>>

function page(result: EngineRequestResult<EngineHistoryRow[]>, current: number, pageSize: number): { rows: EngineHistoryRow[]; total: number; revision?: string } {
  if (!result.ok || !Array.isArray(result.data)) throw new Error(result.message || '读取历史归档失败，请重试')
  const pagination = result.pagination
  if (!pagination || pagination.current !== current || pagination.pageSize !== pageSize || !Number.isSafeInteger(pagination.total) || pagination.total < 0 || pagination.totalPages !== Math.ceil(pagination.total / pageSize)) throw new Error('历史归档分页信息无效，请重试')
  if (result.metadata?.archiveMessageCount !== undefined && result.metadata.archiveMessageCount !== pagination.total) throw new Error('历史归档数量不一致，请重试')
  if (result.data.length !== Math.max(0, Math.min(pageSize, pagination.total - (current - 1) * pageSize))) throw new Error('历史归档页不完整，请重试')
  const ids = new Set<string>()
  for (const row of result.data) {
    if (!row.id || ids.has(row.id)) throw new Error('历史归档出现重复或缺失的消息 ID，请重试')
    ids.add(row.id)
  }
  return { rows: result.data, total: pagination.total, ...(typeof result.metadata?.archiveRevision === 'string' ? { revision: result.metadata.archiveRevision } : {}) }
}

/** Load one older page. Changed archives refresh only the already selected window. */
export async function loadArchiveWindow(request: ArchivePageRequest, sessionId: string, previous?: ArchiveWindow): Promise<ArchiveWindow> {
  const header = page(await request(1, 1), 1, 1)
  const lastPage = Math.max(1, Math.ceil(header.total / ARCHIVE_PAGE_SIZE))
  const prior = previous?.sessionId === sessionId ? previous : undefined
  const unchanged = prior && header.revision !== undefined && header.revision === prior.revision && header.total === prior.total && lastPage === prior.lastPage
  if (unchanged && prior.firstPage === 1) return { ...prior }
  const selectedPageCount = prior ? prior.lastPage - prior.firstPage + 1 : 0
  const firstPage = prior ? Math.max(1, lastPage - selectedPageCount) : lastPage
  const rows: EngineHistoryRow[] = []
  if (header.total > 0) {
    const end = unchanged ? firstPage : lastPage
    for (let current = firstPage; current <= end; current++) {
      const result = page(await request(current, ARCHIVE_PAGE_SIZE), current, ARCHIVE_PAGE_SIZE)
      if (result.total !== header.total || result.revision !== header.revision) throw new Error('历史记录在加载期间有更新，请再次加载')
      rows.push(...result.rows)
    }
    if (unchanged) rows.push(...prior.rows)
  }
  const ids = new Set<string>()
  for (const row of rows) {
    if (!row.id || ids.has(row.id)) throw new Error('历史归档跨页消息 ID 重复，请重试')
    ids.add(row.id)
  }
  return { sessionId, rows, firstPage, lastPage, total: header.total, ...(header.revision !== undefined ? { revision: header.revision } : {}) }
}

/** A fresh snapshot updates loaded rows and adds later rows without reintroducing a summary. */
export function mergeArchiveProjection(rows: EngineHistoryRow[], projection: EngineHistoryRow[]): EngineHistoryRow[] {
  const result = [...rows]
  const current = projection.filter(row => !(row.role === 'system' && row.metadata?.isCompactSummary === true))
  for (let index = 0; index < current.length; index++) {
    const row = current[index]
    if (!row.id) continue
    const existing = result.findIndex(item => item.id === row.id)
    if (existing >= 0) {
      result[existing] = row.role === 'tool' && row.content === '[tool result cleared]' ? { ...row, content: result[existing].content } : row
      continue
    }
    const following = current.slice(index + 1).find(item => result.some(known => known.id === item.id))
    const before = following ? result.findIndex(item => item.id === following.id) : result.length
    result.splice(before, 0, row)
  }
  return result
}
