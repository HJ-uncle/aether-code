import type { ChatAttachment } from '../../core/engine/useChat'
import { mimeFor } from '../../core/editor/preview'
import { fileTreePathKey, isFileTreePathWithin } from '../../core/workspace/file-tree-memory'
import { mentionToken, type Mention } from '../chat/mention-context'
import type { WorkDraft } from './work-state'

const fileSources = new Set(['file', 'dir', 'code', 'terminal'])
const absolute = (path: string): boolean => /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(path)
export function workspaceReferencePath(root: string, path: string): string {
  return absolute(path) ? path : `${root.replace(/[\\/]+$/, '')}/${path.replace(/^\.\//, '')}`
}

export function workspaceTransferRelativePath(root: string, path: string): string {
  const candidate = workspaceReferencePath(root, path)
  if (!isFileTreePathWithin(root, candidate)) throw new Error('资料不属于原工作区，未更改草稿或目录。')
  return candidate.replace(/\\/g, '/').slice(root.replace(/\\/g, '/').replace(/\/+$/, '').length).replace(/^\/+/, '')
}

/** Plan before copying anything: a directory is a live scope, not an attachment
 * to recursively duplicate (possibly including an entire repository). */
export function planWorkWorkspaceTransfer(draft: WorkDraft, attachments: readonly ChatAttachment[], sources: readonly ChatAttachment[],
  previousRoot: string, nextRoot: string) {
  const files = new Map<string, ChatAttachment>()
  const key = (path: string): string => fileTreePathKey(workspaceReferencePath(previousRoot, path))
  for (const file of [...attachments, ...sources]) if (!files.has(key(file.path))) files.set(key(file.path), file)
  for (const mention of draft.mentions) {
    if (!mention.path || !fileSources.has(mention.source) || mention.content !== undefined) continue
    if (mention.source === 'dir') {
      if (!isFileTreePathWithin(nextRoot, workspaceReferencePath(previousRoot, mention.path)))
        throw new Error(`「${mention.displayText}」引用的是原工作区的整个目录。请改为需要的文件引用后切换；草稿和资料已保留。`)
      continue
    }
    if (!files.has(key(mention.path))) files.set(key(mention.path), {
      path: mention.path, name: mention.path.split(/[\\/]/).filter(Boolean).at(-1) || mention.displayText,
      type: mimeFor(mention.path) ?? 'application/octet-stream', size: 0, attachmentId: crypto.randomUUID()
    })
  }
  return { files: [...files.values()], key }
}

/** Rewrite authored chips by their positions. Equal @text typed as prose must
 * never be changed, and later chip offsets must follow the new token lengths. */
export function remapWorkWorkspaceDraft(draft: WorkDraft, previousRoot: string, replacements: ReadonlyMap<string, ChatAttachment>): WorkDraft {
  let text = '', cursor = 0
  const mentions: Mention[] = []
  for (const mention of draft.mentions) {
    const token = mentionToken(mention)
    const start = mention.textOffset ?? draft.text.indexOf(token, cursor)
    if (start < cursor || draft.text.slice(start, start + token.length) !== token)
      throw new Error('草稿引用的位置已变化，请重试切换工作区。草稿和资料已保留。')
    let next = mention
    if (mention.path && fileSources.has(mention.source)) {
      const originalPath = workspaceReferencePath(previousRoot, mention.path)
      const file = mention.content === undefined ? replacements.get(fileTreePathKey(originalPath)) : undefined
      next = file ? { ...mention, path: file.path, origin: 'attachment', attachmentId: file.attachmentId ?? mention.attachmentId }
        : { ...mention, path: originalPath }
    }
    text += draft.text.slice(cursor, start)
    mentions.push({ ...next, textOffset: text.length })
    text += mentionToken(next)
    cursor = start + token.length
  }
  return { text: text + draft.text.slice(cursor), mentions }
}
