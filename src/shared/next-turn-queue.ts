/** Foundation contracts only: no IPC, model invocation or engine admission is installed. */
export interface NextTurnQueueScope {
  source: { mode: 'embedded' | 'remote'; endpoint: string; accountId: string | null }
  tenantId: string
  namespace: { id: string; generation: string }
  owner: 'work'
  taskId: string
}

export type QueueResourceSelection =
  { kind: 'inherit' } | { kind: 'none' } | { kind: 'override'; ids: string[] }
export type QueueModelSelection =
  | { kind: 'explicit'; modelId: string }
  | { kind: 'client-default' | 'engine-default'; observedModelId?: string }
export type QueueMemorySelection =
  { kind: 'inherit' } | { kind: 'override'; scope: 'off' | 'session' | 'global'; version: string }
export interface QueueMention {
  source: 'file' | 'dir' | 'code' | 'terminal' | 'agent' | 'browser'
  displayText: string
  textOffset: number
  path?: string
  content?: string
  startLine?: number
  endLine?: number
  startColumn?: number
  endColumn?: number
}
export interface QueueAttachmentReceipt {
  kind: 'local-workspace' | 'local-scratch' | 'remote-session'
  scope: NextTurnQueueScope
  path: string
  name: string
  mime: string
  bytes: number
  receiptId: string
  sha256: string
}
export interface NextTurnQueueEnvelope {
  /** Main-owned enqueue identity; no provider or credential fields are stored. */
  submissionDigest?: string
  draft: { text: string; revision: number; mentions: QueueMention[] }
  model: QueueModelSelection
  workspace: { kind: 'local-workspace' | 'local-scratch' | 'remote-session'; identity: string }
  agent: {
    primaryAgentId: string | null
    collaborators: { agentId?: string; resumeRunId?: string }[]
  }
  resources: {
    skills: QueueResourceSelection
    mcpServers: QueueResourceSelection
    knowledgeBases: QueueResourceSelection
  }
  thinking: { kind: 'inherit' | 'off' } | { kind: 'effort'; effort: 'low' | 'medium' | 'high' }
  memory: QueueMemorySelection
  security: { policy: 'engine-session'; observedVersion?: string }
  subagentModel?: string
  utilityModel?: string
  attachments: QueueAttachmentReceipt[]
}
export interface FrozenQueueSubmission {
  requestKey: string
  bodyDigest: string
  entryRevision: number
  anchor: { runId: string; attemptId: string; version: number } | null
  /** Final serialized wire request, including admission; retry never re-runs preparation. */
  wireBody?: string
}
interface QueueEntryBase {
  id: string
  revision: number
  createdAt: number
  updatedAt: number
  envelope: NextTurnQueueEnvelope
}
export type NextTurnQueueEntry =
  | (QueueEntryBase & { phase: 'pending' })
  | (QueueEntryBase & {
      phase: 'dispatching' | 'admission-unknown'
      frozen: FrozenQueueSubmission
      reason?: string
    })
  | (QueueEntryBase & {
      phase: 'accepted' | 'terminal'
      frozen: FrozenQueueSubmission
      receipt: { runId: string; turnId: string; userMessageId: string; assistantMessageId: string }
      outcome?: 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
    })

export interface NextTurnQueueState {
  schemaVersion: 1
  scope: NextTurnQueueScope
  revision: number
  paused: boolean
  pauseReason?: string
  resumeAnchor?: FrozenQueueSubmission['anchor']
  entries: NextTurnQueueEntry[]
  removed: { id: string; entryRevision: number; removedAt: number }[]
}
export type NextTurnQueueUserMutation =
  | { kind: 'enqueue'; id: string; envelope: NextTurnQueueEnvelope; at: number }
  | { kind: 'edit'; id: string; entryRevision: number; envelope: NextTurnQueueEnvelope; at: number }
  | { kind: 'move'; id: string; beforeId: string | null }
  | { kind: 'remove'; id: string; entryRevision: number; at: number }
  | { kind: 'clear-pending'; at: number }
  | { kind: 'pause'; reason: string }
  | { kind: 'resume' }
export type NextTurnQueueMutation =
  NextTurnQueueUserMutation | NextTurnQueueOwnerMutation
export type NextTurnQueueOwnerMutation =
  | { kind: 'confirm-resume'; anchor: FrozenQueueSubmission['anchor'] }
  | { kind: 'recover-interrupted-submissions'; at: number }
  | { kind: 'claim'; id: string; entryRevision: number; frozen: FrozenQueueSubmission; at: number }
  | { kind: 'admission-unknown'; id: string; reason: string; at: number }
  | { kind: 'accepted'; id: string; receipt: { runId: string; turnId: string; userMessageId: string; assistantMessageId: string }; at: number }
  | { kind: 'terminal'; id: string; outcome: 'succeeded' | 'failed' | 'cancelled' | 'interrupted'; at: number }

export interface NextTurnQueueLimits {
  maxEntries: number
  maxRemoved: number
  maxTextBytes: number
  maxStateBytes: number
  maxMentions: number
  maxAttachments: number
  maxAttachmentBytes: number
  maxRevisions: number
  maxJournalBytes: number
  maxAuxiliaryFiles: number
  maxAuxiliaryBytes: number
}
export const DEFAULT_NEXT_TURN_QUEUE_LIMITS: Readonly<NextTurnQueueLimits> = Object.freeze({
  maxEntries: 100,
  maxRemoved: 2000,
  maxTextBytes: 1024 * 1024,
  maxStateBytes: 4 * 1024 * 1024,
  maxMentions: 100,
  maxAttachments: 32,
  maxAttachmentBytes: 100 * 1024 * 1024,
  maxRevisions: 5000,
  maxJournalBytes: 128 * 1024 * 1024,
  maxAuxiliaryFiles: 128,
  maxAuxiliaryBytes: 16 * 1024 * 1024
})
export interface QueueCommitReceipt {
  bucketKey: string
  revision: number
  operationId: string
  committedAt: number
  snapshotDigest: string
}
export interface QueueCommitResult {
  state: NextTurnQueueState
  receipt: QueueCommitReceipt
  replayed: boolean
  /** A directory sync may be unsupported on Windows; never equate this with a power-loss guarantee. */
  durabilityWarnings: string[]
}
export class NextTurnQueueError extends Error {
  constructor(
    readonly code:
      'INVALID' | 'SCOPE' | 'CAS' | 'CAPACITY' | 'CORRUPT' | 'IO' | 'AUTHORITY' | 'CONFLICT',
    message: string,
    readonly evidencePath?: string
  ) {
    super(message)
    this.name = 'NextTurnQueueError'
  }
}
