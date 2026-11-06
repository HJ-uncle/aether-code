import type { NextTurnQueueEnvelope } from './next-turn-queue'
import type { WorkQueueAction, WorkQueueDraft, WorkQueueInvokeResult, WorkQueueRequest, WorkNextTurnApi } from './work-next-turn-api'

export const CODE_QUEUE_IPC = { invoke: 'code:next-turn-queue', changed: 'code:next-turn-queue:changed' } as const
export interface CodeQueueOptions {
  agentId?: string
  collaborators?: { agentId?: string; resumeRunId?: string }[]
  workspacePaths?: string[]
  memoryScope?: 'off' | 'session' | 'global'
}
export interface CodeQueueDraft extends WorkQueueDraft { code: CodeQueueOptions }
export interface CodeQueueEntrySelector { id: string; entryRevision: number }
export type CodeQueueAction = Exclude<WorkQueueAction, { kind: 'enqueue' }> |
  { kind: 'enqueue'; expectedRevision: number; operationId: string; id: string; submission: CodeQueueDraft } |
  { kind: 'replace-submission'; expectedRevision: number; operationId: string; id: string; entryRevision: number; submission: CodeQueueDraft } |
  { kind: 'retarget-model'; expectedRevision: number; operationId: string; entries: CodeQueueEntrySelector[]; model: NextTurnQueueEnvelope['model'] } |
  { kind: 'merge-pending'; expectedRevision: number; operationId: string; entries: CodeQueueEntrySelector[]; id: string; submission?: CodeQueueDraft } |
  { kind: 'set-connected'; connected: boolean }
export interface CodeQueueRequest extends Omit<WorkQueueRequest, 'action'> { action: CodeQueueAction }
export interface CodeNextTurnApi extends Omit<WorkNextTurnApi, 'invoke'> {
  invoke(input: CodeQueueRequest): Promise<WorkQueueInvokeResult>
}
export type CodeQueueInvokeResult = WorkQueueInvokeResult
