import hljs from 'highlight.js'

export interface SourceToken { text: string; className: string }
export type SourceHighlightLines = SourceToken[][]

/** Tokenize complete text once so multiline comments and strings retain their
 * language state. Scrolling only renders existing tokens; it never lexes again. */
export function highlightSource(content: string, language: string): SourceHighlightLines {
  const lines: SourceHighlightLines = [[]]
  const append = (text: string, className: string): void => {
    for (const part of text.split(/(\r\n|\r|\n)/)) {
      if (part === '\r\n' || part === '\r' || part === '\n') lines.push([])
      else if (part) lines.at(-1)!.push({ text: part, className })
    }
  }
  const walk = (node: unknown, className: string): void => {
    if (typeof node === 'string') { append(node, className); return }
    if (!node || typeof node !== 'object') return
    const token = node as { scope?: string | string[]; children?: unknown[] }
    const scope = Array.isArray(token.scope) ? token.scope.join(' ') : token.scope
    const nextClass = scope ? `hljs-${scope}` : className
    for (const child of token.children ?? []) walk(child, nextClass)
  }
  const result = hljs.highlight(content, { language, ignoreIllegals: true })
  walk((result._emitter as unknown as { rootNode: unknown }).rootNode, '')
  return lines
}

export function tryHighlightSource(content: string, language: string): SourceHighlightLines {
  try { return highlightSource(content, language) }
  catch { return content.split(/\r\n|\r|\n/).map(line => line ? [{ text: line, className: '' }] : []) }
}
