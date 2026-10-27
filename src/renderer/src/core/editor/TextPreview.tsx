import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type UIEvent } from 'react'
import { sourceLanguage } from './source-highlight-language'
import type { SourceHighlightLines } from './source-highlight'
import './text-preview.css'

const LINE_HEIGHT = 20
const OVERSCAN = 12
const VIRTUAL_LINES = 600
const VIRTUAL_CHARACTERS = 32 * 1024

export function isLargeText(content: string): boolean {
  return content.length > VIRTUAL_CHARACTERS || content.split('\n', VIRTUAL_LINES + 1).length > VIRTUAL_LINES
}

/** Code and Work share the same bounded, selectable read-only surface. */
export function TextPreview({ content, name }: { content: string; name: string }): JSX.Element {
  const virtual = isLargeText(content)
  const lines = useMemo(() => content.split(/\r\n|\r|\n/), [content])
  const viewport = useRef<HTMLDivElement>(null)
  const frame = useRef(0)
  const pendingScroll = useRef(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(600)
  const language = useMemo(() => sourceLanguage(name), [name])
  const [highlighted, setHighlighted] = useState<{ content: string; language: string; lines: SourceHighlightLines } | null>(null)

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
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const start = virtual ? Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN) : 0
  const end = virtual ? Math.min(lines.length, Math.ceil((scrollTop + height) / LINE_HEIGHT) + OVERSCAN) : lines.length
  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    if (!virtual) return
    pendingScroll.current = event.currentTarget.scrollTop
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      setScrollTop(pendingScroll.current)
    })
  }
  return <div ref={viewport} className="work-artifact-panel-v2__source work-text-preview text-preview" onScroll={onScroll}
    role="grid" aria-label={`${name} 文本预览`} aria-rowcount={lines.length} tabIndex={0}>
    <div className="work-text-preview__spacer text-preview__spacer" style={{ height: lines.length * LINE_HEIGHT }}>
      <div className="work-text-preview__window text-preview__window" style={{ transform: `translateY(${start * LINE_HEIGHT}px)` }}>
        {visibleLines.slice(start, end).map((line, index) => <div className="work-text-preview__line text-preview__line" role="row" aria-rowindex={start + index + 1} key={start + index}>
          <span className="work-text-preview__number text-preview__number" aria-hidden="true">{start + index + 1}</span>
          <span className="work-text-preview__text text-preview__text" role="gridcell">{typeof line === 'string'
            ? line || ' '
            : line.length ? line.map((token, tokenIndex) => <span className={token.className} key={tokenIndex}>{token.text}</span>) : ' '}</span>
        </div>)}
      </div>
    </div>
  </div>
}
