/** Paired engine root-run v1. Transport completion is independent of execution outcome. */
export type RootRunStatus = 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export interface RootPending {
  requestId: string
  kind: 'ask' | 'permission'
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  pendingAction?: Record<string, unknown>
  description?: string
  question?: string
  options?: unknown[]
  status: 'pending' | 'answered'
  output?: string
}
export interface RootRun {
  schemaVersion: 1
  runId: string
  sessionId: string
  turnId: string
  userMessageId: string
  assistantMessageId: string
  version: number
  seq: number
  status: RootRunStatus
  modelId?: string
  actualModelId?: string
  workspacePaths?: string[]
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  error?: string | { message: string; code?: string }
  stopReason?: string
  pending: RootPending[]
}
