import type { RootRun } from '@shared/root-run'
import type { SubagentRun } from '@shared/subagent'
import type { ChatMessage } from '@renderer/core/engine/useChat'

interface ExecutionInterval { start: number; end?: number }
export interface SessionExecutionTiming {
  intervals: ExecutionInterval[]
  incomplete: boolean
}

const timestamp = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0
const rootKey = (run: RootRun): string => JSON.stringify([run.sessionId, run.runId])
const activeRoot = (run: RootRun): boolean => run.status === 'running' || run.status === 'waiting'

/** Billing snapshots only contain extrema, which cannot distinguish execution
 * from hours between questions. Timing must come from the loaded run records. */
export function sessionExecutionTiming(messages: readonly ChatMessage[]): SessionExecutionTiming {
  const roots = new Map<string, RootRun>()
  const children = new Map<string, { run: SubagentRun; owner: ChatMessage }>()
  for (const message of messages) {
    if (message.run) {
      const run = message.run, key = rootKey(run)
      const previous = roots.get(key)
      if (!previous || run.version > previous.version ||
        run.version === previous.version && run.updatedAt > previous.updatedAt) roots.set(key, run)
    }
    for (const tool of message.tools) {
      const run = tool.subagent
      if (!run) continue
      const key = JSON.stringify([run.tenantId, run.rootSessionId, run.runId])
      const previous = children.get(key)
      if (!previous || run.lastSeq >= previous.run.lastSeq) children.set(key, { run, owner: message })
    }
  }
  const timing: SessionExecutionTiming = { intervals: [], incomplete: false }
  const add = (start: number | undefined, end: number | undefined, active: boolean): void => {
    if (!timestamp(start) || !active && (!timestamp(end) || end < start)) {
      timing.incomplete = true
      return
    }
    timing.intervals.push({ start, ...(active ? {} : { end }) })
  }
  for (const run of roots.values()) add(run.startedAt, run.finishedAt, activeRoot(run))
  const rootIds = new Set([...roots.values()].map(run => run.runId))
  for (const message of messages) {
    if (message.role !== 'assistant' || message.run || message.runId && rootIds.has(message.runId)) continue
    // A lone historical createdAt is not a measured duration. In particular,
    // never use a later user message or the current clock to finish old turns.
    add(message.startedAt, message.endedAt, message.status === 'streaming' || message.status === 'waiting')
  }
  for (const { run, owner } of children.values()) {
    if (run.status === 'queued' && !timestamp(run.startedAt)) continue
    // History can retain a running child snapshot after its parent finished.
    // Only a live parent makes that unfinished interval safe to extend to now.
    const parent = owner.run && roots.get(rootKey(owner.run))
    const parentActive = parent ? activeRoot(parent) : owner.status === 'streaming' || owner.status === 'waiting'
    add(run.startedAt, run.finishedAt, parentActive && (run.status === 'running' || run.status === 'cancelling'))
  }
  return timing
}

/** Interval union counts overlapping parent/child work and repeated root
 * transcript segments once, while keeping the gaps between turns out. */
export function sessionExecutionDuration(timing: SessionExecutionTiming, now: number): number | undefined {
  const intervals = timing.intervals.map(interval => ({ start: interval.start, end: interval.end ?? now }))
    .filter(interval => Number.isFinite(interval.end) && interval.end >= interval.start)
    .sort((a, b) => a.start - b.start)
  if (!intervals.length) return undefined
  let total = 0, start = intervals[0].start, end = intervals[0].end
  for (const interval of intervals.slice(1)) {
    if (interval.start <= end) end = Math.max(end, interval.end)
    else { total += end - start; start = interval.start; end = interval.end }
  }
  return total + end - start
}
