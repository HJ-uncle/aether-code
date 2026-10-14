import type { PublishedChildFence, PublishedChildIdentity, PublishedChildReference, PublishedChildUsage } from '@shared/published-child'
import type { ChatSsePayload } from '@shared/ipc'
import type { SubagentRun } from '@shared/subagent'
import type { ChatMessage } from './useChat'

const IDENTITY_KEYS = ['tenantId', 'runId', 'rootSessionId', 'parentSessionId', 'parentConversationId',
  'parentMessageId', 'parentToolCallId', 'childSessionId', 'modelId'] as const
const FENCE_KEYS = ['tenantId', 'parentSessionId', 'rootSessionId', 'parentTurnId', 'rootRunId',
  'attemptId', 'streamId', 'generation'] as const
const MAX_REFERENCES = 4096
const MAX_REFERENCE_BYTES = 256 * 1024
const MAX_ARCHIVE_REFERENCE_BYTES = 2 * 1024 * 1024
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min
const utf8Bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192

export class PublishedChildRecoveryError extends Error {
  constructor(readonly reason: string) { super(`协作记录需要重新同步（${reason}）`); this.name = 'PublishedChildRecoveryError' }
}
function fail(reason: string): never { throw new PublishedChildRecoveryError(reason) }

export function parsePublishedFence(value: unknown): PublishedChildFence {
  if (!record(value) || FENCE_KEYS.some(key => !text(value[key])) ||
    !integer(value.eventSequence) || !integer(value.revision) || !integer(value.usageRevision) ||
    value.recoveryMode !== undefined && value.recoveryMode !== 'persisted-published' ||
    value.recoveryMode === 'persisted-published' && (!text(value.bootstrapId) || typeof value.bootstrapDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.bootstrapDigest))) fail('invalid_fence')
  return { ...value } as unknown as PublishedChildFence
}
export function samePublishedFence(a: PublishedChildFence, b: PublishedChildFence): boolean {
  return ([...FENCE_KEYS, 'eventSequence', 'revision', 'usageRevision', 'recoveryMode', 'bootstrapId', 'bootstrapDigest'] as const).every(key => a[key] === b[key])
}
export function parsePublishedIdentity(value: unknown, fence: PublishedChildFence): PublishedChildIdentity {
  if (!record(value) || IDENTITY_KEYS.some(key => !text(value[key])) || !integer(value.createdAt) ||
    value.tenantId !== fence.tenantId || value.parentSessionId !== fence.parentSessionId ||
    value.rootSessionId !== fence.rootSessionId || value.parentConversationId !== fence.parentTurnId ||
    ['agentId', 'agentName'].some(key => value[key] !== undefined && !text(value[key]))) fail('foreign_child_identity')
  return Object.fromEntries([...IDENTITY_KEYS, 'createdAt', 'agentId', 'agentName'].filter(key => value[key] !== undefined).map(key => [key, value[key]])) as unknown as PublishedChildIdentity
}

export function normalizePublishedChildReference(value: unknown): PublishedChildReference | undefined {
  if (!record(value) || value.protocolVersion !== 1 || !integer(value.source) || !text(value.sessionId) ||
    !text(value.snapshotId) || !integer(value.atSeq, 1) || !integer(value.projectionIndex) || utf8Bytes(value) > MAX_REFERENCE_BYTES) return undefined
  try {
    const fence = parsePublishedFence(value.fence), identity = parsePublishedIdentity(value.identity, fence)
    if (value.sessionId !== fence.parentSessionId) return undefined
    return { protocolVersion: 1, source: value.source, sessionId: value.sessionId, snapshotId: value.snapshotId,
      fence, identity, atSeq: value.atSeq, projectionIndex: value.projectionIndex }
  } catch { return undefined }
}

