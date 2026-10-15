import type { EngineSnapshot } from '../../shared/ipc'

type ProbeSnapshot = Pick<EngineSnapshot, 'phase' | 'mode' | 'baseUrl' | 'instanceId' | 'accountId'>

export interface HealthProbeLease {
  generation: number
  transport: AbortController
  snapshot: ProbeSnapshot
}

/** Account switches replace the transport without incrementing the process
 * generation, so generation alone cannot authorize a probe result. */
export function isHealthProbeCurrent(
  lease: HealthProbeLease,
  generation: number,
  transport: AbortController,
  snapshot: ProbeSnapshot
): boolean {
  return !lease.transport.signal.aborted && lease.generation === generation &&
    lease.transport === transport && snapshot.phase === 'ready' &&
    lease.snapshot.mode === snapshot.mode && lease.snapshot.baseUrl === snapshot.baseUrl &&
    lease.snapshot.instanceId === snapshot.instanceId &&
    (lease.snapshot.accountId ?? null) === (snapshot.accountId ?? null)
}
