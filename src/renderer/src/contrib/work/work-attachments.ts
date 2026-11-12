import type { ChatAttachment, ChatMessage } from '../../core/engine/useChat'
import type { Mention } from '../chat/mention-context'
import { draftAttachmentSelection } from '../chat/attachment-references'

const attachmentKey = (path: string): string => path.replace(/\\/g, '/')

/** Keep upload receipts (including live remote tokens) when history has only a path. */
export function mergeWorkAttachments(...groups: readonly (readonly ChatAttachment[])[]): ChatAttachment[] {
  const files = new Map<string, ChatAttachment>()
  for (const group of groups) for (const file of group) {
    const key = attachmentKey(file.path)
    if (!files.has(key)) files.set(key, file)
  }
  return [...files.values()]
}

function isAttachmentReference(mention: Mention): boolean {
  return mention.source === 'file' && Boolean(mention.path) &&
    mention.origin !== 'workspace' && mention.origin !== 'artifact'
}

/** References select resources for this turn; merely keeping a resource never resends it. */
export function draftAttachments(
  pending: readonly ChatAttachment[],
  sources: readonly ChatAttachment[],
  mentions: readonly Mention[]
): ChatAttachment[] {
  const referenced = new Set(mentions.filter(mention => isAttachmentReference(mention) && mention.content === undefined).flatMap(mention => {
    // A historical version's exact path wins; identity is the fallback after a
    // queue/import path remap, not permission to resend every edited version.
    const file = sources.find(item => attachmentKey(item.path) === attachmentKey(mention.path!))
      ?? (mention.attachmentId ? sources.findLast(item => item.attachmentId === mention.attachmentId) : undefined)
    return file ? [file] : []
  }))
  // Snapshot references already carry the original bytes inside the message.
  const embedded = new Set(mentions.filter(mention => mention.path && mention.content !== undefined)
    .map(mention => attachmentKey(mention.path!)))
  return mergeWorkAttachments(draftAttachmentSelection(pending, mentions), sources.filter(file => referenced.has(file)))
    .filter(file => !embedded.has(attachmentKey(file.path)))
}

/** Inline resource references stay inline when a sent turn is restored for editing. */
export function restoreWorkAttachments(
  pending: readonly ChatAttachment[],
  sources: readonly ChatAttachment[],
  incoming: readonly ChatAttachment[],
  mentions: readonly Mention[]
): { attachments: ChatAttachment[]; sources: ChatAttachment[] } {
  const referenced = new Set(mentions.filter(isAttachmentReference).map(mention => attachmentKey(mention.path!)))
  const referencedIds = new Set(mentions.filter(isAttachmentReference).flatMap(mention => mention.attachmentId ? [mention.attachmentId] : []))
  return {
    attachments: mergeWorkAttachments(pending, incoming.filter(file => !referenced.has(attachmentKey(file.path)) && !(file.attachmentId && referencedIds.has(file.attachmentId)))),
    sources: mergeWorkAttachments(sources, incoming)
  }
}

export function workMessageAttachments(messages: readonly ChatMessage[]): ChatAttachment[] {
  return mergeWorkAttachments(...messages.filter(message => message.role === 'user').map(message => message.attachments ?? []))
}
