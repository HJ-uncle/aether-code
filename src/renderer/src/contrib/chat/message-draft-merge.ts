import { buildMentionMessage, mentionToken, sameMention, type Mention } from './mention-context'

type MessageDraft = { text: string; mentions: readonly Mention[] }

function anchoredMentions(draft: MessageDraft): Mention[] {
  let cursor = 0
  return draft.mentions.flatMap(mention => {
    const token = mentionToken(mention)
    const offset = mention.textOffset ?? draft.text.indexOf(token, cursor)
    if (!token || offset < cursor || draft.text.slice(offset, offset + token.length) !== token) return []
    cursor = offset + token.length
    return [{ ...mention, textOffset: offset }]
  })
}

/** Recovery is idempotent; deliberate history additions can still append again. */
export function restoreMessageDraft(
  current: MessageDraft,
  incoming: MessageDraft
): { text: string; mentions: Mention[] } {
  const incomingMentions = anchoredMentions(incoming)
  const expected = buildMentionMessage(incoming.text, incomingMentions, { includeAgentRefs: true })
  const keepCurrent = (): { text: string; mentions: Mention[] } => ({ text: current.text, mentions: [...current.mentions] })
  if (!expected) return keepCurrent()
  const currentMentions = anchoredMentions(current)
  const matches = (start: number, end: number): boolean => {
    // A paragraph boundary inside a chip is not a boundary in the editable draft.
    if (currentMentions.some(mention => {
      const offset = mention.textOffset!, finish = offset + mentionToken(mention).length
      return (offset < start && finish > start) || (offset < end && finish > end)
    })) return false
    const mentions = currentMentions.filter(mention => mention.textOffset! >= start && mention.textOffset! < end)
      .map(mention => ({ ...mention, textOffset: mention.textOffset! - start }))
    return buildMentionMessage(current.text.slice(start, end), mentions, { includeAgentRefs: true }) === expected
  }
  if (matches(0, current.text.length)) return keepCurrent()

  // Match only complete paragraphs (or contiguous groups for multiline requests),
  // never a substring of a newer instruction. Keep the original text and chip
  // offsets; serialization is used only for comparison, not to rewrite the draft.
  const starts = [0], ends: number[] = []
  for (const separator of current.text.matchAll(/\r?\n[^\S\r\n]*\r?\n(?:[^\S\r\n]*\r?\n)*/g)) {
    ends.push(separator.index)
    starts.push(separator.index + separator[0].length)
  }
  ends.push(current.text.length)
  const targetLength = incoming.text.trim().length
  const spacingAllowance = 2 * Math.max(currentMentions.length, incomingMentions.length)
  for (let first = 0; first < starts.length; first++) {
    for (let last = first; last < ends.length; last++) {
      const length = current.text.slice(starts[first], ends[last]).trim().length
      // Sending only adds spacing around chips. It never collapses internal
      // whitespace, so longer candidates cannot become the original request.
      if (length > targetLength + spacingAllowance) break
      if (length >= targetLength - spacingAllowance && matches(starts[first], ends[last])) return keepCurrent()
    }
  }
  return appendMessageDraft(current, incoming)
}

/** Keep current chip positions intact: matching token text can capture a typed @ label instead. */
export function appendMessageDraft(
  current: MessageDraft,
  incoming: MessageDraft
): { text: string; mentions: Mention[] } {
  if (current.text === incoming.text && current.mentions.length === incoming.mentions.length &&
    current.mentions.every((mention, index) => sameMention(mention, incoming.mentions[index]) &&
      mention.textOffset === incoming.mentions[index].textOffset))
    return { text: current.text, mentions: [...current.mentions] }
  const prefix = current.text + (current.text && incoming.text ? '\n\n' : '')
  let cursor = 0
  const appended = incoming.mentions.flatMap(mention => {
    const token = mentionToken(mention)
    const offset = mention.textOffset ?? incoming.text.indexOf(token, cursor)
    if (!token || offset < cursor || incoming.text.slice(offset, offset + token.length) !== token) return []
    cursor = offset + token.length
    return [{ ...mention, textOffset: prefix.length + offset }]
  })
  return {
    text: prefix + incoming.text,
    mentions: [...current.mentions, ...appended]
  }
}
