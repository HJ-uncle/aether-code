/**
 * 拖拽分隔条
 *
 * 布局里唯一需要直接监听鼠标的地方。用 pointer events 而不是 mousemove：
 * 拖拽时指针可能移出窗口或被其它元素捕获，pointer capture 能稳定收尾。
 */
import { useCallback, useRef, type JSX } from 'react'

interface ResizerProps {
  orientation: 'vertical' | 'horizontal'
  onDelta: (delta: number) => void
  /** 按下时用于计算增量基准 */
  ariaLabel: string
}

export function Resizer({ orientation, onDelta, ariaLabel }: ResizerProps): JSX.Element {
  // 用 ref 存上次位置，避免每次移动都触发重渲染
  const lastRef = useRef<number | null>(null)

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const target = event.currentTarget
      target.setPointerCapture(event.pointerId)
      lastRef.current = orientation === 'vertical' ? event.clientX : event.clientY
    },
    [orientation]
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (lastRef.current === null) return
      const current = orientation === 'vertical' ? event.clientX : event.clientY
      const delta = current - lastRef.current
      if (delta === 0) return
      lastRef.current = current
      onDelta(delta)
    },
    [onDelta, orientation]
  )

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    lastRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }, [])

  return (
    <div
      className={`resizer resizer--${orientation}`}
      role="separator"
      aria-label={ariaLabel}
      aria-orientation={orientation}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    />
  )
}
