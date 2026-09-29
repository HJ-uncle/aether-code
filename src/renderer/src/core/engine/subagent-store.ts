import { useSyncExternalStore } from 'react'
import type { SubagentRun } from '@shared/subagent'
import { cancelSubagentRun, getSubagentRun, listSubagentRuns } from './client'
import {
  isSubagentActive,
  mergeSubagentRun,
  normalizeSubagentEvent,
  normalizeSubagentRun
} from './subagent-state'

const runs = new Map<string, SubagentRun>()
const listeners = new Set<() => void>()
const requests = new Map<string, Promise<void>>()

export function subscribeSubagents(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function ingestSubagentRun(raw: unknown): SubagentRun | undefined {
  const incoming = normalizeSubagentRun(raw)
  if (!incoming) return undefined
  const previous = runs.get(incoming.runId)
  const next = mergeSubagentRun(previous, incoming)
  if (next !== previous) {
    runs.set(next.runId, next)
    for (const listener of listeners) listener()
  }
  return next
}

export function ingestSubagentEvent(raw: unknown): SubagentRun | undefined {
  const event = normalizeSubagentEvent(raw)
  return event ? ingestSubagentRun(event.snapshot) : undefined
}

export function getSubagentRuns(parentSessionId: string | null): SubagentRun[] {
  return parentSessionId
    ? [...runs.values()].filter((run) => run.parentSessionId === parentSessionId)
    : []
}

export function useSubagentRun(runId: string | undefined): SubagentRun | undefined {
  return useSyncExternalStore(subscribeSubagents, () => (runId ? runs.get(runId) : undefined))
}

export function forgetSubagentSession(parentSessionId: string): void {
  for (const [id, run] of runs) if (run.parentSessionId === parentSessionId) runs.delete(id)
  for (const listener of listeners) listener()
}

export async function refreshSubagentRuns(parentSessionId: string): Promise<void> {
  const pending = requests.get(parentSessionId)
  if (pending) return pending
  const before = new Map(getSubagentRuns(parentSessionId).map((run) => [run.runId, run]))
  const request = (async () => {
    const result = await listSubagentRuns(parentSessionId)
    if (!Array.isArray(result)) return
    const currentIds = new Set(result.map((run) => run.runId))
    let removed = false
    for (const [id, snapshot] of before) {
      // Authoritative list deletion must not erase a snapshot that arrived while the request was in flight.
      if (!currentIds.has(id) && runs.get(id) === snapshot) {
        runs.delete(id)
        removed = true
      }
    }
    for (const run of result) ingestSubagentRun(run)
    if (removed) for (const listener of listeners) listener()
  })()
  requests.set(parentSessionId, request)
  try {
    await request
  } finally {
    requests.delete(parentSessionId)
  }
}

export async function refreshSubagentRun(runId: string): Promise<void> {
  ingestSubagentRun(await getSubagentRun(runId))
}

export async function requestSubagentCancellation(runId: string): Promise<void> {
  ingestSubagentRun(await cancelSubagentRun(runId))
}

/** A detached parent SSE must not freeze a child card; reconcile only sessions with active runs. */
export function hasActiveSubagents(parentSessionId: string | null): boolean {
  return getSubagentRuns(parentSessionId).some((run) => isSubagentActive(run.status))
}
