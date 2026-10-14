import type { SubagentDiscoveryRef } from './subagent'

export interface PublishedChildFence {
  tenantId: string
  parentSessionId: string
  rootSessionId: string
  parentTurnId: string
  rootRunId: string
  attemptId: string
  streamId: string
  generation: string
  eventSequence: number
  revision: number
  usageRevision: number
  recoveryMode?: 'persisted-published'
  bootstrapId?: string
  bootstrapDigest?: string
}

export type PublishedChildIdentity = Pick<SubagentDiscoveryRef,
  'tenantId' | 'runId' | 'rootSessionId' | 'parentSessionId' | 'parentConversationId' |
  'parentMessageId' | 'parentToolCallId' | 'childSessionId' | 'modelId' | 'createdAt' | 'agentId' | 'agentName'>

/** Exact published evidence. This is deliberately not a SubagentRun summary. */
export interface PublishedChildReference {
  protocolVersion: 1
  source: number
  sessionId: string
  snapshotId: string
  fence: PublishedChildFence
  identity: PublishedChildIdentity
  atSeq: number
  projectionIndex: number
}

export interface PublishedChildUsage {
  source: 'live-published' | 'persisted-published'
  clientSource: number
  sessionId: string
  snapshotId: string
  fence: PublishedChildFence
  revision: string
  scalar: { totalTokens: number; count: number; unknown: number; finishedAt?: number }
}
