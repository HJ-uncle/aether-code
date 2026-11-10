import { useEffect, useRef, useState, type JSX } from 'react'
import type { BrowserTabState, BrowserViewport } from '@shared/browser'
import { Icon } from '@renderer/workbench/icons'
import { Popover } from '@renderer/workbench/Popover'
import { Select } from '@renderer/workbench/Select'
import { customViewportLabel, DESKTOP_VIEWPORT, PHONE_VIEWPORT, viewportPreset } from './viewport-display'
import './work-browser.css'

type Inspector = 'console' | 'network' | null

/** Work gives the page the full height until a display or inspection control is needed. */
export function BrowserDisplayMenu({ tab, inspector, onViewport, onZoom, onInspector }: {
  tab: BrowserTabState
  inspector: Inspector
  onViewport: (value: BrowserViewport | null) => void
  onZoom: (value: number) => void
  onInspector: (value: Inspector) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState(false)
  const [width, setWidth] = useState('1280')
  const [height, setHeight] = useState('800')
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const mode = viewportPreset(tab.viewport)
  const modified = Boolean(tab.viewport || tab.zoomFactor !== 1 || inspector)
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>('button')?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])
  const close = (): void => { setOpen(false); trigger.current?.focus({ preventScroll: true }) }
  return <Popover className="work-browser-display" panelClassName="work-browser-display__popover" label="网页显示与检查"
    width={284} placement="down" align="end" open={open} onOpenChange={setOpen}
    trigger={() => <button ref={trigger} type="button" className={`browser-tool${open ? ' is-active' : ''}`}
      title={`网页显示与检查 · ${tab.viewport ? `${tab.viewport.width} × ${tab.viewport.height}` : '适应区域'} · ${Math.round(tab.zoomFactor * 100)}%`}
      aria-label="网页显示与检查" aria-haspopup="dialog" aria-expanded={open} data-display-modified={modified || undefined}>
      <Icon name="fit-screen" size={16} />
    </button>}>
    <div ref={panel} className="work-browser-display__content" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    }}>
      <div className="work-browser-display__heading"><strong>网页显示</strong><button type="button" className="browser-tool" aria-label="关闭显示选项" onClick={close}><Icon name="close" size={14} /></button></div>
      <div className="work-browser-display__row"><span>视口</span><Select value={custom ? 'custom' : mode} ariaLabel="网页视口" width={220}
        options={[{ value: 'fit', label: '适应区域' }, { value: 'desktop', label: '桌面 · 1280 × 800' }, { value: 'phone', label: '手机 · 390 × 844' },
          { value: 'custom', label: mode === 'custom' ? customViewportLabel(tab.viewport) : '自定义尺寸…' }]}
        onChange={value => {
          setCustom(value === 'custom')
          if (value === 'custom') { setWidth(String(tab.viewport?.width ?? 1280)); setHeight(String(tab.viewport?.height ?? 800)) }
          else onViewport(value === 'phone' ? PHONE_VIEWPORT : value === 'desktop' ? DESKTOP_VIEWPORT : null)
        }} /></div>
      {custom ? <form className="work-browser-display__dimensions" onSubmit={event => {
        event.preventDefault(); event.stopPropagation()
        onViewport({ width: Number(width), height: Number(height), mobile: false, deviceScaleFactor: 1 }); setCustom(false)
      }}>
        <label>宽<input className="ui-input ui-input--compact" aria-label="视口宽度" type="number" min={240} max={3840} required value={width} onChange={event => setWidth(event.target.value)} /></label>
        <span aria-hidden="true">×</span>
        <label>高<input className="ui-input ui-input--compact" aria-label="视口高度" type="number" min={240} max={3840} required value={height} onChange={event => setHeight(event.target.value)} /></label>
        <button type="submit">应用</button>
        <button type="button" className="browser-tool" aria-label="取消自定义视口" onClick={() => setCustom(false)}><Icon name="close" size={14} /></button>
      </form> : null}
      <div className="work-browser-display__row"><span>缩放</span><Select value={String(tab.zoomFactor)} ariaLabel="网页缩放" width={140}
        options={[...new Set([0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2, tab.zoomFactor])].sort((a, b) => a - b)
          .map(factor => ({ value: String(factor), label: `${Math.round(factor * 100)}%` }))}
        onChange={value => onZoom(Number(value))} /></div>
      <div className="work-browser-display__inspectors">
        <button type="button" aria-pressed={inspector === 'console'} onClick={() => { onInspector(inspector === 'console' ? null : 'console'); close() }}><Icon name="terminal" size={15} />控制台</button>
        <button type="button" aria-pressed={inspector === 'network'} onClick={() => { onInspector(inspector === 'network' ? null : 'network'); close() }}><Icon name="swap-horizontal" size={15} />网络</button>
      </div>
    </div>
  </Popover>
}
