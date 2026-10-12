import { useCallback, useEffect, useLayoutEffect, useRef, type JSX, type RefObject } from 'react'

interface ResizerProps {
  orientation: 'vertical' | 'horizontal'
  targetRef: RefObject<HTMLDivElement | null>
  size: number
  min: number
  max: number
  direction?: 1 | -1
  active?: boolean
  onResize: (size: number) => void
  ariaLabel: string
}

interface Drag {
  pointerId: number
  separator: HTMLDivElement
  target: HTMLDivElement
  property: 'width' | 'height'
  origin: number
  initial: number
  preview: number
  direction: 1 | -1
  min: number
  max: number
}

/** Preview locally so a drag does not broadcast or persist every pointer event. */
export function Resizer({
  orientation,
  targetRef,
  size,
  min,
  max,
  direction = 1,
  active = true,
  onResize,
  ariaLabel
}: ResizerProps): JSX.Element {
  const drag = useRef<Drag | null>(null)
  const frame = useRef(0)
  const latest = useRef(onResize)
  useLayoutEffect(() => {
    latest.current = onResize
  }, [onResize])

  const paint = useCallback(() => {
    frame.current = 0
    const current = drag.current
    if (!current) return
    current.target.style[current.property] = `${current.preview}px`
    current.separator.setAttribute('aria-valuenow', String(current.preview))
  }, [])

  const finish = useCallback((commit: boolean) => {
    cancelAnimationFrame(frame.current)
    frame.current = 0
    const current = drag.current
    if (!current) return
    drag.current = null
    const next = commit ? current.preview : current.initial
    current.target.style[current.property] = `${next}px`
    current.separator.setAttribute('aria-valuenow', String(next))
    if (current.separator.hasPointerCapture(current.pointerId))
      current.separator.releasePointerCapture(current.pointerId)
    if (commit && next !== current.initial) latest.current(next)
  }, [])

  useLayoutEffect(() => {
    const current = drag.current
    if (!current) return
    const property = orientation === 'vertical' ? 'width' : 'height'
    if (
      !active ||
      current.initial !== size ||
      current.property !== property ||
      current.direction !== direction ||
      current.min !== min ||
      current.max !== max ||
      current.target !== targetRef.current
    ) {
      finish(false)
      // A reset or another layout command owns the new size; cancellation must
      // not restore a stale preview over the newly committed React style.
      if (current.target === targetRef.current) current.target.style[property] = `${size}px`
      current.separator.setAttribute('aria-valuenow', String(size))
    }
  }, [active, size, orientation, direction, min, max, targetRef, finish])
  useEffect(() => {
    const cancel = (): void => finish(false)
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('blur', cancel)
      finish(false)
    }
  }, [finish])

  const update = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    const position = current.property === 'width' ? event.clientX : event.clientY
    current.preview = Math.min(
      current.max,
      Math.max(current.min, current.initial + current.direction * (position - current.origin))
    )
  }

  return (
    <div
      className={`resizer resizer--${orientation}`}
      role="separator"
      aria-label={ariaLabel}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={size}
      tabIndex={active ? 0 : -1}
      onPointerDown={(event) => {
        if (!active || event.button !== 0 || !targetRef.current) return
        event.preventDefault()
        finish(false)
        const separator = event.currentTarget
        separator.focus()
        separator.setPointerCapture(event.pointerId)
        drag.current = {
          pointerId: event.pointerId,
          separator,
          target: targetRef.current,
          property: orientation === 'vertical' ? 'width' : 'height',
          origin: orientation === 'vertical' ? event.clientX : event.clientY,
          initial: size,
          preview: size,
          direction,
          min,
          max
        }
      }}
      onPointerMove={(event) => {
        update(event)
        if (drag.current && !frame.current) frame.current = requestAnimationFrame(paint)
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return
        update(event)
        finish(true)
      }}
      onPointerCancel={(event) => {
        if (drag.current?.pointerId === event.pointerId) finish(false)
      }}
      onLostPointerCapture={(event) => {
        if (drag.current?.pointerId === event.pointerId) finish(false)
      }}
      onKeyDown={(event) => {
        if (!active) return
        if (event.key === 'Escape' && drag.current) {
          event.preventDefault()
          finish(false)
          return
        }
        const decrease = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp'
        const increase = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'
        let next: number
        if (event.key === 'Home') next = min
        else if (event.key === 'End') next = max
        else if (event.key === decrease || event.key === increase)
          next = size + direction * (event.key === decrease ? -1 : 1) * (event.shiftKey ? 50 : 10)
        else return
        event.preventDefault()
        finish(false)
        latest.current(Math.min(max, Math.max(min, next)))
      }}
    />
  )
}
