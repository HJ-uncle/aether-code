import type { RootRun } from '@shared/root-run'
import type { EngineHistoryRow } from './chat-history'
import { replayMessages } from './chat-history'
import { isHistoryDisplayRow } from './history-page'
import { applyRootRuns } from './root-run-state'
import { applyHistoryFinalResult } from './final-result'
import { isRootFollowupFor, normalizeRootFollowupMessage } from './root-followup-message'
import type { ChatMessage, ToolActivity } from './useChat'

export interface DisplayHistoryTurn {
  userMessageId: string
  conversationId?: string
  preview: string
  createdAt?: number
}
export type DisplayHistoryCompleteness = 'complete' | 'sqlite_compacted'
export interface DisplayHistoryPage {
  schemaVersion: 1
  grouping?: 'root'
  turns: DisplayHistoryTurn[]
  messages: EngineHistoryRow[]
  loadedTurnIds: string[]
  revision: string
  mutationRevision: string
  backend: 'jsonl' | 'sqlite'
  completeness: DisplayHistoryCompleteness
}
export interface DisplayHistoryCache {
  sessionId: string
  page: DisplayHistoryPage
  bodies: ReadonlyMap<string, ChatMessage[]>
  /** A changed mutation epoch must not revive an unloaded, stale snapshot body. */
  invalidatedTurnIds: ReadonlySet<string>
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192
}

type DisplayAdmission = Pick<ChatMessage, 'id' | 'role' | 'runId' | 'conversationId' | 'rootFollowup'>
function rowIdentity(row: EngineHistoryRow): DisplayAdmission {
  return { id: row.id!, role: row.role === 'user' ? 'user' : 'assistant',
    runId: row.metadata?.runId ?? row.metadata?.rootRunId,
    conversationId: row.conversationId ?? row.metadata?.turnId,
    rootFollowup: normalizeRootFollowupMessage(row) }
}

/** Index and whole-turn bodies must describe the same response, never raw row pages. */
export function checkDisplayHistory(raw: unknown, anchorMessageId?: string, limit = 2): DisplayHistoryPage {
  const invalid = (): never => { throw new Error('完整对话记录格式不正确，请重新加载') }
  if (!record(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.turns) || !Array.isArray(raw.messages) ||
    !Array.isArray(raw.loadedTurnIds) || !identity(raw.revision) || !identity(raw.mutationRevision) ||
    !['jsonl', 'sqlite'].includes(String(raw.backend)) || !['complete', 'sqlite_compacted'].includes(String(raw.completeness)) ||
    raw.grouping !== undefined && raw.grouping !== 'root' ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > 10) return invalid()
  const turns: DisplayHistoryTurn[] = [], ids = new Set<string>()
  for (const value of raw.turns) {
    if (!record(value) || !identity(value.userMessageId) || ids.has(value.userMessageId) || typeof value.preview !== 'string' ||
      value.conversationId !== undefined && !identity(value.conversationId) ||
      value.createdAt !== undefined && (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || !Number.isFinite(new Date(value.createdAt).getTime()))) return invalid()
    ids.add(value.userMessageId)
    turns.push({ userMessageId: value.userMessageId, preview: value.preview,
      ...(typeof value.conversationId === 'string' ? { conversationId: value.conversationId } : {}),
      ...(typeof value.createdAt === 'number' ? { createdAt: value.createdAt } : {}) })
  }
  const start = anchorMessageId ? turns.findIndex(turn => turn.userMessageId === anchorMessageId) : Math.max(0, turns.length - limit)
  if (start < 0) return invalid()
  const expected = turns.slice(start, start + limit).map(turn => turn.userMessageId)
  if (raw.loadedTurnIds.length !== expected.length || raw.loadedTurnIds.some((id, index) => id !== expected[index])) return invalid()
  const rowIds = new Set<string>(), userIds: string[] = []
  let admission: DisplayAdmission | undefined
  for (const row of raw.messages) {
    if (!isHistoryDisplayRow(row) || rowIds.has(row.id!)) return invalid()
    rowIds.add(row.id!)
    if (row.role === 'user') {
      const current = rowIdentity(row)
      // Only an opted-in response may include extra user rows in one body.
      // An orphan supplement that the server indexed remains its own anchor.
      if (raw.grouping !== 'root' || ids.has(row.id!) || !isRootFollowupFor(current, admission)) {
        userIds.push(row.id!)
        admission = current
      }
    }
    // A leading assistant/tool is precisely the split-turn failure this protocol removes.
    if (!userIds.length || row.role === 'system' && row.metadata?.isCompactSummary) return invalid()
  }
  if (userIds.length !== expected.length || userIds.some((id, index) => id !== expected[index])) return invalid()
  return { schemaVersion: 1, ...(raw.grouping === 'root' ? { grouping: 'root' as const } : {}), turns, messages: raw.messages as EngineHistoryRow[], loadedTurnIds: expected,
    revision: raw.revision, mutationRevision: raw.mutationRevision,
    backend: raw.backend as DisplayHistoryPage['backend'], completeness: raw.completeness as DisplayHistoryCompleteness }
}

