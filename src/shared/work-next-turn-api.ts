import type { EngineSnapshot } from './ipc'
import type { NextTurnQueueEnvelope, NextTurnQueueState, NextTurnQueueUserMutation, QueueCommitResult } from './next-turn-queue'
export const WORK_QUEUE_IPC = { invoke: 'work:next-turn-queue', changed: 'work:next-turn-queue:changed' } as const
export type WorkQueueTarget = Pick<EngineSnapshot, 'mode' | 'baseUrl' | 'instanceId' | 'accountId'>
export interface WorkQueueDraft {
  draft: NextTurnQueueEnvelope['draft']; model: NextTurnQueueEnvelope['model']; resources: NextTurnQueueEnvelope['resources']
  thinking: NextTurnQueueEnvelope['thinking']; subagentModel?: string; utilityModel?: string
  attachments: { path: string; name: string; type: string; size: number; remoteUploadId?: string }[]
}
export type WorkQueueAction =
  | { kind: 'read' } | { kind: 'reconcile'; retryIfAbsent?: boolean }
  | { kind: 'enqueue'; expectedRevision: number; operationId: string; id: string; submission: WorkQueueDraft }
  | { kind: 'edit-draft'; expectedRevision: number; operationId: string; id: string; entryRevision: number; draft: WorkQueueDraft['draft'] }
  | { kind: 'mutate'; expectedRevision: number; operationId: string; operation: Exclude<NextTurnQueueUserMutation, { kind: 'enqueue' | 'edit' }> }
export interface WorkQueueRequest { taskId: string; expectedEngine: WorkQueueTarget; action: WorkQueueAction }
export interface WorkQueueRead { state: NextTurnQueueState; dispatchError?: string }
export interface WorkNextTurnApi {
  /** Keep typed failures as data across contextBridge; custom Error fields are not cloned. */
  invoke(input: WorkQueueRequest): Promise<WorkQueueInvokeResult>
  onChanged(listener: (input: { scope: NextTurnQueueState['scope']; revision: number }) => void): () => void
}
export type WorkQueueInvokeResult = { ok: true; value: WorkQueueRead | QueueCommitResult } | { ok: false; code: string; message: string }
