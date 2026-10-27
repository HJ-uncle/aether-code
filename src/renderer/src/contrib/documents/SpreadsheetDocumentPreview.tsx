import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX, type UIEvent } from 'react'
import { spreadsheetColumn } from './document-kind'
import { PreviewMessage } from './preview-controls'
import type { SheetCell, SheetLayout } from './spreadsheet-preview-contract'
import { buildSpreadsheetAxis, spreadsheetAxisIndex } from './spreadsheet-page'
import { acquireSpreadsheetSession, getSpreadsheetSession, subscribeSpreadsheetSessions } from './spreadsheet-preview-session'

const HEADER_HEIGHT = 30
const ROW_HEADER_WIDTH = 52
const OVERSCAN_ROWS = 8
const OVERSCAN_COLUMNS = 3

function Cell({ cell }: { cell: SheetCell }): JSX.Element | null {
  if (cell.covered) return null
  return <td title={cell.text} colSpan={cell.colSpan} rowSpan={cell.rowSpan} style={{ fontWeight: cell.bold ? 600 : undefined, fontStyle: cell.italic ? 'italic' : undefined, textAlign: cell.align, verticalAlign: cell.verticalAlign, whiteSpace: cell.wrap ? 'pre-wrap' : undefined, color: cell.color, backgroundColor: cell.background, textDecoration: cell.underline && cell.strike ? 'underline line-through' : cell.underline ? 'underline' : cell.strike ? 'line-through' : undefined, borderTop: cell.borders?.top ? `${cell.borders.top.width || 1}px ${cell.borders.top.style || 'solid'} ${cell.borders.top.color || 'currentColor'}` : undefined, borderRight: cell.borders?.right ? `${cell.borders.right.width || 1}px ${cell.borders.right.style || 'solid'} ${cell.borders.right.color || 'currentColor'}` : undefined, borderBottom: cell.borders?.bottom ? `${cell.borders.bottom.width || 1}px ${cell.borders.bottom.style || 'solid'} ${cell.borders.bottom.color || 'currentColor'}` : undefined, borderLeft: cell.borders?.left ? `${cell.borders.left.width || 1}px ${cell.borders.left.style || 'solid'} ${cell.borders.left.color || 'currentColor'}` : undefined }}>{cell.text}</td>
}

function dimensions(rows: number, columns: number, layout?: SheetLayout): SheetLayout {
  return {
    rows: Array.from({ length: Math.max(1, rows) }, (_, index) => layout?.rows[index] ?? 30),
    columns: Array.from({ length: Math.max(1, columns) }, (_, index) => layout?.columns[index] ?? 110),
  }
}

