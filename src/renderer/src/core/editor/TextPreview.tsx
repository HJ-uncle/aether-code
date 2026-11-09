import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type UIEvent } from 'react'
import { sourceLanguage } from './source-highlight-language'
import type { SourceHighlightLines } from './source-highlight'
import { useDocumentContextMenu } from './useDocumentContextMenu'
import './text-preview.css'

export interface TextPreviewReveal {
  line: number
  column?: number
  length?: number
  revision: number
}

const LINE_HEIGHT = 20
const OVERSCAN = 12
const VIRTUAL_LINES = 600
const VIRTUAL_CHARACTERS = 32 * 1024

export function isLargeText(content: string): boolean {
  return content.length > VIRTUAL_CHARACTERS || content.split('\n', VIRTUAL_LINES + 1).length > VIRTUAL_LINES
}

/** Code and Work share the same bounded, selectable read-only surface. */
export function TextPreview({ content, name, reveal, active = true }: {
  content: string
  name: string
  reveal?: TextPreviewReveal
  active?: boolean
}): JSX.Element {
  const virtual = isLargeText(content)
  const lines = useMemo(() => content.split(/\r\n|\r|\n/), [content])
  const viewport = useRef<HTMLDivElement>(null)
  const { menu } = useDocumentContextMenu(viewport, { active, getText: () => content })
  const frame = useRef(0)
  const pendingScroll = useRef(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(600)
  const language = useMemo(() => sourceLanguage(name), [name])
  const [highlighted, setHighlighted] = useState<{ content: string; language: string; lines: SourceHighlightLines } | null>(null)
  const targetLine = reveal && Number.isFinite(reveal.line) && reveal.line >= 1
    ? Math.min(lines.length, Math.floor(reveal.line)) : null
  const targetColumn = reveal?.column && Number.isFinite(reveal.column) ? Math.max(1, Math.floor(reveal.column)) : 1
  const targetLength = reveal?.length && Number.isFinite(reveal.length) ? Math.max(0, Math.floor(reveal.length)) : 0
  const revealKey = targetLine === null ? '' : JSON.stringify([targetLine, targetColumn, targetLength, reveal?.revision])
  const positioned = useRef<{ content: string; key: string } | null>(null)
  const positionedHorizontally = useRef<{ content: string; key: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    // Keep the source visible while the optional highlighter loads. Very large
    // truncated files retain the plain bounded surface instead of blocking input.
    if (!language || content.length > 256 * 1024) return
    const timer = setTimeout(() => {
      void import('./source-highlight').then(({ tryHighlightSource }) => {
        if (!cancelled) setHighlighted({ content, language, lines: tryHighlightSource(content, language) })
      }).catch(() => { /* Unsupported syntax falls back to the original text. */ })
    }, 0)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [content, language])
  const visibleLines = highlighted?.content === content && highlighted.language === language ? highlighted.lines : lines

  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const observer = new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.height ?? element.clientHeight
      setHeight(previous => previous === next ? previous : next)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    pendingScroll.current = 0
    setScrollTop(0)
    if (viewport.current) viewport.current.scrollTop = 0
  }, [content])
  useLayoutEffect(() => {
    const element = viewport.current
    if (!active || !element?.clientHeight || targetLine === null || !revealKey) return
    if (positioned.current?.content === content && positioned.current.key === revealKey) return
    positioned.current = { content, key: revealKey }
    positionedHorizontally.current = null
    // Set the virtual window before measuring the highlighted span. Changing
    // this viewport directly never moves the surrounding Work conversation.
    const padding = Number.parseFloat(getComputedStyle(element).paddingTop) || 0
    element.scrollTop = Math.max(0, padding + (targetLine - 1) * LINE_HEIGHT - (element.clientHeight - LINE_HEIGHT) / 2)
    pendingScroll.current = element.scrollTop
    setScrollTop(element.scrollTop)
  }, [active, content, height, revealKey, targetLine])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const start = virtual ? Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN) : 0
  const end = virtual ? Math.min(lines.length, Math.ceil((scrollTop + height) / LINE_HEIGHT) + OVERSCAN) : lines.length
  useLayoutEffect(() => {
    const element = viewport.current
    if (!active || !element?.clientWidth || targetLine === null || !revealKey ||
      positioned.current?.content !== content || positioned.current.key !== revealKey) return
    if (positionedHorizontally.current?.content === content && positionedHorizontally.current.key === revealKey) return
    const row = element.querySelector<HTMLElement>(`[aria-rowindex="${targetLine}"]`)
    if (!row) return
    positionedHorizontally.current = { content, key: revealKey }
    const marker = row.querySelector<HTMLElement>('.text-preview__match')
    if (!marker) { element.scrollLeft = 0; return }
    const bounds = element.getBoundingClientRect(), match = marker.getBoundingClientRect()
    const gutter = row.querySelector<HTMLElement>('.text-preview__number')?.offsetWidth ?? 0
    const left = bounds.left + gutter + 12, right = bounds.left + element.clientWidth - 16
    if (match.left < left) element.scrollLeft -= left - match.left
    else if (match.right > right) element.scrollLeft += match.right - right
  }, [active, content, revealKey, targetLine, start, end, visibleLines, height])
  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    if (!virtual) return
    pendingScroll.current = event.currentTarget.scrollTop
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      setScrollTop(pendingScroll.current)
    })
  }
  return <><div ref={viewport} className="work-artifact-panel-v2__source work-text-preview text-preview" onScroll={onScroll}
    role="grid" aria-label={`${name} 文本预览`} aria-rowcount={lines.length} tabIndex={0}>
    <div className="work-text-preview__spacer text-preview__spacer" style={{ height: lines.length * LINE_HEIGHT }}>
      <div className="work-text-preview__window text-preview__window" style={{ transform: `translateY(${start * LINE_HEIGHT}px)` }}>
        {visibleLines.slice(start, end).map((line, index) => <div className={`work-text-preview__line text-preview__line${targetLine === start + index + 1 ? ' is-revealed' : ''}`} role="row" aria-rowindex={start + index + 1} aria-selected={targetLine === start + index + 1} key={start + index}>
          <span className="work-text-preview__number text-preview__number" aria-hidden="true">{start + index + 1}</span>
          <span className="work-text-preview__text text-preview__text" role="gridcell">{renderLine(line,
            targetLine === start + index + 1 ? { start: targetColumn - 1, length: targetLength } : undefined)}</span>
        </div>)}
      </div>
    </div>
  </div>{menu}</>
}

function renderLine(line: string | SourceHighlightLines[number], match?: { start: number; length: number }): JSX.Element[] | string {
  const tokens = typeof line === 'string' ? [{ text: line, className: '' }] : line
  if (!tokens.length || tokens.every(token => !token.text)) return ' '
  let offset = 0
  return tokens.map((token, index) => {
    const start = offset
    offset += token.text.length
    const from = match ? Math.max(0, match.start - start) : 0
    const to = match ? Math.min(token.text.length, match.start + match.length - start) : 0
    return <span key={index} className={token.className}>{match && match.length > 0 && from < to
      ? <>{token.text.slice(0, from)}<mark className="text-preview__match">{token.text.slice(from, to)}</mark>{token.text.slice(to)}</>
      : token.text}</span>
  })
}
