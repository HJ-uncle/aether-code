import type { CommandJobSnapshot } from '@shared/command-job'
import { request } from '@renderer/core/engine/client'
import { normalizeCommandJob, sameCommandOwner } from '@renderer/core/engine/command-job-state'
import { assertEngineSource, getExpectedEngine } from '@renderer/core/engine/source'
import type { ChatFileContext } from './chat-link'
import { isCommandReceipt, type CommandReceipt } from '@shared/command-receipt'

export function commandReceiptJob(jobId: string, metadata?: Record<string, unknown>): CommandJobSnapshot | undefined {
  const candidates = [metadata?.commandJob, ...Array.isArray(metadata?.commandJobs) ? metadata.commandJobs : []]
  return candidates.map(normalizeCommandJob).find(job => job?.jobId === jobId)
}

export function commandReceiptBelongs(job: CommandJobSnapshot, context?: ChatFileContext): boolean {
  return Boolean(context?.sessionId && (job.sessionId === context.sessionId ||
    job.ownerSessionId === context.sessionId && job.sessionId === context.receiptParentSessionId))
}

/** One user action reads one bounded page. The captured job is the scope authority. */
export async function readCommandReceiptPage(job: CommandJobSnapshot, cursor: number, cursorOffset: number, source: number): Promise<CommandReceipt> {
  assertEngineSource(source)
  const response = await request<unknown>({ method: 'GET', path: `/command-jobs/${encodeURIComponent(job.jobId)}/output`,
    query: { sessionId: job.sessionId, cursor, cursorOffset, maxBytes: 32768 }, expectedEngine: getExpectedEngine() })
  assertEngineSource(source)
  if (!response.ok) throw new Error(response.message || '命令输出读取失败，请重试')
  if (!response.data || typeof response.data !== 'object') throw new Error('命令输出响应无效')
  const page = response.data as Record<string, unknown>, nextJob = normalizeCommandJob(page.job)
  if (!nextJob || !sameCommandOwner(job, nextJob)) throw new Error('命令输出归属不一致')
  const receipt = { ...page, type: 'command_result', version: 1, jobId: nextJob.jobId,
    status: nextJob.status, exitCode: nextJob.exitCode, signal: nextJob.signal, error: nextJob.error }
  if (!isCommandReceipt(receipt) || receipt.nextCursor < cursor ||
    receipt.entries.some(entry => entry.seq <= cursor) ||
    receipt.nextCursor === cursor && (receipt.nextOffset ?? 0) < cursorOffset && !receipt.truncated ||
    receipt.entries.reduce((bytes, entry) => bytes + new TextEncoder().encode(entry.text).byteLength, 0) > 32768 ||
    receipt.hasMore && receipt.nextCursor === cursor && (receipt.nextOffset ?? 0) === cursorOffset) throw new Error('命令输出分页响应无效')
  return receipt
}
