import { useCallback, useLayoutEffect, useSyncExternalStore } from 'react'
import { subscribeEngineSource } from './source'
import type { CommandJobSnapshot } from '@shared/command-job'
import { request as engineRequest } from './client'
import type { EngineRequestInput } from '@shared/ipc'
import type { CommandJobOutput } from '@shared/command-job'
import { emptyCommandOutput, mergeCommandJob, mergeCommandOutput, normalizeCommandJob, sameCommandOwner, type CommandOutputState } from './command-job-state'

export interface CommandJobView { job: CommandJobSnapshot; output: CommandOutputState }
const jobs = new Map<string, CommandJobView>()
const listeners = new Set<() => void>()
const jobListeners = new Map<string, Set<() => void>>()
const outputReaders = new Map<string, { count: number }>()
const outputLru = new Map<string, true>()
const listedAt = new Map<string, number>()
const requests = new Map<string, { promise: Promise<CommandJobView>; token: object }>()
const listings = new Map<string, Promise<void>>()
const activeSessions = new Map<string, string>()
const deletedJobs = new Set<string>()
const sessionEpochs = new Map<string, object>()
const LIST_TTL_MS = 1000
const OUTPUT_JOB_LIMIT = 4, OUTPUT_TOTAL_LIMIT = 1024 * 1024
const ownsSession = (sessionId: string): boolean => [...activeSessions.values()].includes(sessionId)
const revision = (sessionId: string): object | undefined => sessionEpochs.get(sessionId)
export class CommandJobRequestError extends Error {
  constructor(public readonly code: number, message: string) { super(message) }
}
export function commandJobMissing(error: unknown): boolean { return error instanceof CommandJobRequestError && [404, 40400].includes(error.code) }
async function requestOrThrow<T>(input: EngineRequestInput): Promise<T> {
  const response = await engineRequest<T>(input)
  if (!response.ok) throw new CommandJobRequestError(response.code, [404, 40400].includes(response.code) ? '任务已过期或不存在' : response.message || '命令请求失败')
  return response.data as T
}
function clearSessionCache(sessionId: string): void {
  // Object identity can be forgotten after the last owner leaves without
  // letting a response from an earlier visit match a newly created session.
  if (ownsSession(sessionId)) sessionEpochs.set(sessionId, {})
  else sessionEpochs.delete(sessionId)
  for (const [id, view] of jobs) if (view.job.sessionId === sessionId) { jobs.delete(id); dropOutput(id); notifyJob(id) }
  for (const id of requests.keys()) if (id.startsWith(JSON.stringify([sessionId]).slice(0, -1) + ',')) requests.delete(id)
  if (!ownsSession(sessionId)) for (const id of outputReaders.keys()) if (id.startsWith(JSON.stringify([sessionId]).slice(0, -1) + ',')) outputReaders.delete(id)
  listings.delete(sessionId)
  listedAt.delete(sessionId)
}
function releaseSession(sessionId: string): void {
  if (!ownsSession(sessionId)) clearSessionCache(sessionId)
}
/** Code and Work each keep their viewed session alive without evicting the other's output. */
export function activateCommandSession(sessionId: string, owner = 'code'): void {
  const previous = activeSessions.get(owner)
  if (previous === sessionId) return
  if (!sessionEpochs.has(sessionId)) sessionEpochs.set(sessionId, {})
  activeSessions.set(owner, sessionId)
  if (previous) releaseSession(previous)
  notify()
}
export function deactivateCommandSession(owner: string): void {
  const previous = activeSessions.get(owner)
  activeSessions.delete(owner)
  if (previous) releaseSession(previous)
  notify()
}
const key = (sessionId: string, jobId: string): string => JSON.stringify([sessionId, jobId])
function notify(): void { for (const listener of listeners) listener() }
function notifyJob(id: string): void { for (const listener of jobListeners.get(id) ?? []) listener() }
/** Log arrival must not re-sort service lists or re-project conversation history. */
function statusChanged(previous: CommandJobSnapshot | undefined, next: CommandJobSnapshot): boolean {
  if (previous === next) return false
  return !previous || previous.status !== next.status || previous.exitCode !== next.exitCode || previous.signal !== next.signal ||
    previous.finishedAt !== next.finishedAt || previous.error?.code !== next.error?.code || previous.error?.message !== next.error?.message ||
    JSON.stringify(previous.changes) !== JSON.stringify(next.changes) || JSON.stringify(previous.changeTracking) !== JSON.stringify(next.changeTracking)
}
function dropOutput(id: string): void {
  outputLru.delete(id)
  requests.delete(id)
  const view = jobs.get(id)
  if (view?.output.initialized) { jobs.set(id, { job: view.job, output: emptyCommandOutput }); notifyJob(id) }
}
export function getCommandOutputCacheUsage(): { jobs: number; bytes: number } {
  return { jobs: outputLru.size, bytes: [...outputLru.keys()].reduce((bytes, id) => bytes + (jobs.get(id)?.output.bytes ?? 0), 0) }
}
function retainOutput(id: string): void {
  outputLru.delete(id); outputLru.set(id, true)
  while (outputLru.size > OUTPUT_JOB_LIMIT || getCommandOutputCacheUsage().bytes > OUTPUT_TOTAL_LIMIT) {
    const candidate = [...outputLru.keys()].find(key => key !== id && !outputReaders.has(key)) ?? outputLru.keys().next().value!
    dropOutput(candidate)
  }
}
/** Reader ownership is independent of a chat's long-lived status subscription. */
export function retainCommandOutput(sessionId: string, jobId: string): () => void {
  const id = key(sessionId, jobId)
  const readers = outputReaders.get(id) ?? { count: 0 }
  readers.count++
  outputReaders.set(id, readers)
  let released = false
  return () => {
    if (released || outputReaders.get(id) !== readers) return
    released = true
    if (--readers.count === 0) { outputReaders.delete(id); dropOutput(id) }
  }
}
export function subscribeCommandJobs(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
export function getCommandJobs(sessionId: string | null): CommandJobSnapshot[] { return [...jobs.values()].filter(view => view.job.sessionId === sessionId).map(view => view.job) }
/** Snapshot consumers must respect acknowledged deletion even while a parent still has an older array. */
export function isCommandJobDeleted(sessionId: string, jobId: string): boolean { return deletedJobs.has(key(sessionId, jobId)) }
export function subscribeCommandOutput(sessionId: string, jobId: string, listener: () => void): () => void {
  const id = key(sessionId, jobId), group = jobListeners.get(id) ?? new Set<() => void>()
  group.add(listener); jobListeners.set(id, group)
  return () => { group.delete(listener); if (!group.size) jobListeners.delete(id) }
}
export function useCommandJob(sessionId: string, jobId: string, readOutput = true): CommandJobView | undefined {
  const subscribe = useCallback((listener: () => void) => subscribeCommandOutput(sessionId, jobId, listener), [sessionId, jobId])
  useLayoutEffect(() => readOutput ? retainCommandOutput(sessionId, jobId) : undefined, [sessionId, jobId, readOutput])
  return useSyncExternalStore(subscribe, () => jobs.get(key(sessionId, jobId)))
}
function ingest(raw: unknown, broadcast = true): { job: CommandJobSnapshot; changed: boolean } | undefined {
  const incoming = normalizeCommandJob(raw)
  if (!incoming || !ownsSession(incoming.sessionId)) return undefined
  const id = key(incoming.sessionId, incoming.jobId)
  if (deletedJobs.has(id)) return undefined
  const previous = jobs.get(id)
  const job = mergeCommandJob(previous?.job, incoming)
  const changed = statusChanged(previous?.job, job)
  if (job !== previous?.job) { jobs.set(id, { job, output: previous?.output ?? emptyCommandOutput }); notifyJob(id); if (broadcast && changed) notify() }
  return { job, changed }
}
export function ingestCommandJob(raw: unknown): CommandJobSnapshot | undefined { return ingest(raw)?.job }
export function forgetCommandSession(sessionId: string): void {
  for (const [owner, active] of activeSessions) if (active === sessionId) activeSessions.delete(owner)
  releaseSession(sessionId)
  notify()
}
/** History replacement must fence old reads without detaching Code/Work owners. */
export function invalidateCommandSession(sessionId: string): void {
  clearSessionCache(sessionId)
  notify()
}
export async function refreshCommandJobs(sessionId: string, options: { force?: boolean } = {}): Promise<void> {
  if (!ownsSession(sessionId)) return
  const epoch = revision(sessionId)
  const pending = listings.get(sessionId)
  if (pending) return pending
  if (!options.force && Date.now() - (listedAt.get(sessionId) ?? 0) < LIST_TTL_MS) return
  const baseline = new Map([...jobs].filter(([, view]) => view.job.sessionId === sessionId).map(([id, view]) => [id, view.job]))
  const request = (async () => {
    const result = await requestOrThrow<{ jobs: CommandJobSnapshot[] }>({ method: 'GET', path: '/command-jobs', query: { sessionId } })
    if (epoch !== revision(sessionId) || !ownsSession(sessionId)) return
    if (!Array.isArray(result?.jobs) || result.jobs.some(job => !normalizeCommandJob(job) || job.sessionId !== sessionId)) throw new Error('命令任务列表无效')
    let changed = false
    const returned = new Set(result.jobs.map(job => key(sessionId, job.jobId)))
    for (const job of result.jobs) if (ingest(job, false)?.changed) changed = true
    // Do not delete a task that a newer stream/output response advanced while
    // this list request was in flight. A later list can reconcile that version.
    for (const [id, previous] of baseline) if (!returned.has(id) && jobs.get(id)?.job === previous) {
      deletedJobs.add(id); jobs.delete(id); dropOutput(id); notifyJob(id); changed = true
    }
    listedAt.set(sessionId, Date.now())
    if (changed) notify()
  })()
  listings.set(sessionId, request)
  try { await request } finally { if (listings.get(sessionId) === request) listings.delete(sessionId) }
}
export async function refreshCommandOutput(sessionId: string, jobId: string): Promise<CommandJobView> {
  if (!ownsSession(sessionId)) throw new Error('命令会话已切换')
  const epoch = revision(sessionId)
  const id = key(sessionId, jobId), pending = requests.get(id)
  if (pending) return pending.promise
  const token = {}
  const request: Promise<CommandJobView> = (async () => {
      const previous = jobs.get(id)
      const outputBefore = previous?.output ?? emptyCommandOutput
      const page = await requestOrThrow<CommandJobOutput>({ method: 'GET', path: `/command-jobs/${encodeURIComponent(jobId)}/output`,
        query: { sessionId, maxBytes: 65536, ...(outputBefore.initialized
          ? { cursor: outputBefore.cursor, cursorOffset: outputBefore.cursorOffset } : { tail: true }) } })
      if (epoch !== revision(sessionId) || !ownsSession(sessionId)) throw new Error('命令会话已切换')
      // Closing/evicting output removes this exact request. A reopened reader
      // gets a different token, so no per-job revision tombstone is needed.
      if (requests.get(id)?.token !== token) throw new Error('命令日志视图已关闭')
      if (deletedJobs.has(id)) throw new CommandJobRequestError(404, '历史记录已删除')
      const incoming = normalizeCommandJob(page?.job)
      if (!incoming || incoming.sessionId !== sessionId || incoming.jobId !== jobId || (previous && !sameCommandOwner(previous.job, incoming))) throw new Error('命令任务归属不匹配')
      const current = jobs.get(id)
      if (previous && current && !sameCommandOwner(previous.job, current.job)) throw new Error('命令任务已变化')
      const job = mergeCommandJob(current?.job, incoming)
      if (!Array.isArray(page.entries) || page.entries.reduce((bytes, entry) => bytes + (typeof entry?.text === 'string' ? new TextEncoder().encode(entry.text).byteLength : 65537), 0) > 65536) throw new Error('命令输出超过单页预算')
      const output = mergeCommandOutput(current?.output ?? emptyCommandOutput, page)
      const view = current?.job === job && current.output === output ? current : { job, output }
      if (page.hasMore && outputBefore.initialized && output.cursor === outputBefore.cursor && output.cursorOffset === outputBefore.cursorOffset) throw new Error('命令输出游标未前进')
      if (view !== current) { jobs.set(id, view); notifyJob(id); if (statusChanged(current?.job, job)) notify() }
      retainOutput(id)
      return view
  })()
  requests.set(id, { promise: request, token })
  try { return await request } finally { if (requests.get(id)?.token === token) requests.delete(id) }
}
export async function cancelCommandJob(sessionId: string, jobId: string): Promise<CommandJobSnapshot> {
  if (!ownsSession(sessionId)) throw new Error('命令会话已切换')
  const epoch = revision(sessionId)
  const result = await requestOrThrow<CommandJobSnapshot>({ method: 'POST', path: `/command-jobs/${encodeURIComponent(jobId)}/cancel`, body: { sessionId } })
  if (epoch !== revision(sessionId) || !ownsSession(sessionId)) throw new Error('命令会话已切换')
  const job = normalizeCommandJob(result)
  if (!job || job.sessionId !== sessionId || job.jobId !== jobId) throw new Error('停止响应的任务归属不匹配')
  const previous = jobs.get(key(sessionId, jobId))
  if (previous && !sameCommandOwner(previous.job, job)) throw new Error('停止响应的任务归属已变化')
  listedAt.delete(sessionId)
  return ingestCommandJob(job)!
}

export async function restartCommandJob(sessionId: string, jobId: string): Promise<CommandJobSnapshot> {
  if (!ownsSession(sessionId)) throw new Error('命令会话已切换')
  const epoch = revision(sessionId)
  const result = await requestOrThrow<CommandJobSnapshot>({ method: 'POST', path: `/command-jobs/${encodeURIComponent(jobId)}/restart`, body: { sessionId } })
  if (epoch !== revision(sessionId) || !ownsSession(sessionId)) throw new Error('命令会话已切换')
  const job = normalizeCommandJob(result)
  if (!job || job.sessionId !== sessionId || job.jobId === jobId || !job.background) throw new Error('重启响应的任务归属不匹配')
  listedAt.delete(sessionId)
  return ingestCommandJob(job)!
}

export async function deleteCommandJob(sessionId: string, jobId: string): Promise<void> {
  if (!ownsSession(sessionId)) throw new Error('命令会话已切换')
  const epoch = revision(sessionId)
  const id = key(sessionId, jobId)
  await requestOrThrow<{ deleted: boolean }>({ method: 'DELETE', path: `/command-jobs/${encodeURIComponent(jobId)}`, query: { sessionId } })
  if (epoch !== revision(sessionId) || !ownsSession(sessionId)) throw new Error('命令会话已切换')
  deletedJobs.add(id)
  jobs.delete(id)
  dropOutput(id); notifyJob(id); listedAt.delete(sessionId)
  notify()
}

subscribeEngineSource(() => {
  activeSessions.clear()
  sessionEpochs.clear()
  deletedJobs.clear()
  jobs.clear()
  outputLru.clear(); outputReaders.clear(); listedAt.clear()
  requests.clear()
  listings.clear()
  for (const id of jobListeners.keys()) notifyJob(id)
  notify()
})
