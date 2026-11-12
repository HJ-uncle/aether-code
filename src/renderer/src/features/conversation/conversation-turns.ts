import type { ChatMessage } from '@renderer/core/engine/useChat'
import { isRootFollowupFor } from '@renderer/core/engine/root-followup-message'
import { sessionMessageTimeline, type SessionMessageSegment } from './message-timeline'
import type { DisplayHistoryTurn } from '@renderer/core/engine/display-history'

export interface SessionConversationGroup {
  id: string
  identity?: string
  messages: ChatMessage[]
  startIndex: number
  endIndex: number
  order: number
}

/** Supplements keep their physical rows, but belong to the original admission
 * for selection, navigation, usage and presentation. Unowned rows stay visible. */
export function sessionConversationGroups(messages: ChatMessage[]): SessionConversationGroup[] {
  const groups: SessionConversationGroup[] = []
  for (const [index, message] of messages.entries()) {
    const identity = message.conversationId ? `conversation:${message.conversationId}`
      : message.runId ? `run:${message.runId}` : undefined
    const previous = groups.at(-1)
    const admission = previous?.messages.find(item => item.role === 'user')
    const assistantBelongsToPrevious = message.role === 'assistant' && Boolean(admission) &&
      (!identity || !previous?.identity || identity === previous.identity)
    const sameIdentity = message.role !== 'user' && Boolean(previous && identity && previous.identity === identity)
    if (previous && (sameIdentity || assistantBelongsToPrevious || isRootFollowupFor(message, admission))) {
      previous.messages.push(message)
      previous.endIndex = index + 1
      if (!previous.identity && identity) previous.identity = identity
      continue
    }
    const id = message.role === 'user' ? `message:${message.id}` : identity ? `turn:${identity}` : `message:${message.id}`
    groups.push({ id, identity, messages: [message], startIndex: index, endIndex: index + 1, order: groups.length + 1 })
  }
  return groups
}

export interface SessionConversationEntry {
  key: string
  message: ChatMessage
  segments?: SessionMessageSegment[]
  processKey?: string
}

/** A legacy server indexes each supplement separately. A snapshot row is not
 * proof that all its archived tools/body have been loaded for export. */
export function sessionConversationComplete(group: SessionConversationGroup, index: readonly DisplayHistoryTurn[] | null | undefined, loaded: readonly string[]): boolean {
  if (!index) return true
  const admission = group.messages.find(message => message.role === 'user')
  const ids = new Set(group.messages.filter(message => message.role === 'user').map(message => message.id))
  return index.filter(turn => ids.has(turn.userMessageId) || admission?.conversationId && turn.conversationId === admission.conversationId)
    .every(turn => loaded.includes(turn.userMessageId))
}

/** One process disclosure spans the same root's assistant segments. The final
 * segment still owns status, interactions and final results; raw rows are never
 * rewritten, so copying/exporting a turn retains all original user input. */
export function sessionConversationEntries(group: SessionConversationGroup): SessionConversationEntry[] {
  const admission = group.messages.find(message => message.role === 'user')
  const lastAssistant = group.messages.findLast(message => message.role === 'assistant')
  const hasFollowups = group.messages.some(message => isRootFollowupFor(message, admission))
  const hasAssistantSegments = group.messages.filter(message => message.role === 'assistant').length > 1
  // Assistant IDs are renamed when a supplement splits the live stream. The
  // preceding immutable user row keeps disclosure state stable across that split.
  let precedingUser = admission?.id ?? group.id, ordinal = 0
  const timelines = new Map<ChatMessage, SessionMessageSegment[]>()
  for (const message of group.messages) {
    if (message.role === 'user') { precedingUser = message.id; ordinal = 0; continue }
    const prefix = `${precedingUser}:assistant:${ordinal++}`
    timelines.set(message, sessionMessageTimeline(message).map(segment => ({ ...segment, key: `${prefix}:${segment.key}` })))
  }
  // History can split ordinary tool iterations into assistant rows even without
  // a supplement. Their progress and tools need one timeline to distinguish the
  // final reply. Partial archives already require matching turn identities to
  // form a group, so they can share that timeline without inventing a user row.
  if (!lastAssistant || !hasFollowups && !hasAssistantSegments) return group.messages.map(message => ({
    key: message === lastAssistant ? `${group.id}:assistant` : message.id,
    message, segments: timelines.get(message), ...(message === lastAssistant ? { processKey: group.id } : {})
  }))
  const segments: SessionMessageSegment[] = []
  for (const message of group.messages) {
    if (message.role === 'assistant') {
      segments.push(...timelines.get(message)!)
    } else if (isRootFollowupFor(message, admission)) {
      segments.push({ kind: 'followup', key: message.id, message })
    }
  }
  return [
    ...(admission ? [{ key: admission.id, message: admission }] : []),
    { key: `${group.id}:assistant`, message: lastAssistant, segments, processKey: group.id }
  ]
}
