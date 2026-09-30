import { useSyncExternalStore } from 'react'
import { subscribeEngineSource } from './source'
import type { CommandJobSnapshot } from '@shared/command-job'
import { request as engineRequest } from './client'
import type { EngineRequestInput } from '@shared/ipc'
import type { CommandJobOutput } from '@shared/command-job'
import { emptyCommandOutput, mergeCommandJob, mergeCommandOutput, normalizeCommandJob, sameCommandOwner, type CommandOutputState } from './command-job-state'

export interface CommandJobView { job: CommandJobSnapshot; output: CommandOutputState }
const jobs = new Map<string, CommandJobView>()
const listeners = new Set<() => void>()
const requests = new Map<string, Promise<CommandJobView>>()
const listings = new Map<string, Promise<void>>()
let activeSessionId: string | null = null
let generation = 0
export class CommandJobRequestError extends Error {
  constructor(public readonly code: number, message: string) { super(message) }
}
export function commandJobMissing(error: unknown): boolean { return error instanceof CommandJobRequestError && [404, 40400].includes(error.code) }
async function requestOrThrow<T>(input: EngineRequestInput): Promise<T> {
  const response = await engineRequest<T>(input)
  if (!response.ok) throw new CommandJobRequestError(response.code, [404, 40400].includes(response.code) ? '任务已过期或不存在' : response.message || '命令请求失败')
  return response.data as T
}
/** Only the viewed session retains output buffers. In-flight requests cannot recreate a cleared cache. */
export function activateCommandSession(sessionId: string): void {
  if (activeSessionId === sessionId) return
  generation++; activeSessionId = sessionId; jobs.clear(); requests.clear(); listings.clear(); notify()
}
const key = (sessionId: string, jobId: string): string => JSON.stringify([sessionId, jobId])
function notify(): void { for (const listener of listeners) listener() }
export function subscribeCommandJobs(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
export function getCommandJobs(sessionId: string | null): CommandJobSnapshot[] { return [...jobs.values()].filter(view => view.job.sessionId === sessionId).map(view => view.job) }
export function useCommandJob(sessionId: string, jobId: string): CommandJobView | undefined {
  return useSyncExternalStore(subscribeCommandJobs, () => jobs.get(key(sessionId, jobId)))
}
export function ingestCommandJob(raw: unknown): CommandJobSnapshot | undefined {
  const incoming = normalizeCommandJob(raw)
  if (!incoming || incoming.sessionId !== activeSessionId) return undefined
  const id = key(incoming.sessionId, incoming.jobId), previous = jobs.get(id)
  const job = mergeCommandJob(previous?.job, incoming)
  if (job !== previous?.job) { jobs.set(id, { job, output: previous?.output ?? emptyCommandOutput }); notify() }
  return job
}
export function forgetCommandSession(sessionId: string): void {
  if (activeSessionId === sessionId) { generation++; activeSessionId = null }
  for (const [id, view] of jobs) if (view.job.sessionId === sessionId) jobs.delete(id)
  notify()
}
export async function refreshCommandJobs(sessionId: string): Promise<void> {
  if (activeSessionId !== sessionId) return
  const epoch = generation
  const pending = listings.get(sessionId)
  if (pending) return pending
  const request = (async () => {
    const result = await requestOrThrow<{ jobs: CommandJobSnapshot[] }>({ method: 'GET', path: '/command-jobs', query: { sessionId } })
    if (epoch !== generation || activeSessionId !== sessionId) return
    if (!Array.isArray(result?.jobs)) throw new Error('命令任务列表无效')
    for (const job of result.jobs) if (job.sessionId === sessionId) ingestCommandJob(job)
  })()
  listings.set(sessionId, request)
  try { await request } finally { if (listings.get(sessionId) === request) listings.delete(sessionId) }
}
export async function refreshCommandOutput(sessionId: string, jobId: string): Promise<CommandJobView> {
  if (activeSessionId !== sessionId) throw new Error('命令会话已切换')
  const epoch = generation
  const id = key(sessionId, jobId), pending = requests.get(id)
  if (pending) return pending
  const request = (async () => {
    // A bounded tail is at most four full pages; extra pages allow entries straddling a page limit.
    for (let pageIndex = 0; pageIndex < 8; pageIndex++) {
      const previous = jobs.get(id)
      const page = await requestOrThrow<CommandJobOutput>({ method: 'GET', path: `/command-jobs/${encodeURIComponent(jobId)}/output`, query: { sessionId, cursor: previous?.output.cursor ?? 0, maxBytes: 65536 } })
      if (epoch !== generation || activeSessionId !== sessionId) throw new Error('命令会话已切换')
      const incoming = normalizeCommandJob(page?.job)
      if (!incoming || incoming.sessionId !== sessionId || incoming.jobId !== jobId || (previous && !sameCommandOwner(previous.job, incoming))) throw new Error('命令任务归属不匹配')
      const current = jobs.get(id)
      if (previous && current && !sameCommandOwner(previous.job, current.job)) throw new Error('命令任务已变化')
      const job = mergeCommandJob(current?.job, incoming)
      const output = mergeCommandOutput(current?.output ?? emptyCommandOutput, page)
      const view = { job, output }
      jobs.set(id, view); notify()
      if (!page.hasMore) return view
      if (output.cursor <= (previous?.output.cursor ?? 0)) throw new Error('命令输出游标未前进')
    }
    return jobs.get(id)!
  })()
  requests.set(id, request)
  try { return await request } finally { if (requests.get(id) === request) requests.delete(id) }
}
export async function cancelCommandJob(sessionId: string, jobId: string): Promise<CommandJobSnapshot> {
  if (activeSessionId !== sessionId) throw new Error('命令会话已切换')
  const epoch = generation
  const result = await requestOrThrow<CommandJobSnapshot>({ method: 'POST', path: `/command-jobs/${encodeURIComponent(jobId)}/cancel`, body: { sessionId } })
  if (epoch !== generation || activeSessionId !== sessionId) throw new Error('命令会话已切换')
  const job = normalizeCommandJob(result)
  if (!job || job.sessionId !== sessionId || job.jobId !== jobId) throw new Error('停止响应的任务归属不匹配')
  const previous = jobs.get(key(sessionId, jobId))
  if (previous && !sameCommandOwner(previous.job, job)) throw new Error('停止响应的任务归属已变化')
  return ingestCommandJob(job)!
}

subscribeEngineSource(() => {
  generation++
  activeSessionId = null
  jobs.clear()
  requests.clear()
  listings.clear()
  notify()
})