export function cacheDisplayHistory(sessionId: string, page: DisplayHistoryPage, previous?: DisplayHistoryCache | null): DisplayHistoryCache {
  const prior = previous?.sessionId === sessionId ? previous : undefined
  // A split body cached from an older engine is not a complete root body.
  const changed = Boolean(prior && (prior.page.mutationRevision !== page.mutationRevision || prior.page.grouping !== page.grouping))
  const known = new Set(page.turns.map(turn => turn.userMessageId))
  const bodies = new Map(changed ? [] : prior?.bodies)
  const invalidated = new Set(prior?.invalidatedTurnIds)
  if (changed) for (const turn of prior!.page.turns) invalidated.add(turn.userMessageId)
  for (const id of bodies.keys()) if (!known.has(id)) { bodies.delete(id); invalidated.add(id) }
  let rows: EngineHistoryRow[] = [], userId: string | undefined
  const loaded = new Set(page.loadedTurnIds)
  const save = (): void => {
    if (!userId) return
    // The endpoint already scopes the session. Child-session messages can carry
    // isSidechain without being foreign history within that selected session.
    bodies.set(userId, replayMessages(rows.map(row => row.isSidechain ? { ...row, isSidechain: false } : row)))
    invalidated.delete(userId)
  }
  for (const row of page.messages) {
    if (row.role === 'user' && (page.grouping !== 'root' || loaded.has(row.id!))) { save(); userId = row.id; rows = [] }
    rows.push(row)
  }
  save()
  return { sessionId, page, bodies, invalidatedTurnIds: invalidated }
}

function preserveToolEvidence(preferred: ToolActivity, fallback?: ToolActivity, live = false): ToolActivity {
  if (!fallback) return preferred
  const settled = ['done', 'error', 'cancelled', 'interrupted'].includes(preferred.state)
  if (live) return preferred.result === '[tool result cleared]' && settled
    ? { ...preferred, result: fallback.result } : preferred
  return { ...fallback, ...preferred,
    result: preferred.result === '[tool result cleared]' ? fallback.result : preferred.result,
    ...(preferred.subagentRef && !preferred.subagent ? { subagent: undefined } : {}) }
}

function restoreLivePrefix(complete: ChatMessage[], present: ChatMessage[]): ChatMessage[] {
  const evidence = new Map(complete.flatMap(message => message.tools).map(tool => [tool.id, tool]))
  const seenTools = new Set(present.flatMap(message => message.tools).map(tool => tool.id))
  let prefixed = false
  return present.map(message => {
    const observed = { ...message, tools: message.tools.map(tool => preserveToolEvidence(tool, evidence.get(tool.id), true)) }
    if (prefixed || message.role !== 'assistant') return observed
    const anchor = message.items.find(item => item.kind === 'tool' && evidence.has(item.id))
    if (!anchor || anchor.kind !== 'tool') return observed
    const archived = complete.find(item => item.tools.some(tool => tool.id === anchor.id))
    if (!archived) return observed
    let boundary = archived.items.findIndex(item => item.kind === 'tool' && item.id === anchor.id)
    if (boundary < 0) return observed
    // Text immediately before the anchor belongs to its own assistant/tool
    // segment and may already be in the live tail. End at the preceding call;
    // never pull disk text/results after an observed stream boundary forward.
    while (boundary > 0 && archived.items[boundary - 1].kind !== 'tool') boundary--
    const prefixItems = archived.items.slice(0, boundary)
    const prefixIds = new Set(prefixItems.flatMap(item => item.kind === 'tool' && !seenTools.has(item.id) ? [item.id] : []))
    if (!prefixIds.size) return observed
    prefixed = true
    const prefixTools = archived.tools.filter(tool => prefixIds.has(tool.id))
    const items = prefixItems.filter(item => item.kind !== 'tool' || prefixIds.has(item.id))
    const content = items.flatMap(item => item.kind === 'content' ? [item.text] : []).join('\n\n')
    const thinking = items.flatMap(item => item.kind === 'thinking' ? [item.text] : []).join('')
    return { ...observed, content: content ? `${content}${observed.content ? '\n\n' + observed.content : ''}` : observed.content,
      thinking: thinking + observed.thinking, tools: [...prefixTools, ...observed.tools], items: [...items, ...observed.items] }
  })
}

