import type { ChatMessage } from '@renderer/core/engine/useChat'
import type { TurnUsageInfo } from './ConversationUsage'
import { sumUsage } from './usage'

/** Work groups durable turns by conversation identity, so aggregate the whole
 * group once instead of summing smaller groups and charging a child twice. */
export function summarizeTurnUsage(messages: ChatMessage[]): TurnUsageInfo | null {
  const assistants = messages.filter(message => message.role === 'assistant')
  if (!assistants.length) return null
  const total = sumUsage(messages)
  if (total.total <= 0 && total.unknownSubagents === 0) return null
  const starts = assistants.map(message => message.startedAt ?? message.run?.startedAt ?? message.createdAt)
    .filter(value => Number.isFinite(value) && value > 0)
  const ends = assistants.map(message => message.endedAt ?? message.run?.finishedAt ?? message.createdAt)
    .filter(value => Number.isFinite(value) && value > 0)
  if (total.endedAt !== undefined) ends.push(total.endedAt)
  const startedAt = starts.length ? Math.min(...starts) : undefined
  const endedAt = ends.length ? Math.max(...ends) : undefined
  const streaming = assistants.some(message => message.status === 'streaming' || message.status === 'waiting')
  return {
    tokens: total.total,
    summary: total.summary,
    askedAt: messages.find(message => message.role === 'user')?.createdAt ?? assistants[0].createdAt,
    // Old archives can retain a single timestamp; that is not a measured duration.
    ...(startedAt !== undefined && (streaming || endedAt !== undefined && endedAt > startedAt) ? { startedAt } : {}),
    ...(endedAt !== undefined && startedAt !== undefined && endedAt > startedAt ? { endedAt } : {}),
    model: assistants.findLast(message => Boolean(message.modelId))?.modelId,
    streaming
  }
}
