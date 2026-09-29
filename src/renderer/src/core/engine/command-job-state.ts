import type { CommandJobOutput, CommandJobSnapshot, CommandJobStatus, CommandOutputEntry } from '@shared/command-job'
import type { ChatMessage, ToolActivity } from './useChat'

const statuses: CommandJobStatus[] = ['running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']
export const commandStatusLabels: Record<CommandJobStatus, string> = {
  running: '运行中', cancelling: '正在停止', succeeded: '已完成', failed: '失败', cancelled: '已取消', timed_out: '已超时', interrupted: '已中断'
}
export function commandJobActive(job: CommandJobSnapshot): boolean { return job.status === 'running' || job.status === 'cancelling' }
export function normalizeCommandJob(value: unknown): CommandJobSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const job = value as CommandJobSnapshot
  if (job.schemaVersion !== 1 || [job.jobId, job.sessionId, job.ownerSessionId].some(id => typeof id !== 'string' || !id) ||
    !Number.isSafeInteger(job.version) || job.version < 1 || !statuses.includes(job.status) ||
    typeof job.command !== 'string' || !Array.isArray(job.args) || job.args.some(arg => typeof arg !== 'string') ||
    typeof job.cwd !== 'string' || typeof job.background !== 'boolean' ||
    [job.runId, job.ownerRunId, job.turnId, job.toolCallId].some(id => id !== undefined && (typeof id !== 'string' || !id)) ||
    [job.createdAt, job.updatedAt].some(stamp => typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp < 0) ||
    (job.finishedAt !== undefined && (typeof job.finishedAt !== 'number' || !Number.isFinite(job.finishedAt) || job.finishedAt < 0)) ||
    (job.error !== undefined && (!job.error || typeof job.error !== 'object' || typeof job.error.code !== 'string' || typeof job.error.message !== 'string')) ||
    !Number.isSafeInteger(job.cursor) || !Number.isSafeInteger(job.earliestCursor) || job.earliestCursor < 0 || job.cursor < job.earliestCursor ||
    (job.exitCode !== null && !Number.isInteger(job.exitCode)) || (job.signal !== null && typeof job.signal !== 'string')) return undefined
  return job
}
export function sameCommandOwner(a: CommandJobSnapshot, b: CommandJobSnapshot): boolean {
  return a.jobId === b.jobId && a.sessionId === b.sessionId && a.ownerSessionId === b.ownerSessionId &&
    a.runId === b.runId && a.ownerRunId === b.ownerRunId && a.turnId === b.turnId && a.toolCallId === b.toolCallId
}
export function mergeCommandJob(previous: CommandJobSnapshot | undefined, incoming: CommandJobSnapshot): CommandJobSnapshot {
  if (!previous) return incoming
  if (!sameCommandOwner(previous, incoming) || incoming.version <= previous.version ||
    (!commandJobActive(previous) && incoming.status !== previous.status) || incoming.cursor < previous.cursor) return previous
  return incoming
}
export function commandToolState(job: CommandJobSnapshot): ToolActivity['state'] {
  return commandJobActive(job) ? 'running' : job.status === 'succeeded' ? 'done' : job.status === 'cancelled' ? 'cancelled' : job.status === 'interrupted' ? 'interrupted' : 'error'
}
/** Retained diagnostics must not recreate cards after their owning conversation turn is deleted. */
export function visibleChildCommandJobs(messages: ChatMessage[], jobs: CommandJobSnapshot[], sessionId: string): CommandJobSnapshot[] {
  return jobs.filter(job => job.background && job.sessionId === sessionId && job.ownerSessionId !== sessionId &&
    messages.some(message => (job.runId && job.runId === message.runId) || (job.turnId && job.turnId === message.conversationId)))
}
export function attachCommandJobs(messages: ChatMessage[], jobs: CommandJobSnapshot[], sessionId: string): ChatMessage[] {
  let changed = false
  const next = messages.map(message => {
    let messageChanged = false
    const tools = message.tools.map(tool => {
      if (tool.name !== 'execute_cmd') return tool
      const incoming = jobs.find(job => job.background && job.sessionId === sessionId && job.ownerSessionId === sessionId &&
        job.toolCallId === tool.id && ((job.runId && job.runId === message.runId) || (job.turnId && job.turnId === message.conversationId)))
      if (!incoming) return tool
      const commandJob = mergeCommandJob(tool.commandJob, incoming)
      if (commandJob === tool.commandJob) return tool
      messageChanged = changed = true
      return { ...tool, commandJob, state: commandToolState(commandJob), error: commandJob.error?.message,
        finishedAt: commandJob.finishedAt, metadata: { ...tool.metadata, commandJob } }
    })
    return messageChanged ? { ...message, tools } : message
  })
  return changed ? next : messages
}

export interface CommandOutputState { entries: CommandOutputEntry[]; cursor: number; truncated: boolean; bytes: number }
export const emptyCommandOutput: CommandOutputState = { entries: [], cursor: 0, truncated: false, bytes: 0 }
const outputLimit = 256 * 1024
/** Cursor is the last consumed entry sequence, never a character offset or the job's latest cursor. */
export function mergeCommandOutput(previous: CommandOutputState, page: CommandJobOutput): CommandOutputState {
  if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < previous.cursor ||
    !Array.isArray(page.entries) || page.entries.some(entry => !Number.isSafeInteger(entry.seq) || entry.seq <= 0 || entry.seq > page.nextCursor ||
      !['stdout', 'stderr'].includes(entry.stream) || typeof entry.text !== 'string')) throw new Error('命令输出响应无效')
  const fresh = page.entries.filter(entry => entry.seq > previous.cursor)
  if (fresh.some((entry, index) => index > 0 && entry.seq <= fresh[index - 1].seq)) throw new Error('命令输出顺序无效')
  let entries = [...previous.entries, ...fresh]
  let bytes = previous.bytes + fresh.reduce((total, entry) => total + new TextEncoder().encode(entry.text).byteLength, 0)
  let truncated = previous.truncated || page.truncated
  while (bytes > outputLimit && entries.length > 1) {
    bytes -= new TextEncoder().encode(entries[0].text).byteLength
    entries = entries.slice(1)
    truncated = true
  }
  return { entries, bytes, cursor: page.nextCursor, truncated }
}
export function exportCommandJob(job: CommandJobSnapshot): string {
  return [`状态：${commandStatusLabels[job.status]}`, `工作目录：${job.cwd}`, `命令：${[job.command, ...job.args].join(' ')}`,
    job.exitCode === null ? '' : `退出码：${job.exitCode}`, job.signal ? `信号：${job.signal}` : '',
    job.error ? `原因：${job.error.code} ${job.error.message}` : '', `任务：${job.jobId}`].filter(Boolean).join('\n')
}
