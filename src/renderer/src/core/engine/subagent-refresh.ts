import type { SubagentRun } from '@shared/subagent'
import { isSubagentActive } from './subagent-state'

export const SUBAGENT_REFRESH_MAX_REQUESTS = 8
export const SUBAGENT_REFRESH_MAX_CONCURRENCY = 2
export const SUBAGENT_REFRESH_MAX_QUEUE = 256
export const SUBAGENT_REFRESH_MAX_QUEUE_BYTES = 256 * 1024

let observationInFlight = 0
const observationWaiters: Array<() => void> = []
/** Permits belong to the real bridge promise, including across source changes. */
export async function withSubagentReadPermit<T>(read: () => Promise<T>): Promise<T> {
  if (observationInFlight >= SUBAGENT_REFRESH_MAX_CONCURRENCY) {
    if (observationWaiters.length >= 32) throw new Error('子代理观察队列已满，请稍后重试')
    await new Promise<void>(resolve => observationWaiters.push(resolve))
  } else observationInFlight++
  try { return await read() }
  finally {
    const next = observationWaiters.shift()
    if (next) next()
    else observationInFlight--
  }
}

export type SubagentObservationJob = { kind: 'discovery'; mode: 'active' | 'changes' } | { kind: 'summary'; runId: string }
export interface SubagentObservationCandidates {
  selectedRunId?: string
  knownIds: readonly string[]
  pendingIds: readonly string[]
  modes: readonly ('active' | 'changes')[]
}
/** A second discovery cannot occupy both workers before selected/known work is dispatched. */
export function nextSubagentObservationJob(candidates: SubagentObservationCandidates,
  issued: readonly SubagentObservationJob[]): SubagentObservationJob | undefined {
  const readIds = new Set(issued.flatMap(job => job.kind === 'summary' ? [job.runId] : []))
  const modes = new Set(issued.flatMap(job => job.kind === 'discovery' ? [job.mode] : []))
  const selected = candidates.selectedRunId && !readIds.has(candidates.selectedRunId) ? candidates.selectedRunId : undefined
  const known = candidates.knownIds.find(id => !readIds.has(id))
  const pending = candidates.pendingIds.find(id => !readIds.has(id))
  const mode = candidates.modes.find(value => !modes.has(value))
  if (!modes.size && mode) return { kind: 'discovery', mode }
  if (selected) return { kind: 'summary', runId: selected }
  if (!candidates.knownIds.some(id => readIds.has(id)) && known) return { kind: 'summary', runId: known }
  if (!candidates.pendingIds.some(id => readIds.has(id)) && pending) return { kind: 'summary', runId: pending }
  if (mode) return { kind: 'discovery', mode }
  const id = issued.filter(job => job.kind === 'summary').length % 2 ? pending ?? known : known ?? pending
  return id ? { kind: 'summary', runId: id } : undefined
}

export async function executeSubagentObservationCycle(options: {
  candidates: () => SubagentObservationCandidates
  read: (job: SubagentObservationJob) => Promise<void>
  current: () => boolean
  maxJobs?: number
}): Promise<SubagentObservationJob[]> {
  const issued: SubagentObservationJob[] = []
  const limit = Math.min(7, Math.max(0, Math.trunc(options.maxJobs ?? 7)))
  let firstFailure: unknown
  let failed = false
  const worker = async (): Promise<void> => {
    while (options.current() && issued.length < limit) {
      const job = nextSubagentObservationJob(options.candidates(), issued)
      if (!job) return
      issued.push(job)
      try { await options.read(job) }
      catch (cause) { if (!failed) { failed = true; firstFailure = cause } }
    }
  }
  await Promise.all([worker(), worker()])
  if (failed && options.current()) throw firstFailure
  return issued
}

/** Round-robin keeps a known later-page child live without downloading the whole directory. */
export function subagentRefreshBatch(
  runs: readonly SubagentRun[],
  selectedRunId: string | undefined,
  afterRunId: string | undefined,
  maxRequests = SUBAGENT_REFRESH_MAX_REQUESTS
): { ids: string[]; afterRunId?: string; partial: boolean } {
  const requestLimit = Number.isFinite(maxRequests)
    ? Math.min(SUBAGENT_REFRESH_MAX_REQUESTS, Math.max(1, Math.trunc(maxRequests)))
    : SUBAGENT_REFRESH_MAX_REQUESTS
  const active = runs.filter(run => isSubagentActive(run.status))
  const anchor = active.findIndex(run => run.runId === afterRunId)
  const ordered = [...active.slice(anchor + 1), ...active.slice(0, anchor + 1)]
  const encoder = new TextEncoder()
  const queue: SubagentRun[] = []
  let queueBytes = 0
  for (const run of ordered) {
    if (queue.length >= SUBAGENT_REFRESH_MAX_QUEUE) break
    const bytes = encoder.encode(run.runId).byteLength
    if (bytes > SUBAGENT_REFRESH_MAX_QUEUE_BYTES) continue
    if (queueBytes + bytes > SUBAGENT_REFRESH_MAX_QUEUE_BYTES) break
    queue.push(run); queueBytes += bytes
  }
  const selected = selectedRunId ? runs.find(run => run.runId === selectedRunId) : undefined
  const selectedBytes = selected ? encoder.encode(selected.runId).byteLength : 0
  const selectedFits = selected && selectedBytes <= SUBAGENT_REFRESH_MAX_QUEUE_BYTES
  const ids: string[] = selectedFits ? [selected.runId] : []
  let requestBytes = selectedFits ? selectedBytes : 0
  let next = afterRunId
  let byteLimited = false
  for (const run of queue) {
    if (ids.length >= requestLimit) break
    next = run.runId
    if (ids.includes(run.runId)) continue
    const bytes = encoder.encode(run.runId).byteLength
    if (requestBytes + bytes > SUBAGENT_REFRESH_MAX_QUEUE_BYTES) { byteLimited = true; continue }
    ids.push(run.runId); requestBytes += bytes
  }
  return { ids, afterRunId: next, partial: byteLimited || active.length > queue.length || !!selected && !selectedFits }
}

/** Reading a card is observation; it never posts a new task or cancels a durable run. */
export async function executeSubagentRefreshBatch(
  ids: readonly string[],
  refresh: (id: string) => Promise<void>,
  isCurrent: () => boolean
): Promise<void> {
  let position = 0
  let firstFailure: unknown
  let failed = false
  const worker = async (): Promise<void> => {
    while (isCurrent() && position < ids.length) {
      const id = ids[position++]
      try { await refresh(id) }
      catch (cause) {
        if (!failed) { firstFailure = cause; failed = true }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(ids.length, SUBAGENT_REFRESH_MAX_CONCURRENCY) }, worker))
  if (failed && isCurrent()) throw firstFailure
}
