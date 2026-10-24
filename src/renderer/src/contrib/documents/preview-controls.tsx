import { useEffect, useState, type JSX, type RefObject } from 'react'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { Icon } from '@renderer/workbench/icons'

export function PreviewMessage({ error, onRetry }: { error?: string; onRetry?: () => void }): JSX.Element {
  return <div className="document-preview__message" role={error ? 'alert' : 'status'}>
    {error ? <Icon name="warning" size={22} /> : <Spinner size={18} />}
    <span>{error || '正在准备文档预览…'}</span>
    {error && onRetry ? <button type="button" onClick={onRetry}>重试预览</button> : null}
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

export function usePreviewWidth(ref: RefObject<HTMLDivElement | null>, enabled = true): number {
  const [width, setWidth] = useState(800)
  useEffect(() => {
    if (!enabled) return
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(entries => { const next = Math.round(entries[0]?.contentRect.width || 800); setWidth(previous => previous === next ? previous : next) })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, enabled])
  return width
}

/**
 * Office resources can be mounted while their resource tab is still hidden.
 * An iframe created during that phase may keep a zero-sized child viewport
 * after the tab becomes visible. Wait for a real layout box before mounting
 * the document surface so the first paint uses the final dimensions.
 */
export function usePreviewVisibility(ref: RefObject<HTMLDivElement | null>, enabled = true): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!enabled) { setVisible(false); return }
    const element = ref.current
    if (!element) return
    const update = (): void => {
      const rect = element.getBoundingClientRect()
      setVisible(rect.width > 0 && rect.height > 0)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    window.addEventListener('resize', update)
    return () => { observer.disconnect(); window.removeEventListener('resize', update) }
  }, [ref, enabled])
  return visible
}
