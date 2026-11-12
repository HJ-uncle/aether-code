import { Marked, type Token, type Tokens } from 'marked'

const markdown = new Marked({ gfm: true })

function tokenText(token: Token): string {
  if (token.type === 'code' || token.type === 'codespan') return token.text
  if (token.type === 'list') return (token as Tokens.List).items.map(item => item.tokens.map(tokenText).join(' ')).join(' ')
  if (token.type === 'table') {
    const table = token as Tokens.Table
    return [table.header, ...table.rows].map(row => row.map(cell => cell.tokens.map(tokenText).join('')).join(' ')).join(' ')
  }
  if (token.type === 'blockquote') return (token as Tokens.Blockquote).tokens.map(tokenText).join(' ')
  if (token.type === 'html') return token.text.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ')
  if ('tokens' in token && Array.isArray(token.tokens)) return token.tokens.map(tokenText).join('')
  if ('text' in token && typeof token.text === 'string') return token.text
  return ''
}

/** A preview removes formatting only; deciding what counts as a result belongs
 * to the run's structured fields. The inspector retains the complete Markdown. */
export function sessionSubagentPreview(text: string): string {
  return markdown.lexer(text).map(tokenText).join(' ').replace(/\s+/g, ' ').trim()
}
