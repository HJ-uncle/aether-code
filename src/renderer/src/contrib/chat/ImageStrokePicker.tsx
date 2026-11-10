import { useCallback, useId, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { Icon } from '@renderer/workbench/icons'
import { Popover } from '@renderer/workbench/Popover'
import './image-stroke-picker.css'

const STROKES = [
  { width: 2, label: '细' },
  { width: 4, label: '中' },
  { width: 8, label: '粗' },
  { width: 12, label: '特粗' }
] as const

export function ImageStrokePicker({ value, onChange, disabled = false }: {
  value: number
  onChange: (width: number) => void
  disabled?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  if (disabled && open) setOpen(false)
  const changeOpen = useCallback((next: boolean): void => {
    if (next) setActiveIndex(Math.max(0, STROKES.findIndex(stroke => stroke.width === value)))
    setOpen(next)
  }, [value])

  useLayoutEffect(() => {
    if (!open || disabled) return
    const item = menuRef.current?.querySelector<HTMLButtonElement>(`[data-stroke-index="${activeIndex}"]`)
    if (!item) return
    let frame = 0
    const focusItem = (): void => {
      if (!item.isConnected) return
      const focused = document.activeElement
      if (focused !== triggerRef.current && !menuRef.current?.contains(focused)) return
      // A portal is hidden while its first position is measured; focus it only
      // after it is visible, without stealing focus after an outside click.
      if (getComputedStyle(item).visibility === 'hidden' || !item.getClientRects().length) {
        frame = requestAnimationFrame(focusItem)
        return
      }
      item.focus({ preventScroll: true })
    }
    focusItem()
    return () => cancelAnimationFrame(frame)
  }, [open, activeIndex, disabled])

  const closeAndFocus = (): void => {
    setOpen(false)
    triggerRef.current?.focus({ preventScroll: true })
  }
  const choose = (width: number): void => {
    onChange(width)
    closeAndFocus()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (disabled || event.nativeEvent.isComposing) return
    if (open && event.key === 'Tab') {
      // Return from the portal before allowing the normal toolbar tab order.
      closeAndFocus()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape'].includes(event.key)) return
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        changeOpen(true)
      }
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') closeAndFocus()
    else if (event.key === 'ArrowDown') setActiveIndex(index => (index + 1) % STROKES.length)
    else if (event.key === 'ArrowUp') setActiveIndex(index => (index + STROKES.length - 1) % STROKES.length)
    else if (event.key === 'Home' || event.key === 'End') setActiveIndex(event.key === 'Home' ? 0 : STROKES.length - 1)
    else choose(STROKES[activeIndex].width)
  }

  return (
    <Popover
      className="image-stroke-picker"
      panelClassName="image-stroke-picker__panel"
      label="选择标注粗细"
      placement="up"
      width={212}
      flush
      disabled={disabled}
      open={open}
      onOpenChange={changeOpen}
      trigger={() => (
        <button
          ref={triggerRef}
          type="button"
          className="image-stroke-picker__trigger"
          aria-label="标注粗细"
          title={`标注粗细：${value} px`}
          aria-haspopup="menu"
          aria-expanded={open && !disabled}
          aria-controls={open && !disabled ? menuId : undefined}
          disabled={disabled}
          onKeyDown={onKeyDown}
        >
          <span className="image-stroke-picker__sample" aria-hidden="true"><span style={{ height: value }} /></span>
          <span className="image-stroke-picker__value">{value}<span> px</span></span>
          <Icon name="chevron" size={12} className="image-stroke-picker__caret" />
        </button>
      )}
    >
      <div ref={menuRef} id={menuId} className="image-stroke-picker__menu" role="menu" aria-label="标注粗细" onKeyDown={onKeyDown}>
        {STROKES.map((stroke, index) => (
          <button
            key={stroke.width}
            type="button"
            role="menuitemradio"
            aria-label={`${stroke.label}，${stroke.width} px`}
            aria-checked={stroke.width === value}
            data-stroke-index={index}
            tabIndex={index === activeIndex ? 0 : -1}
            className="image-stroke-picker__option"
            onFocus={() => setActiveIndex(index)}
            onClick={() => choose(stroke.width)}
          >
            <span className="image-stroke-picker__sample" aria-hidden="true"><span style={{ height: stroke.width }} /></span>
            <span className="image-stroke-picker__label">{stroke.label}</span>
            <span className="image-stroke-picker__value">{stroke.width}<span> px</span></span>
            <span className="image-stroke-picker__check" aria-hidden="true">{stroke.width === value ? <Icon name="check" size={14} /> : null}</span>
          </button>
        ))}
      </div>
    </Popover>
  )
}
