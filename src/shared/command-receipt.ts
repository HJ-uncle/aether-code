import type { CommandJobStatus, CommandOutputEntry } from './command-job'

export interface CommandReceipt {
  type: 'command_result'
  version: 1
  jobId: string
  status: CommandJobStatus
  exitCode: number | null
  signal: string | null
  entries: CommandOutputEntry[]
  nextCursor: number
  nextOffset?: number
  earliestCursor: number
  truncated: boolean
  hasMore: boolean
  error?: { code: string; message?: string }
  notice?: string
}
export interface CommandReceiptError { jobId: string; error: string }
export type CommandReceiptItem = CommandReceipt | CommandReceiptError
const statuses = ['running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function isCommandTool(name?: string): boolean {
  return ['execute_cmd', 'command_output', 'wait_command', 'wait_commands', 'cancel_command'].includes(name ?? '')
}

/** Recognize the engine envelope, never a program's arbitrary JSON text field. */
export function isCommandReceipt(value: unknown): value is CommandReceipt {
  if (!record(value) || value.type !== 'command_result' || value.version !== 1 || typeof value.jobId !== 'string' || !value.jobId ||
    !statuses.includes(String(value.status)) || (value.exitCode !== null && !Number.isInteger(value.exitCode)) ||
    (value.signal !== null && typeof value.signal !== 'string') || !integer(value.nextCursor) || !integer(value.earliestCursor) ||
    (value.nextCursor < value.earliestCursor && !value.truncated) || (value.nextOffset !== undefined && !integer(value.nextOffset)) ||
    typeof value.truncated !== 'boolean' || typeof value.hasMore !== 'boolean' || !Array.isArray(value.entries) ||
    (value.notice !== undefined && typeof value.notice !== 'string') ||
    (value.error !== undefined && (!record(value.error) || typeof value.error.code !== 'string' || value.error.message !== undefined && typeof value.error.message !== 'string'))) return false
  return value.entries.every((entry, index, entries) => record(entry) && integer(entry.seq) && entry.seq > 0 &&
    ['stdout', 'stderr'].includes(String(entry.stream)) && typeof entry.text === 'string' &&
    (index === 0 || entry.seq > entries[index - 1].seq) &&
    (entry.seq <= (value.nextCursor as number) || (index === entries.length - 1 && Boolean(value.nextOffset))))
}

export function parseCommandReceipts(text: string, toolName?: string): CommandReceiptItem[] | null {
  if (!isCommandTool(toolName)) return null
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (isCommandReceipt(value)) return [value]
  // Only the old command_output tool owned this exact page envelope. In
  // execute_cmd the same JSON could be the program's actual business output.
  if (toolName === 'command_output' && record(value) && record(value.job) &&
    Object.keys(value).every(key => ['job', 'entries', 'nextCursor', 'nextOffset', 'earliestCursor', 'truncated', 'hasMore'].includes(key))) {
    const job = value.job
    if (job.schemaVersion === 1 && [job.jobId, job.sessionId, job.ownerSessionId].every(id => typeof id === 'string' && id.length > 0) &&
      integer(job.version) && job.version > 0 && typeof job.command === 'string' && typeof job.cwd === 'string' &&
      Array.isArray(job.args) && job.args.every(arg => typeof arg === 'string') && typeof job.background === 'boolean' &&
      integer(job.createdAt) && integer(job.updatedAt) && integer(job.cursor) && integer(job.earliestCursor) && job.cursor >= job.earliestCursor) {
      const receipt = { ...value, type: 'command_result', version: 1, jobId: job.jobId, status: job.status,
        exitCode: job.exitCode, signal: job.signal, error: job.error }
      if (isCommandReceipt(receipt)) return [receipt]
    }
  }
  if (!record(value) || value.type !== 'command_results' || value.version !== 1 || !Array.isArray(value.results)) return null
  if (!value.results.every(item => isCommandReceipt(item) || record(item) && typeof item.jobId === 'string' && item.jobId.length > 0 &&
    typeof item.error === 'string' && Object.keys(item).every(key => ['jobId', 'error'].includes(key)))) return null
  return value.results as CommandReceiptItem[]
}

/** Historical engine trailers have a fixed marker and coverage vocabulary.
 * Require matching metadata as well so a command printing JSON is never eaten. */
export function commandLogText(text: string, toolName?: string, metadata?: Record<string, unknown>): string {
  if (toolName !== 'execute_cmd' || !metadata || (!record(metadata.commandJob) && !Array.isArray(metadata.changes))) return text
  const marker = '\n[文件变化观察] ', at = text.lastIndexOf(marker)
  if (at < 0) return text
  let tail: unknown
  try { tail = JSON.parse(text.slice(at + marker.length)) } catch { return text }
  if (!record(tail) || Object.keys(tail).some(key => !['changes', 'changeTracking'].includes(key)) || !Array.isArray(tail.changes) || !record(tail.changeTracking)) return text
  const tracking = tail.changeTracking
  if (!['observing', 'complete', 'partial', 'unavailable'].includes(String(tracking.status)) ||
    tracking.scope !== '仅 cwd 内有界文件观察，不覆盖目录外或其他系统副作用' ||
    tracking.rollback !== '可能含外部并发编辑，须审阅并明确选择变更 ID 后回退') return text
  const job = record(metadata.commandJob) ? metadata.commandJob : undefined
  const changes = Array.isArray(metadata.changes) ? metadata.changes : job?.changes
  if (tail.changes.length && (!Array.isArray(changes) || !tail.changes.every(change => record(change) &&
    changes.some(item => record(item) && item.id === change.id && item.path === change.path && item.kind === change.kind)))) return text
  return text.slice(0, at)
}
