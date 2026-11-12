import type { Mention } from './mention-context'

export interface MentionDraft { text: string; mentions: Mention[] }
interface Edit { before: MentionDraft; after: MentionDraft; typingAt: number | null }

const clone = (draft: MentionDraft): MentionDraft => ({ text: draft.text, mentions: draft.mentions.map(mention => ({ ...mention })) })

/** Display numbering is derived from the attachment strip; undo restores the
 * authored content and resource identity without reverting that strip's order. */
export function sameAuthoredDraft(left: MentionDraft, right: MentionDraft): boolean {
  const identity = (mention: Mention): string => JSON.stringify(Object.fromEntries(
    Object.entries(mention).filter(([key]) => key !== 'displayText').sort(([left], [right]) => left.localeCompare(right))))
  return left.text === right.text && left.mentions.length === right.mentions.length &&
    left.mentions.every((mention, index) => identity(mention) === identity(right.mentions[index]))
}

/** Native undo cannot see programmatic atomic-chip mutations. One history owns
 * text and chips together so undo after a drag cannot resurrect plain DOM labels. */
export function createMentionEditHistory(limit = 50) {
  const undo: Edit[] = [], redo: Edit[] = []
  return {
    reset(): void { undo.length = 0; redo.length = 0 },
    record(before: MentionDraft, after: MentionDraft, typing = false, now = Date.now()): void {
      if (sameAuthoredDraft(before, after)) return
      const previous = undo.at(-1)
      if (typing && previous?.typingAt != null && now - previous.typingAt < 650 && sameAuthoredDraft(previous.after, before)) {
        previous.after = clone(after)
        previous.typingAt = now
      } else {
        undo.push({ before: clone(before), after: clone(after), typingAt: typing ? now : null })
        if (undo.length > limit) undo.shift()
      }
      redo.length = 0
    },
    undo(current: MentionDraft): MentionDraft | null {
      const edit = undo.at(-1)
      if (!edit || !sameAuthoredDraft(edit.after, current)) return null
      undo.pop(); redo.push(edit)
      return clone(edit.before)
    },
    redo(current: MentionDraft): MentionDraft | null {
      const edit = redo.at(-1)
      if (!edit || !sameAuthoredDraft(edit.before, current)) return null
      redo.pop(); undo.push(edit)
      return clone(edit.after)
    }
  }
}
