const titleCharacters = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const MAX_LABEL_CHARACTERS = 24

/** Existing drafts retain only the generated filename, so keep this recognition
 * narrow and share it with queue merging to avoid losing the readable label. */
export function pastedTextLabel(name: string, mime: string): string | null {
  if (mime.split(';', 1)[0].trim().toLowerCase() !== 'text/plain') return null
  const match = /^粘贴的文本(?:-([^\\/:*?"<>|\r\n-]+))?\.txt$/u.exec(name)
  if (!match || match[0] !== name) return null
  const title = match[1]
  if (!title) return '粘贴文本'
  if (title.trim() !== title) return null
  // Grapheme boundaries also preserve skin tones and joined emoji sequences.
  const characters = [...titleCharacters.segment(title)].map(part => part.segment)
  if (characters.length > 48) return null
  const excerpt = characters.slice(0, MAX_LABEL_CHARACTERS).join('')
  return `粘贴文本 · ${excerpt}${characters.length > MAX_LABEL_CHARACTERS ? '…' : ''}`
}
