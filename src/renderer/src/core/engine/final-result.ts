import { normalizeFinalResult, type FinalResult } from '../../../../shared/final-result'
import type { ChatMessage } from './useChat'

/** Root status and the immutable manifest must agree before calling anything a result. */
export function getMessageFinalResult(message: ChatMessage, sessionId: string): FinalResult | undefined {
  const result = message.finalResult
  const run = message.run
  if (!result || message.role !== 'assistant' || message.status !== 'done' || run?.status !== 'succeeded' ||
    result.sessionId !== sessionId || run.sessionId !== sessionId || run.runId !== result.runId ||
    run.turnId !== result.turnId || run.assistantMessageId !== result.assistantMessageId || message.id !== result.assistantMessageId ||
    message.runId && message.runId !== result.runId ||
    message.conversationId && message.conversationId !== result.turnId) return undefined
  return result
}

/** Prefer the durable manifest when available; completed legacy roots without
 * one still need to expose their transcript tail as the user-visible answer. */
export function finalAnswerForMessage(message: ChatMessage, sessionId: string): { text: string } | false | undefined {
  const result = getMessageFinalResult(message, sessionId)
  if (result) return { text: result.text }
  // A completed root can be replayed from older history without the result
  // manifest that newer runs publish.  Treat its last content as the answer so
  // collapsing the process does not hide the only user-visible response.
  // Segmented assistant rows are retained as process history; only the row
  // owning the root assistant identity may become this fallback answer.
  const run = message.run
  const ownsRootAssistant = !run?.assistantMessageId || run.assistantMessageId === message.id
  if (message.role === 'assistant' && message.status === 'done' && run?.status === 'succeeded' &&
    ownsRootAssistant && message.content.trim()) return undefined
  // A transcript with no durable root identity is the legacy path: the
  // timeline can infer its last content as the answer directly.
  if (message.role === 'assistant' && message.status === 'done' && !message.finalResult && !message.run && !message.runId) {
    return undefined
  }
  // Keep the explicit false sentinel while a root is running or waiting for
  // its manifest; progress text must not flash as the final response.
  return false
}

/** Receiving a manifest does not settle a running/failed root or attach it to another message. */
export function applyFinalResult(message: ChatMessage, raw: unknown): ChatMessage {
  const result = normalizeFinalResult(raw)
  if (!result || message.role !== 'assistant' || message.runId !== result.runId ||
    message.conversationId !== result.turnId || message.run && message.run.sessionId !== result.sessionId) return message
  const previous = message.finalResult
  if (previous && previous.publishedAt >= result.publishedAt) return message
  return { ...message, finalResult: result }
}

export function applyProjectedFinalResult(messages: ChatMessage[], raw: unknown): ChatMessage[] {
  const result = normalizeFinalResult(raw)
  if (!result) return messages
  const owner = messages.findLastIndex(message => message.role === 'assistant' && message.runId === result.runId &&
    message.conversationId === result.turnId && (!message.run || message.run.sessionId === result.sessionId))
  if (owner < 0) return messages
  const next = applyFinalResult(messages[owner], result)
  return next === messages[owner] ? messages : messages.map((message, index) => index === owner ? next : message)
}
