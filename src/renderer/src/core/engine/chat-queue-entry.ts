import type { ChatAttachment, QueuedMessage, SendOptions } from './useChat'

export type QueuedChatEntry = QueuedMessage & { options: SendOptions }

/** The tray and transport must share the same captured attachment selection. */
export function createQueuedChatEntry(
  id: string,
  text: string,
  options: SendOptions,
  attachments: ChatAttachment[] = options.attachments ?? []
): QueuedChatEntry {
  const captured = attachments.map(file => ({ ...file }))
  return { id, text, attachments: captured, options: { ...options, attachments: captured } }
}

export function editQueuedChatEntry(
  entry: QueuedChatEntry,
  text: string,
  attachments: ChatAttachment[]
): QueuedChatEntry {
  return createQueuedChatEntry(entry.id, text.trim(), entry.options, attachments)
}
