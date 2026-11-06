import type { FinalResult } from '@shared/final-result'
import type { ChatMessage } from '@renderer/core/engine/useChat'
import { getMessageFinalResult } from '../../core/engine/final-result'

export interface WorkFinalResultSelection {
  sessionId: string
  runId: string
  itemId: string
  revision: number
}

/** The newest user group owns the default view even before it publishes any
 * delivery. Older files remain explicitly selectable without posing as new work. */
export function workFinalResultCatalog(messages: readonly ChatMessage[], sessionId: string): {
  results: FinalResult[]; current?: FinalResult; currentKey: string
} {
  const lastUser = messages.findLastIndex(message => message.role === 'user')
  const latestMessage = messages.findLastIndex(message => message.role === 'assistant')
  const currentTurnId = messages[lastUser]?.conversationId
  const byRun = new Map<string, FinalResult>()
  const currentRuns = new Set<string>()
  for (const [index, message] of messages.entries()) {
    const result = getMessageFinalResult(message, sessionId)
    if (!result) continue
    const previous = byRun.get(result.runId)
    if (!previous || previous.publishedAt < result.publishedAt) byRun.set(result.runId, result)
    if ((lastUser >= 0 ? index > lastUser && (!currentTurnId || result.turnId === currentTurnId) : index === latestMessage)) currentRuns.add(result.runId)
  }
  const results = [...byRun.values()].sort((left, right) => right.publishedAt - left.publishedAt)
  return { results, current: results.find(result => currentRuns.has(result.runId)),
    currentKey: messages[lastUser]?.id ?? messages.at(-1)?.runId ?? 'empty' }
}