/** A modern partial page cannot borrow completeness or usage from resident runs. */
export function parsePublishedUsage(value: unknown, source: number, sessionId: string): PublishedChildUsage {
  if (!record(value) || value.protocolVersion !== 1 || !['live-published', 'persisted-published'].includes(String(value.source)) || !text(value.snapshotId)) fail('invalid_recovery')
  const fence = parsePublishedFence(value.fence)
  if (fence.parentSessionId !== sessionId || !integer(source)) fail('foreign_session')
  const usage = value.usage
  if (!record(usage) || usage.source !== 'authoritative-scalar' || !text(usage.revision) ||
    typeof usage.totalTokens !== 'number' || !Number.isFinite(usage.totalTokens) || usage.totalTokens < 0 ||
    !integer(usage.count) || !integer(usage.unknown) || usage.unknown > usage.count ||
    usage.finishedAt !== undefined && !integer(usage.finishedAt)) fail('invalid_usage_scalar')
  return { source: value.source as PublishedChildUsage['source'], clientSource: source, sessionId, snapshotId: value.snapshotId,
    fence, revision: usage.revision, scalar: { totalTokens: usage.totalTokens, count: usage.count, unknown: usage.unknown,
      ...(usage.finishedAt !== undefined ? { finishedAt: usage.finishedAt as number } : {}) } }
}

/** Revisions are opaque. Only an explicit current snapshot can change an owner. */
export function replacePublishedUsage(previous: PublishedChildUsage | undefined, next: PublishedChildUsage,
  scope: { source: number; sessionId: string; fullRestore: boolean }): PublishedChildUsage {
  if (next.clientSource !== scope.source || next.sessionId !== scope.sessionId) fail('source_changed')
  if (!previous) return next
  if (previous.clientSource !== next.clientSource || previous.sessionId !== next.sessionId) {
    if (!scope.fullRestore) fail('source_changed')
    return next
  }
  const sameOwner = [...FENCE_KEYS].every(key => previous.fence[key] === next.fence[key]) && previous.source === next.source
  if (!sameOwner) { if (!scope.fullRestore) fail('owner_changed'); return next }
  if (next.fence.eventSequence < previous.fence.eventSequence || next.fence.revision < previous.fence.revision || next.fence.usageRevision < previous.fence.usageRevision) fail('stale_usage')
  if (next.revision === previous.revision && (!samePublishedFence(previous.fence, next.fence) || JSON.stringify(previous.scalar) !== JSON.stringify(next.scalar))) fail('same_revision_conflict')
  return next
}

export interface PublishedProjectionEntry {
  projectionIndex: number
  field: 'subagentEvent' | 'toolEnd' | 'toolResult'
  runId: string
  atSeq: number
  sourceAtSeq?: number
  nested?: 'subagent' | 'metadata.subagent' | 'meta.subagent'
  nestedLocations?: Array<'subagent' | 'metadata.subagent' | 'meta.subagent'>
}

export function parsePublishedProjectionPage(value: unknown, authority: PublishedChildUsage,
  originalCount: number): { entries: PublishedProjectionEntry[]; nextCursor: string | null; totalCount: number } {
  if (!record(value) || value.protocolVersion !== 1 || value.snapshotId !== authority.snapshotId ||
    !samePublishedFence(parsePublishedFence(value.fence), authority.fence) || !Array.isArray(value.entries) ||
    value.originalProjectionCount !== originalCount || !integer(value.totalCount) || value.totalCount > MAX_REFERENCES || value.entries.length > 64 ||
    typeof value.hasMore !== 'boolean' ||
    value.hasMore && (!text(value.nextCursor) || !value.entries.length) || !value.hasMore && value.nextCursor !== null || utf8Bytes(value) > MAX_REFERENCE_BYTES) fail('invalid_projection_page')
  const entries = value.entries.map(raw => {
    if (!record(raw) || !integer(raw.projectionIndex) || raw.projectionIndex >= originalCount ||
      !['subagentEvent', 'toolEnd', 'toolResult'].includes(String(raw.field)) || !text(raw.runId) || !integer(raw.atSeq, 1) ||
      raw.sourceAtSeq !== undefined && (!integer(raw.sourceAtSeq, 1) || raw.sourceAtSeq > raw.atSeq)) fail('invalid_projection_ref')
    const locations = raw.nestedLocations ?? (raw.nested ? [raw.nested] : [])
    if (!Array.isArray(locations) || raw.nestedLocations !== undefined && raw.nested !== undefined ||
      (raw.field === 'subagentEvent' ? locations.length !== 0 : locations.length < 1 || locations.length > 3) ||
      locations.some(location => !['subagent', 'metadata.subagent', 'meta.subagent'].includes(String(location))) || new Set(locations).size !== locations.length) fail('invalid_projection_location')
    return { ...raw } as unknown as PublishedProjectionEntry
  })
  return { entries, nextCursor: value.hasMore ? value.nextCursor as string : null, totalCount: value.totalCount }
}

