export type MentionSource = 'file' | 'dir' | 'code' | 'terminal' | 'agent'

export interface Mention {
  displayText: string
  source: MentionSource
  path?: string
  startLine?: number
  endLine?: number
  startColumn?: number
  endColumn?: number
  /** 添加时的编辑缓冲区快照，不能让之后的保存/切换改变用户已经引用的内容。 */
  content?: string
  /** 草稿恢复时准确区分引用 chip 与用户手工输入的同名 @ 文本。 */
  textOffset?: number
}

export function mentionToken(mention: Mention): string {
  if (!mention.path) return mention.displayText
  if (mention.source === 'code' && mention.startLine) {
    const range = mention.endLine && mention.endLine !== mention.startLine
      ? `${mention.startLine}-${mention.endLine}` : `${mention.startLine}`
    return `@${mention.path}:${range}`
  }
  return `@${mention.path}`
}

export function formatPathDisplay(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = normalized.split('/').filter(Boolean)
  return parts.length <= 2 ? normalized : parts.slice(-2).join('/')
}

export function sameMention(a: Mention, b: Mention): boolean {
  return a.source === b.source && a.path === b.path && a.startLine === b.startLine &&
    a.endLine === b.endLine && a.startColumn === b.startColumn && a.endColumn === b.endColumn &&
    a.content === b.content && a.displayText === b.displayText
}

/** 不依赖引擎读盘来还原选区，尤其是尚未保存的内容和只选中半行的片段。 */
export function buildMentionMessage(text: string, mentions: readonly Mention[]): string {
  const snapshots = mentions.filter((mention, index) => mention.content !== undefined &&
    mentions.findIndex((other) => sameMention(other, mention)) === index)
  if (!snapshots.length) return text
  const blocks = snapshots.map((mention) => {
    const content = mention.content ?? ''
    const longestFence = (content.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 2)
    const fence = '`'.repeat(longestFence + 1)
    const location = mention.startLine
      ? `；选区 ${mention.startLine}:${mention.startColumn ?? 1}–${mention.endLine ?? mention.startLine}:${mention.endColumn ?? 1}`
      : '；完整编辑缓冲区'
    return `文件：${mention.path ?? mention.displayText}${location}\n${fence}\n${content}\n${fence}`
  })
  return `${text}\n\n以下为添加到对话时的编辑器内容快照，可能包含未保存修改：\n\n${blocks.join('\n\n')}`
}

export function isStoredMention(value: unknown): value is Mention {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.displayText === 'string' &&
    ['file', 'dir', 'code', 'terminal', 'agent'].includes(String(record.source)) &&
    ['path', 'content'].every((key) => record[key] === undefined || typeof record[key] === 'string') &&
    ['startLine', 'endLine', 'startColumn', 'endColumn', 'textOffset'].every((key) =>
      record[key] === undefined || (typeof record[key] === 'number' && Number.isInteger(record[key]) && Number(record[key]) >= 0))
}

/** 润色只能改提问文字，不能把已经添加的文件/代码快照变成失去元数据的字符串。 */
export function preserveMentions(text: string, mentions: readonly Mention[]): { text: string; mentions: Mention[] } {
  let result = text
  let cursor = 0
  const anchored = mentions.map((mention) => {
    const token = mentionToken(mention)
    let offset = result.indexOf(token, cursor)
    if (offset < 0) {
      result += result.endsWith('\n') ? '' : '\n'
      offset = result.length
      result += token
    }
    cursor = offset + token.length
    return { ...mention, textOffset: offset }
  })
  return { text: result, mentions: anchored }
}
