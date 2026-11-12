import { isToolkitId, withToolkitSelection } from '@shared/toolkits'
import { mentionToken, type Mention } from '../chat/mention-context'

type Draft = { text: string; mentions: readonly Mention[] }

/** Only identity-bearing chips at their recorded positions can select a toolkit. */
export function draftToolkitIds(draft: Draft): string[] {
  return [...new Set(draft.mentions.flatMap(mention => {
    if (mention.source !== 'toolkit' || !isToolkitId(mention.path) ||
      mention.textOffset === undefined || mention.textOffset < 0) return []
    const token = mentionToken(mention)
    return draft.text.slice(mention.textOffset, mention.textOffset + token.length) === token ? [mention.path!] : []
  }))]
}

/** User edits change selection; clearing a submitted draft must not call this. */
export function editDraftToolkits(current: readonly string[] | undefined, before: Draft, after: Draft): string[] | undefined {
  const previous = draftToolkitIds(before), next = draftToolkitIds(after)
  const added = next.filter(id => !previous.includes(id))
  const removed = previous.filter(id => !next.includes(id))
  // Restored historical labels are display metadata, not a fresh selection.
  if (!added.length && !removed.length) return current === undefined ? undefined : [...current]
  if (current === undefined) throw new Error('正在读取会话工具包选择，请稍后再修改工具包。')
  return added.reduce((selection, id) => withToolkitSelection(selection, id), current.filter(id => !removed.includes(id)))
}
