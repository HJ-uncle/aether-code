import type { SubagentRunsPage } from '@shared/subagent'
import type { getEngineSource, getExpectedEngine } from './source'

export const SUBAGENT_DIRECTORY_MAX_PAGES = 3
export const SUBAGENT_DIRECTORY_MAX_REFERENCES = 192
export const SUBAGENT_DIRECTORY_MAX_BYTES = 256 * 1024
export const SUBAGENT_DIRECTORY_RECENT_CURSORS = 3
// The existing engine route allows at most 200 rows, independently of its byte cap.
const MAX_WIRE_PAGE_REFERENCES = 200

export interface SubagentDirectoryScope {
  source: ReturnType<typeof getEngineSource>
  expectedEngine: ReturnType<typeof getExpectedEngine>
  generation: number
  parentSessionId: string
}

/** References prove ownership, but never carry a second copy of a run view. */
export interface SubagentDirectoryReference {
  runId: string
  childSessionId: string
  parentConversationId: string
  parentMessageId: string
  parentToolCallId: string
  lastSeq: number
}

export interface SubagentDirectoryPage {
  inputCursor?: string
  nextCursor?: string
  references: readonly SubagentDirectoryReference[]
  /** A new membership revision may retain observed identities, not its old cursor chain. */
  seenOnly: boolean
}

export interface SubagentDirectoryState {
  scope: SubagentDirectoryScope
  schemaVersion: 1 | 2
  parentSessionId: string
  tenantId?: string
  rootSessionId?: string
  ids: readonly string[]
  pages: readonly SubagentDirectoryPage[]
  revision?: string
  nextCursor?: string
  recentCursors: readonly string[]
  hasMore: boolean
  endReached: boolean
  /** Only a complete first page retained in its entirety proves resident completeness. */
  listComplete: boolean
  residentComplete: boolean
  partial: boolean
  budgetTrimmed: boolean
  /** UTF-8 serialized directory bytes, including scope, IDs, references and every cursor. */
  residentBytes: number
  updatedAt: number
}

export interface SubagentDirectoryUpdate {
  scope: SubagentDirectoryScope
  inputCursor?: string
  page: SubagentRunsPage
  updatedAt: number
  /** Explicitly returning to the first page discards only this resident directory window. */
  restart?: boolean
}

export interface SubagentDirectoryReduction {
  status: 'applied' | 'rejected' | 'legacy'
  state: SubagentDirectoryState
  reason?: string
}

const encoder = new TextEncoder()
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function validScope(scope: SubagentDirectoryScope): boolean {
  const engine = scope?.expectedEngine
  return integer(scope?.source) && integer(scope?.generation) && nonempty(scope?.parentSessionId)
    && !!engine && (engine.mode === 'embedded' || engine.mode === 'remote') && typeof engine.baseUrl === 'string'
    && (engine.instanceId == null || typeof engine.instanceId === 'string')
    && (engine.accountId == null || typeof engine.accountId === 'string')
}

export function sameSubagentDirectoryScope(left: SubagentDirectoryScope, right: SubagentDirectoryScope): boolean {
  return validScope(right) && left.source === right.source && left.generation === right.generation
    && left.parentSessionId === right.parentSessionId && left.expectedEngine.mode === right.expectedEngine.mode
    && left.expectedEngine.baseUrl === right.expectedEngine.baseUrl
    // Match engineConnectionKey: null and omitted identities both mean unbound.
    && (left.expectedEngine.instanceId ?? null) === (right.expectedEngine.instanceId ?? null)
    && (left.expectedEngine.accountId ?? null) === (right.expectedEngine.accountId ?? null)
}

export function subagentDirectoryResidentBytes(state: SubagentDirectoryState): number {
  // Include the byte ledger itself; its encoded decimal width converges in a few passes.
  let bytes = 0
  for (let pass = 0; pass < 4; pass++) {
    const next = encoder.encode(JSON.stringify({ ...state, residentBytes: bytes })).byteLength
    if (next === bytes) return bytes
    bytes = next
  }
  return bytes
}

export function createSubagentDirectory(
  scope: SubagentDirectoryScope,
  schemaVersion: 1 | 2 = 2,
  identity?: { tenantId: string; rootSessionId: string }
): SubagentDirectoryState {
  if (!validScope(scope) || (schemaVersion !== 1 && schemaVersion !== 2)
    || (identity && (!nonempty(identity.tenantId) || !nonempty(identity.rootSessionId))))
    throw new Error('Invalid subagent directory scope')
  const state: SubagentDirectoryState = {
    scope: { ...scope, expectedEngine: { ...scope.expectedEngine } }, schemaVersion,
    parentSessionId: scope.parentSessionId, tenantId: identity?.tenantId, rootSessionId: identity?.rootSessionId,
    ids: [], pages: [], recentCursors: [], hasMore: false, endReached: false,
    listComplete: false, residentComplete: false, partial: true, budgetTrimmed: false, residentBytes: 0, updatedAt: 0
  }
  state.residentBytes = subagentDirectoryResidentBytes(state)
  if (state.residentBytes > SUBAGENT_DIRECTORY_MAX_BYTES) throw new Error('Subagent directory scope exceeds byte budget')
  return state
}