export function parsePublishedLookup(value: unknown, authority: PublishedChildUsage, runId: string): { identity: PublishedChildIdentity; atSeq: number } {
  if (!record(value) || value.snapshotId !== authority.snapshotId || !samePublishedFence(parsePublishedFence(value.fence), authority.fence) ||
    !record(value.item) || !integer(value.item.atSeq, 1) || utf8Bytes(value) > MAX_REFERENCE_BYTES) fail('invalid_child_lookup')
  const identity = parsePublishedIdentity(value.item.identity, authority.fence)
  if (identity.runId !== runId) fail('foreign_child_identity')
  return { identity, atSeq: value.item.atSeq }
}

/** The existing lease page carries exact identities, avoiding one request per child. */
export function parsePublishedIdentityPage(value: unknown, authority: PublishedChildUsage): {
  items: Array<{ identity: PublishedChildIdentity; atSeq: number; firstOrdinal: number }>
  total: number; nextCursor: string | null
} {
  if (!record(value) || value.protocolVersion !== 1 || value.snapshotId !== authority.snapshotId ||
    !samePublishedFence(parsePublishedFence(value.fence), authority.fence) || !integer(value.totalPublishedCount) || value.totalPublishedCount > MAX_REFERENCES ||
    !Array.isArray(value.refs) || value.refs.length > 64 || value.includedCount !== value.refs.length || typeof value.residentComplete !== 'boolean' ||
    typeof value.hasMore !== 'boolean' || value.hasMore && (!text(value.nextCursor) || !value.refs.length || value.residentComplete) ||
    !value.hasMore && value.nextCursor !== null || value.refs.length > value.totalPublishedCount || utf8Bytes(value) > MAX_REFERENCE_BYTES ||
    value.source !== undefined && value.source !== authority.source) fail('invalid_identity_page')
  const usage = parsePublishedUsage({ ...value, source: authority.source }, authority.clientSource, authority.sessionId)
  if (usage.revision !== authority.revision || JSON.stringify(usage.scalar) !== JSON.stringify(authority.scalar)) fail('identity_usage_conflict')
  const items = value.refs.map(raw => {
    if (!record(raw) || !record(raw.identity) || !text(raw.identity.runId) || !integer(raw.firstOrdinal, 1)) fail('invalid_identity_page')
    return { ...parsePublishedLookup({ snapshotId: value.snapshotId, fence: value.fence, item: raw }, authority, raw.identity.runId), firstOrdinal: raw.firstOrdinal }
  })
  return { items, total: value.totalPublishedCount, nextCursor: value.hasMore ? value.nextCursor as string : null }
}

