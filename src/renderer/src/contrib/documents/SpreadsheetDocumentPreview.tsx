import { useCallback, useEffect, useState, useSyncExternalStore, type JSX } from 'react'
import { Icon } from '@renderer/workbench/icons'
import { spreadsheetColumn } from './document-kind'
import { PreviewMessage, PreviewPager } from './preview-controls'
import { SHEET_PAGE_COLUMNS, SHEET_PAGE_ROWS } from './spreadsheet-preview-contract'
import { acquireSpreadsheetSession, type Lease } from './spreadsheet-preview-session'

export default function SpreadsheetDocumentPreview({ data, sessionKey, onRetry }: { data: ArrayBuffer; sessionKey: string; onRetry?: () => void }): JSX.Element {
  const [lease, setLease] = useState<Lease | null>(null)
  const [sheet, setSheet] = useState(0)
  const [page, setPage] = useState(1), [columnPage, setColumnPage] = useState(0)
  useEffect(() => {
    const acquired = acquireSpreadsheetSession(sessionKey, data)
    acquired.session.select(0, 0, 0)
    setSheet(0); setPage(1); setColumnPage(0)
    setLease(acquired)
    return () => { acquired.release() }
  }, [data, sessionKey])
  const subscribe = useCallback((notify: () => void) => lease?.session.subscribe(notify) ?? (() => {}), [lease])
  const snapshot = useCallback(() => lease?.session.version ?? 0, [lease])
  useSyncExternalStore(subscribe, snapshot, snapshot)
  const row = (page - 1) * SHEET_PAGE_ROWS, column = columnPage * SHEET_PAGE_COLUMNS
  const session = lease?.session
  useEffect(() => { session?.select(sheet, row, column) }, [session, sheet, row, column])
  const sheets = session?.sheets || []
  const current = session?.page && session.page.sheet === sheet && session.page.row === row && session.page.column === column ? session.page : null
  if (session?.error) return <PreviewMessage error={session.error} onRetry={onRetry} />
  if (!session || !sheets.length) return <PreviewMessage />
  const selected = sheets[sheet] || sheets[0]
  return <>
    <div className="document-preview__table-nav">
      <PreviewPager page={page} total={Math.max(1, Math.ceil(selected.rows / SHEET_PAGE_ROWS))} onPage={setPage} />
      <div className="document-preview__toolbar" role="group" aria-label="表格列范围">
        <button type="button" aria-label="上一组列" disabled={columnPage === 0} onClick={() => setColumnPage(value => value - 1)}><Icon name="chevron-left" size={16} /></button>
        <span data-document-column-range>{spreadsheetColumn(column + 1)}–{spreadsheetColumn(Math.max(1, Math.min(selected.columns, column + SHEET_PAGE_COLUMNS)))}</span>
        <button type="button" aria-label="下一组列" disabled={column + SHEET_PAGE_COLUMNS >= selected.columns} onClick={() => setColumnPage(value => value + 1)}><Icon name="chevron-right" size={16} /></button>
      </div>
    </div>
    {current && current.formatFallbacks > 0 && <div className="document-preview__format-note" role="status">部分单元格格式无法还原，已显示原始值或缺少计算结果的提示。</div>}
    <div id="document-sheet-panel" className="document-preview__body document-preview__body--sheet" role="tabpanel" aria-labelledby="document-sheet-tabs" data-document-sheet={sheet} data-document-row-start={row + 1}>
      {!current ? <PreviewMessage /> : <table className="document-preview__table" aria-label={selected.name}>
        <thead><tr><th aria-label="行号" />{current.cells[0]?.map((_, index) => <th key={index} scope="col" style={{ width: current.layout.columns[index], minWidth: current.layout.columns[index] }}>{spreadsheetColumn(column + index + 1)}</th>)}</tr></thead>
        <tbody>{current.cells.map((cells, index) => <tr key={row + index} style={{ height: current.layout.rows[index] }}><th scope="row" style={{ height: current.layout.rows[index] }}>{row + index + 1}</th>
          {cells.map((cell, cellIndex) => cell.covered ? null : <td key={column + cellIndex} title={cell.text} colSpan={cell.colSpan} rowSpan={cell.rowSpan} style={{ fontWeight: cell.bold ? 600 : undefined, fontStyle: cell.italic ? 'italic' : undefined, textAlign: cell.align, verticalAlign: cell.verticalAlign, whiteSpace: cell.wrap ? 'pre-wrap' : undefined, color: cell.color, backgroundColor: cell.background, textDecoration: cell.underline && cell.strike ? 'underline line-through' : cell.underline ? 'underline' : cell.strike ? 'line-through' : undefined, borderTop: cell.borders?.top ? `${cell.borders.top.width || 1}px ${cell.borders.top.style || 'solid'} ${cell.borders.top.color || 'currentColor'}` : undefined, borderRight: cell.borders?.right ? `${cell.borders.right.width || 1}px ${cell.borders.right.style || 'solid'} ${cell.borders.right.color || 'currentColor'}` : undefined, borderBottom: cell.borders?.bottom ? `${cell.borders.bottom.width || 1}px ${cell.borders.bottom.style || 'solid'} ${cell.borders.bottom.color || 'currentColor'}` : undefined, borderLeft: cell.borders?.left ? `${cell.borders.left.width || 1}px ${cell.borders.left.style || 'solid'} ${cell.borders.left.color || 'currentColor'}` : undefined }}>{cell.text}</td>)}
        </tr>)}</tbody>
      </table>}
    </div>
    <div id="document-sheet-tabs" className="document-preview__toolbar document-preview__toolbar--sheets">
      <div className="document-preview__sheet-tabs" role="tablist" aria-label="工作表">
        {sheets.map((item, index) => <button key={index} type="button" role="tab" aria-selected={sheet === index} aria-controls="document-sheet-panel" tabIndex={sheet === index ? 0 : -1}
          onClick={() => { setSheet(index); setPage(1); setColumnPage(0) }}
          onKeyDown={event => {
            let next = index
            if (event.key === 'ArrowRight') next = (index + 1) % sheets.length
            else if (event.key === 'ArrowLeft') next = (index + sheets.length - 1) % sheets.length
            else if (event.key === 'Home') next = 0
            else if (event.key === 'End') next = sheets.length - 1
            else return
            event.preventDefault()
            setSheet(next); setPage(1); setColumnPage(0)
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
          }}>{item.name}</button>)}
      </div>
      <span>{selected.rows.toLocaleString()} 行 · {selected.columns} 列</span>
    </div>
  </>
}