function sameReference(left: SubagentDirectoryReference, right: SubagentDirectoryReference): boolean {
  return left.runId === right.runId && left.childSessionId === right.childSessionId
    && left.parentConversationId === right.parentConversationId && left.parentMessageId === right.parentMessageId
    && left.parentToolCallId === right.parentToolCallId
}

function reference(raw: unknown): SubagentDirectoryReference | undefined {
  if (!record(raw) || raw.schemaVersion !== 2 || raw.view !== 'summary'
    || !nonempty(raw.runId) || !nonempty(raw.childSessionId) || !nonempty(raw.parentConversationId)
    || !nonempty(raw.parentMessageId) || !nonempty(raw.parentToolCallId) || !integer(raw.lastSeq)) return undefined
  return { runId: raw.runId, childSessionId: raw.childSessionId, parentConversationId: raw.parentConversationId,
    parentMessageId: raw.parentMessageId, parentToolCallId: raw.parentToolCallId, lastSeq: raw.lastSeq }
}

function uniquePages(pages: readonly SubagentDirectoryPage[]): SubagentDirectoryPage[] {
  const ids = new Set<string>()
  return [...pages].reverse().map(page => ({ ...page, references: page.references.filter(item => {
    if (ids.has(item.runId)) return false
    ids.add(item.runId)
    return true
  }) })).reverse().filter(page => !page.seenOnly || page.references.length > 0)
}

