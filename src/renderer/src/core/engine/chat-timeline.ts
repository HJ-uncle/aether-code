import type { RootRun } from '@shared/root-run'
import type { ChatMessage } from './useChat'
import { replayMessages, type EngineHistoryRow } from './chat-history'
import { reducePayload } from './chat-payload'
import { normalizeRootFollowupMessage } from './root-followup-message'

export function ownsRootMessage(message: ChatMessage, run: RootRun): boolean {
  return message.runId === run.runId || message.conversationId === run.turnId ||
    message.id === run.userMessageId || message.id === run.assistantMessageId
}

export function emptyRunAssistant(run: RootRun, createdAt = run.createdAt): ChatMessage {
  return { id: run.assistantMessageId, runId: run.runId, attemptId: run.attemptId, conversationId: run.turnId,
    role: 'assistant', content: '', thinking: '', tools: [], items: [],
    status: 'streaming', createdAt, startedAt: createdAt }
}

/**
 * Collapse the visual boundary between two physical attempts of the same
 * retained turn.  The engine deliberately gives every continuation a fresh
 * attempt/message identity so late events and billing can be audited without
 * ambiguity; the conversation surface should still read as one answer.
 *
 * This helper only runs when the server supplied the exact predecessor and
 * current attempt IDs.  Equal text, adjacency, or a user supplied label never
 * qualify, so an unrelated follow-up cannot be merged into an older answer.
 */
export function mergeContinuationAssistantSegments(messages: ChatMessage[], target: {
  runId: string
  turnId?: string
  previousAttemptId: string
  previousMessageId?: string
  attemptId: string
  messageId: string
}): ChatMessage[] {
  if (!target.runId || !target.previousAttemptId || !target.attemptId || target.previousAttemptId === target.attemptId) return messages
  const currentIndex = messages.findLastIndex(message => message.role === 'assistant' &&
    (message.runId === target.runId || message.id === target.messageId || target.turnId !== undefined && message.conversationId === target.turnId) &&
    (message.attemptId === target.attemptId || message.id === target.messageId))
  const previousIndex = messages.findLastIndex(message => message.role === 'assistant' &&
    (message.runId === target.runId || target.previousMessageId !== undefined && message.id === target.previousMessageId ||
      target.turnId !== undefined && message.conversationId === target.turnId) &&
    (message.attemptId === target.previousAttemptId || message.id === target.previousMessageId))
  if (currentIndex < 0 || previousIndex < 0 || currentIndex === previousIndex) return messages
  const previous = messages[previousIndex], current = messages[currentIndex]
  const previousUsage = previous.usage && typeof previous.usage === 'object' && !Array.isArray(previous.usage)
    ? previous.usage as Record<string, unknown> : {}
  const currentUsage = current.usage && typeof current.usage === 'object' && !Array.isArray(current.usage)
    ? current.usage as Record<string, unknown> : {}
  const usageKeys = new Set([...Object.keys(previousUsage), ...Object.keys(currentUsage)])
  const usage: Record<string, unknown> = {}
  for (const key of usageKeys) {
    const before = previousUsage[key], after = currentUsage[key]
    // Durable assistant rows carry per-attempt billing increments. Context
    // fields are snapshots and must follow the latest attempt instead.
    if (key === 'currentPromptTokens' || key === 'contextWindow' || key === 'requestInputTokenEstimate') {
      if (after !== undefined) usage[key] = after
      else if (before !== undefined) usage[key] = before
    } else if (typeof before === 'number' && typeof after === 'number' && Number.isFinite(before) && Number.isFinite(after)) {
      usage[key] = before + after
    } else if (after !== undefined) usage[key] = after
    else if (before !== undefined) usage[key] = before
  }
  const merged: ChatMessage = {
    ...previous,
    ...current,
    id: target.messageId,
    runId: target.runId,
    attemptId: target.attemptId,
    conversationId: current.conversationId ?? previous.conversationId,
    content: previous.content + current.content,
    thinking: previous.thinking + current.thinking,
    tools: [...previous.tools, ...current.tools],
    items: [...previous.items, ...current.items],
    createdAt: Math.min(previous.createdAt, current.createdAt),
    startedAt: previous.startedAt ?? current.startedAt,
    // A newly inserted continuation card usually has no usage yet. Preserve
    // the interrupted invocation until its first cumulative usage frame lands.
    usage: Object.keys(usage).length ? usage : undefined,
  }
  const result = messages.filter((_message, index) => index !== previousIndex && index !== currentIndex)
  result.splice(Math.min(previousIndex, currentIndex), 0, merged)
  return result
}

