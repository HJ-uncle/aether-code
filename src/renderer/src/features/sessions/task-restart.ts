import type { NextTurnQueueEntry, QueueContinuationTarget } from '@shared/next-turn-queue'
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

export function continuationTarget(run: RootRun, childRunId?: string): QueueContinuationTarget | null {
  if (!run.attemptId || !run.turnId || !Number.isSafeInteger(run.version) || run.version < 1 || run.pending.some(item => item.status === 'pending') ||
    !['failed', 'cancelled', 'interrupted', ...(childRunId ? ['succeeded'] : [])].includes(run.status)) return null
  return { runId: run.runId, attemptId: run.attemptId, version: run.version, turnId: run.turnId,
    ...(childRunId ? { childRunId } : {}) }
}

export function continuationObserved(entry: NextTurnQueueEntry, messages: readonly ChatMessage[]): boolean {
  if (!('receipt' in entry)) return false
  return messages.some(({ run }) => run?.runId === entry.receipt.runId &&
    (!entry.receipt.attemptId || run.attemptId === entry.receipt.attemptId))
}

/** A continuation belongs to one source attempt. A later failure of the same
 * logical run must remain actionable, independently of earlier successful starts. */
export function sessionTaskRestart(taskId: string, source: RootRun, read: SessionQueueRead | null,
  messages: readonly ChatMessage[]): SessionTaskRestartPresentation {
  const unavailable: SessionTaskRestartPresentation = { status: 'unavailable', resolved: false, busy: false }
  if (!taskId || !source.attemptId || !read || read.state.scope.owner !== 'work' || read.state.scope.taskId !== taskId) return unavailable
  const entry = [...read.state.entries].reverse().find(entry => entry.envelope.recovery?.runId === source.runId &&
    entry.envelope.recovery.attemptId === source.attemptId)
  if (!entry) return unavailable
  const identity = { entryId: entry.id, ...('receipt' in entry ? { replacementRunId: entry.receipt.runId } : {}) }
  const run = 'receipt' in entry ? messages.find(message => message.run?.runId === entry.receipt.runId &&
    message.run.attemptId === entry.receipt.attemptId)?.run : undefined
  const started = entry.phase === 'accepted' || entry.phase === 'terminal'
    ? entry.startedAt !== undefined || entry.outcome === 'succeeded' || Boolean(run?.startedAt || run?.status === 'waiting' || run?.status === 'succeeded') : false
  if (started) return { ...identity, status: 'resolved', resolved: true, busy: false }
  if (entry.phase === 'pending') return read.dispatchError
    ? { ...identity, status: 'unconfirmed', resolved: false, busy: false, label: '核对并继续', error: read.dispatchError }
    : { ...identity, status: 'pending', resolved: false, busy: true, label: '正在继续' }
  if (entry.phase === 'admission-unknown') return { ...identity, status: 'unconfirmed', resolved: false, busy: false,
    label: '核对并继续', error: read.dispatchError || entry.reason }
  if (entry.phase === 'dispatching') return { ...identity, status: 'pending', resolved: false, busy: true, label: '正在继续' }
  if (run && ['failed', 'cancelled', 'interrupted'].includes(run.status) || 'outcome' in entry && entry.outcome && entry.outcome !== 'succeeded')
    return { ...identity, status: 'failed', resolved: false, busy: false, label: '继续任务',
      error: typeof run?.error === 'string' ? run.error : run?.error?.message || read.dispatchError || '任务未能继续，请重试' }
  return read.dispatchError ? { ...identity, status: 'unconfirmed', resolved: false, busy: false, label: '核对并继续', error: read.dispatchError }
    : { ...identity, status: 'pending', resolved: false, busy: true, label: '正在确认启动' }
}