/** The caller commits run views only after this entire page has passed atomic validation. */
export function reduceSubagentDirectory(state: SubagentDirectoryState, update: SubagentDirectoryUpdate): SubagentDirectoryReduction {
  const reject = (reason: string): SubagentDirectoryReduction => ({ status: 'rejected', state, reason })
  if (!sameSubagentDirectoryScope(state.scope, update.scope)) return reject('scope-mismatch')
  if (!integer(update.updatedAt) || (update.restart !== undefined && typeof update.restart !== 'boolean')) return reject('invalid-update')
  const page = update.page
  if (!record(page) || page.schemaVersion !== state.schemaVersion || !Array.isArray(page.runs)
    || (page.schemaVersion === 2 && page.runs.length > MAX_WIRE_PAGE_REFERENCES)
    || typeof page.hasMore !== 'boolean' || typeof page.listComplete !== 'boolean'
    || (page.listComplete && page.hasMore) || (page.revision !== undefined && !nonempty(page.revision))
    || (page.nextCursor !== undefined && !nonempty(page.nextCursor))) return reject('invalid-page')
  const inputCursor = update.inputCursor
  if (inputCursor !== undefined && !nonempty(inputCursor)) return reject('invalid-cursor')
  if (state.schemaVersion === 1) {
    // The legacy complete-array transport is deliberately outside this bounded pager.
    if (inputCursor !== undefined || page.hasMore || page.nextCursor !== undefined || !page.listComplete) return reject('legacy-pagination-unavailable')
    const next = { ...state, endReached: true, updatedAt: Math.max(state.updatedAt, update.updatedAt) }
    next.residentBytes = subagentDirectoryResidentBytes(next)
    return { status: 'legacy', state: next, reason: 'legacy-pagination-unavailable' }
  }
  if (page.hasMore && (!nonempty(page.nextCursor) || !nonempty(page.revision))) return reject('missing-page-cursor')
  const later = inputCursor !== undefined
  if (later && (update.restart || state.endReached || inputCursor !== state.nextCursor)) return reject('cursor-mismatch')
  if (later && (!nonempty(state.revision) || page.revision !== state.revision)) return reject('revision-mismatch')
  if (later && page.listComplete) return reject('later-page-cannot-be-complete')
  if (later && page.nextCursor !== undefined && (page.nextCursor === inputCursor || state.recentCursors.includes(page.nextCursor)
    || state.pages.some(item => item.inputCursor === page.nextCursor))) return reject('recent-cursor-repeat')

  let tenantId = state.tenantId
  let rootSessionId = state.rootSessionId
  const previous = new Map(state.pages.flatMap(item => item.references).map(item => [item.runId, item]))
  const incoming: SubagentDirectoryReference[] = []
  const incomingIds = new Set<string>()
  for (const raw of page.runs) {
    const item = reference(raw)
    if (!item || !record(raw) || !nonempty(raw.tenantId) || !nonempty(raw.rootSessionId)
      || raw.parentSessionId !== state.parentSessionId) return reject('run-identity-mismatch')
    tenantId ??= raw.tenantId
    rootSessionId ??= raw.rootSessionId
    if (raw.tenantId !== tenantId || raw.rootSessionId !== rootSessionId) return reject('run-scope-mismatch')
    if (incomingIds.has(item.runId)) return reject('duplicate-run-id')
    incomingIds.add(item.runId)
    const known = previous.get(item.runId)
    if (known && !sameReference(known, item)) return reject('run-identity-conflict')
    incoming.push(known && known.lastSeq > item.lastSeq ? { ...item, lastSeq: known.lastSeq } : item)
  }

  const refreshed = new Map(incoming.map(item => [item.runId, item]))
  const previousPages = state.pages.map(item => ({ ...item, references: item.references.map(old => refreshed.get(old.runId) ?? old) }))
  const currentPage: SubagentDirectoryPage = { inputCursor, nextCursor: page.nextCursor, references: incoming, seenOnly: false }
  const changedRevision = !later && state.pages.length > 0 && page.revision !== state.revision
  let pages: SubagentDirectoryPage[]
  if (update.restart) pages = [currentPage]
  else if (later) pages = [...previousPages, currentPage]
  else if (changedRevision) pages = [...previousPages.map(item => ({ references: item.references, seenOnly: true })), currentPage]
  else if (page.listComplete) pages = [currentPage]
  else pages = [currentPage, ...previousPages.filter(item => item.seenOnly || item.inputCursor !== undefined)]
  pages = uniquePages(pages)

  const preserveProgress = !later && !changedRevision && !update.restart && !page.listComplete && state.recentCursors.length > 0
  const nextCursor = preserveProgress ? state.nextCursor : page.hasMore ? page.nextCursor : undefined
  const endReached = preserveProgress ? state.endReached : !page.hasMore
  const recentCursors = later ? [...state.recentCursors, inputCursor].slice(-SUBAGENT_DIRECTORY_RECENT_CURSORS)
    : changedRevision || update.restart ? [] : [...state.recentCursors]
  let trimmed = false
  while (pages.length > SUBAGENT_DIRECTORY_MAX_PAGES) { pages.shift(); trimmed = true }
  while (pages.reduce((total, item) => total + item.references.length, 0) > SUBAGENT_DIRECTORY_MAX_REFERENCES) {
    if (pages.length > 1) pages.shift()
    else pages[0] = { ...pages[0], references: pages[0].references.slice(1) }
    trimmed = true
  }
  const materialize = (): SubagentDirectoryState => {
    const complete = !later && page.listComplete && !trimmed && pages.length === 1 && !pages[0].seenOnly
      && pages[0].references.length === incoming.length
    const next: SubagentDirectoryState = {
      ...state, tenantId, rootSessionId, revision: page.revision, pages,
      ids: [...new Set(pages.flatMap(item => item.references.map(run => run.runId)))], nextCursor, recentCursors,
      hasMore: !endReached && nextCursor !== undefined, endReached, listComplete: complete, residentComplete: complete,
      partial: !complete, budgetTrimmed: complete ? false : trimmed || (!update.restart && state.budgetTrimmed),
      updatedAt: Math.max(state.updatedAt, update.updatedAt), residentBytes: 0
    }
    next.residentBytes = subagentDirectoryResidentBytes(next)
    return next
  }
  let next = materialize()
  while (next.residentBytes > SUBAGENT_DIRECTORY_MAX_BYTES) {
    if (pages.length > 1) pages.shift()
    else if (pages[0]?.references.length) {
      // Removing one record and serializing the entire oversized window again
      // makes long UTF-8 identities quadratic. Size a prefix once, then verify
      // the final directory exactly; small ledger/boolean changes get slack.
      const references = pages[0].references
      const excess = next.residentBytes - SUBAGENT_DIRECTORY_MAX_BYTES + 32
      let removedBytes = 0
      let removedCount = 0
      for (const item of references) {
        removedBytes += encoder.encode(JSON.stringify(item)).byteLength + encoder.encode(JSON.stringify(item.runId)).byteLength
          + (removedCount < references.length - 1 ? 2 : 0)
        removedCount++
        if (removedBytes >= excess) break
      }
      pages[0] = { ...pages[0], references: references.slice(removedCount) }
    }
    else return reject('directory-byte-budget-exceeded')
    trimmed = true
    next = materialize()
  }
  return { status: 'applied', state: next }
}
