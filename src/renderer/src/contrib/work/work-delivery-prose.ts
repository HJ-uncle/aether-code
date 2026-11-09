import { Marked, type Token, type Tokens } from 'marked'
import type { FinalResult } from '../../../../shared/final-result'
import { classifyChatLink, type ChatFileContext } from '../chat/chat-link'
import { workChangePathKey } from './work-file-changes'

const markdown = new Marked({ gfm: true })

function plainLabel(tokens: Token[]): string | undefined {
  let label = ''
  for (const token of tokens) {
    if ((token.type === 'text' && !token.tokens) || token.type === 'codespan') label += token.text
    else return undefined
  }
  return label
}

function onlyLink(tokens: Token[]): Tokens.Link | undefined {
  const content = tokens.filter(token => token.type !== 'space' && !(token.type === 'text' && !token.text.trim()))
  if (content.length !== 1) return undefined
  const token = content[0]
  if (token.type === 'link') return token as Tokens.Link
  if ((token.type === 'text' || token.type === 'paragraph' || token.type === 'strong' || token.type === 'em') && token.tokens) return onlyLink(token.tokens)
  return undefined
}

/** Cards own published downloads. Only remove an entire bare filename list
 * when every entry resolves to the same manifest shown alongside this answer.
 * Prose, labelled instructions, mixed lists and the stored transcript stay intact. */
export function workDeliveryProse(text: string, result: FinalResult | undefined, context: ChatFileContext,
  engineBaseUrl?: string): string {
  if (!result?.items.length || result.sessionId !== context.sessionId) return text
  // The engine publishes canonical absolute paths; download URLs keep paths
  // relative to this message's workspace. Compare both in the same namespace.
  const paths = new Map(result.items.map(item => [workChangePathKey(item.path, context.workspaceRoot), item]))
  const matches = (item: Tokens.ListItem): boolean => {
    if (item.task) return false
    const link = onlyLink(item.tokens)
    if (!link || link.title) return false
    const target = classifyChatLink(link.href, context.sessionId, engineBaseUrl)
    if (target.kind !== 'artifact' && target.kind !== 'file') return false
    const path = target.path.replace(/\\/g, '/')
    const delivery = paths.get(workChangePathKey(path, context.workspaceRoot))
    if (!delivery) return false
    const label = plainLabel(link.tokens)
    return label === delivery.name || label === delivery.path || label === path
  }
  // Marked normalizes Windows line endings. Keep source offsets separate so
  // exported/replayed CRLF answers match without rewriting retained prose.
  const normalized = text.replace(/\r\n?/g, '\n')
  let sourceCursor = 0, normalizedCursor = 0
  const sourceOffset = (offset: number): number => {
    while (normalizedCursor < offset) {
      if (text[sourceCursor] === '\r' && text[sourceCursor + 1] === '\n') sourceCursor++
      sourceCursor++; normalizedCursor++
    }
    return sourceCursor
  }
  let cursor = 0, preserved = 0, output = ''
  for (const token of markdown.lexer(normalized)) {
    // Marked omits link definitions from its block stream. Locate each raw
    // block monotonically so reference links do not shift subsequent ranges.
    const start = normalized.indexOf(token.raw, cursor)
    if (start < 0) return text
    cursor = start + token.raw.length
    if (token.type !== 'list' || !token.items.length || !token.items.every(matches)) continue
    output += text.slice(preserved, sourceOffset(start))
    preserved = sourceOffset(cursor)
  }
  return preserved ? output + text.slice(preserved) : text
}
