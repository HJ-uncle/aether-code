import type { NextTurnQueueEntry } from '@shared/next-turn-queue'
import type { RootRun } from '@shared/root-run'
import type { SessionQueueRead } from '@shared/session-next-turn-api'
import type { ChatMessage } from '../../core/engine/useChat'

export interface SessionTaskRestartPresentation {
  status: 'unavailable' | 'pending' | 'unconfirmed' | 'resolved' | 'failed'
  resolved: boolean
  busy: boolean
  label?: string
  error?: string
  entryId?: string
  replacementRunId?: string
}

function linkedRun(entry: NextTurnQueueEntry, taskId: string, messages: readonly ChatMessage[]): RootRun | undefined {
  if (!('receipt' in entry) || entry.receipt.runId === entry.envelope.recovery?.runId) return undefined
  let latest: RootRun | undefined
  for (const { run } of messages) {
    if (run?.sessionId === taskId && run.runId === entry.receipt.runId &&
      (!latest || run.version > latest.version || run.version === latest.version && run.updatedAt > latest.updatedAt)) latest = run
  }
  return latest
}

function startedAt(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function started(run: RootRun | undefined): boolean {
  // Message.startedAt may be synthesized from createdAt during history replay;
  // only the durable run can prove a failed replacement actually started.
  return Boolean(run && (startedAt(run.startedAt) ||
    ['waiting', 'succeeded'].includes(run.status)))
}

/** Direct durable links survive reload and keep each failed run in a retry chain
 * independent. Accepting a request is not proof that its replacement executed. */
export function sessionTaskRestart(taskId: string, runId: string, read: SessionQueueRead | null,
  messages: readonly ChatMessage[]): SessionTaskRestartPresentation {
  const unavailable: SessionTaskRestartPresentation = { status: 'unavailable', resolved: false, busy: false }
  if (!taskId || !runId || !read || read.state.scope.owner !== 'work' || read.state.scope.taskId !== taskId) return unavailable
  const entries = [...read.state.entries].sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt)
  const linked = (id: string) => entries.filter(entry => entry.envelope.recovery?.runId === id)
  // A later failed admission cannot resurrect a root that an earlier execution
  // already superseded. Terminal success remains evidence after archive paging.
  const resolve = (id: string, ancestors = new Set<string>()): NextTurnQueueEntry | undefined => {
    if (ancestors.has(id)) return undefined
    const visited = new Set(ancestors).add(id)
    return linked(id).find(entry => 'receipt' in entry && entry.receipt.runId !== id &&
      (entry.outcome === 'succeeded' || 'startedAt' in entry && startedAt(entry.startedAt) ||
        started(linkedRun(entry, taskId, messages)) || resolve(entry.receipt.runId, visited)))
  }
  const resolved = resolve(runId)
  const entry = resolved ?? linked(runId)[0]
  if (!entry) return unavailable
  const identity = { entryId: entry.id, ...('receipt' in entry ? { replacementRunId: entry.receipt.runId } : {}) }
  if (resolved) return { ...identity, status: 'resolved', resolved: true, busy: false }
  if (entry.phase === 'pending') return read.dispatchError
    ? { ...identity, status: 'unconfirmed', resolved: false, busy: false, label: '核对并重启', error: read.dispatchError }
    : { ...identity, status: 'pending', resolved: false, busy: true, label: '正在重启' }
  if (entry.phase === 'admission-unknown') return { ...identity, status: 'unconfirmed', resolved: false, busy: false,
    label: '核对并重启', error: read.dispatchError || entry.reason }
  if (entry.phase === 'dispatching') return { ...identity, status: 'pending', resolved: false, busy: true, label: '正在重启' }
  const run = linkedRun(entry, taskId, messages)
  if (run && ['failed', 'cancelled', 'interrupted'].includes(run.status) || 'outcome' in entry && entry.outcome && entry.outcome !== 'succeeded') {
    const error = typeof run?.error === 'string' ? run.error : run?.error?.message
    return { ...identity, status: 'failed', resolved: false, busy: false, label: '重新启动',
      error: error || read.dispatchError || '任务未能启动，请重试' }
  }
  if (read.dispatchError) return { ...identity, status: 'unconfirmed', resolved: false, busy: false,
    label: '核对并重启', error: read.dispatchError }
  return entry.phase === 'accepted'
    ? { ...identity, status: 'pending', resolved: false, busy: true, label: '正在确认启动' }
    : { ...identity, status: 'unconfirmed', resolved: false, busy: false, label: '核对并重启', error: read.dispatchError }
}
