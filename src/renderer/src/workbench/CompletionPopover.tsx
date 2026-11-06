import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useMotionPresence, useMotionValue } from './MotionPresence'
import { OverlayScope, useOverlay } from './overlay'

/** Completion keeps focus in its editor, but its menu must escape editor/scroll clipping. */
export function CompletionPopover({ anchorRef, children, onClose, className = '', open }: {
  anchorRef: RefObject<HTMLElement | null>
  children: ReactNode
  onClose: () => void
  className?: string
  open?: boolean
}) {
  const [dismissed, setDismissed] = useState(false)
  const show = open ?? !dismissed
  const motion = useMotionPresence(show, { onExited: () => { if (open === undefined) onClose() } })
  const shownChildren = useMotionValue(show ? children : null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = () => { if (open === undefined) setDismissed(true); else onClose() }
  const overlay = useOverlay({ open: show, present: motion.present, panelRef, triggerRef: anchorRef,
    onClose: () => closeRef.current(), restoreFocus: false })
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  useLayoutEffect(() => {
    if (!show) return
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
    const scroll = (event: Event): void => {
      if (event.target instanceof Node && panel.contains(event.target)) return
      place()
    }
    document.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      document.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', place)
    }
  }, [anchorRef, show])
  if (!motion.present) return null
  return createPortal(<OverlayScope id={overlay.id}><div ref={panelRef} {...motion.motionProps} {...overlay.layerProps} data-motion-axis="y" className={`completion-popover ${className}`} style={{ ...position, zIndex: overlay.zIndex }}>{shownChildren}</div></OverlayScope>, document.body)
}
