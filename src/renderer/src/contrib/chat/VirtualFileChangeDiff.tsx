import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react'
import { highlightFileChangeLine, type FileChangePreviewRow } from './file-change-preview'
import './virtual-file-change-diff.css'

const ROW_HEIGHT = 22
const OVERSCAN = 12

/** Reserve horizontal space independently of the mounted rows, so scrolling
 * past a long line cannot shrink the scrollbar or move the current column. */
function displayColumns(text: string): number {
  let columns = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (code === 9) columns += 4 - columns % 4
    else if ((code >= 0x300 && /\p{Mark}/u.test(character)) || code === 0x200d || code === 0xfe0f) continue
    else columns += code >= 0x1100 && (code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf ||
      code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff ||
      code >= 0xfe10 && code <= 0xfe6f || code >= 0xff01 && code <= 0xff60 ||
      code >= 0xffe0 && code <= 0xffe6 || code >= 0x1f000) ? 2 : 1
  }
  return columns
}

/** The inspector supplies a bounded flex area. Only its visible rows and a
 * small overscan are mounted or highlighted; every diff row remains reachable. */
export function VirtualFileChangeDiff({ rows, language, displayPath }: {
  rows: readonly FileChangePreviewRow[]
  language: string | undefined
  displayPath: string
}): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<number | null>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 0 })
  const syncViewport = useCallback((): void => {
    const element = viewportRef.current
    if (!element) return
    const next = { top: element.scrollTop, height: element.clientHeight }
    setViewport(previous => previous.top === next.top && previous.height === next.height ? previous : next)
  }, [])
  const scheduleViewport = useCallback((): void => {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => { frameRef.current = null; syncViewport() })
  }, [syncViewport])

  useLayoutEffect(() => {
    const element = viewportRef.current
    if (!element) return
    syncViewport()
    const observer = new ResizeObserver(scheduleViewport)
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [scheduleViewport, syncViewport])

  const dimensions = useMemo(() => {
    let columns = 0
    let lineNumber = 0
    for (const row of rows) {
      if (row.type === 'gap') continue
      columns = Math.max(columns, displayColumns(row.text) + (row.noNewline ? 24 : 0))
      lineNumber = Math.max(lineNumber, row.oldNo ?? 0, row.newNo ?? 0)
    }
    return { columns, digits: Math.max(4, String(lineNumber).length) }
  }, [rows])
  const visibleCount = Math.max(1, Math.ceil(viewport.height / ROW_HEIGHT))
  const firstVisible = Math.max(0, Math.min(Math.floor(viewport.top / ROW_HEIGHT), rows.length - visibleCount))
  const start = Math.max(0, firstVisible - OVERSCAN)
  const end = viewport.height > 0 ? Math.min(rows.length, firstVisible + visibleCount + OVERSCAN) : start
  const visibleRows = useMemo(() => rows.slice(start, end).map((row, offset) => ({
    row, index: start + offset,
    html: row.type === 'gap' ? '' : highlightFileChangeLine(row.text || ' ', language)
  })), [rows, start, end, language])
  const style: CSSProperties & Record<'--file-change-row-height' | '--file-change-number-width', string> = {
    '--file-change-row-height': `${ROW_HEIGHT}px`, '--file-change-number-width': `${dimensions.digits}ch`
  }

  return <div ref={viewportRef} className="diff-card__body virtual-file-change-diff" tabIndex={0}
    aria-label={`${displayPath} 文件差异`} data-diff-scroll="" data-total-rows={rows.length}
    data-visible-start={start} data-visible-end={end} style={style} onScroll={scheduleViewport}
    onKeyDown={event => {
      if (event.target !== event.currentTarget || event.altKey || (event.key !== 'Home' && event.key !== 'End')) return
      event.preventDefault()
      event.currentTarget.scrollTop = event.key === 'Home' ? 0 : event.currentTarget.scrollHeight
      scheduleViewport()
    }}>
    <div className="virtual-file-change-diff__track" style={{ height: rows.length * ROW_HEIGHT,
      minWidth: `max(100%, calc(${dimensions.columns + dimensions.digits + 2}ch + 24px))` }}>
      <div className="virtual-file-change-diff__window" style={{ top: start * ROW_HEIGHT }}>
        {visibleRows.map(({ row, index, html }) => row.type === 'gap' ? (
          <div key={index} className="diff-card__gap" data-diff-index={index}>
            <span>已省略 {row.count} 行未修改内容</span>
          </div>
        ) : (
          <div key={index} className={`diff-row diff-row--${row.type}`} data-diff-index={index}>
            <span className="diff-row__gutter" aria-hidden="true">
              <span className="diff-row__no">{row.type === 'del' ? row.oldNo ?? '' : row.newNo ?? ''}</span>
              <span className="diff-row__sign">{row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '}</span>
            </span>
            <span className="diff-row__text">
              <code dangerouslySetInnerHTML={{ __html: html }} />
              {row.noNewline ? <span className="diff-card__hint">（文件末尾无换行）</span> : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  </div>
}
