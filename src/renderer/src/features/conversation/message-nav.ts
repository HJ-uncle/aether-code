import type { ChatMessage } from '@renderer/core/engine/useChat'
import type { DisplayHistoryTurn } from '@renderer/core/engine/display-history'
import type { NavTurn } from './shared/MessageNavRail'
import { userMessageText } from './shared/mention-context'
import { isRootFollowupFor } from '@renderer/core/engine/root-followup-message'

export interface SessionNavigationGroup {
  id: string
  startIndex: number
  messages: readonly ChatMessage[]
}

/** Older engines may still index supplements separately. Hide only entries
 * whose original admission is actually loaded, never an orphan history row. */
export function sessionGroupedDisplayTurns(groups: readonly SessionNavigationGroup[], index?: readonly DisplayHistoryTurn[] | null, loaded?: readonly string[]): readonly DisplayHistoryTurn[] | null | undefined {
  if (!index) return index
  const attached = new Set(groups.flatMap(group => {
    const admission = group.messages.find(message => message.role === 'user')
    return group.messages.filter(message => isRootFollowupFor(message, admission) && (!loaded || loaded.includes(message.id))).map(message => message.id)
  }))
  return attached.size ? index.filter(turn => !attached.has(turn.userMessageId)) : index
}

/** Use the same complete-turn identity as selection and export. */
export function sessionNavigationTurns(groups: readonly SessionNavigationGroup[], index?: readonly DisplayHistoryTurn[] | null, loadedTurnIds?: readonly string[]): NavTurn[] {
  const loaded = groups.flatMap(group => {
    const message = group.messages.find(item => item.role === 'user')
    if (!message) return []
    const text = userMessageText(message.content).replace(/\s+/g, ' ').trim()
    return [{ id: group.id, message, preview: text.slice(0, 60) || message.attachments?.[0]?.name || '附件消息' }]
  })
  index = sessionGroupedDisplayTurns(groups, index, loadedTurnIds)
  if (!index) return loaded
  const byUser = new Map(loaded.map(turn => [turn.message.id, turn]))
  const indexed = new Set(index.map(turn => turn.userMessageId))
  return [...index.map(turn => byUser.get(turn.userMessageId) ?? {
    id: `message:${turn.userMessageId}`,
    preview: turn.preview,
    // This row is only an index entry; navigation loads the actual turn before
    // mounting it or copying its user prompt.
    message: { id: turn.userMessageId, role: 'user' as const, content: turn.preview,
      thinking: '', tools: [], items: [], status: 'done' as const,
      createdAt: turn.createdAt ?? 0, conversationId: turn.conversationId }
  }), ...loaded.filter(turn => !indexed.has(turn.message.id))]
}
