import { NextTurnQueueError } from '../shared/next-turn-queue'

const LIVE = 0, COMMITTING = 1, REVOKE_PENDING = 2, REVOKED = 3
export interface QueueAuthorityCheck { (): void; readonly capabilityFence?: SharedArrayBuffer }
export const createQueueCapabilityFence = (): SharedArrayBuffer => new SharedArrayBuffer(4)
export function queueCapabilityWords(fence: SharedArrayBuffer): Int32Array {
  if (!(fence instanceof SharedArrayBuffer) || fence.byteLength !== 4) throw new NextTurnQueueError('AUTHORITY', 'Invalid owned capability fence')
  return new Int32Array(fence)
}
/** The CAS is the commit authorization linearization point. A release that wins
 * first forbids COMMIT; a COMMIT that wins first is joined by the release ACK. */
export function acquireQueueCommit(fence: SharedArrayBuffer): void {
  if (Atomics.compareExchange(queueCapabilityWords(fence), 0, LIVE, COMMITTING) !== LIVE)
    throw new NextTurnQueueError('AUTHORITY', 'Queue capability was released before commit authorization')
}
export function assertQueueCapability(fence: SharedArrayBuffer, acquired: boolean): void {
  const state = Atomics.load(queueCapabilityWords(fence), 0)
  if (acquired ? state !== COMMITTING && state !== REVOKE_PENDING : state !== LIVE)
    throw new NextTurnQueueError('AUTHORITY', 'Queue capability is revoked or already committing')
}
export function revokeQueueCapability(fence: SharedArrayBuffer): void {
  const words = queueCapabilityWords(fence)
  for (;;) {
    const state = Atomics.load(words, 0)
    if (state === REVOKED || state === REVOKE_PENDING) return
    if (Atomics.compareExchange(words, 0, state, state === COMMITTING ? REVOKE_PENDING : REVOKED) === state) return
  }
}
export function finishQueueCommit(fence: SharedArrayBuffer): void {
  const words = queueCapabilityWords(fence)
  if (Atomics.compareExchange(words, 0, COMMITTING, LIVE) !== COMMITTING)
    Atomics.compareExchange(words, 0, REVOKE_PENDING, REVOKED)
}
