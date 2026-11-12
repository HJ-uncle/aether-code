import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'

/** Scrolling a keyboard-selected row beneath a stationary pointer is not a hover choice. */
export function usePickerPointerSelection(enabled = true) {
  const position = useRef<{ x: number; y: number } | null>(null)
  const keyboard = useRef(false)
  useEffect(() => {
    keyboard.current = false
    position.current = null
    if (!enabled) return
    const moved = (event: PointerEvent): void => {
      const previous = position.current
      if (previous && (previous.x !== event.clientX || previous.y !== event.clientY)) keyboard.current = false
      position.current = { x: event.clientX, y: event.clientY }
    }
    window.addEventListener('pointermove', moved, true)
    return () => window.removeEventListener('pointermove', moved, true)
  }, [enabled])
  const markKeyboard = useCallback((): void => { keyboard.current = true }, [])
  const canActivate = useCallback((event: ReactPointerEvent): boolean => {
    position.current ??= { x: event.clientX, y: event.clientY }
    return !keyboard.current
  }, [])
  return { markKeyboard, canActivate }
}
