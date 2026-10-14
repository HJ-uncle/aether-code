import type { ChatSsePayload } from '@shared/ipc'
import type { PublishedChildReference, PublishedChildUsage } from '@shared/published-child'
import type { ChatRecoverySnapshot } from './chat-recovery'
import type { SubagentRun } from '@shared/subagent'
import { assertSubagentConnection, captureSubagentConnection, getSubagentRun, requestOrThrow } from './client'
import { PublishedChildRecoveryError, parsePublishedFence, parsePublishedLookup, parsePublishedProjectionPage,
  parsePublishedUsage, parsePublishedIdentityPage, restorePublishedProjection, samePublishedFence, type PublishedProjectionEntry } from './published-child-recovery'
import { PublishedRecoveryCancelledError, type PublishedRecoveryProgress } from './published-recovery-control'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const bytes = (value: string): number => new TextEncoder().encode(value).byteLength
// SQLite's default BINARY text ordering compares UTF-8, not locale collation or
// JavaScript UTF-16 code units; this also covers non-ASCII imported run IDs.
const compareRunIds = (left: string, right: string): number => {
  const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right)
  for (let index = 0; index < Math.min(a.length, b.length); index++) if (a[index] !== b[index]) return a[index] - b[index]
  return a.length - b.length
}
const digest = async (value: string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
function fail(reason: string): never { throw new PublishedChildRecoveryError(reason) }

/** Pages stay on one lease. The first page paints before later pages or a large body. */
export async function preparePublishedSnapshot(snapshot: ChatRecoverySnapshot, source: number,
  verify: () => void, options: {
    signal?: AbortSignal
    waitForBody?: () => Promise<void>
    progress?: (preview: ChatRecoverySnapshot, progress: PublishedRecoveryProgress) => void
  } = {}): Promise<ChatRecoverySnapshot> {
  const check = (): void => { if (options.signal?.aborted) throw new PublishedRecoveryCancelledError(); verify() }
  check()
  const connection = captureSubagentConnection()
  if (connection.source !== source) fail('source_changed')
  const authority = parsePublishedUsage(snapshot.subagentRecovery, source, snapshot.sessionId)
  const read = async (path: string, query: Record<string, string | number>): Promise<unknown> => {
    check(); assertSubagentConnection(connection)
    const result = await requestOrThrow<unknown>({ method: 'GET', path,
      query: { sessionId: snapshot.sessionId, childRecoveryProtocol: 1, snapshotId: authority.snapshotId, ...query },
      expectedEngine: connection.expectedEngine, toolProfile: connection.toolProfile, subagentProtocol: 2 })
    check(); assertSubagentConnection(connection)
    return result
  }
  if (snapshot.source !== 'live' && snapshot.source !== 'persisted-published' || !snapshot.run ||
    snapshot.run.runId !== authority.fence.rootRunId || snapshot.run.turnId !== authority.fence.parentTurnId ||
    snapshot.eventId !== authority.fence.streamId + ':' + authority.fence.eventSequence) fail('snapshot_prefix_mismatch')
  const archive = snapshot.subagentProjectionArchive
  if (!archive || archive.protocolVersion !== 1 || archive.snapshotId !== authority.snapshotId ||
    archive.endpoint !== '/chat/snapshot/projection' || !Number.isSafeInteger(archive.totalCount) || archive.totalCount < 0 ||
    archive.totalCount > 4096 || !Number.isSafeInteger(archive.originalProjectionCount) || archive.originalProjectionCount < archive.totalCount ||
    archive.originalProjectionCount > 16384) fail('projection_budget')
  const body = snapshot.bodyArchive
  if (body && (body.protocolVersion !== 1 || body.source !== 'sealed-current-turn' || body.endpoint !== '/chat/snapshot/body' ||
    body.previewComplete !== false || !Number.isSafeInteger(body.byteLength) || body.byteLength < 1 || body.byteLength > 8 * 1024 * 1024 ||
    !Number.isSafeInteger(body.chunkCount) || body.chunkCount < 1 || body.chunkCount > 1024 || !/^[a-f0-9]{64}$/.test(body.sha256) ||
    !Number.isSafeInteger(body.originalProjectionCount) || body.originalProjectionCount < 1 || body.originalProjectionCount > 16384 ||
    typeof body.originalCurrentTurnComplete !== 'boolean')) fail('body_archive_budget')
  let projection = snapshot.projection, indices = snapshot.projectionIndices
  if (!indices) fail('missing_projection_positions')
  const entries: PublishedProjectionEntry[] = [], cursors = new Set<string>()
  const identities = new Map<string, ReturnType<typeof parsePublishedLookup>>()
  let cursor: string | null = null, identityBytes = 0, loadedBodyParts = 0
  const pagedIdentities = record(snapshot.subagentRecovery) && 'refs' in snapshot.subagentRecovery
  const identityCursors = new Set<string>()
  let identityCursor: string | null = null, identityTotal: number | undefined
  let lastIdentity: { firstOrdinal: number; runId: string } | undefined
  const acceptIdentities = (raw: unknown): void => {
    const page = parsePublishedIdentityPage(raw, authority)
    if (identityTotal !== undefined && identityTotal !== page.total) fail('identity_count_conflict')
    identityTotal = page.total
    for (const item of page.items) {
      const runId = item.identity.runId
      if (identities.has(runId) || lastIdentity && (item.firstOrdinal < lastIdentity.firstOrdinal ||
        item.firstOrdinal === lastIdentity.firstOrdinal && compareRunIds(runId, lastIdentity.runId) <= 0)) fail('identity_order_conflict')
      identityBytes += bytes(JSON.stringify(item))
      if (identities.size >= 4096 || identityBytes > 8 * 1024 * 1024) fail('identity_archive_budget')
      identities.set(runId, item); lastIdentity = { firstOrdinal: item.firstOrdinal, runId }
    }
    if (identities.size > page.total || !page.nextCursor && identities.size !== page.total) fail('identity_count_conflict')
    if (page.nextCursor) {
      if (identityCursors.has(page.nextCursor)) fail('repeated_identity_cursor')
      identityCursors.add(page.nextCursor)
    }
    identityCursor = page.nextCursor
  }
  if (pagedIdentities) acceptIdentities(snapshot.subagentRecovery)
  let previewCache: { count: number; projection: ChatSsePayload[]; snapshot: ChatRecoverySnapshot } | undefined
  const projected = (preview: boolean): ChatRecoverySnapshot => {
    if (preview && previewCache?.count === entries.length && previewCache.projection === projection) return previewCache.snapshot
    const restoredPositions: number[] = []
    const restoredProjection = restorePublishedProjection(projection, indices!, archive.originalProjectionCount, entries, identities, authority,
      { preview, positions: restoredPositions })
    const restored = { ...snapshot, projection: restoredProjection, projectionIndices: restoredPositions,
      publishedUsage: authority, currentTurnComplete: preview ? false : body?.originalCurrentTurnComplete ?? snapshot.currentTurnComplete }
    if (preview) previewCache = { count: entries.length, projection, snapshot: restored }
    return restored
  }
  const emit = async (phase: PublishedRecoveryProgress['phase'], preview = true): Promise<void> => {
    check()
    options.progress?.(projected(preview), { source, sessionId: snapshot.sessionId, snapshotId: authority.snapshotId,
      phase, loadedReferences: entries.length, totalReferences: archive.totalCount, loadedBodyParts,
      totalBodyParts: body?.chunkCount ?? 0, previewAvailable: true })
    if (options.progress) await new Promise<void>(resolve => setTimeout(resolve, 0))
    check()
  }
  await emit('references')
  do {
    const raw = await read('/chat/snapshot/projection', { limit: 64, ...(cursor ? { cursor } : {}) })
    const page = parsePublishedProjectionPage(raw, authority, archive.originalProjectionCount)
    if (page.totalCount !== archive.totalCount || entries.length + page.entries.length > archive.totalCount) fail('projection_count_conflict')
    const missing = [...new Set(page.entries.map(entry => entry.runId))].filter(runId => !identities.has(runId))
    while (pagedIdentities && missing.some(runId => !identities.has(runId))) {
      if (!identityCursor) fail('missing_published_identity')
      acceptIdentities(await read('/chat/snapshot/children', { limit: 64, cursor: identityCursor }))
    }
    for (let offset = 0; !pagedIdentities && offset < missing.length; offset += 4) {
      check()
      const batch = missing.slice(offset, offset + 4)
      const results = await Promise.allSettled(batch.map(async runId => parsePublishedLookup(
        await read('/chat/snapshot/children/' + encodeURIComponent(runId), {}), authority, runId)))
      check()
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') throw result.reason
        identityBytes += bytes(JSON.stringify(result.value))
        if (identities.size >= 4096 || identityBytes > 8 * 1024 * 1024) fail('identity_archive_budget')
        identities.set(batch[index], result.value)
      }
    }
    entries.push(...page.entries)
    cursor = page.nextCursor
    if (cursor) { if (cursors.has(cursor)) fail('repeated_projection_cursor'); cursors.add(cursor) }
    await emit('references')
  } while (cursor)
  if (entries.length !== archive.totalCount) fail('incomplete_projection_archive')
  if (body) {
    await emit('body-ready')
    await options.waitForBody?.(); check()
    const chunks: string[] = []; let total = 0
    for (let part = 0; part < body.chunkCount; part++) {
      const page = await read('/chat/snapshot/body', { part })
      if (!record(page) || page.protocolVersion !== 1 || page.snapshotId !== authority.snapshotId ||
        !samePublishedFence(parsePublishedFence(page.fence), authority.fence) || page.part !== part || typeof page.chunk !== 'string' ||
        page.nextPart !== (part + 1 < body.chunkCount ? part + 1 : null) || JSON.stringify(page.archive) !== JSON.stringify(body) ||
        await digest(page.chunk) !== page.chunkDigest) fail('body_archive_corrupt')
      check()
      total += bytes(page.chunk)
      if (total > body.byteLength || bytes(JSON.stringify(page)) > 256 * 1024) fail('body_archive_budget')
      chunks.push(page.chunk); loadedBodyParts++
      if (part % 16 === 0 || part + 1 === body.chunkCount) await emit('body')
    }
    const encoded = chunks.join('')
    if (total !== body.byteLength || await digest(encoded) !== body.sha256) fail('body_archive_corrupt')
    check()
    let full: unknown
    try { full = JSON.parse(encoded) } catch { fail('body_archive_corrupt') }
    if (!record(full) || full.streamId !== authority.fence.streamId || full.eventId !== snapshot.eventId ||
      !Array.isArray(full.projection) || !Array.isArray(full.projectionIndices) || full.projection.length !== body.originalProjectionCount) fail('body_archive_corrupt')
    projection = full.projection as ChatSsePayload[]; indices = full.projectionIndices as number[]
  }
  await emit((body?.originalCurrentTurnComplete ?? snapshot.currentTurnComplete) === false ? 'retained' : 'complete', false)
  return projected(false)
}

