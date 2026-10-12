import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/** Completion keeps focus in its editor, but its menu must escape editor/scroll clipping. */
export function CompletionPopover({ anchorRef, children, onClose, className = '' }: {
  anchorRef: RefObject<HTMLElement | null>
  children: ReactNode
  onClose: () => void
  className?: string
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (!anchor || !panel) return
    const place = (): void => {
      if (!anchor.isConnected || anchor.closest('[hidden], [inert]') || !anchor.getClientRects().length) {
        closeRef.current()
        return
      }
      const rect = anchor.getBoundingClientRect()
      const margin = 8, gap = 6
      // Keep the app chrome available even in a short window. Prefer the side
      // with enough space, then bound the list rather than covering the editor.
      const topInset = Math.max(margin, document.querySelector('.menu-bar')?.getBoundingClientRect().bottom ?? margin)
      const bottomInset = innerHeight - margin
      let visibleTop = topInset, visibleBottom = bottomInset, visibleLeft = margin, visibleRight = innerWidth - margin
      // A connected editor may have scrolled out of its clipping ancestors.
      // Keeping its portal alive would leave an invisible menu owning Enter/Tab.
      for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect()
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { visibleTop = Math.max(visibleTop, bounds.top); visibleBottom = Math.min(visibleBottom, bounds.bottom) }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { visibleLeft = Math.max(visibleLeft, bounds.left); visibleRight = Math.min(visibleRight, bounds.right) }
      }
      if (rect.bottom <= visibleTop || rect.top >= visibleBottom || rect.right <= visibleLeft || rect.left >= visibleRight) {
        closeRef.current()
        return
      }
      const anchorTop = Math.min(bottomInset, Math.max(topInset, rect.top))
      const anchorBottom = Math.max(topInset, Math.min(bottomInset, rect.bottom))
      const above = Math.max(0, anchorTop - topInset - gap)
      const below = Math.max(0, bottomInset - anchorBottom - gap)
      const up = above >= Math.min(300, panel.scrollHeight) || above >= below
      if ((up ? above : below) < 1) { closeRef.current(); return }
      const maxHeight = Math.max(1, Math.min(300, up ? above : below))
      const width = Math.min(430, rect.width, innerWidth - margin * 2)
      const next: CSSProperties = {
        position: 'fixed', width, maxHeight,
        left: Math.max(margin, Math.min(rect.left, innerWidth - width - margin)),
        ...(up ? { bottom: innerHeight - anchorTop + gap } : { top: anchorBottom + gap }),
        visibility: 'visible'
      }
      setPosition(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(anchor)
    observer.observe(panel)
    const outside = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && !anchor.contains(target) && !panel.contains(target)) closeRef.current()
    }
    // The editor intentionally keeps focus while a completion is open, so the
    // document-level Escape handler belongs to the portal rather than the
    // contentEditable. Capture it before editor handlers can consume it and
    // release the portal immediately.
    const keydown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeRef.current()
    }
    const scroll = (event: Event): void => {
      if (event.target instanceof Node && panel.contains(event.target)) return
      place()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', keydown, true)
    document.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', keydown, true)
      document.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', place)
    }
  }, [anchorRef])
  return createPortal(<div ref={panelRef} className={`completion-popover ${className}`} style={position}>{children}</div>, document.body)
}
