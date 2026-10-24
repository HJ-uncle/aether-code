import { useEffect, useState, type JSX, type RefObject } from 'react'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { Icon } from '@renderer/workbench/icons'

export function PreviewMessage({ error }: { error?: string }): JSX.Element {
  return <div className="document-preview__message" role={error ? 'alert' : 'status'}>
    {error ? <Icon name="warning" size={22} /> : <Spinner size={18} />}
    <span>{error || '正在准备文档预览…'}</span>
  </div>
}

export function PreviewPager({ page, total, onPage, zoom, onZoom }: {
  page: number; total: number; onPage: (page: number) => void; zoom?: number; onZoom?: (zoom: number) => void
}): JSX.Element {
  return <div className="document-preview__toolbar" role="group" aria-label="文档翻页">
    <button type="button" aria-label="上一页" title="上一页" disabled={page <= 1} onClick={() => onPage(page - 1)}><Icon name="chevron-left" size={16} /></button>
    <label className="document-preview__page-label">第 <input aria-label="页码" type="number" min={1} max={total} value={page}
      onChange={event => { const next = Number(event.target.value); if (Number.isInteger(next) && next >= 1 && next <= total) onPage(next) }} /> / {total} 页</label>
    <button type="button" aria-label="下一页" title="下一页" disabled={page >= total} onClick={() => onPage(page + 1)}><Icon name="chevron-right" size={16} /></button>
    {onZoom && <select aria-label="缩放" value={zoom} onChange={event => onZoom(Number(event.target.value))}>
      <option value={0}>适应宽度</option>{[0.5, 0.75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}
    </select>}
  </div>
}

export function usePreviewWidth(ref: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(800)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(entries => { const next = Math.round(entries[0]?.contentRect.width || 800); setWidth(previous => previous === next ? previous : next) })
    observer.observe(element)
    return () => observer.disconnect()
  })
  return width
}
