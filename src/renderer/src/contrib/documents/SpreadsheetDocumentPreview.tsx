import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type JSX, type UIEvent } from 'react'
import { spreadsheetColumn } from './document-kind'
import { PreviewCapabilityNotice, PreviewMessage } from './preview-controls'
import type { SheetLayout } from './spreadsheet-preview-contract'
import { bufferedSpreadsheetRange, buildSpreadsheetAxis, spreadsheetAxisIndex } from './spreadsheet-page'
import { acquireSpreadsheetSession, getSpreadsheetSession, subscribeSpreadsheetSessions } from './spreadsheet-preview-session'
import { Select } from '@renderer/workbench/Select'
import { SpreadsheetChart } from './SpreadsheetChart'
import { SpreadsheetCell } from './SpreadsheetCell'

const HEADER_HEIGHT = 30
const ROW_HEADER_WIDTH = 52
const OVERSCAN_ROWS = 8
const OVERSCAN_COLUMNS = 3

function dimensions(rows: number, columns: number, layout?: SheetLayout): SheetLayout {
  return {
    rows: Array.from({ length: Math.max(1, rows) }, (_, index) => layout?.rows[index] ?? 30),
    columns: Array.from({ length: Math.max(1, columns) }, (_, index) => layout?.columns[index] ?? 110),
  }
}

