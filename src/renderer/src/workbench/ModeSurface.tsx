import { useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import type { AppMode } from '@renderer/core/platform/app-mode'

/** 两个工作台常驻，退出层立即 inert；动画仅改变呈现，不延迟真实模式提交。 */
export function ModeSurface({
  mode,
  active,
  children
}: {
  mode: AppMode
  active: boolean
  children: ReactNode
}): JSX.Element {
  const previous = useRef(active)
  const [exiting, setExiting] = useState(false)
  useLayoutEffect(() => {
    const leaving = previous.current && !active
    previous.current = active
    setExiting(leaving && !matchMedia('(prefers-reduced-motion: reduce)').matches)
    if (!leaving) return
    const timer = window.setTimeout(() => setExiting(false), 220)
    return () => window.clearTimeout(timer)
  }, [active])
  return (
    <section
      id={`mode-${mode}`}
      role="tabpanel"
      aria-labelledby={`mode-tab-${mode}`}
      className={`mode-surface${active ? ' is-active' : exiting ? ' is-exiting' : ''}`}
      data-mode={mode}
      hidden={!active && !exiting}
      aria-hidden={!active}
      inert={!active}
    >
      {children}
    </section>
  )
}
