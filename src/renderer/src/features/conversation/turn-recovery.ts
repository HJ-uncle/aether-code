import type { ChatMessage } from '@renderer/core/engine/useChat'
import { userMessageDraft } from './shared/mention-context'

/** Only the latest settled turn can be replayed. Never substitute the live draft
 * or a previous turn when archive paging has omitted the original request. */
export function recoverSessionTurn(messages: readonly ChatMessage[], assistantId: string) {
  const index = messages.findIndex(message => message.id === assistantId && message.role === 'assistant')
  const assistant = messages[index]
  if (!assistant || !['error', 'aborted', 'interrupted'].includes(assistant.status) ||
    messages.slice(index + 1).some(message => message.role === 'user' || message.role === 'assistant')) return null
  const user = messages.slice(0, index).findLast(message => message.role === 'user')
  if (!user || (user.runId && assistant.runId && user.runId !== assistant.runId) ||
    (user.conversationId && assistant.conversationId && user.conversationId !== assistant.conversationId)) return null
  const draft = userMessageDraft(user.content)
  const attachments = [...(user.attachments ?? [])]
  return draft.text.trim() || attachments.length ? { ...draft, attachments, status: assistant.status } : null
}
