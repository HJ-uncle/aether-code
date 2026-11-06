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
  return { id: run.assistantMessageId, runId: run.runId, conversationId: run.turnId,
    role: 'assistant', content: '', thinking: '', tools: [], items: [],
    status: 'streaming', createdAt, startedAt: createdAt }
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