export default function SpreadsheetDocumentPreview({ data, sessionKey, onRetry }: { data: ArrayBuffer; sessionKey: string; onRetry?: () => void }): JSX.Element {
  const [selection, setSelection] = useState({ key: '', sheet: 0 })
  const { sheet } = selection.key === sessionKey ? selection : { sheet: 0 }
  const session = useSyncExternalStore(subscribeSpreadsheetSessions,
    () => getSpreadsheetSession(sessionKey, data), () => null)
  useEffect(() => acquireSpreadsheetSession(sessionKey, data).release, [data, sessionKey])
  const subscribe = useCallback((notify: () => void) => session?.subscribe(notify) ?? (() => {}), [session])
  const snapshot = useCallback(() => session?.version ?? 0, [session])
  useSyncExternalStore(subscribe, snapshot, snapshot)
  const [viewport, setViewport] = useState({ top: 0, left: 0, width: 800, height: 600 })
  const body = useRef<HTMLDivElement>(null)
  const frame = useRef(0)
  const sheets = session?.sheets || []
  const selected = sheets[sheet] || sheets[0]
  const rowCount = selected ? Math.max(1, selected.rows) : 1
  const columnCount = selected ? Math.max(1, selected.columns) : 1
  const sheetLayout = session?.layouts[sheet]
  const layout = useMemo(() => dimensions(rowCount, columnCount, sheetLayout), [rowCount, columnCount, sheetLayout])
  const rowAxis = useMemo(() => buildSpreadsheetAxis(layout.rows), [layout.rows])
  const columnAxis = useMemo(() => buildSpreadsheetAxis(layout.columns), [layout.columns])
  const visibleTop = Math.max(0, viewport.top - HEADER_HEIGHT)
  const visibleLeft = Math.max(0, viewport.left - ROW_HEADER_WIDTH)
  const visibleRow = spreadsheetAxisIndex(rowAxis, visibleTop)
  const visibleColumn = spreadsheetAxisIndex(columnAxis, visibleLeft)
  const lastVisibleRow = spreadsheetAxisIndex(rowAxis, visibleTop + Math.max(0, viewport.height - HEADER_HEIGHT))
  const lastVisibleColumn = spreadsheetAxisIndex(columnAxis, visibleLeft + Math.max(0, viewport.width - ROW_HEADER_WIDTH))
  const firstRow = Math.max(0, visibleRow - OVERSCAN_ROWS)
  const endRow = Math.min(rowCount, lastVisibleRow + 1 + OVERSCAN_ROWS)
  const firstColumn = Math.max(0, visibleColumn - OVERSCAN_COLUMNS)
  const endColumn = Math.min(columnCount, lastVisibleColumn + 1 + OVERSCAN_COLUMNS)
  // The whole viewport is one rectangle. A merge crossing the old 100x20 page
  // boundary therefore keeps one owner and one set of covered cells.
  const range = session?.getRange(sheet, firstRow, firstColumn, endRow, endColumn)
  useEffect(() => {
    if (!session || !selected) return
    session.requestRange(sheet, firstRow, firstColumn, endRow, endColumn)
  }, [session, sheet, selected, firstRow, firstColumn, endRow, endColumn])
  useEffect(() => {
    const element = body.current
    if (!element) return
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect
      if (rect) setViewport(previous => ({ ...previous, width: rect.width, height: rect.height }))
    })
    observer.observe(element)
    return () => { observer.disconnect(); cancelAnimationFrame(frame.current) }
  }, [])
  useEffect(() => {
    const element = body.current
    if (!element) return
    const maximumTop = Math.max(0, HEADER_HEIGHT + rowAxis.total - element.clientHeight)
    const maximumLeft = Math.max(0, ROW_HEADER_WIDTH + columnAxis.total - element.clientWidth)
    if (element.scrollTop > maximumTop || element.scrollLeft > maximumLeft) {
      element.scrollTo({ top: Math.min(element.scrollTop, maximumTop), left: Math.min(element.scrollLeft, maximumLeft) })
    }
  }, [rowAxis, columnAxis])
  useEffect(() => {
    const element = body.current
    if (!element) return
    element.scrollTop = 0
    element.scrollLeft = 0
    setViewport(previous => ({ ...previous, top: 0, left: 0 }))
  }, [session, sheet])
  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    const { scrollTop, scrollLeft } = event.currentTarget
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      setViewport(previous => previous.top === scrollTop && previous.left === scrollLeft ? previous : { ...previous, top: scrollTop, left: scrollLeft })
    })
  }
  if (session?.error) return <PreviewMessage error={session.error} onRetry={onRetry} />
  if (!session || !selected) return <PreviewMessage />
  const rangeError = session.getRangeError(sheet, firstRow, firstColumn, endRow, endColumn)
  return <>
    <div className="document-preview__body document-preview__body--sheet" ref={body} onScroll={onScroll}
      id="document-sheet-panel" role="tabpanel" aria-labelledby="document-sheet-tabs" data-document-sheet={sheet} data-document-row-start={visibleRow + 1} data-document-row-count={selected.rows}>
      <div className="document-preview__sheet-viewport" style={{ position: 'relative', width: Math.max(ROW_HEADER_WIDTH + columnAxis.total, viewport.width), height: Math.max(HEADER_HEIGHT + rowAxis.total, viewport.height) }}>
        <table className="document-preview__table" style={{ width: ROW_HEADER_WIDTH + columnAxis.total }}>
          <colgroup><col style={{ width: ROW_HEADER_WIDTH, minWidth: ROW_HEADER_WIDTH }} />{layout.columns.map((width, index) => <col key={index} style={{ width, minWidth: width }} />)}</colgroup>
          <thead><tr style={{ height: HEADER_HEIGHT }}><th aria-label="行号" />{firstColumn ? <th aria-hidden="true" colSpan={firstColumn} /> : null}{Array.from({ length: endColumn - firstColumn }, (_, index) => <th key={firstColumn + index} scope="col">{spreadsheetColumn(firstColumn + index + 1)}</th>)}{endColumn < columnCount ? <th aria-hidden="true" colSpan={columnCount - endColumn} /> : null}</tr></thead>
          <tbody>
            {firstRow ? <tr aria-hidden="true" style={{ height: rowAxis.offsets[firstRow] }}><td colSpan={columnCount + 1} style={{ height: rowAxis.offsets[firstRow], padding: 0, border: 0 }} /></tr> : null}
            {Array.from({ length: endRow - firstRow }, (_, index) => firstRow + index).map(row => <tr key={row} style={{ height: layout.rows[row] }}><th scope="row" style={{ height: layout.rows[row] }}>{row + 1}</th>
              {firstColumn ? <td aria-hidden="true" colSpan={firstColumn} style={{ padding: 0, border: 0 }} /> : null}
              {Array.from({ length: endColumn - firstColumn }, (_, index) => firstColumn + index).map(column => {
                const cell = range?.cells[row - firstRow]?.[column - firstColumn]
                return cell ? <Cell key={column} cell={cell} /> : <td key={column} />
              })}
              {endColumn < columnCount ? <td aria-hidden="true" colSpan={columnCount - endColumn} style={{ padding: 0, border: 0 }} /> : null}
            </tr>)}
            {endRow < rowCount ? <tr aria-hidden="true" style={{ height: rowAxis.total - rowAxis.offsets[endRow] }}><td colSpan={columnCount + 1} style={{ height: rowAxis.total - rowAxis.offsets[endRow], padding: 0, border: 0 }} /></tr> : null}
          </tbody>
        </table>
      </div>
      {rangeError ? <PreviewMessage error={rangeError} onRetry={onRetry} /> : session.pageError ? <PreviewMessage error={session.pageError} onRetry={onRetry} /> : null}
    </div>
    <div id="document-sheet-tabs" className="document-preview__toolbar document-preview__toolbar--sheets">
      <div className="document-preview__sheet-tabs" role="tablist" aria-label="工作表">
        {sheets.map((item, index) => <button key={index} type="button" role="tab" aria-selected={sheet === index} aria-controls="document-sheet-panel" tabIndex={sheet === index ? 0 : -1}
          onClick={() => { setSelection({ key: sessionKey, sheet: index }); if (body.current) { body.current.scrollTop = 0; body.current.scrollLeft = 0 } }}
          onKeyDown={event => {
            let next = index
            if (event.key === 'ArrowRight') next = (index + 1) % sheets.length
            else if (event.key === 'ArrowLeft') next = (index + sheets.length - 1) % sheets.length
            else if (event.key === 'Home') next = 0
            else if (event.key === 'End') next = sheets.length - 1
            else return
            event.preventDefault()
            setSelection({ key: sessionKey, sheet: next })
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
          }}>{item.name}</button>)}
      </div>
      <span>{selected.rows.toLocaleString()} 行 · {selected.columns} 列</span>
    </div>
  </>
}
