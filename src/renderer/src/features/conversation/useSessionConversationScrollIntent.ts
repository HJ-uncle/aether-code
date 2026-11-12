import { useCallback, useEffect, useRef, type HTMLAttributes, type RefObject } from 'react'
import { sessionConversationAwayFromBottom } from './conversation-scroll'

/** A nested log/editor owns its scrolling; portals also bubble React events here. */
function ownsScroll(container: HTMLElement, target: EventTarget | null, delta: number): boolean {
  if (!(target instanceof Element) || !container.contains(target)) return false
  for (let node: Element | null = target; node && node !== container; node = node.parentElement) {
    if (node.scrollHeight <= node.clientHeight + 2 || !/auto|scroll/.test(getComputedStyle(node).overflowY)) continue
    if (delta < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 2) return false
    if (getComputedStyle(node).overscrollBehaviorY !== 'auto') return false
  }
  return true
}

/** Layout changes must not overwrite the user's choice to follow or read. */
export function useSessionConversationScrollIntent(
  scrollRef: RefObject<HTMLDivElement | null>,
  pause: () => void,
  resume: () => void,
  measure: () => boolean | null
) {
  const gesture = useRef<{ direction: number; top: number; until: number } | null>(null)
  const pointer = useRef<{ id: number; y: number; scrollbar: boolean } | null>(null)
  const reset = useCallback((): void => { gesture.current = null; pointer.current = null }, [])
  const begin = (delta: number): void => {
    const element = scrollRef.current
    if (!element || !delta) return
    if (delta < 0 && element.scrollTop > 0) pause()
    gesture.current = { direction: delta, top: element.scrollTop, until: performance.now() + 1000 }
    // A downward gesture at the bottom can resume after inspecting a disclosure,
    // even when Chromium has no further distance to scroll and emits no event.
    if (delta > 0 && sessionConversationAwayFromBottom(element) === false) resume()
  }
  useEffect(() => {
    const release = (event: PointerEvent): void => {
      const drag = pointer.current
      if (!drag || drag.id !== event.pointerId) return
      pointer.current = null
      if (gesture.current) gesture.current.until = performance.now() + 1000
      if (drag.scrollbar && scrollRef.current && sessionConversationAwayFromBottom(scrollRef.current) === false) resume()
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      window.removeEventListener('blur', reset)
    }
  }, [scrollRef, resume, reset])

  const handlers: HTMLAttributes<HTMLDivElement> = {
    onWheelCapture(event) {
      if (!event.ctrlKey && !event.shiftKey && ownsScroll(event.currentTarget, event.target, event.deltaY)) begin(event.deltaY)
    },
    onPointerDownCapture(event) {
      reset()
      const element = event.currentTarget
      if (!(event.target instanceof Element) || !element.contains(event.target)) return
      const scrollbar = event.button === 0 && element.scrollHeight > element.clientHeight + 2 &&
        event.clientX - element.getBoundingClientRect().left >= element.clientWidth
      if (event.pointerType === 'touch' || scrollbar) pointer.current = { id: event.pointerId, y: event.clientY, scrollbar }
      if (scrollbar) {
        pause()
        gesture.current = { direction: 0, top: element.scrollTop, until: Infinity }
      }
    },
    onPointerMoveCapture(event) {
      const drag = pointer.current
      if (!drag || drag.id !== event.pointerId || drag.scrollbar) return
      const delta = drag.y - event.clientY
      if (Math.abs(delta) < 3) return
      drag.y = event.clientY
      if (ownsScroll(event.currentTarget, event.target, delta)) begin(delta)
    },
    onKeyDownCapture(event) {
      if (event.nativeEvent.isComposing) return
      if (!(event.target instanceof Element) || event.target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="listbox"], [role="menu"], [role="slider"]')) return
      if (event.key === ' ' && event.target.closest('button, summary, a, [role="button"]')) return
      const delta = ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey ? -1
        : ['ArrowDown', 'PageDown', 'End', ' '].includes(event.key) ? 1 : 0
      if (delta && ownsScroll(event.currentTarget, event.target, delta)) begin(delta)
    },
    onScroll(event) {
      if (event.target !== event.currentTarget) return
      const away = measure(), intent = gesture.current, top = event.currentTarget.scrollTop
      if (!intent || performance.now() > intent.until) return
      if (top < intent.top && intent.direction === 0) pause()
      if (top > intent.top && intent.direction >= 0 && away === false) resume()
      intent.top = top
    }
  }
  return { handlers, reset }
}