/** A display read cannot replace a live turn or write back into its reducer state. */
export function mergeDisplayHistory(cache: DisplayHistoryCache | null, current: ChatMessage[], liveTurnIds: ReadonlySet<string>, runs: RootRun[] = []): ChatMessage[] {
  if (!cache) return current
  const order = cache.page.turns.map(turn => turn.userMessageId)
  const byConversation = new Map(cache.page.turns.filter(turn => turn.conversationId).map(turn => [turn.conversationId!, turn.userMessageId]))
  const known = new Set(order), grouped = new Map<string, ChatMessage[]>(), unowned: ChatMessage[] = []
  const groupedRoots = cache.page.grouping === 'root'
  const admissions = new Map<string, DisplayAdmission>()
  const rootKey = (runId?: string, turnId?: string): string => JSON.stringify([runId, turnId])
  const remember = (message: DisplayAdmission): void => {
    if (message.role === 'user' && !message.rootFollowup && message.runId && message.conversationId)
      admissions.set(rootKey(message.runId, message.conversationId), message)
  }
  if (groupedRoots) {
    for (const body of cache.bodies.values()) if (body[0]) remember(body[0])
    for (const message of current) remember(message)
    for (const run of runs) remember({ id: run.userMessageId, role: 'user', runId: run.runId, conversationId: run.turnId })
  }
  let userId: string | undefined, admission: DisplayAdmission | undefined
  for (const message of current) {
    if (message.role === 'user') {
      // An indexed orphan is authoritative, and a later ordinary admission
      // prevents old-root mail from jumping backwards across a turn boundary.
      const candidate = groupedRoots && message.rootFollowup && !known.has(message.id)
        ? isRootFollowupFor(message, admission) ? admission : !admission ? admissions.get(rootKey(message.runId, message.conversationId)) : undefined
        : undefined
      admission = candidate && isRootFollowupFor(message, candidate) ? candidate : message
      userId = admission.id
    }
    const owner = userId ?? message.run?.userMessageId ??
      (message.conversationId ? byConversation.get(message.conversationId) : undefined)
    if (!owner) { unowned.push(message); continue }
    const group = grouped.get(owner) ?? []
    group.push(message); grouped.set(owner, group)
  }
  const result: ChatMessage[] = []
  for (const id of order) {
    const present = grouped.get(id) ?? []
    const stored = cache.bodies.get(id)
    // Old engines still index supplements separately. Protect their live tail
    // through the admitted root without treating a supplement as a new run.
    const live = liveTurnIds.has(id) || !groupedRoots && present.some(message => message.rootFollowup && runs.some(run =>
      run.runId === message.rootFollowup!.rootRunId && run.turnId === message.rootFollowup!.turnId && liveTurnIds.has(run.userMessageId)))
    if (!stored) {
      if (!cache.invalidatedTurnIds.has(id) || live) result.push(...present)
      continue
    }
    const complete = applyRootRuns(stored, runs.filter(run => run.userMessageId === id))
    if (live && present.length) {
      // A live projection is tied to its stream cursor; disk may already be ahead.
      // Restore a missing old prefix only before its earliest observed tool.
      if (!present.some(message => message.role === 'user' && message.id === id)) result.push(complete[0])
      let restored = restoreLivePrefix(complete, present)
      for (const message of complete) if (message.finalResult) restored = applyHistoryFinalResult(restored, message.finalResult)
      result.push(...restored)
    } else {
      const presentById = new Map(present.map(message => [message.id, message]))
      const presentTools = new Map(present.flatMap(message => message.tools).map(tool => [tool.id, tool]))
      result.push(...complete.map(message => {
        const previous = presentById.get(message.id)
        const observedResult = previous?.finalResult
        const finalResult = observedResult && observedResult.runId === message.runId && observedResult.turnId === message.conversationId &&
          (!message.finalResult || observedResult.publishedAt > message.finalResult.publishedAt) ? observedResult : message.finalResult
        return { ...message, ...(previous ? { run: previous.run ?? message.run, pending: previous.pending, interactions: previous.interactions,
          status: previous.status, error: previous.error, answered: previous.answered } : {}),
          finalResult,
          tools: message.tools.map(tool => {
            const observed = presentTools.get(tool.id)
            // Preserve current file-review and child/job state while taking the
            // full historical body from the complete-turn display response.
            return observed ? preserveToolEvidence({ ...observed,
              result: tool.result === '[tool result cleared]' ? observed.result : tool.result }, tool) : tool
          }) }
      }))
    }
  }
  // Newly admitted optimistic/live turns can legitimately precede index refresh.
  result.push(...unowned)
  for (const [id, group] of grouped) if (!known.has(id) && (!cache.invalidatedTurnIds.has(id) || liveTurnIds.has(id))) result.push(...group)
  return result
}
