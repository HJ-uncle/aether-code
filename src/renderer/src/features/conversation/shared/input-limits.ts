import { mentionToken, type Mention } from './mention-context'

/** This is an editor text limit, never an attachment or send-payload limit. */
export const COMPOSER_MAX_CHARS = 100_000
export const COMPOSER_INPUT_LIMIT_MESSAGE = '输入框正文最多 100,000 个字符；超过 1,000 个字符的粘贴内容会保存为附件。'

interface ComposerDraft { text: string; mentions: readonly Mention[] }

function countComposerText(text: string, mentions: readonly Mention[], excludeSeparators: boolean): number {
  let count = 0, cursor = 0
  const countText = (value: string): void => { for (const _character of value) count++ }
  for (const mention of mentions) {
    const token = mentionToken(mention)
    const start = mention.textOffset ?? text.indexOf(token, cursor)
    if (start < cursor || text.slice(start, start + token.length) !== token) continue
    countText(text.slice(cursor, start))
    cursor = start + token.length
    // A chip needs a trailing caret spacer; its serialized separator is not
    // authored prose. Count any additional spaces normally.
    if (excludeSeparators && (text[cursor] === ' ' || text[cursor] === '\u00a0')) cursor++
  }
  countText(text.slice(cursor))
  return count
}

export function composerCharacterCount(text: string, mentions: readonly Mention[] = []): number {
  return countComposerText(text, mentions, true)
}

/** Restored older drafts remain intact and can be shortened without rejecting their history. */
export function acceptsComposerChange(previous: ComposerDraft, next: ComposerDraft): boolean {
  const count = composerCharacterCount(next.text, next.mentions)
  return count <= COMPOSER_MAX_CHARS || count <= composerCharacterCount(previous.text, previous.mentions) ||
    // Removing a chip can turn its retained separator back into ordinary
    // whitespace. Permit edits that add no prose, even across that boundary.
    countComposerText(next.text, next.mentions, false) <= countComposerText(previous.text, previous.mentions, false)
}
