import type { EngineRequestResult } from '@shared/ipc'
import type { EngineHistoryRow } from './chat-history'
import { checkHistoryPage } from './history-page'

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
export type ArchivePageAction = 'older' | 'newer' | 'latest'
export interface ArchivePageInfo { firstPage: number; lastPage: number; totalPages: number; unversioned: boolean }

function page(result: EngineRequestResult<EngineHistoryRow[]>, current: number, pageSize: number): { rows: EngineHistoryRow[]; total: number; revision?: string } {
  return checkHistoryPage(result, current, pageSize, '历史归档')
}

/** Load one older page. Changed archives refresh only the already selected window. */
export async function loadArchiveWindow(request: ArchivePageRequest, sessionId: string, previous?: ArchiveWindow, action: ArchivePageAction = 'older'): Promise<ArchiveWindow> {
  const header = page(await request(1, 1), 1, 1)
  const lastPage = Math.max(1, Math.ceil(header.total / ARCHIVE_PAGE_SIZE))
  const prior = previous?.sessionId === sessionId ? previous : undefined
  if (header.revision === undefined) {
    // Equal counts cannot detect same-count edits in legacy SQLite archives.
    // A page stands alone; navigating replaces it rather than merging epochs.
    let current = action === 'latest' || !prior ? lastPage
      : Math.max(1, Math.min(lastPage, action === 'older' ? prior.firstPage - 1 : prior.lastPage + 1))
    let selected = page(await request(current, ARCHIVE_PAGE_SIZE), current, ARCHIVE_PAGE_SIZE)
    const actualLast = Math.max(1, Math.ceil(selected.total / ARCHIVE_PAGE_SIZE))
    if (current > actualLast) {
      current = actualLast
      selected = page(await request(current, ARCHIVE_PAGE_SIZE), current, ARCHIVE_PAGE_SIZE)
    }
    if (!selected.rows.length && selected.total > 0) throw new Error('历史记录在加载期间有更新，请再次加载')
    return { sessionId, rows: selected.rows, firstPage: current, lastPage: current, total: selected.total,
      ...(selected.revision !== undefined ? { revision: selected.revision } : {}) }
  }
  if (action === 'newer' && prior?.revision === header.revision && prior.total === header.total) return { ...prior }
  const selectedPrior = action === 'latest' ? undefined : prior
  const unchanged = selectedPrior && header.revision === selectedPrior.revision && header.total === selectedPrior.total && lastPage === selectedPrior.lastPage
  if (unchanged && selectedPrior.firstPage === 1) return { ...selectedPrior }
  const selectedPageCount = selectedPrior ? selectedPrior.lastPage - selectedPrior.firstPage + 1 : 0
  const firstPage = selectedPrior ? Math.max(1, lastPage - selectedPageCount) : lastPage
  const rows: EngineHistoryRow[] = []
  if (header.total > 0) {
    const end = unchanged ? firstPage : lastPage
    for (let current = firstPage; current <= end; current++) {
      const result = page(await request(current, ARCHIVE_PAGE_SIZE), current, ARCHIVE_PAGE_SIZE)
      if (result.total !== header.total || result.revision !== header.revision) throw new Error('历史记录在加载期间有更新，请再次加载')
      rows.push(...result.rows)
    }
    if (unchanged) rows.push(...selectedPrior.rows)
  }
  const ids = new Set<string>()
  for (const row of rows) {
    if (!row.id || ids.has(row.id)) throw new Error('历史归档跨页消息 ID 重复，请重试')
    ids.add(row.id)
  }
  return { sessionId, rows, firstPage, lastPage, total: header.total, ...(header.revision !== undefined ? { revision: header.revision } : {}) }
}

/** A legacy page has no proof that a later compact snapshot is the same epoch. */
export function archiveDisplayHistory(window: ArchiveWindow, projection: EngineHistoryRow[]): EngineHistoryRow[] {
  return window.revision === undefined ? window.rows : mergeArchiveProjection(window.rows, projection)
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
