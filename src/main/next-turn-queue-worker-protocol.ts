import { assertQueueJsonValue } from '../shared/next-turn-queue-state'
import { queueCapabilityWords } from './next-turn-queue-authority-fence'
import type { NextTurnQueueLimits, NextTurnQueueMutation, NextTurnQueueScope } from '../shared/next-turn-queue'

export const QUEUE_WORKER_RPC_LIMITS = Object.freeze({ maxRequests: 32, maxRequestBytes: 16 * 1024 * 1024, maxFrameBytes: 8 * 1024 * 1024, deadlineMs: 90000 })
export type QueueWorkerPhase = 'before-transaction' | 'before-commit' | 'after-commit' | 'after-commit-grant' | 'commit-acquired'
export type QueueWorkerBody =
  | { method: 'read' | 'diagnostics'; scope: NextTurnQueueScope }
  | { method: 'findReceipt' | 'findCommitted'; scope: NextTurnQueueScope; operationId: string }
  | { method: 'findArchived'; scope: NextTurnQueueScope; id: string }
  | { method: 'queryExact' | 'mutate'; scope: NextTurnQueueScope; expectedRevision: number; operationId: string; operation: NextTurnQueueMutation }
  | { method: 'listScopes'; maximum: number }
export interface QueueWorkerStart {
  instanceId: string
  file: string
  limits: NextTurnQueueLimits
  identity: Omit<NextTurnQueueScope, 'taskId'>
  rpcLimits?: { maxRequests: number; maxRequestBytes: number; maxFrameBytes: number; deadlineMs: number }
  epoch: SharedArrayBuffer
  requireExisting: boolean
  requireCapabilityFence?: boolean
  maxVerifiedScopes?: number
  holdAt?: QueueWorkerPhase
  testHangAt?: 'startup' | 'close'
}
export interface QueueWorkerRequest { kind: 'request'; instanceId: string; id: string; epoch: number; body: QueueWorkerBody; capabilityFence?: SharedArrayBuffer }
export type QueueWorkerInput = QueueWorkerRequest
  | { kind: 'authorize'; instanceId: string; id: string; step: QueueWorkerPhase; ok: boolean; message: string }
  | { kind: 'release-test'; instanceId: string }
  | { kind: 'close'; instanceId: string }
export type QueueWorkerOutput =
  | { kind: 'ready'; instanceId: string; runtime: string }
  | { kind: 'authority'; instanceId: string; id: string; step: QueueWorkerPhase; epoch: number }
  | { kind: 'test-barrier'; instanceId: string; id: string; step: QueueWorkerPhase }
  | { kind: 'result'; instanceId: string; id: string; ok: true; value: unknown }
  | { kind: 'result'; instanceId: string; id: string; ok: false; code: 'INVALID' | 'SCOPE' | 'CAS' | 'CAPACITY' | 'CORRUPT' | 'IO' | 'AUTHORITY' | 'CONFLICT'; message: string; commitMayExist: boolean }
  | { kind: 'fatal'; instanceId: string; message: string }
  | { kind: 'closed'; instanceId: string }

export function assertQueueWorkerInputFrame(message: QueueWorkerInput, maximum: number): void {
  if (message.kind === 'request') {
    const { capabilityFence, ...json } = message
    if (capabilityFence !== undefined) queueCapabilityWords(capabilityFence)
    assertQueueJsonValue(json, maximum - (capabilityFence ? 4 : 0))
  } else assertQueueJsonValue(message, maximum)
}

/** 0 is the immutable owner's live epoch, 1 fences new/held commits on close.
 * Only trusted source/namespace lifecycle code may revoke this owner. */
export function assertWorkerEpoch(shared: Int32Array, expected: number): void {
  if (Atomics.load(shared, 0) !== expected || Atomics.load(shared, 1) !== 0)
    throw new Error('Queue worker authority epoch was revoked')
}
