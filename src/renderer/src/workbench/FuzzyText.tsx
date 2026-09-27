/**
 * 模糊命中字符逐个标亮（命令面板 / 快速打开共用）。
 * positions 为空则原样返回文本。
 */
import { type JSX } from 'react'

export function FuzzyText({ text, positions }: { text: string; positions: number[] }): JSX.Element {
  if (positions.length === 0) return <>{text}</>
  const set = new Set(positions)
  const parts: JSX.Element[] = []
  let plain: string[] = []
  let marked: string[] = []
  const flush = (): void => {
    if (plain.length > 0) {
      parts.push(<span key={`p${parts.length}`}>{plain.join('')}</span>)
      plain = []
    }
    if (marked.length > 0) {
      parts.push(<mark key={`m${parts.length}`}>{marked.join('')}</mark>)
      marked = []
    }
  }
  for (let i = 0; i < text.length; i += 1) {
    if (set.has(i)) {
      flush()
      marked.push(text[i])
    } else {
      if (marked.length > 0) flush()
      plain.push(text[i])
    }
  }
  flush()
  return <>{parts}</>
}
