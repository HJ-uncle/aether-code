import { cloneElement, isValidElement, useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type HTMLAttributes, type ReactElement, type ReactNode } from 'react'
import { MOTION_EXIT_MS, MOTION_REDUCED_QUERY, startMotionTransition, type MotionState } from './motion'

function reducedMotion(): boolean { return typeof matchMedia !== 'undefined' && matchMedia(MOTION_REDUCED_QUERY).matches }
function subscribeReducedMotion(listener: () => void): () => void {
  if (typeof matchMedia === 'undefined') return () => {}
  const media = matchMedia(MOTION_REDUCED_QUERY)
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}

export function useMotionPresence(show: boolean, options: { exitMs?: number; onExited?: () => void } = {}) {
  const reduced = useSyncExternalStore(subscribeReducedMotion, reducedMotion, () => true)
  const [mounted, setMounted] = useState(show)
  const [phase, setPhase] = useState<MotionState>(show && !reduced ? 'entering' : 'open')
  const exited = useRef(options.onExited)
  useLayoutEffect(() => { exited.current = options.onExited }, [options.onExited])
  useLayoutEffect(() => {
    if (!show && !mounted) return
    if (show) setMounted(true)
    return startMotionTransition(show, reduced, {
      // Native Window methods cannot be invoked with the scheduler as their receiver.
      frame: callback => window.requestAnimationFrame(callback),
      cancelFrame: id => window.cancelAnimationFrame(id),
      delay: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
      cancelDelay: id => window.clearTimeout(id)
    }, setPhase, () => { setMounted(false); exited.current?.() }, options.exitMs ?? MOTION_EXIT_MS)
    // mounted is intentionally not a dependency: entering updates it, while
    // only intent/preference changes may restart or cancel a transition.
  }, [show, reduced, options.exitMs])
  // Positioned portals measure during layout effects. Their very first commit
  // must already carry the entrance style, before that measurement flushes CSS.
  const state: MotionState = !show ? 'closing' : reduced ? 'open' : !mounted || phase === 'closing' ? 'entering' : phase
  return {
    present: show || (!reduced && mounted), state,
    motionProps: { 'data-motion-state': state, inert: !show || undefined, 'aria-hidden': !show || undefined }
  }
}

/** Keep this boundary mounted; conditional children are retained only while
 * exiting. asChild applies attributes to a native element without a layout box. */
export function MotionPresence({ show, axis = 'y', asChild = false, children, exitMs, onExited, ...props }: {
  show: boolean
  axis?: 'x' | 'y'
  asChild?: boolean
  children: ReactNode
  exitMs?: number
  onExited?: () => void
} & HTMLAttributes<HTMLDivElement>) {
  const presence = useMotionPresence(show, { exitMs, onExited })
  const last = useRef(children)
  useLayoutEffect(() => { if (show) last.current = children }, [show, children])
  if (!presence.present) return null
  const content = show ? children : last.current
  if (asChild && isValidElement<HTMLAttributes<HTMLElement>>(content)) {
    const element = content as ReactElement<HTMLAttributes<HTMLElement>>
    return cloneElement(element, { ...props, ...presence.motionProps, 'data-motion-axis': axis,
      className: [element.props.className, props.className].filter(Boolean).join(' ') || undefined,
      style: { ...element.props.style, ...props.style } } as HTMLAttributes<HTMLElement>)
  }
  return <div {...props} {...presence.motionProps} data-motion-axis={axis} className={['ui-motion-collapse', props.className].filter(Boolean).join(' ')}>
    <div className="ui-motion-collapse__content">{content}</div>
  </div>
}

/** For legacy conditionally mounted popups, delay only the dismissal callback.
 * Side effects such as selecting a command still run immediately. */
export function useMotionDismiss(onClose: () => void, resetKey?: unknown) {
  const [show, setShow] = useState(true)
  const closeRef = useRef(onClose)
  useLayoutEffect(() => { closeRef.current = onClose }, [onClose])
  useLayoutEffect(() => { setShow(true) }, [resetKey])
  const presence = useMotionPresence(show, { onExited: () => closeRef.current() })
  const close = useCallback(() => setShow(false), [])
  return { ...presence, show, close }
}

/** Retain the last data value for a controlled overlay's exit frame. */
export function useMotionValue<T>(value: T | null | undefined): T | null {
  const last = useRef<T | null>(value ?? null)
  useLayoutEffect(() => { if (value != null) last.current = value }, [value])
  return value ?? last.current
}