/** A details click revalidates the old lease and requests exactly its saved seq. */
export async function readPublishedChild(reference: PublishedChildReference): Promise<SubagentRun> {
  const connection = captureSubagentConnection()
  const verify = (): void => { assertSubagentConnection(connection); if (connection.source !== reference.source) fail('source_changed') }
  verify()
  const authority: PublishedChildUsage = { source: reference.fence.recoveryMode ?? 'live-published', clientSource: reference.source,
    sessionId: reference.sessionId, snapshotId: reference.snapshotId, fence: reference.fence, revision: 'reference-only',
    scalar: { totalTokens: 0, count: 0, unknown: 0 } }
  const raw = await requestOrThrow<unknown>({ method: 'GET', path: '/chat/snapshot/children/' + encodeURIComponent(reference.identity.runId),
    query: { sessionId: reference.sessionId, childRecoveryProtocol: 1, snapshotId: reference.snapshotId },
    expectedEngine: connection.expectedEngine, toolProfile: connection.toolProfile, subagentProtocol: 2 })
  verify()
  const lookup = parsePublishedLookup(raw, authority, reference.identity.runId)
  if (reference.atSeq > lookup.atSeq || JSON.stringify(lookup.identity) !== JSON.stringify(reference.identity)) fail('published_reference_conflict')
  const run = await getSubagentRun(reference.identity.runId, { connection, verify, atSeq: reference.atSeq,
    parentSessionId: reference.sessionId, rootSessionId: reference.identity.rootSessionId,
    parentConversationId: reference.identity.parentConversationId })
  verify()
  for (const key of ['tenantId', 'parentMessageId', 'parentToolCallId', 'childSessionId', 'createdAt'] as const)
    if (run[key] !== reference.identity[key]) fail('published_reference_conflict')
  return run
}
