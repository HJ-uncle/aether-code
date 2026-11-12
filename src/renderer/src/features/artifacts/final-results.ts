import type { FinalResult } from '@shared/final-result'
import type { ChatMessage } from '@renderer/core/engine/useChat'
import { getMessageFinalResult } from '../../core/engine/final-result'

export interface FinalResultSelection {
  sessionId: string
  runId: string
  itemId: string
  revision: number
}

/** Conversation cards keep their own turn; the workspace keeps the latest
 * actual delivery until another nonempty publication replaces it. */
export function sessionFinalResultCatalog(messages: readonly ChatMessage[], sessionId: string): {
  results: FinalResult[]; current?: FinalResult; latestDelivery?: FinalResult; deliveryKey: string
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
  const latestDelivery = results.find(result => result.items.length > 0)
  return { results, current: results.find(result => currentRuns.has(result.runId)), latestDelivery,
    deliveryKey: latestDelivery ? JSON.stringify([latestDelivery.runId, latestDelivery.publishedAt,
      latestDelivery.items.map(item => [item.id, item.assetId])]) : 'empty' }
}