export default function SpreadsheetDocumentPreview({ data, sessionKey, onRetry }: { data: ArrayBuffer; sessionKey: string; onRetry?: () => void }): JSX.Element {
  const panelId = useId()
  const [selection, setSelection] = useState({ key: '', sheet: 0 })
  const [chartSelection, setChartSelection] = useState({ key: '', sheet: 0, id: '' })
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
  const chartReturnPosition = useRef({ top: 0, left: 0 })
  const rangeConsumer = useRef({})
  useEffect(() => {
    const consumer = rangeConsumer.current
    return () => session?.cancelRangeRequests(consumer)
  }, [session])
  const sheets = session?.sheets || []
  const selected = sheets[sheet] || sheets[0]
  const charts = session?.charts[sheet] || []
  const focusedChart = chartSelection.key === sessionKey && chartSelection.sheet === sheet
    ? charts.find(chart => chart.id === chartSelection.id) : undefined
  const ready = Boolean(session && selected && !session.error)
  const rowCount = selected ? Math.max(1, selected.rows) : 1
  const columnCount = selected ? Math.max(1, selected.columns) : 1
  const sheetLayout = session?.layouts[sheet]
  const layout = useMemo(() => dimensions(rowCount, columnCount, sheetLayout), [rowCount, columnCount, sheetLayout])
  const rowAxis = useMemo(() => buildSpreadsheetAxis(layout.rows), [layout.rows])
  const columnAxis = useMemo(() => buildSpreadsheetAxis(layout.columns), [layout.columns])
  const contentWidth = Math.max(ROW_HEADER_WIDTH + columnAxis.total, ...charts.map(chart => ROW_HEADER_WIDTH + chart.x + chart.width + 16))
  const contentHeight = Math.max(HEADER_HEIGHT + rowAxis.total, ...charts.map(chart => HEADER_HEIGHT + chart.y + chart.height + 16))
  const visibleTop = Math.max(0, viewport.top - HEADER_HEIGHT)
  const visibleLeft = Math.max(0, viewport.left - ROW_HEADER_WIDTH)
  const visibleRow = spreadsheetAxisIndex(rowAxis, visibleTop)
  const visibleColumn = spreadsheetAxisIndex(columnAxis, visibleLeft)
  const lastVisibleRow = spreadsheetAxisIndex(rowAxis, visibleTop + Math.max(0, viewport.height - HEADER_HEIGHT))
  const lastVisibleColumn = spreadsheetAxisIndex(columnAxis, visibleLeft + Math.max(0, viewport.width - ROW_HEADER_WIDTH))
  const requested = bufferedSpreadsheetRange(Math.max(0, visibleRow - OVERSCAN_ROWS), Math.max(0, visibleColumn - OVERSCAN_COLUMNS),
    Math.min(rowCount, lastVisibleRow + 1 + OVERSCAN_ROWS), Math.min(columnCount, lastVisibleColumn + 1 + OVERSCAN_COLUMNS), rowCount, columnCount)
  const { row: requestRow, column: requestColumn, endRow: requestEndRow, endColumn: requestEndColumn } = requested
  // The whole viewport is one rectangle. A merge crossing the old 100x20 page
  // boundary therefore keeps one owner and one set of covered cells.
  const range = session?.getRange(sheet, requestRow, requestColumn, requestEndRow, requestEndColumn)
  const firstRow = range?.row ?? requestRow, firstColumn = range?.column ?? requestColumn
  const endRow = range?.endRow ?? requestEndRow, endColumn = range?.endColumn ?? requestEndColumn
  useEffect(() => {
    if (!session || !selected) return
    session.requestRange(sheet, requestRow, requestColumn, requestEndRow, requestEndColumn, rangeConsumer.current)
  }, [session, sheet, selected, requestRow, requestColumn, requestEndRow, requestEndColumn])
  useEffect(() => {
    const element = body.current
    if (!element) return
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect
      if (rect && rect.width > 0 && rect.height > 0) setViewport(previous => previous.width === rect.width && previous.height === rect.height ? previous : { ...previous, width: rect.width, height: rect.height })
    })
    observer.observe(element)
    return () => { observer.disconnect(); cancelAnimationFrame(frame.current); frame.current = 0 }
  }, [ready])
  useEffect(() => {
    const element = body.current
    if (!element || focusedChart) return
    const maximumTop = Math.max(0, contentHeight - element.clientHeight)
    const maximumLeft = Math.max(0, contentWidth - element.clientWidth)
    if (element.scrollTop > maximumTop || element.scrollLeft > maximumLeft) {
      element.scrollTo({ top: Math.min(element.scrollTop, maximumTop), left: Math.min(element.scrollLeft, maximumLeft) })
    }
  }, [contentHeight, contentWidth, focusedChart])
  useEffect(() => {
    const element = body.current
    if (!element) return
    element.scrollTop = 0
    element.scrollLeft = 0
    setViewport(previous => ({ ...previous, top: 0, left: 0 }))
  }, [session, sheet])
  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    const element = event.currentTarget
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const { scrollTop, scrollLeft } = element
      setViewport(previous => previous.top === scrollTop && previous.left === scrollLeft ? previous : { ...previous, top: scrollTop, left: scrollLeft })
    })
  }
  const selectChart = (id: string): void => {
    if (id && !focusedChart && body.current) chartReturnPosition.current = { top: body.current.scrollTop, left: body.current.scrollLeft }
    setChartSelection({ key: sessionKey, sheet, id })
    // The chart stays in this worksheet. Preserve the user's cell position
    // while they inspect a readable chart in a narrow Work pane.
    requestAnimationFrame(() => body.current?.scrollTo(id ? { top: 0, left: 0 } : chartReturnPosition.current))
  }
  if (session?.error) return <PreviewMessage error={session.error} onRetry={onRetry} />
  if (!session || !selected) return <PreviewMessage />
  const rangeError = session.getRangeError(sheet, requestRow, requestColumn, requestEndRow, requestEndColumn)
  return <>
    <PreviewCapabilityNotice kind="xlsx" />
    <div className={`document-preview__body document-preview__body--sheet${focusedChart ? ' document-preview__body--chart' : ''}`} ref={body} onScroll={onScroll}
      id={panelId} role="tabpanel" aria-labelledby={`${panelId}-tab-${sheet}`} data-document-sheet={sheet} data-document-row-start={visibleRow + 1} data-document-row-count={selected.rows}>
      {focusedChart ? <div className="document-preview__chart-focus" data-focused-chart={focusedChart.id}>
        <button type="button" className="document-preview__chart-back" onClick={() => selectChart('')}>返回工作表</button>
        <SpreadsheetChart key={focusedChart.id} chart={focusedChart} width={Math.max(280, viewport.width - 24)} height={Math.max(300, Math.min(640, viewport.height - 64, (viewport.width - 24) * 0.62 + 110))} />
      </div> : <div className="document-preview__sheet-viewport" style={{ position: 'relative', width: Math.max(contentWidth, viewport.width), height: Math.max(contentHeight, viewport.height) }}>
        <table className="document-preview__table" aria-label={selected.name} style={{ width: ROW_HEADER_WIDTH + columnAxis.total }}>
          <colgroup><col style={{ width: ROW_HEADER_WIDTH, minWidth: ROW_HEADER_WIDTH }} />{layout.columns.map((width, index) => <col key={index} style={{ width, minWidth: width }} />)}</colgroup>
          <thead><tr style={{ height: HEADER_HEIGHT }}><th aria-label="行号" />{firstColumn ? <th aria-hidden="true" colSpan={firstColumn} /> : null}{Array.from({ length: endColumn - firstColumn }, (_, index) => <th key={firstColumn + index} scope="col">{spreadsheetColumn(firstColumn + index + 1)}</th>)}{endColumn < columnCount ? <th aria-hidden="true" colSpan={columnCount - endColumn} /> : null}</tr></thead>
          <tbody>
            {firstRow ? <tr aria-hidden="true" style={{ height: rowAxis.offsets[firstRow] }}><td colSpan={columnCount + 1} style={{ height: rowAxis.offsets[firstRow], padding: 0, border: 0 }} /></tr> : null}
            {Array.from({ length: endRow - firstRow }, (_, index) => firstRow + index).map(row => <tr key={row} style={{ height: layout.rows[row] }}><th scope="row" style={{ height: layout.rows[row] }}>{row + 1}</th>
              {firstColumn ? <td aria-hidden="true" colSpan={firstColumn} style={{ padding: 0, border: 0 }} /> : null}
              {Array.from({ length: endColumn - firstColumn }, (_, index) => firstColumn + index).map(column => {
                const cell = range?.cells[row - firstRow]?.[column - firstColumn]
                return cell ? <SpreadsheetCell key={column} cell={cell} /> : <td key={column} />
              })}
              {endColumn < columnCount ? <td aria-hidden="true" colSpan={columnCount - endColumn} style={{ padding: 0, border: 0 }} /> : null}
            </tr>)}
            {endRow < rowCount ? <tr aria-hidden="true" style={{ height: rowAxis.total - rowAxis.offsets[endRow] }}><td colSpan={columnCount + 1} style={{ height: rowAxis.total - rowAxis.offsets[endRow], padding: 0, border: 0 }} /></tr> : null}
          </tbody>
        </table>
        {charts.map(chart => <div key={chart.id} className="document-preview__chart-anchor"
          style={{ left: ROW_HEADER_WIDTH + chart.x, top: HEADER_HEIGHT + chart.y, width: chart.width, height: chart.height }}>
          {ROW_HEADER_WIDTH + chart.x < viewport.left + viewport.width + 400 && ROW_HEADER_WIDTH + chart.x + chart.width > viewport.left - 400
            && HEADER_HEIGHT + chart.y < viewport.top + viewport.height + 400 && HEADER_HEIGHT + chart.y + chart.height > viewport.top - 400
            ? <SpreadsheetChart chart={chart} onExpand={() => selectChart(chart.id)} /> : null}
        </div>)}
      </div>}
      {rangeError ? <PreviewMessage error={rangeError} onRetry={onRetry} /> : session.pageError ? <PreviewMessage error={session.pageError} onRetry={onRetry} /> : null}
    </div>
    <div className="document-preview__toolbar document-preview__toolbar--sheets">
      <div className="document-preview__sheet-tabs" data-scroll-axis="x" role="tablist" aria-label="工作表">
        {sheets.map((item, index) => <button key={index} id={`${panelId}-tab-${index}`} type="button" role="tab" aria-selected={sheet === index} aria-controls={panelId} tabIndex={sheet === index ? 0 : -1}
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
      {charts.length ? <Select className="document-preview__chart-select" ariaLabel="图表" title="查看当前工作表中的图表" placement="up" width={260}
        value={focusedChart?.id || ''} triggerLabel={focusedChart ? `图表 · ${focusedChart.title}` : `图表 ${charts.length}`}
        onChange={selectChart} options={[{ value: '', label: '工作表' }, ...charts.map((chart, index) => ({ value: chart.id, label: chart.title || `图表 ${index + 1}` }))]} />
        : <span>{selected.rows.toLocaleString()} 行 · {selected.columns} 列</span>}
    </div>
  </>
}
