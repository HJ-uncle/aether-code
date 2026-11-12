import { type JSX, useRef, useEffect } from 'react'
import { sessionPaneRatio, sessionSplitRatio } from '../features/sessions/view-performance'

export function SessionDivider({
  ratio,
  setRatio
}: {
  ratio: number
  setRatio: (ratio: number) => void
}): JSX.Element {
  const drag = useRef<{ element: HTMLDivElement; parent: HTMLElement; startX: number; startRatio: number; width: number; next: number } | null>(null)
  const frame = useRef<number | null>(null)
  const paint = (): void => {
    const current = drag.current
    if (!current) return
    current.parent.style.setProperty('--work-conversation-ratio', `${current.next}%`)
    current.element.setAttribute('aria-valuenow', String(Math.round(current.next)))
  }
  const finish = (commit: boolean): void => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    const current = drag.current
    if (!current) return
    if (commit) {
      paint()
      setRatio(current.next)
    } else {
      current.parent.style.setProperty('--work-conversation-ratio', `${current.startRatio}%`)
      current.element.setAttribute('aria-valuenow', String(Math.round(current.startRatio)))
    }
    drag.current = null
  }
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
  }, [])
  return (
    <div
      className="work-divider"
      role="separator"
      aria-label="调整对话与工作区宽度"
      aria-orientation="vertical"
      aria-valuemin={35}
      aria-valuemax={62}
      aria-valuenow={Math.round(ratio)}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          setRatio(sessionPaneRatio(ratio, 0, event.key === 'ArrowLeft' ? -2 : 2, 100))
        }
      }}
      onPointerDown={(event) => {
        event.preventDefault()
        const parent = event.currentTarget.parentElement
        if (!parent) return
        // Measure once; pointer moves paint locally instead of rerendering both panes.
        drag.current = { element: event.currentTarget, parent, startX: event.clientX, startRatio: ratio, width: parent.clientWidth, next: ratio }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const current = drag.current
        if (!current) return
        current.next = sessionPaneRatio(current.startRatio, current.startX, event.clientX, current.width)
        if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; paint() })
      }}
      onPointerUp={(event) => {
        const current = drag.current
        if (current) current.next = sessionPaneRatio(current.startRatio, current.startX, event.clientX, current.width)
        finish(true)
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => finish(false)}
    />
  )
}

export function SessionPanelDivider({
  ratio,
  setRatio,
  label,
  min = 20,
  max = 60
}: {
  ratio: number
  setRatio: (ratio: number) => void
  label: string
  min?: number
  max?: number
}): JSX.Element {
  const drag = useRef<{ element: HTMLDivElement; parent: HTMLElement; startX: number; startRatio: number; width: number; next: number } | null>(null)
  const frame = useRef<number | null>(null)
  const paint = (): void => {
    const current = drag.current
    if (!current) return
    current.element.setAttribute('aria-valuenow', String(Math.round(current.next)))
    current.parent.style.setProperty('--work-panel-split-ratio', `${current.next}%`)
  }
  const finish = (commit: boolean): void => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    const current = drag.current
    if (!current) return
    if (commit) {
      paint()
      setRatio(current.next)
    } else {
      current.parent.style.setProperty('--work-panel-split-ratio', `${current.startRatio}%`)
      current.element.setAttribute('aria-valuenow', String(Math.round(current.startRatio)))
    }
    drag.current = null
  }
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
  }, [])
  return (
    <div
      className="work-panel-divider"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(ratio)}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const delta = event.key === 'ArrowLeft' ? -2 : 2
        setRatio(Math.max(min, Math.min(max, ratio + delta)))
      }}
      onPointerDown={(event) => {
        event.preventDefault()
        const parent = event.currentTarget.parentElement
        if (!parent) return
        drag.current = { element: event.currentTarget, parent, startX: event.clientX, startRatio: ratio, width: parent.clientWidth, next: ratio }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const current = drag.current
        if (!current) return
        current.next = sessionSplitRatio(current.startRatio, current.startX, event.clientX, current.width, min, max)
        if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; paint() })
      }}
      onPointerUp={(event) => {
        const current = drag.current
        if (current) current.next = sessionSplitRatio(current.startRatio, current.startX, event.clientX, current.width, min, max)
        finish(true)
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => finish(false)}
    />
  )
}
