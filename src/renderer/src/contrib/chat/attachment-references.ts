import type { ChatAttachment } from '../../core/engine/useChat'
import { pastedTextLabel } from '../../../../shared/pasted-text-label'
import type { Mention } from './mention-context'

export const ATTACHMENT_DRAG_TYPE = 'application/x-aether-attachment-reference'

export interface AttachmentReference {
  id: string
  label: string
  file: ChatAttachment
}

/** Legacy receipts need a deterministic identity until they are saved again. */
export function attachmentIdentity(file: Pick<ChatAttachment, 'attachmentId' | 'path'>): string {
  return file.attachmentId || `legacy:${file.path.replace(/\\/g, '/')}`
}

export function attachmentReferences(files: readonly ChatAttachment[]): AttachmentReference[] {
  let image = 0, document = 0
  return files.map(file => ({ id: attachmentIdentity(file), file,
    label: pastedTextLabel(file.name, file.type) ??
      (file.type.startsWith('image/') ? `图${++image}` : `附件${++document}`) }))
}

export function attachmentMention(reference: AttachmentReference): Mention {
  return { source: 'file', origin: 'attachment', attachmentId: reference.id,
    path: reference.file.path, displayText: reference.label }
}

export function freezeAttachmentReferences(files: readonly ChatAttachment[]): ChatAttachment[] {
  return attachmentReferences(files).map(({ id, label, file }) => ({ ...file, attachmentId: id, referenceLabel: label }))
}

/** IDs determine order; a stale drop must never discard an upload that just completed. */
export function reorderAttachments(files: readonly ChatAttachment[], ids: readonly string[]): ChatAttachment[] {
  const byId = new Map(files.map(file => [attachmentIdentity(file), file]))
  const ordered: ChatAttachment[] = []
  for (const id of ids) {
    const file = byId.get(id)
    if (file) { ordered.push(file); byId.delete(id) }
  }
  return [...ordered, ...byId.values()]
}

export function referencesAttachment(mention: Mention, reference: AttachmentReference): boolean {
  return mention.source === 'file' && mention.origin === 'attachment' && mention.content === undefined &&
    (mention.attachmentId ? mention.attachmentId === reference.id
      : mention.path?.replace(/\\/g, '/') === reference.file.path.replace(/\\/g, '/'))
}
