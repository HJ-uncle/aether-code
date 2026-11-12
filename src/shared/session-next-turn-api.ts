import type { EngineSnapshot } from './ipc'
import type { NextTurnQueueEnvelope, NextTurnQueueState, NextTurnQueueUserMutation, QueueCommitResult } from './next-turn-queue'
export const SESSION_QUEUE_IPC = { invoke: 'work:next-turn-queue', changed: 'work:next-turn-queue:changed' } as const
export type SessionQueueTarget = Pick<EngineSnapshot, 'mode' | 'baseUrl' | 'instanceId' | 'accountId'>
export interface SessionQueueDraft {
  draft: NextTurnQueueEnvelope['draft']; model: NextTurnQueueEnvelope['model']; resources: NextTurnQueueEnvelope['resources']
  thinking: NextTurnQueueEnvelope['thinking']; subagentModel?: string; utilityModel?: string
  attachments: { path: string; name: string; type: string; size: number; remoteUploadId?: string; attachmentId?: string; referenceLabel?: string }[]
}
export type SessionQueueAction =
  | { kind: 'restart'; runId: string }
  | { kind: 'read' } | { kind: 'reconcile'; retryIfAbsent?: boolean }
  | { kind: 'enqueue'; expectedRevision: number; operationId: string; id: string; submission: SessionQueueDraft }
  | { kind: 'edit-draft'; expectedRevision: number; operationId: string; id: string; entryRevision: number; draft: SessionQueueDraft['draft'] }
  | { kind: 'mutate'; expectedRevision: number; operationId: string; operation: Exclude<NextTurnQueueUserMutation, { kind: 'enqueue' | 'edit' | 'replace-pending' }> }
export interface SessionQueueRequest { taskId: string; expectedEngine: SessionQueueTarget; action: SessionQueueAction }
export interface SessionQueueRead { state: NextTurnQueueState; dispatchError?: string }
export interface SessionNextTurnApi {
  /** Keep typed failures as data across contextBridge; custom Error fields are not cloned. */
  invoke(input: SessionQueueRequest): Promise<SessionQueueInvokeResult>
  onChanged(listener: (input: { scope: NextTurnQueueState['scope']; revision: number }) => void): () => void
}
export type SessionQueueInvokeResult = { ok: true; value: SessionQueueRead | QueueCommitResult } | { ok: false; code: string; message: string }
