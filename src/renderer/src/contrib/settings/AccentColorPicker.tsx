import { useEffect, useRef, useState, type CSSProperties, type JSX, type KeyboardEvent, type PointerEvent } from 'react'
import { normalizeAccentHex } from '@shared/accent-color'
import { Icon } from '@renderer/workbench/icons'
import { hexToHsv, hexToRgb, hsvToHex, rgbToHex, type ColorHsv, type ColorRgb } from './color-picker-model'
import './accent-color-picker.css'

const PALETTE = [
  { label: '海洋蓝', color: '#007aff' },
  { label: '鸢尾紫', color: '#af52de' },
  { label: '玫瑰粉', color: '#ff2d55' },
  { label: '珊瑚橙', color: '#ff9500' },
  { label: '暖阳黄', color: '#eab308' },
  { label: '叶绿色', color: '#34c759' },
  { label: '薄荷绿', color: '#30b89a' },
  { label: '石墨灰', color: '#8e8e93' }
]
const CHANNELS = [
  { key: 'r', label: '红色通道', caption: 'R' },
  { key: 'g', label: '绿色通道', caption: 'G' },
  { key: 'b', label: '蓝色通道', caption: 'B' }
] as const
const APPLY_IDLE_DELAY = 300
type RgbDraft = Record<keyof ColorRgb, string>
type EyeDropperConstructor = new () => { open: (options: { signal: AbortSignal }) => Promise<{ sRGBHex: string }> }
const rgbDraft = (color: string): RgbDraft => {
  const rgb = hexToRgb(color)
  return { r: String(rgb.r), g: String(rgb.g), b: String(rgb.b) }
}
const clamp = (value: number): number => Math.max(0, Math.min(1, value))

