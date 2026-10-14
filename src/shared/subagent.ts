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

export interface SubagentRunV1 {
  schemaVersion: 1
  runId: string
  tenantId: string
  rootSessionId: string
  parentSessionId: string
  parentConversationId: string
  parentMessageId: string
  parentToolCallId: string
  childSessionId: string
  resumeFromRunId?: string
  /** Custom Agent identity; childSessionId remains the persistent context identity. */
  agentId?: string
  agentName?: string
  /** Display-only capability metadata; enforcement remains in the engine. */
  continuation?: { role?: string; readOnly: boolean }
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

/** Explicit user delegation, separate from the immutable main Agent binding. */
export interface AgentCollaborator {
  agentId?: string
  resumeRunId?: string
}

export interface SubagentEvent {
  schemaVersion: 1
  kind: string
  runId: string
  seq: number
  snapshot: SubagentRunV1
}

/** A summary is a display projection; its short list never claims to be the full run. */
export interface SubagentToolSummary extends SubagentToolCall {
  revisionSeq: number
  ordinal: number
  detailRef: string
  detailTruncated: boolean
  argsPreview?: string
  outputPreview?: string
}

export interface SubagentCoverage {
  asOfSeq: number
  toolCount: number
  includedToolCount: number
  activeToolCount: number
  includedActiveToolCount: number
  ids: string[]
  hasMore: boolean
  truncated: boolean
  completeness: 'complete' | 'partial' | 'unknown'
  nextCursor?: string
}

export interface SubagentRunView extends Omit<SubagentRunV1, 'schemaVersion' | 'toolCalls'> {
  schemaVersion: 2
  view: 'summary'
  toolCalls: SubagentToolSummary[]
  coverage: SubagentCoverage
  toolCount: number
  activeToolCount: number
  latestActivity?: SubagentToolSummary
  recoveryRequired?: boolean
  /** Coverage proves fetched data; resident fields describe only the bounded local sample. */
  residentToolCount?: number
  residentBytes?: number
}

export type SubagentRun = SubagentRunV1 | SubagentRunView

export type SubagentIdentity = Pick<
  SubagentRunV1,
  | 'tenantId'
  | 'rootSessionId'
  | 'parentSessionId'
  | 'parentConversationId'
  | 'parentMessageId'
  | 'parentToolCallId'
  | 'childSessionId'
>

export type SubagentViewHeader = Omit<SubagentRunView, 'toolCalls' | 'coverage'>

export interface SubagentDeltaEvent {
  schemaVersion: 2
  kind: string
  runId: string
  seq: number
  baseSeq: number
  identity: SubagentIdentity
  header?: SubagentViewHeader
  headerPatch: Partial<Omit<SubagentViewHeader, 'schemaVersion' | 'view'>>
  toolUpsert?: SubagentToolSummary
  coverage?: SubagentCoverage
}

/** A negotiated legacy checkpoint is explicit; it is never fabricated as a contiguous delta. */
export interface SubagentViewEvent {
  schemaVersion: 2
  kind: 'snapshot'
  runId: string
  seq: number
  view: SubagentRunView
}

export type SubagentWireEvent = SubagentEvent | SubagentDeltaEvent | SubagentViewEvent

export interface SubagentRunsPage {
  schemaVersion: 1 | 2
  runs: SubagentRun[]
  revision?: string
  listComplete: boolean
  hasMore: boolean
  nextCursor?: string
}

export interface SubagentToolsPage {
  schemaVersion: 2
  runId: string
  asOfSeq: number
  items: SubagentToolSummary[]
  nextCursor?: string
  hasMore: boolean
  totalCount: number
}

export interface SubagentToolDetailPage {
  schemaVersion: 2
  runId: string
  asOfSeq: number
  tool: SubagentToolSummary
  detail: {
    encoding: 'json-utf8'
    text: string
    offset: number
    nextOffset?: number
    totalBytes: number
    hasMore: boolean
  }
}

export interface SubagentEventsPage {
  schemaVersion: 2
  runId: string
  events: SubagentWireEvent[]
  nextSeq: number
  hasMore: boolean
  checkpointRequired: boolean
}

/** Discovery carries exact identity hints, never a truncated run/usage snapshot. */
export interface SubagentCapabilities {
  /** Three explicit server capabilities are required; summary v2 alone is insufficient. */
  childRecovery?: boolean
  protocol: 1 | 2
  discovery: boolean
}
export interface SubagentDiscoveryScope {
  tenantId: string
  parentSessionId: string
  rootSessionId?: string
  parentConversationId?: string
}
export type SubagentDiscoveryRef = Pick<SubagentRunV1,
  'tenantId' | 'runId' | 'parentSessionId' | 'rootSessionId' | 'parentConversationId' |
  'parentMessageId' | 'parentToolCallId' | 'childSessionId' | 'modelId' | 'agentId' | 'agentName' | 'createdAt'> & {
    revision: number
    createdRevision: number
    runSeq: number
    status: SubagentRunStatus
    deleted: boolean
  }
export interface SubagentDiscoveryPage {
  protocolVersion: 1
  source: 'durable-lifecycle'
  generation: string
  scope: SubagentDiscoveryScope
  mode: 'active' | 'changes'
  asOfRevision: number
  floorRevision: number
  activeCount: number
  items: SubagentDiscoveryRef[]
  includedCount: number
  scannedCount: number
  nextRevision?: number
  hasMore: boolean
  nextCursor: string | null
  membershipCompleteness: 'partial' | 'complete'
}
