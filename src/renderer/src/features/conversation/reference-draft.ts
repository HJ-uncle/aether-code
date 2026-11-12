import { formatPathDisplay, mentionToken, type Mention } from './shared/mention-context'
import { fileTreePathKey, isFileTreePathWithin } from '../../core/workspace/file-tree-memory'
import type { SessionDraft } from '../sessions/state'

/** References remain editable inline tokens; adding one never rewrites the user's request. */
export function appendSessionMentions(draft: SessionDraft, incoming: readonly Mention[]): SessionDraft {
  let text = draft.text
  const mentions = [...draft.mentions]
  for (const item of incoming) {
    if (!item.displayText) continue
    if (text && !/\s$/.test(text)) text += ' '
    const mention = { ...item, textOffset: text.length }
    text += `${mentionToken(mention)} `
    mentions.push(mention)
  }
  return { text, mentions }
}

export function workspaceReferenceMentions(entries: readonly { path: string; kind: 'file' | 'directory' }[], root: string | null): Mention[] {
  const rootKey = root ? fileTreePathKey(root) : null
  const rootDepth = rootKey?.split('/').filter(Boolean).length ?? 0
  const seen = new Set<string>()
  return entries.flatMap(entry => {
    const key = fileTreePathKey(entry.path)
    if (seen.has(key)) return []
    seen.add(key)
    // Compare with the tree's identity rules, but preserve the actual filename
    // case. Counting segments also handles separator aliases and the POSIX root.
    const path = root && key !== rootKey && isFileTreePathWithin(root, entry.path)
      ? entry.path.replace(/\\/g, '/').split('/').filter(Boolean).slice(rootDepth).join('/')
      : entry.path
    return [{ source: entry.kind === 'directory' ? 'dir' : 'file', origin: 'workspace', path,
      displayText: formatPathDisplay(path) || path } satisfies Mention]
  })
}
