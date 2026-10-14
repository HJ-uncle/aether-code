import type { PublishedChildUsage } from '@shared/published-child'
import { PublishedChildRecoveryError, replacePublishedUsage } from './published-child-recovery'

export interface PublishedUsageScope {
  source: number
  sessionId: string
  viewEpoch: number
  historyEpoch: number
  owner: string
}

export function publishedUsageOwner(usage: PublishedChildUsage): string {
  const fence = usage.fence
  return JSON.stringify([usage.clientSource, usage.sessionId, usage.source, fence.tenantId,
    fence.parentSessionId, fence.rootSessionId, fence.parentTurnId, fence.rootRunId,
    fence.attemptId, fence.streamId, fence.generation])
}

/** A settled transport, rather than a cadence timeout, releases the single flight. */
export function createPublishedUsageRefresh(options: {
  current: (scope: PublishedUsageScope) => boolean
  authority: () => PublishedChildUsage | undefined
  read: (scope: PublishedUsageScope) => Promise<PublishedChildUsage>
  accept: (scope: PublishedUsageScope, usage: PublishedChildUsage) => void
  pending: (scope: PublishedUsageScope, message: string | null) => void
  ownerChanged: (scope: PublishedUsageScope) => void
  now?: () => number
}): {
  request: (scope: PublishedUsageScope, force?: boolean) => Promise<void>
  clear: () => void
} {
  const now = options.now ?? Date.now
  let flight: Promise<void> | null = null
  let trailing: PublishedUsageScope | null = null
  let due = 0, failures = 0, epoch = 0
  function request(scope: PublishedUsageScope, force = false): Promise<void> {
    if (!options.current(scope)) return Promise.resolve()
    if (flight) { if (force) trailing = scope; return flight }
    if (!force && now() < due) return Promise.resolve()
    const generation = epoch
    // The renderer may preserve a confirmed value across an outage. It must
    // never replace it with a fabricated zero or details-derived increment.
    const valid = (): boolean => generation === epoch && options.current(scope) &&
      Boolean(options.authority() && publishedUsageOwner(options.authority()!) === scope.owner)
    const operation = Promise.resolve().then(() => options.read(scope)).then(next => {
      if (!valid()) return
      const previous = options.authority()
      const accepted = replacePublishedUsage(previous, next, { source: scope.source,
        sessionId: scope.sessionId, fullRestore: false })
      options.accept(scope, accepted)
      failures = 0; due = now() + 5000
      options.pending(scope, null)
    }).catch((error: unknown) => {
      if (!valid()) return
      failures = Math.min(failures + 1, 4)
      due = now() + Math.min(30_000, 5000 * 2 ** (failures - 1))
      options.pending(scope, '用量统计待同步；当前显示上次确认的数值')
      if (error instanceof PublishedChildRecoveryError && error.reason === 'owner_changed') options.ownerChanged(scope)
    }).finally(() => {
      if (flight !== operation) return
      flight = null
      const queued = trailing; trailing = null
      if (queued && options.current(queued)) void request(queued, true)
    })
    flight = operation
    return operation
  }
  return { request, clear: () => { epoch++; trailing = null; due = 0; failures = 0 } }
}
