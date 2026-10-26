import { useEffect, useRef, useState, type JSX } from 'react'
import { Icon } from '@renderer/workbench/icons'
import { DOCUMENT_LIMITS, spreadsheetColumn, previewErrorMessage } from './document-kind'
import { prepareOfficeArchive } from './office-archive'
import { PreviewMessage, PreviewPager } from './preview-controls'
import { SHEET_PAGE_COLUMNS, SHEET_PAGE_ROWS, type SheetPage, type SheetSummary, type SpreadsheetRequest, type SpreadsheetResponse } from './spreadsheet-preview-contract'

export default function SpreadsheetDocumentPreview({ data, onRetry }: { data: ArrayBuffer; onRetry?: () => void }): JSX.Element {
  const worker = useRef<Worker | null>(null)
  const [sheets, setSheets] = useState<SheetSummary[]>([]), [sheet, setSheet] = useState(0)
  const [page, setPage] = useState(1), [columnPage, setColumnPage] = useState(0), [result, setResult] = useState<SheetPage | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setSheets([]); setSheet(0); setPage(1); setColumnPage(0); setResult(null); setError('')
    const timer = setTimeout(() => { setError('工作簿解析超时，原文件已保留。'); controller.abort(); worker.current?.terminate(); worker.current = null }, DOCUMENT_LIMITS.parseTimeoutMs)
    void (async () => {
      const buffer = await prepareOfficeArchive(data, 'xlsx', controller.signal)
      controller.signal.throwIfAborted()
      const target = new Worker(new URL('./spreadsheet-preview.worker.ts', import.meta.url), { type: 'module', name: 'aether-document-spreadsheet' })
      worker.current = target
      target.onmessage = (event: MessageEvent<SpreadsheetResponse>) => {
        if (controller.signal.aborted) return
        if (event.data.kind === 'loaded') {
          clearTimeout(timer)
          if (!event.data.sheets.length) setError('工作簿中没有可预览的工作表。')
          else setSheets(event.data.sheets)
        } else if (event.data.kind === 'page') setResult(event.data.page)
        else { clearTimeout(timer); setError(previewErrorMessage(new Error(event.data.message))); target.terminate(); worker.current = null }
      }
      target.onerror = () => { clearTimeout(timer); if (!controller.signal.aborted) setError('工作簿解析失败，请重试。'); target.terminate(); worker.current = null }
      target.postMessage({ kind: 'load', data: buffer } satisfies SpreadsheetRequest, [buffer])
    })().catch((reason: unknown) => { clearTimeout(timer); if (!controller.signal.aborted) setError(previewErrorMessage(reason)) })
    return () => { clearTimeout(timer); controller.abort(); worker.current?.terminate(); worker.current = null }
  }, [data])
  const row = (page - 1) * SHEET_PAGE_ROWS, column = columnPage * SHEET_PAGE_COLUMNS
  useEffect(() => {
    if (!sheets.length || !worker.current) return
    worker.current.postMessage({ kind: 'page', sheet, row, column } satisfies SpreadsheetRequest)
  }, [sheets, sheet, row, column])
  if (error) return <PreviewMessage error={error} onRetry={onRetry} />
  if (!sheets.length) return <PreviewMessage />
  const selected = sheets[sheet]
  const current = result && result.sheet === sheet && result.row === row && result.column === column ? result : null
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
        <thead><tr><th aria-label="行号" />{current.cells[0]?.map((_, index) => <th key={index} scope="col">{spreadsheetColumn(column + index + 1)}</th>)}</tr></thead>
        <tbody>{current.cells.map((cells, index) => <tr key={row + index}><th scope="row">{row + index + 1}</th>
          {cells.map((cell, cellIndex) => <td key={column + cellIndex} title={cell.text} style={{ fontWeight: cell.bold ? 600 : undefined, fontStyle: cell.italic ? 'italic' : undefined, textAlign: cell.align }}>{cell.text}</td>)}
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
