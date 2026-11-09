import { NextTurnQueueError, type QueueMention } from './next-turn-queue'
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
