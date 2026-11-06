import type { ChatMessage } from '@renderer/core/engine/useChat'
import type { DisplayHistoryTurn } from '@renderer/core/engine/display-history'
import type { NavTurn } from '../chat/MessageNavRail'
import { userMessageText } from '../chat/mention-context'
import { WORK_MESSAGE_PAGE_SIZE } from './work-view-performance'
import { isRootFollowupFor } from '@renderer/core/engine/root-followup-message'

export interface WorkNavigationGroup {
  id: string
  startIndex: number
  messages: readonly ChatMessage[]
}

/** Older engines may still index supplements separately. Hide only entries
 * whose original admission is actually loaded, never an orphan history row. */
export function workGroupedDisplayTurns(groups: readonly WorkNavigationGroup[], index?: readonly DisplayHistoryTurn[] | null, loaded?: readonly string[]): readonly DisplayHistoryTurn[] | null | undefined {
  if (!index) return index
  const attached = new Set(groups.flatMap(group => {
    const admission = group.messages.find(message => message.role === 'user')
    return group.messages.filter(message => isRootFollowupFor(message, admission) && (!loaded || loaded.includes(message.id))).map(message => message.id)
  }))
  return attached.size ? index.filter(turn => !attached.has(turn.userMessageId)) : index
}

/** Use the same complete-turn identity as selection and export. */
export function workNavigationTurns(groups: readonly WorkNavigationGroup[], index?: readonly DisplayHistoryTurn[] | null, loadedTurnIds?: readonly string[]): NavTurn[] {
  const loaded = groups.flatMap(group => {
    const message = group.messages.find(item => item.role === 'user')
    if (!message) return []
    const text = userMessageText(message.content).replace(/\s+/g, ' ').trim()
    return [{ id: group.id, message, preview: text.slice(0, 60) || message.attachments?.[0]?.name || '附件消息' }]
  })
  index = workGroupedDisplayTurns(groups, index, loadedTurnIds)
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

/** Keep the requested turn mounted without expanding the entire transcript. */
export function workNavigationTarget(
  messages: readonly { id: string }[],
  groups: readonly WorkNavigationGroup[],
  turnId: string
): { turnId: string; firstId: string } | null {
  const group = groups.find(item => item.id === turnId)
  if (!group || !group.messages.some(message => message.role === 'user') ||
    group.startIndex < 0 || group.startIndex >= messages.length) return null
  // Near the end, retain the latest page so stepping to the last turn does not
  // leave an unnecessarily small window or hide its preceding question.
  const first = Math.min(group.startIndex, Math.max(0, messages.length - WORK_MESSAGE_PAGE_SIZE))
  return { turnId, firstId: messages[first].id }
}
