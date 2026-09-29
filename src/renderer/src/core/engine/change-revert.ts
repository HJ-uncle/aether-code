import type { EngineRequestInput } from '@shared/ipc'

export type RevertStatus = 'reverted' | 'already_reverted' | 'conflict' | 'unavailable' | 'failed'
export interface RevertItem {
  id: string
  path: string
  status: RevertStatus
  message?: string
  expectedHash?: string
  actualHash?: string
}
export interface RevertReport {
  results: RevertItem[]
  total: number
  reverted: number
  conflicts: number
  unavailable: number
  failed: number
}
export interface RevertIntent {
  sessionId: string
  ids?: string[]
  createdAfter?: number
  fromTurnId?: string
  scope?: 'pending' | 'all'
}
type Request = <T>(input: EngineRequestInput) => Promise<T>
interface HistoryRow {
  id?: string
  role?: string
  content?: unknown
  createdAt?: number
  conversationId?: string
}

const reports = new Map<string, RevertReport>()
const outcomes = new Map<string, RevertItem>()
const listeners = new Set<() => void>()

export function subscribeReverts(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function getRevertReport(sessionId: string): RevertReport | null {
  return reports.get(sessionId) ?? null
}
export function getRevertOutcome(id: string): RevertItem | null {
  return outcomes.get(id) ?? null
}
export function dismissRevertReport(sessionId: string): void {
  reports.delete(sessionId)
  for (const listener of listeners) listener()
}
export function revertComplete(report: RevertReport): boolean {
  return report.results.length === report.total && report.results.every(
    (item) => item.status === 'reverted' || item.status === 'already_reverted'
  )
}
export const revertStatusLabel: Record<RevertStatus, string> = {
  reverted: '已撤回',
  already_reverted: '此前已撤回',
  conflict: '版本冲突',
  unavailable: '不可自动回退',
  failed: '回退失败'
}

export function revertSummary(report: RevertReport): string {
  if (report.total === 0) return '没有需要撤回的改动'
  const restored = report.results.filter((item) => item.status === 'reverted')
  const parts = [`已撤回 ${new Set(restored.map((item) => item.path)).size} 个文件（${restored.length} 处改动）`]
  for (const status of ['already_reverted', 'conflict', 'unavailable', 'failed'] as const) {
    const count = report.results.filter((item) => item.status === status).length
    if (count) parts.push(`${revertStatusLabel[status]} ${count} 处`)
  }
  return parts.join('；')
}

export function groupRevertResults(report: RevertReport): Array<{ path: string; items: RevertItem[] }> {
  const groups = new Map<string, RevertItem[]>()
  for (const item of report.results) {
    const group = groups.get(item.path) ?? []
    group.push(item)
    groups.set(item.path, group)
  }
  return Array.from(groups, ([path, items]) => ({ path, items }))
}

/** Selection belongs to the server: an omitted ids field must never become the visible UI list. */
export async function revertChanges(request: Request, intent: RevertIntent): Promise<RevertReport> {
  const report = await request<RevertReport>({
    method: 'POST', path: '/changes/revert-batch', body: intent
  })
  if (!report || !Array.isArray(report.results) || !Number.isInteger(report.total) || report.total < 0) {
    throw new Error('回退响应无效，已保留对话历史；请重新读取改动状态')
  }
  reports.set(intent.sessionId, report)
  for (const item of report.results) outcomes.set(item.id, item)
  for (const listener of listeners) listener()
  return report
}

/** Stable message and turn IDs are required; neither content nor timestamps select rollback scope. */
export function locateRevertRow(rows: HistoryRow[], target: { id: string; role: string; content: string }): HistoryRow {
  if (target.role !== 'user') throw new Error('只能从用户消息开始回退')
  const row = rows.find((item) => item.id === target.id && item.role === 'user')
  if (!row?.id || !row.conversationId) throw new Error('无法定位该消息的稳定轮次，请重新加载会话后回退')
  return row
}

export async function revertConversationFrom(
  request: Request,
  sessionId: string,
  target: { id: string; role: string; content: string }
): Promise<RevertReport> {
  const rows = await request<HistoryRow[]>({ method: 'GET', path: '/conversation/history', query: { sessionId } })
  if (!Array.isArray(rows)) throw new Error('读取会话历史失败，未执行文件回退')
  const row = locateRevertRow(rows, target)
  const report = await revertChanges(request, { sessionId, scope: 'all', fromTurnId: row.conversationId })
  if (!revertComplete(report)) {
    throw new Error(`${revertSummary(report)}。对话历史已保留，请在改动面板查看逐文件结果。`)
  }
  try {
    await request({ method: 'POST', path: '/conversation/truncate', body: { sessionId, messageId: row.id } })
  } catch (error) {
    throw new Error(`文件回退已完成，但对话删除失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return report
}
