/** Shared timing contract; CSS tokens use the same defaults. */
export const MOTION_ENTER_MS = 180
export const MOTION_EXIT_MS = 120
export const MOTION_REDUCED_QUERY = '(prefers-reduced-motion: reduce)'
export type MotionState = 'entering' | 'open' | 'closing'

/** Native inert blocks element events, but document/window capture listeners
 * must opt out while their retained surface is closing or hidden. */
export function isMotionInteractive(element: Element | null): boolean {
  return Boolean(element?.isConnected && !element.closest('[hidden], [inert], [aria-hidden="true"]'))
}

export function motionDuration(reduced: boolean, duration = MOTION_EXIT_MS): number {
  return reduced ? 0 : Math.max(0, duration)
}

export interface MotionScheduler {
  frame(callback: () => void): number
  cancelFrame(id: number): void
  delay(callback: () => void, milliseconds: number): number
  cancelDelay(id: number): void
}

/** Cleanup owns every callback, including a frame already queued before a
 * rapid reversal. A cancelled exit must never dismiss a newly opened panel. */
export function startMotionTransition(show: boolean, reduced: boolean, scheduler: MotionScheduler,
  onState: (state: MotionState) => void, onExited: () => void, exitMs = MOTION_EXIT_MS): () => void {
  let active = true
  let frame = 0, nextFrame = 0, timer = 0
  if (show) {
    onState(reduced ? 'open' : 'entering')
    if (!reduced) frame = scheduler.frame(() => {
      if (!active) return
      nextFrame = scheduler.frame(() => { if (active) onState('open') })
    })
  } else {
    onState('closing')
    if (motionDuration(reduced, exitMs) === 0) onExited()
    else timer = scheduler.delay(() => { if (active) onExited() }, exitMs)
  }
  return () => {
    active = false
    scheduler.cancelFrame(frame)
    scheduler.cancelFrame(nextFrame)
    scheduler.cancelDelay(timer)
  }
}