/** Restore original sparse positions, keeping child evidence as an unloaded reference. */
export function restorePublishedProjection(projection: ChatSsePayload[], indices: number[], originalCount: number,
  entries: PublishedProjectionEntry[], identities: ReadonlyMap<string, { identity: PublishedChildIdentity; atSeq: number }>,
  authority: PublishedChildUsage, options: { preview?: boolean; positions?: number[] } = {}): ChatSsePayload[] {
  if (projection.length !== indices.length || !integer(originalCount) || originalCount > 16384 || entries.length > MAX_REFERENCES ||
    utf8Bytes(entries) > MAX_ARCHIVE_REFERENCE_BYTES) fail('projection_budget')
  const positions = new Map<number, ChatSsePayload>()
  for (let index = 0; index < projection.length; index++) {
    const position = indices[index]
    if (!integer(position) || position >= originalCount || positions.has(position)) fail('invalid_projection_position')
    positions.set(position, { ...projection[index] })
  }
  const seen = new Set<number>()
  for (const entry of entries) {
    if (seen.has(entry.projectionIndex)) fail('duplicate_projection_ref')
    seen.add(entry.projectionIndex)
    const lookup = identities.get(entry.runId), sequence = entry.sourceAtSeq ?? entry.atSeq
    if (!lookup || lookup.atSeq !== entry.atSeq || sequence > lookup.atSeq) fail('missing_published_identity')
    const ref: PublishedChildReference = { protocolVersion: 1, source: authority.clientSource, sessionId: authority.sessionId,
      snapshotId: authority.snapshotId, fence: authority.fence, identity: lookup.identity, atSeq: sequence, projectionIndex: entry.projectionIndex }
    const frame = positions.get(entry.projectionIndex) ?? {}
    if (entry.field === 'subagentEvent') positions.set(entry.projectionIndex, { ...frame, publishedChild: ref })
    else {
      const raw = frame[entry.field]
      if (!record(raw)) {
        if (!options.preview) fail('missing_original_tool_slot')
        positions.set(entry.projectionIndex, { ...frame, publishedChild: ref }); continue
      }
      positions.set(entry.projectionIndex, { ...frame, [entry.field]: { ...raw, publishedChild: ref } })
    }
  }
  const sorted = [...positions].sort(([a], [b]) => a - b)
  if (options.positions) options.positions.push(...sorted.map(([position]) => position))
  return sorted.map(([, frame]) => frame)
}

/** Only a verified continuation on the same root stream can release an old card. */
export function advancePublishedChild(messages: ChatMessage[], run: SubagentRun,
  scope: { source: number; sessionId: string; eventId?: string }): ChatMessage[] {
  const split = scope.eventId?.lastIndexOf(':') ?? -1
  if (split < 1 || !scope.eventId) return messages
  const stream = scope.eventId.slice(0, split), sequence = Number(scope.eventId.slice(split + 1))
  if (!integer(sequence, 1)) return messages
  let changed = false
  const next = messages.map(message => {
    if (!message.publishedChildFence) return message
    const fence = message.publishedChildFence
    if (stream !== fence.streamId || sequence <= fence.eventSequence || run.tenantId !== fence.tenantId ||
      run.parentSessionId !== scope.sessionId || run.parentConversationId !== fence.parentTurnId || run.rootSessionId !== fence.rootSessionId) return message
    let edited = false
    const tools = message.tools.map(tool => {
      const ref = tool.subagentRef
      const identity = ref?.identity ?? tool.subagent
      if (!identity || ref && (ref.source !== scope.source || ref.sessionId !== scope.sessionId) ||
        run.lastSeq <= (ref?.atSeq ?? tool.subagent?.lastSeq ?? 0) ||
        [...IDENTITY_KEYS, 'createdAt'].some(key => run[key as keyof PublishedChildIdentity] !== identity[key as keyof PublishedChildIdentity])) return tool
      const { subagentRef: _oldRef, ...ordinary } = tool
      edited = true; changed = true
      return { ...ordinary, subagent: run, state: run.status === 'succeeded' ? 'done' as const :
        run.status === 'failed' || run.status === 'blocked' ? 'error' as const :
        run.status === 'cancelled' ? 'cancelled' as const : run.status === 'interrupted' ? 'interrupted' as const : 'running' as const }
    })
    return edited ? { ...message, tools } : message
  })
  return changed ? next : messages
}