/** Server-owned attempt boundary. Equal prose never establishes ownership. */
export function applyProjectedAssistantSegment(messages: ChatMessage[], segment: import('@shared/ipc').ChatSsePayload['assistantSegment'], run: RootRun): ChatMessage[] {
  if (!segment || segment.runId !== run.runId || segment.turnId !== run.turnId || !segment.attemptId || !segment.messageId ||
    !Number.isSafeInteger(segment.createdAt) || segment.createdAt < 0) return messages
  if (messages.some(message => message.role === 'assistant' && message.runId === segment.runId && message.attemptId === segment.attemptId)) return messages
  const receipt = run.continuationReceipt
  if (receipt?.protocolVersion === 1 && receipt.rootRunId === run.runId && receipt.turnId === run.turnId &&
    receipt.sessionId === run.sessionId && receipt.attemptId === segment.attemptId && receipt.previousAttemptId !== receipt.attemptId &&
    receipt.assistantIdentityKind === 'continuation-segment') {
    const merged = mergeContinuationAssistantSegments(messages, {
      runId: segment.runId, turnId: segment.turnId, previousAttemptId: receipt.previousAttemptId,
      previousMessageId: receipt.assistantAnchorId,
      attemptId: segment.attemptId, messageId: segment.messageId,
    })
    if (merged !== messages) return merged.map(message => message.id === segment.messageId
      ? { ...message, status: rootStatusForSegment(run), run, endedAt: undefined, error: undefined, pending: undefined }
      : message)
  }
  const index = messages.findLastIndex(message => ownsRootMessage(message, run))
  const result = [...messages]
  result.splice(index < 0 ? result.length : index + 1, 0, { ...emptyRunAssistant(run, segment.createdAt),
    id: segment.messageId, attemptId: segment.attemptId, status: segment.attemptId === run.attemptId ? rootStatusForSegment(run) : 'done' })
  return result
}
function rootStatusForSegment(run: RootRun): ChatMessage['status'] {
  return run.status === 'running' ? 'streaming' : run.status === 'cancelled' ? 'aborted' :
    run.status === 'failed' ? 'error' : run.status === 'succeeded' ? 'done' : run.status
}

/** A delivered user row is a transcript boundary, not assistant body text.
 * Its immutable ID also makes repeated live/snapshot delivery idempotent. */
export function applyProjectedUserMessage(messages: ChatMessage[], row: EngineHistoryRow, run: RootRun): ChatMessage[] {
  if (row.role !== 'user' || !row.id || row.isSidechain ||
    row.metadata?.rootRunId && row.metadata.rootRunId !== run.runId ||
    row.metadata?.runId && row.metadata.runId !== run.runId ||
    row.metadata?.turnId && row.metadata.turnId !== run.turnId ||
    row.conversationId && row.conversationId !== run.turnId) return messages
  const user = replayMessages([{ ...row, conversationId: run.turnId,
    metadata: { ...row.metadata, rootRunId: run.runId } }])[0]
  if (!user) return messages
  // Identity enrichment for legacy frames cannot manufacture delivery evidence.
  user.rootFollowup = normalizeRootFollowupMessage(row)
  user.run = run
  const existing = messages.findIndex(message => message.role === 'user' && message.id === row.id)
  if (existing >= 0) return messages.map((message, index) => index === existing ? user : message)
  const result = [...messages]
  let insertion = result.length
  for (let index = result.length - 1; index >= 0; index--) {
    if (ownsRootMessage(result[index], run)) { insertion = index + 1; break }
  }
  const previous = result[insertion - 1]
  const next = emptyRunAssistant(run, user.createdAt || run.createdAt)
  if (previous?.role === 'assistant' && ownsRootMessage(previous, run)) {
    next.modelId = previous.modelId
    next.contextModelId = previous.contextModelId
    next.contextUsageEstimated = previous.contextUsageEstimated
    result[insertion - 1] = { ...previous,
      id: previous.id === run.assistantMessageId ? `segment:${run.runId}:before:${row.id}` : previous.id,
      status: 'done', endedAt: previous.endedAt ?? (user.createdAt || undefined),
      pending: undefined, error: undefined }
  }
  result.splice(insertion, 0, user, next)
  return result
}

const usageSnapshots = new Set(['currentPromptTokens', 'contextWindow', 'requestInputTokenEstimate'])

/** Stream usage is cumulative for a root. Persist segment increments so a
 * split transcript still sums to exactly one root's bill. */
export function applyProjectedUsage(messages: ChatMessage[], usage: unknown, runId: string): ChatMessage[] {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return messages
  let owner = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'assistant' && messages[index].runId === runId) { owner = index; break }
  }
  if (owner < 0) return messages
  const frame: Record<string, unknown> = { ...usage }
  for (const [key, value] of Object.entries(frame)) {
    if (typeof value !== 'number' || usageSnapshots.has(key)) continue
    let previous = 0
    for (let index = 0; index < owner; index++) {
      const message = messages[index]
      if (message.role !== 'assistant' || message.runId !== runId || !message.usage || typeof message.usage !== 'object') continue
      const amount = (message.usage as Record<string, unknown>)[key]
      if (typeof amount === 'number' && Number.isFinite(amount)) previous += amount
    }
    frame[key] = Math.max(0, value - previous)
  }
  return messages.map((message, index) => index === owner ? reducePayload(message, { usage: frame }) : message)
}

/** Final persistence names the current assistant segment only. */
export function bindProjectedAssistantId(messages: ChatMessage[], runId: string, id: string): ChatMessage[] {
  let owner = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'assistant' && messages[index].runId === runId) { owner = index; break }
  }
  if (owner < 0 || !id || messages[owner].id === id) return messages
  return messages.map((message, index) => index === owner ? { ...message, id } : message)
}
