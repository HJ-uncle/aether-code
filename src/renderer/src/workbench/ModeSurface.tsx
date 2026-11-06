import { type JSX, type ReactNode } from 'react'
import { useMotionPresence } from './MotionPresence'
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
  const motion = useMotionPresence(active)
  return (
    <section
      id={`mode-${mode}`}
      role="tabpanel"
      aria-labelledby={`mode-tab-${mode}`}
      className={`mode-surface${active ? ' is-active' : motion.present ? ' is-exiting' : ''}`}
      data-mode={mode}
      {...motion.motionProps}
      aria-hidden={!active}
      hidden={!motion.present}
    >
      {children}
    </section>
  )
}