/** 独立调色面板避免平台默认取色控件跳出应用的材质、字体和键盘节奏。 */
export function AccentColorPicker({ value, onPreview, onConfirm, onCancel }: {
  value: string
  onPreview: (color: string) => void
  onConfirm: (color: string) => Promise<void>
  onCancel: () => void
}): JSX.Element {
  const [color, setColor] = useState(value)
  const [hsv, setHsv] = useState(() => hexToHsv(value))
  const [hex, setHex] = useState(value)
  const [rgb, setRgb] = useState(() => rgbDraft(value))
  const [error, setError] = useState('')
  const [invalid, setInvalid] = useState<'hex' | 'rgb' | null>(null)
  const [sampling, setSampling] = useState(false)
  const [waitingToApply, setWaitingToApply] = useState(false)
  const [saving, setSaving] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const spectrumRef = useRef<HTMLDivElement>(null)
  const hueRef = useRef(hsv)
  const currentRef = useRef(value)
  const initialColor = useRef(value)
  const pendingRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  const previewChangeRef = useRef(onPreview)
  const savingRef = useRef(false)
  const samplingRef = useRef<AbortController | null>(null)
  previewChangeRef.current = onPreview
  const EyeDropper = (window as Window & { EyeDropper?: EyeDropperConstructor }).EyeDropper

  const flush = (): void => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    setWaitingToApply(false)
    if (pendingRef.current) {
      const next = pendingRef.current
      pendingRef.current = null
      previewChangeRef.current(next)
    }
  }

  useEffect(() => {
    mountedRef.current = true
    // Popover 首帧在定位前隐藏，下一绘制帧再聚焦，避免焦点留在页内按钮。
    const frame = requestAnimationFrame(() => spectrumRef.current?.focus({ preventScroll: true }))
    return () => {
      cancelAnimationFrame(frame)
      mountedRef.current = false
      samplingRef.current?.abort()
      // 关闭意味着取消草稿；清除待预览帧，避免恢复原色后又被延迟回调覆盖。
      if (timerRef.current) clearTimeout(timerRef.current)
      pendingRef.current = null
    }
  }, [])

  // 草稿与已保存设置分开，预览只改变本轮外观，完成后才写入设置。
  const choose = (next: string, nextHsv?: ColorHsv, continuous = false): void => {
    if (savingRef.current) return
    const selection = nextHsv ?? hexToHsv(next)
    if (!nextHsv && (selection.s === 0 || selection.v === 0)) selection.h = hueRef.current.h
    hueRef.current = selection
    currentRef.current = next
    setHsv(selection)
    setColor(next)
    setHex(next)
    setRgb(rgbDraft(next))
    setError('')
    setInvalid(null)
    pendingRef.current = next
    if (continuous) {
      // 移动时只预览面板草稿，停顿后才应用主题，避免整个工作台随拖动反复刷新。
      if (timerRef.current) clearTimeout(timerRef.current)
      setWaitingToApply(true)
      timerRef.current = setTimeout(flush, APPLY_IDLE_DELAY)
    } else flush()
  }

  const chooseHsv = (next: ColorHsv, continuous = false): void => choose(hsvToHex(next), next, continuous)
  const locate = (event: PointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    chooseHsv({ h: hueRef.current.h, s: clamp((event.clientX - rect.left) / rect.width),
      v: 1 - clamp((event.clientY - rect.top) / rect.height) }, true)
  }
  const spectrumKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = { ...hueRef.current }
    const step = event.shiftKey ? 0.1 : 0.01
    if (event.key === 'ArrowLeft') next.s = clamp(next.s - step)
    else if (event.key === 'ArrowRight') next.s = clamp(next.s + step)
    else if (event.key === 'ArrowUp') next.v = clamp(next.v + step)
    else if (event.key === 'ArrowDown') next.v = clamp(next.v - step)
    else if (event.key === 'Home') { next.s = 0; next.v = 1 }
    else if (event.key === 'End') { next.s = 1; next.v = 0 }
    else return
    event.preventDefault()
    chooseHsv(next)
  }
  const applyHex = (): void => {
    if (hex === currentRef.current) return
    const normalized = normalizeAccentHex(hex)
    if (normalized) choose(normalized)
    else { setInvalid('hex'); setError('请输入有效的 HEX 色值，例如 #4b95f1。') }
  }
  const applyRgb = (): void => {
    const channels = CHANNELS.map(({ key }) => rgb[key].trim())
    if (channels.some(channel => !/^\d{1,3}$/.test(channel) || Number(channel) > 255)) {
      setInvalid('rgb')
      setError('RGB 通道需要是 0–255 之间的整数。')
      return
    }
    const next = rgbToHex({ r: Number(rgb.r), g: Number(rgb.g), b: Number(rgb.b) })
    if (next !== currentRef.current) choose(next)
  }
  const restoreDraft = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Escape' || !invalid) return
    event.preventDefault()
    event.stopPropagation()
    setHex(currentRef.current)
    setRgb(rgbDraft(currentRef.current))
    setInvalid(null)
    setError('')
  }
  const panelKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (!savingRef.current) onCancel()
    } else if (event.key === 'Tab') {
      const controls = panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')
      if (!controls?.length) return
      const first = controls[0], last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
  }
  const confirm = async (): Promise<void> => {
    if (invalid || savingRef.current) return
    flush()
    savingRef.current = true
    setSaving(true)
    try {
      await onConfirm(currentRef.current)
    } catch (reason) {
      if (mountedRef.current) setError(reason instanceof Error ? reason.message : '颜色保存失败，请重试。')
    } finally {
      savingRef.current = false
      if (mountedRef.current) setSaving(false)
    }
  }
  const sampleScreen = async (): Promise<void> => {
    if (!EyeDropper) return
    const controller = new AbortController()
    samplingRef.current = controller
    setSampling(true)
    try {
      const selected = await new EyeDropper().open({ signal: controller.signal })
      const normalized = normalizeAccentHex(selected.sRGBHex)
      if (mountedRef.current && normalized) choose(normalized)
    } catch (reason) {
      if (mountedRef.current && !(reason instanceof DOMException && reason.name === 'AbortError')) {
        setError('屏幕取色未完成，请重试。')
      }
    } finally {
      if (mountedRef.current) { setSampling(false); spectrumRef.current?.focus() }
    }
  }

  const spectrumStyle: CSSProperties & { '--picker-hue': string } = { '--picker-hue': hsvToHex({ h: hsv.h, s: 1, v: 1 }) }
  return (
    <div className="accent-color-picker" ref={panelRef} onKeyDown={panelKey} aria-busy={saving}>
      <header className="accent-color-picker__header">
        <span className="accent-color-picker__title"><span className="accent-color-picker__wheel" aria-hidden="true" />颜色</span>
        <button type="button" className="accent-color-picker__reset" disabled={saving || color === initialColor.current}
          title="恢复打开面板时的颜色，继续编辑"
          onClick={() => choose(initialColor.current)}>还原</button>
      </header>
      <div className="accent-color-picker__body">
        <div ref={spectrumRef} className="accent-color-picker__spectrum" role="slider" tabIndex={saving ? -1 : 0} aria-disabled={saving}
          aria-label="饱和度和亮度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(hsv.s * 100)}
          aria-valuetext={`饱和度 ${Math.round(hsv.s * 100)}%，亮度 ${Math.round(hsv.v * 100)}%`}
          aria-describedby="accent-color-picker-keyboard" style={spectrumStyle}
          onPointerDown={event => {
            if (event.button !== 0 || savingRef.current) return
            event.preventDefault()
            event.currentTarget.focus()
            event.currentTarget.setPointerCapture(event.pointerId)
            locate(event)
          }}
          onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) locate(event) }}
          onPointerUp={event => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
            locate(event)
            event.currentTarget.releasePointerCapture(event.pointerId)
            flush()
          }}
          onLostPointerCapture={flush} onPointerCancel={flush} onKeyDown={spectrumKey}>
          <span className="accent-color-picker__cursor" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: color }} />
        </div>
        <span className="accent-color-picker__sr-only" id="accent-color-picker-keyboard">左右方向键调整饱和度，上下方向键调整亮度。按住 Shift 可加大步幅。</span>
        <div className="accent-color-picker__hue-row">
          <span className="accent-color-picker__sample" aria-label={`当前颜色 ${color}`} style={{ background: color }} />
          <input className="accent-color-picker__hue" type="range" min={0} max={360} step={1} value={hsv.h} disabled={saving}
            aria-label="色相" aria-valuetext={`${Math.round(hsv.h)} 度`}
            onChange={event => chooseHsv({ ...hueRef.current, h: Number(event.target.value) }, true)}
            onPointerUp={flush} onKeyUp={flush} onBlur={flush} />
          {EyeDropper && <button type="button" className="accent-color-picker__eyedropper" aria-label="从屏幕取色" title="从屏幕取色"
            disabled={sampling || saving} onClick={() => void sampleScreen()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m14 5 5 5M13 7l4 4M15 3l6 6-3 3-1-1-9 9H4v-4l9-9-1-1 3-3Z" />
            </svg>
          </button>}
        </div>
        <label className="accent-color-picker__hex-field">
          <span>HEX</span>
          <input type="text" aria-label="自定义强调色色值" value={hex} spellCheck={false} autoComplete="off" disabled={saving}
            aria-invalid={invalid === 'hex'} aria-describedby={error ? 'accent-color-picker-error' : undefined}
            onChange={event => { setHex(event.target.value); setInvalid(null); setError('') }} onBlur={applyHex}
            onKeyDown={event => { restoreDraft(event); if (event.key === 'Enter') { event.preventDefault(); applyHex() } }} />
          <span className="accent-color-picker__color-space">sRGB</span>
        </label>
        <div className="accent-color-picker__rgb">
          {CHANNELS.map(({ key, label, caption }) => <label key={key} className="accent-color-picker__channel">
            <span>{caption}</span>
            <input type="number" min={0} max={255} step={1} inputMode="numeric" aria-label={label} disabled={saving}
              aria-invalid={invalid === 'rgb'} aria-describedby={error ? 'accent-color-picker-error' : undefined}
              value={rgb[key]} onChange={event => { setRgb({ ...rgb, [key]: event.target.value }); setInvalid(null); setError('') }}
              onBlur={applyRgb} onKeyDown={event => { restoreDraft(event); if (event.key === 'Enter') { event.preventDefault(); applyRgb() } }} />
          </label>)}
        </div>
        <div className="accent-color-picker__palette">
          <span className="accent-color-picker__label">常用颜色</span>
          <div className="accent-color-picker__swatches">
            {PALETTE.map(item => <button type="button" key={item.color} className={`accent-color-picker__swatch${item.color === color ? ' is-selected' : ''}`}
              aria-label={`选择${item.label}`} aria-pressed={item.color === color} title={item.label} disabled={saving}
              onClick={() => choose(item.color)}>
              <span style={{ background: item.color }}>{item.color === color && <Icon name="check" size={12} />}</span>
            </button>)}
          </div>
        </div>
        {error && <p className="accent-color-picker__error" id="accent-color-picker-error" role="alert">{error}</p>}
      </div>
      <footer className="accent-color-picker__footer">
        <span><Icon name={error ? 'warning' : 'check'} size={12} />{error ? '尚未保存' : saving ? '正在保存…' : waitingToApply ? '停顿后预览' : color === initialColor.current ? '未修改' : '预览中，完成后保存'}</span>
        <button type="button" className="accent-color-picker__done" aria-label="完成颜色选择" disabled={saving || Boolean(invalid)} onClick={() => void confirm()}>完成</button>
      </footer>
    </div>
  )
}
