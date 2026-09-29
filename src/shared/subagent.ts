/** Versioned snapshots shared with the engine; IDs describe different ownership boundaries. */
export type SubagentRunStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'interrupted'

export interface SubagentError {
  code: string
  message: string
  retryable: boolean
}

export interface SubagentUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  estimated?: boolean
  unknown?: boolean
}

export interface SubagentToolCall {
  id: string
  name: string
  args: unknown
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  output?: string
  error?: SubagentError
  startedAt?: number
  finishedAt?: number
  durationMs?: number
}

export interface SubagentRun {
  schemaVersion: 1
  runId: string
  tenantId: string
  rootSessionId: string
  parentSessionId: string
  parentConversationId: string
  parentMessageId: string
  parentToolCallId: string
  childSessionId: string
  task: string
  description: string
  modelId: string
  status: SubagentRunStatus
  lastSeq: number
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  durationMs?: number
  error?: SubagentError
  stopReason?: string
  resultSummary?: string
  partialOutput?: string
  externalEffectStatus?: 'unknown'
  usage: SubagentUsage
  toolCalls: SubagentToolCall[]
  transcriptRef?: string
}

export interface SubagentEvent {
  schemaVersion: 1
  kind: string
  runId: string
  seq: number
  snapshot: SubagentRun
}
