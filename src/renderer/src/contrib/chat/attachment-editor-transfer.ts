import { attachmentMention, referencesAttachment, type AttachmentReference } from './attachment-references'
import { mentionToken, type Mention } from './mention-context'

export const ATTACHMENT_CHIP_DRAG_TYPE = 'application/x-aether-attachment-chip'
export const ATTACHMENT_CLIPBOARD_TYPE = 'application/x-aether-attachment-clipboard'

/** Transfer data selects an existing resource; it never supplies paths or markup. */
export function attachmentDropReference(raw: string, references: readonly AttachmentReference[]): AttachmentReference | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') return undefined
    return references.find(reference => reference.id === value.id)
  } catch { return undefined }
}

export function attachmentDragKey(raw: string, owner: string): string | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || !('owner' in value) || value.owner !== owner ||
      !('key' in value) || typeof value.key !== 'string') return undefined
    return value.key
  } catch { return undefined }
}

/** Only a locally captured clipboard snapshot reaches this function. Rebind its
 * attachment IDs against the current draft so a removed file cannot be revived. */
export function rebindAttachmentClipboard(draft: { text: string; mentions: readonly Mention[] }, references: readonly AttachmentReference[]):
  { text: string; mentions: Mention[] } | null {
  let text = '', cursor = 0
  const mentions: Mention[] = []
  for (const mention of draft.mentions) {
    if (mention.origin !== 'attachment' || mention.content !== undefined) continue
    const token = mentionToken(mention), start = mention.textOffset
    if (start === undefined || start < cursor || draft.text.slice(start, start + token.length) !== token) return null
    const reference = references.find(item => referencesAttachment(mention, item))
    if (!reference) return null
    text += draft.text.slice(cursor, start)
    const rebound = attachmentMention(reference)
    mentions.push({ ...rebound, textOffset: text.length })
    text += mentionToken(rebound)
    cursor = start + token.length
  }
  if (!mentions.length) return null
  return { text: text + draft.text.slice(cursor), mentions }
}
