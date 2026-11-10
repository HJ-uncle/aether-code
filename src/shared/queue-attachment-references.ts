import { NextTurnQueueError, type QueueMention, type QueueAttachmentReceipt } from './next-turn-queue'
import { queueMentionToken } from './next-turn-queue-state'

export interface QueueDraftReferenceInput {
  text: string
  revision: number
  mentions: readonly QueueMention[]
}

function pathKey(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * Rewrite only authored file chips whose bytes are being frozen into a queue
 * attachment. Plain `@` text and inline snapshots stay untouched. Offsets are
 * rebuilt from the resulting text so a subsequent queue validation can still
 * prove every chip belongs to the authored draft.
 */
export function remapQueueAttachmentReferences(
  draft: QueueDraftReferenceInput,
  paths: ReadonlyMap<string, string>
): { text: string; revision: number; mentions: QueueMention[] } {
  const normalized = new Map([...paths].map(([from, to]) => [pathKey(from), to]))
  let cursor = 0
  let output = ''
  const nextMentions: QueueMention[] = []
  for (const mention of draft.mentions) {
    const token = queueMentionToken(mention)
    const start = mention.textOffset
    if (!Number.isInteger(start) || start < cursor || draft.text.slice(start, start + token.length) !== token)
      throw new NextTurnQueueError('INVALID', 'Mention position does not match the authored chip')
    output += draft.text.slice(cursor, start)
    const nextPath = mention.source === 'file' && mention.content === undefined && mention.path
      ? normalized.get(pathKey(mention.path))
      : undefined
    const next = nextPath === undefined ? { ...mention } : { ...mention, path: nextPath }
    const nextToken = queueMentionToken(next)
    const offset = output.length
    output += nextToken
    nextMentions.push({ ...next, textOffset: offset })
    cursor = start + token.length
  }
  output += draft.text.slice(cursor)
  return { ...draft, text: output, mentions: nextMentions }
}

/** Each merged turn gets one numbering scope. Repeated stable IDs reuse bytes;
 * conflicting edited versions must not silently discard one queued instruction. */
export function mergeQueueAttachmentReferences(draft: QueueDraftReferenceInput, receipts: readonly QueueAttachmentReceipt[]): {
  draft: { text: string; revision: number; mentions: QueueMention[] }; attachments: QueueAttachmentReceipt[]
} {
  const byIdentity = new Map<string, QueueAttachmentReceipt>()
  const canonical = new Map<QueueAttachmentReceipt, QueueAttachmentReceipt>()
  for (const file of receipts) {
    const key = file.attachmentId ? `attachment:${file.attachmentId}` : `receipt:${file.receiptId}`
    const prior = byIdentity.get(key)
    if (prior && (prior.sha256 !== file.sha256 || prior.bytes !== file.bytes))
      throw new NextTurnQueueError('CONFLICT', '同一附件的内容在待发消息之间已变化，请逐条发送这些消息')
    if (!prior) byIdentity.set(key, file)
    canonical.set(file, prior ?? file)
  }
  const paths = new Map<string, string>()
  const referencedReceipt = (path: string): QueueAttachmentReceipt | undefined => receipts.find(file =>
    pathKey(path) === pathKey(file.path) || pathKey(path).endsWith('/' + pathKey(file.path)))
  for (const mention of draft.mentions) {
    if (mention.source !== 'file' || mention.content !== undefined || !mention.path) continue
    const original = referencedReceipt(mention.path)
    if (!original) continue
    const target = canonical.get(original)!
    if (target !== original) {
      const normalized = pathKey(mention.path)
      paths.set(mention.path, normalized.slice(0, normalized.length - pathKey(original.path).length) + target.path)
    }
  }
  let images = 0, files = 0
  const attachments = [...byIdentity.values()].map(file => ({ ...file,
    referenceLabel: file.mime.startsWith('image/') ? `图${++images}` : `附件${++files}` }))
  const remapped = remapQueueAttachmentReferences(draft, paths)
  return { attachments, draft: { ...remapped, mentions: remapped.mentions.map(mention => {
    if (!mention.attachmentId || mention.source !== 'file' || mention.content !== undefined) return mention
    const file = attachments.find(item => item.attachmentId === mention.attachmentId)
    return file ? { ...mention, displayText: file.referenceLabel } : mention
  }) } }
}
