import type { EngineFileChange } from '@shared/ipc'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { mergeFileChanges } from '@renderer/core/engine/tool-file-changes'
import { workChangePathKey } from './work-file-changes'

export interface WorkProgressChange {
  key: string
  latest: EngineFileChange
  records: EngineFileChange[]
}

/** One acknowledged edit does not acknowledge earlier edits to the same file. */
export function workProgressChangeStatus(records: readonly EngineFileChange[]): { label: string; detail: string; pending: number } {
  const pending = records.filter(change => change.status === 'pending').length
  const kept = records.filter(change => change.status === 'kept').length
  const reverted = records.filter(change => change.status === 'reverted').length
  const detail = `${records.length} 条记录` + [pending && `${pending} 条待确认`, kept && `${kept} 条已保留`, reverted && `${reverted} 条已撤回`]
    .filter(Boolean).map(label => ` · ${label}`).join('')
  const label = pending ? `${pending} / ${records.length} 待确认`
    : kept && reverted ? `${records.length} 条已处理`
      : kept ? '已保留' : reverted ? '已撤回' : '暂无记录'
  return { label, detail, pending }
}

/** Visible panels retry transient sync failures without a tight request loop. */
export function workProgressRetryDelay(failures: number): number {
  return Math.min(30_000, 2_000 * 2 ** Math.max(0, failures - 1))
}

/** Only explicit change receipts belong here; an output file alone proves no edit. */
export function workProgressChanges(sessionId: string, tools: readonly ToolActivity[], stored: readonly EngineFileChange[], root?: string | null): WorkProgressChange[] {
  if (!sessionId) return []
  const streamed = tools.flatMap(tool => mergeFileChanges(
    tool.change, tool.changes,
    tool.commandJob?.sessionId === sessionId ? tool.commandJob.changes : undefined
  )).filter(change => !change.sessionId || change.sessionId === sessionId)
  // HTTP rows must name their owner; legacy streamed receipts inherit the
  // controller's active session. Filter before merging so ID collisions cannot
  // pull another task's content or status into this task.
  const durable = stored.filter(change => change.sessionId === sessionId)
  const receipts = mergeFileChanges(streamed, durable)
  const files = new Map<string, WorkProgressChange>()
  for (const change of receipts) {
    const key = workChangePathKey(change.path, root)
    const current = files.get(key)
    if (!current) files.set(key, { key, latest: change, records: [change] })
    else {
      current.records.push(change)
      if (change.createdAt > current.latest.createdAt ||
        (change.createdAt === current.latest.createdAt && (change.seq ?? 0) >= (current.latest.seq ?? 0))) current.latest = change
    }
  }
  return [...files.values()].sort((a, b) => b.latest.createdAt - a.latest.createdAt || (b.latest.seq ?? 0) - (a.latest.seq ?? 0))
}

export function workProgressPath(path: string, root?: string | null): string {
  const normalized = path.replace(/\\/g, '/')
  const prefix = root?.replace(/\\/g, '/').replace(/\/+$/, '')
  if (prefix && workChangePathKey(normalized).startsWith(`${workChangePathKey(prefix)}/`)) return normalized.slice(prefix.length + 1)
  return normalized
}
