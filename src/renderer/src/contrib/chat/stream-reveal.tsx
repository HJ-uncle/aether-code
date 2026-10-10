import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

// Match --duration-normal. Birth times survive Markdown reparsing, so closing a
// delimiter cannot make previously visible text fade from zero a second time.
const REVEAL_MS = 250
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
type Birth = { start: number; end: number; at: number }
export type SourceRange = { start: number; end: number }
export type StreamReveal = { source: string; births: Birth[] }

export function useStreamReveal(text: string, streaming: boolean): StreamReveal {
  const committed = useRef<{ text: string; births: Birth[] }>({ text: '', births: [] })
  const [revision, setRevision] = useState(0)
  const reveal = useMemo(() => {
    const previous = committed.current, now = performance.now()
    const appended = streaming && text.startsWith(previous.text)
    const births = appended ? previous.births.filter(birth => now - birth.at < REVEAL_MS) : []
    if (appended && text.length > previous.text.length) {
      births.push({ start: previous.text.length, end: text.length, at: now })
    }
    return { source: text, births }
  }, [text, streaming, revision])

  useLayoutEffect(() => {
    committed.current = { text, births: reveal.births }
    const latest = reveal.births.at(-1)
    if (!latest) return
    // Collapse completed batches back to plain text even if the stream pauses.
    const timer = window.setTimeout(() => setRevision(value => value + 1),
      Math.max(0, latest.at + REVEAL_MS - performance.now()) + 16)
    return () => window.clearTimeout(timer)
  }, [text, reveal])
  return reveal
}

/** Nested tokens omit Markdown markers. Uncertain mappings stay fully visible. */
export function tokenSources(raws: string[], parent: SourceRange | undefined, reveal: StreamReveal): (SourceRange | undefined)[] {
  if (!parent || !reveal.births.length) return raws.map(() => undefined)
  let cursor = parent.start
  return raws.map(raw => {
    const start = reveal.source.indexOf(raw, cursor)
    if (raw && start >= cursor && start + raw.length <= parent.end) {
      cursor = start + raw.length
      return { start, end: cursor }
    }
    // A blockquote's nested raw text drops each line's `>` prefix. Bound its
    // source by ordered complete lines; do not guess inside the whole parent.
    const lines = raw.split('\n').filter(Boolean)
    if (lines.length < 2) return undefined
    let lineCursor = cursor, first = -1
    for (const line of lines) {
      const offset = reveal.source.indexOf(line, lineCursor)
      if (offset < lineCursor || offset + line.length > parent.end) return undefined
      if (first === -1) first = offset
      lineCursor = offset + line.length
    }
    cursor = lineCursor
    return { start: first, end: cursor }
  })
}

function FadeChunk({ text, at }: { text: string; at: number }): ReactNode {
  // Keep this delay fixed for the mounted span. Updating it on each SSE frame
  // would advance the same animation twice; remounts resume its original age.
  const [delay] = useState(() => -Math.min(REVEAL_MS, performance.now() - at))
  return <span className="md-stream-chunk" style={{ animationDelay: `${delay}ms` }}>{text}</span>
}

function revealSlice(text: string, start: number, reveal: StreamReveal, key: string): ReactNode {
  const end = start + text.length, parts: ReactNode[] = []
  let cursor = start
  let segments: Intl.Segments | undefined
  for (const birth of reveal.births) {
    let from = Math.max(start, birth.start), to = Math.min(end, birth.end)
    if (to <= from) continue
    segments ??= graphemes.segment(text)
    const first = segments.containing(from - start)
    const last = to < end ? segments.containing(to - start) : undefined
    // A later frame may finish an emoji/combining character. Keep that whole
    // grapheme visible rather than splitting its glyph across opacity layers.
    if (first && first.index < from - start) from = start + first.index + first.segment.length
    if (last && last.index < to - start) to = start + last.index
    if (to <= from) continue
    if (from > cursor) parts.push(text.slice(cursor - start, from - start))
    parts.push(<FadeChunk key={`${key}:${from}:${birth.at}`} text={text.slice(from - start, to - start)} at={birth.at} />)
    cursor = to
  }
  if (cursor < end) parts.push(text.slice(cursor - start))
  return parts
}

export function revealText(text: string, key: string, source: SourceRange | undefined, reveal: StreamReveal): ReactNode {
  if (!source || !reveal.births.length || !text) return text
  const start = reveal.source.indexOf(text, source.start)
  if (start >= source.start && start + text.length <= source.end) return revealSlice(text, start, reveal, key)

  // Blockquotes and indented code strip a prefix from every line. Match lines
  // independently; ambiguous/normalised content remains readable immediately.
  let cursor = source.start
  return text.split(/(\n)/).map((line, index) => {
    const offset = reveal.source.indexOf(line, cursor)
    if (!line || offset < cursor || offset + line.length > source.end) return line
    cursor = offset + line.length
    return revealSlice(line, offset, reveal, `${key}:${index}`)
  })
}
