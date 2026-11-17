import type { RootRun } from '@shared/root-run'
import { createRecoverySingleFlight, type RecoveryScope } from './chat-recovery-loop'

const terminal = (run: RootRun): boolean => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status)

/** A task can finish while its session later receives a different server-owned task. */
export function idleRootChanged(sessionId: string, known: RootRun | undefined, next: RootRun | undefined): boolean {
  if (!next || next.sessionId !== sessionId) return false
  if (!known) return true
  if (known.sessionId !== sessionId) return false
  if (next.runId !== known.runId) return Number.isFinite(next.createdAt) && next.createdAt >= known.createdAt
  if (next.version <= known.version || next.seq !== known.seq || next.turnId !== known.turnId ||
    next.userMessageId !== known.userMessageId) return false
  // Continuation changes the attempt and assistant segment, not the logical
  // root. Discover it even if the new attempt finished before this probe.
  const nextAttempt = typeof next.attemptId === 'string' && Boolean(next.attemptId.trim()) && next.attemptId !== known.attemptId
  return nextAttempt || !terminal(known) && next.assistantMessageId === known.assistantMessageId
}

/** Discovery only reads a small status. Hydration remains owned by the existing recovery loop. */
export function createIdleRootDiscovery(): {
  check: (scope: RecoveryScope, input: {
    current: () => boolean
    read: () => Promise<RootRun | undefined>
    known: () => RootRun | undefined
    refresh: () => Promise<unknown>
  }) => Promise<void>
  clear: () => void
} {
  const reads = createRecoverySingleFlight<void>()
  return {
    check(scope, input) {
      return reads.read(scope, async () => {
        if (!input.current()) return
        const next = await input.read()
        if (input.current() && idleRootChanged(scope.sessionId, input.known(), next)) await input.refresh()
      })
    },
    clear: () => reads.clear()
  }
}
