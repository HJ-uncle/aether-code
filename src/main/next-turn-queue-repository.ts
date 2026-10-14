import type { NextTurnQueueLimits, NextTurnQueueMutation, NextTurnQueueScope, NextTurnQueueState, QueueCommitReceipt, QueueCommitResult } from '../shared/next-turn-queue'
import type { QueueAuthorityCheck } from './next-turn-queue-authority-fence'
import type { QueueStoreRead } from './next-turn-queue-store'

/** Storage selection is trusted construction, never a renderer option. Legacy JSON remains the default. */
export interface NextTurnQueueRepository {
  readonly limits: NextTurnQueueLimits
  read(scope: NextTurnQueueScope): Promise<QueueStoreRead>
  mutate(scope: NextTurnQueueScope, expectedRevision: number, operationId: string, operation: NextTurnQueueMutation, assertAuthority: QueueAuthorityCheck): Promise<QueueCommitResult>
  findReceipt(scope: NextTurnQueueScope, operationId: string): Promise<QueueCommitReceipt | null>
  findCommitted(scope: NextTurnQueueScope, operationId: string): Promise<{ state: NextTurnQueueState; receipt: QueueCommitReceipt } | null>
  listScopes(maximum?: number): Promise<NextTurnQueueScope[]>
  close?(): Promise<void>
  revoke?(): void
  onEngineChanged?(): void
}
