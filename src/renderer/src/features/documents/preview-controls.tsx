import { useEffect, useRef, useState, type JSX, type RefObject } from 'react'
import { Spinner } from '@renderer/ui/ui-primitives'
import { Icon } from '@renderer/ui/icons'
import { Select } from '@renderer/ui/Select'
import { documentPreviewNotice, type DocumentKind } from './document-kind'

export function PreviewMessage({ error, onRetry }: { error?: string; onRetry?: () => void }): JSX.Element {
  return <div className="document-preview__message" role={error ? 'alert' : 'status'}>
    {error ? <Icon name="alert-circle" size={22} /> : <Spinner size={18} />}
    <span>{error || '正在准备文档预览…'}</span>
    {error && onRetry ? <button type="button" onClick={onRetry}>重试预览</button> : null}
  </div>
}

/** Keep the product boundary visible on every Office/PDF surface. The
 * renderer can be useful for reading while still differing from the native
 * application's pagination, calculation, or annotation behavior. */
export function PreviewCapabilityNotice({ kind }: { kind: DocumentKind }): JSX.Element {
  return <div className="document-preview__format-note" role="note" data-document-capability={kind}>
    {documentPreviewNotice(kind)}
  </div>
}

export function PreviewZoom({ zoom, onZoom }: { zoom: number; onZoom: (zoom: number) => void }): JSX.Element {
  return <div className="document-preview__toolbar document-preview__toolbar--zoom" role="group" aria-label="文档缩放">
    <Select ariaLabel="缩放" className="document-preview__zoom-select" width={160} value={String(zoom)} onChange={value => onZoom(Number(value))}
      options={[{ value: '0', label: '适应宽度' }, ...[0.5, 0.75, 1, 1.25, 1.5, 2].map(value => ({ value: String(value), label: `${Math.round(value * 100)}%` }))]} />
  </div>
}

export function usePreviewWidth(ref: RefObject<HTMLDivElement | null>, enabled = true): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(entries => { const next = Math.max(0, Math.round(entries[0]?.contentRect.width || 0)); setWidth(previous => previous === next ? previous : next) })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, enabled])
  return width
}

/** Keep the previous painted surface during a resize gesture. Only the first
 * real layout width and a settled later width trigger expensive repainting. */
export function useStablePreviewWidth(width: number, delayMs = 160): number {
  const [stable, setStable] = useState(width > 0 ? width : 0)
  const stableRef = useRef(stable)
  useEffect(() => {
    if (width <= 0 || stableRef.current === width) return
    const timer = setTimeout(() => {
      stableRef.current = width
      setStable(width)
    }, stableRef.current === 0 ? 0 : delayMs)
    return () => clearTimeout(timer)
  }, [width, delayMs])
  return stable
}

/**
 * Office resources can be mounted while their resource tab is still hidden.
 * An iframe created during that phase may keep a zero-sized child viewport
 * after the tab becomes visible. Wait for a real layout box before mounting
 * the document surface so the first paint uses the final dimensions.
 */
export function usePreviewVisibility(ref: RefObject<HTMLDivElement | null>, enabled = true): boolean {
  const [visibility, setVisibility] = useState({ enabled, visible: false })
  if (visibility.enabled !== enabled) setVisibility({ enabled, visible: false })
  const enabledRef = useRef(enabled)
  useEffect(() => {
    enabledRef.current = enabled
    if (!enabled) return
    const element = ref.current
    if (!element) return
    const update = (): void => {
      if (!enabledRef.current) return
      const rect = element.getBoundingClientRect()
      // Window resizing can transiently report a zero box. Once mounted, keep
      // the painted surface; hidden previews are unmounted by their active prop.
      if (rect.width > 0 && rect.height > 0) setVisibility({ enabled: true, visible: true })
    }
    const frame = requestAnimationFrame(update)
    const observer = new ResizeObserver(update)
    observer.observe(element)
    window.addEventListener('resize', update)
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', update) }
  }, [ref, enabled])
  return enabled && visibility.enabled && visibility.visible
}
