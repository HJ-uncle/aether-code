import { mentionToken, type Mention } from './mention-context'

/** Only anchored reference chips change with an edited attachment. Identical
 * text typed by the user is ordinary prose and must remain untouched. */
export function replaceImageAttachmentReferences(draft: { text: string; mentions: readonly Mention[] },
  previous: { path: string }, next: { path: string; name: string; attachmentId?: string }): { text: string; mentions: Mention[] } {
  const pathKey = (path: string): string => path.replace(/\\/g, '/')
  const edits = draft.mentions.flatMap((mention, index) => {
    if (mention.source !== 'file' || mention.content !== undefined || !mention.path || pathKey(mention.path) !== pathKey(previous.path)) return []
    const token = mentionToken(mention), start = mention.textOffset
    if (start === undefined || start < 0 || draft.text.slice(start, start + token.length) !== token)
      throw new Error('图片引用的位置已变化，请重新添加图片后再应用编辑。')
    const updated: Mention = { ...mention, path: next.path, displayText: mention.attachmentId ? mention.displayText : next.name, origin: 'attachment',
      ...(mention.attachmentId || next.attachmentId ? { attachmentId: mention.attachmentId ?? next.attachmentId } : {}) }
    return [{ index, start, end: start + token.length, token: mentionToken(updated), mention: updated }]
  }).sort((left, right) => left.start - right.start)
  if (!edits.length) return { text: draft.text, mentions: [...draft.mentions] }
  let text = '', cursor = 0
  for (const edit of edits) {
    if (edit.start < cursor) throw new Error('图片引用的位置重叠，请重新添加图片后再应用编辑。')
    text += draft.text.slice(cursor, edit.start) + edit.token
    cursor = edit.end
  }
  text += draft.text.slice(cursor)
  const mentions = draft.mentions.map((mention, index) => {
    const edit = edits.find(item => item.index === index)
    const updated = edit?.mention ?? mention
    if (updated.textOffset === undefined) return updated
    const delta = edits.filter(item => item.end <= updated.textOffset!).reduce((sum, item) => sum + item.token.length - (item.end - item.start), 0)
    return delta ? { ...updated, textOffset: updated.textOffset + delta } : updated
  })
  return { text, mentions }
}
