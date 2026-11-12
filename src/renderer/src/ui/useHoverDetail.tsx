import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { isTopOverlay, OverlayScope, useOverlay } from './overlay'
import './hover-detail.css'

interface HoverDetailOptions {
  enabled: boolean
  content: ReactNode
  label: string
  placement?: 'vertical' | 'side'
  preferredSide?: 'above' | 'below'
  /** Side details clear the whole owning surface, while staying aligned to the hovered row. */
  sideAnchor?: string
}

interface HoverDetailTriggerProps<T extends HTMLElement> extends Pick<HTMLAttributes<T>,
  'onPointerEnter' | 'onPointerLeave' | 'onPointerDown' | 'onFocus' | 'onBlur' | 'aria-describedby'> {
  ref: RefObject<T | null>
  'data-hover-detail-trigger': string
}

interface Position { left: number; top: number; maxHeight: number; side: 'above' | 'below' | 'left' | 'right' }
const OPEN_DELAY = 400
const CLOSE_DELAY = 160
const MARGIN = 8
const GAP = 6

/** A read-only detail surface leaves the row's click and keyboard action intact. */
export function useHoverDetail<T extends HTMLElement = HTMLButtonElement>({ enabled, content, label, placement = 'vertical', preferredSide = 'below', sideAnchor }: HoverDetailOptions): {
  triggerProps: HoverDetailTriggerProps<T>
  tooltip: ReactNode
} {
  const id = useId()
  const triggerRef = useRef<T>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerFocusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const overTrigger = useRef(false)
  const overPanel = useRef(false)
  const keyboardFocus = useRef(false)
  const pointerFocus = useRef(false)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const [phase, setPhase] = useState<'closed' | 'pending' | 'open'>('closed')
  const [position, setPosition] = useState<Position | null>(null)
  const open = enabled && phase === 'open'

  const clearOpen = useCallback(() => {
    if (openTimer.current !== null) clearTimeout(openTimer.current)
    openTimer.current = null
  }, [])
  const clearClose = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }, [])
  const close = useCallback(() => {
    clearOpen(); clearClose()
    overPanel.current = false
    keyboardFocus.current = false
    setPhase('closed')
    setPosition(null)
  }, [clearOpen, clearClose])
  const canShow = useCallback(() => {
    const anchor = triggerRef.current
    return Boolean(enabledRef.current && anchor?.isConnected && anchor.getClientRects().length &&
      !anchor.closest('[hidden], [inert], [aria-hidden="true"]') && getComputedStyle(anchor).visibility !== 'hidden')
  }, [])
  const show = useCallback(() => {
    clearOpen(); clearClose()
    if (canShow()) setPhase('open')
  }, [canShow, clearOpen, clearClose])
  const scheduleClose = useCallback(() => {
    clearOpen(); clearClose()
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null
      if (!overTrigger.current && !overPanel.current && !keyboardFocus.current) close()
    }, CLOSE_DELAY)
  }, [clearOpen, clearClose, close])

  const overlay = useOverlay({ open, panelRef, triggerRef, onClose: close,
    modal: false, initialFocus: false, restoreFocus: false, trapFocus: false })

  useEffect(() => {
    if (open && !isTopOverlay(overlay.id)) close()
  }, [open, overlay.id, overlay.isTop, close])

  const reposition = useCallback(() => {
    const anchor = triggerRef.current, panel = panelRef.current
    if (!canShow() || !anchor) { close(); return }
    if (!panel) return
    const rect = anchor.getBoundingClientRect()
    const width = window.innerWidth, height = window.innerHeight
    if (rect.bottom <= 0 || rect.top >= height || rect.right <= 0 || rect.left >= width) { close(); return }
    const below = Math.max(0, height - rect.bottom - GAP - MARGIN)
    const above = Math.max(0, rect.top - GAP - MARGIN)
    // scrollHeight retains the full content height after a short viewport has
    // constrained the panel, avoiding repeated flips between the two sides.
    const desired = Math.min(480, height * 0.6, panel.scrollHeight + panel.offsetHeight - panel.clientHeight)
    if (placement === 'side') {
      const surface = (sideAnchor ? anchor.closest(sideAnchor) : null)?.getBoundingClientRect() ?? rect
      const right = width - surface.right - GAP - MARGIN
      const left = surface.left - GAP - MARGIN
      const side = right >= panel.offsetWidth ? 'right' : left >= panel.offsetWidth ? 'left' : null
      if (side) {
        const maxHeight = Math.min(480, height * 0.6, height - MARGIN * 2)
        const panelHeight = Math.min(desired, maxHeight)
        const position: Position = {
          left: side === 'right' ? surface.right + GAP : surface.left - GAP - panel.offsetWidth,
          top: Math.max(MARGIN, Math.min(rect.top, height - panelHeight - MARGIN)),
          maxHeight,
          side
        }
        setPosition(previous => previous?.left === position.left && previous.top === position.top &&
          previous.maxHeight === maxHeight && previous.side === side ? previous : position)
        return
      }
    }
    // Long receipt lists can scroll above the row instead of covering the
    // answer below it. Flip only when even a small readable area cannot fit.
    const side = preferredSide === 'above'
      ? above >= Math.min(desired, 160) || above >= below ? 'above' : 'below'
      : below >= desired || below >= above ? 'below' : 'above'
    const maxHeight = Math.min(480, height * 0.6, side === 'below' ? below : above)
    if (maxHeight < 1) { close(); return }
    const panelHeight = Math.min(desired, maxHeight)
    const left = Math.max(MARGIN, Math.min(rect.left, width - panel.offsetWidth - MARGIN))
    const top = Math.max(MARGIN, Math.min(side === 'below' ? rect.bottom + GAP : rect.top - GAP - panelHeight,
      height - panelHeight - MARGIN))
    setPosition(previous => previous?.left === left && previous.top === top && previous.maxHeight === maxHeight && previous.side === side
      ? previous : { left, top, maxHeight, side })
  }, [canShow, close, placement, preferredSide, sideAnchor])

  useLayoutEffect(() => {
    if (!open) return
    reposition()
    const anchor = triggerRef.current, panel = panelRef.current
    const resize = new ResizeObserver(reposition)
    if (anchor) resize.observe(anchor)
    if (panel) resize.observe(panel)
    const surface = sideAnchor ? anchor?.closest(sideAnchor) : null
    if (surface) resize.observe(surface)
    const visibility = new MutationObserver(reposition)
    for (let ancestor: HTMLElement | null = anchor; ancestor; ancestor = ancestor.parentElement)
      visibility.observe(ancestor, { attributes: true, attributeFilter: ['hidden', 'inert', 'aria-hidden', 'style', 'class'] })
    window.addEventListener('resize', reposition)
    return () => { resize.disconnect(); visibility.disconnect(); window.removeEventListener('resize', reposition) }
  }, [open, reposition, sideAnchor])

  useEffect(() => {
    if (!enabled || phase === 'closed') return
    const onScroll = (event: Event): void => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return
      close()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (phase === 'pending' && event.key === 'Escape' && !event.isComposing) close()
    }
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', close)
    }
  }, [enabled, phase, close])

  useEffect(() => { if (!enabled) close() }, [enabled, close])
  useEffect(() => () => {
    clearOpen(); clearClose()
    if (pointerFocusTimer.current !== null) clearTimeout(pointerFocusTimer.current)
  }, [clearOpen, clearClose])

  const triggerProps: HoverDetailTriggerProps<T> = {
    ref: triggerRef,
    'data-hover-detail-trigger': id,
    'aria-describedby': open ? id : undefined,
    onPointerEnter: event => {
      if (event.pointerType === 'touch' || !enabled) return
      overTrigger.current = true
      clearClose()
      if (open) return
      clearOpen()
      setPhase('pending')
      openTimer.current = setTimeout(() => {
        openTimer.current = null
        if (overTrigger.current || keyboardFocus.current) show()
      }, OPEN_DELAY)
    },
    onPointerLeave: event => {
      overTrigger.current = false
      if (event.relatedTarget instanceof Node && panelRef.current?.contains(event.relatedTarget)) { clearOpen(); return }
      scheduleClose()
    },
    onPointerDown: () => {
      pointerFocus.current = true
      if (pointerFocusTimer.current !== null) clearTimeout(pointerFocusTimer.current)
      // Suppress only the browser's focus caused by this pointer event, even
      // when clicking an already-focused button produces no new focus event.
      pointerFocusTimer.current = setTimeout(() => {
        pointerFocus.current = false
        pointerFocusTimer.current = null
      }, 0)
      keyboardFocus.current = false
      close()
    },
    onFocus: event => {
      keyboardFocus.current = !pointerFocus.current && event.currentTarget.matches(':focus-visible')
      pointerFocus.current = false
      if (keyboardFocus.current) show()
    },
    onBlur: event => {
      keyboardFocus.current = false
      pointerFocus.current = false
      // Clicking non-focusable tooltip text can focus body. Let that selection
      // finish, while a real focus move to another control dismisses the detail.
      if (event.relatedTarget instanceof Node && panelRef.current?.contains(event.relatedTarget)) return
      if (overPanel.current && (!event.relatedTarget || event.relatedTarget === document.body)) return
      close()
    }
  }

  const tooltip = open ? createPortal(<OverlayScope id={overlay.id}>
    <div ref={panelRef} id={id} role="tooltip" aria-label={label} className="hover-detail" {...overlay.layerProps}
      data-hover-detail="true" data-hover-detail-label={label} data-placement={position?.side ?? 'below'}
      style={{ left: position?.left ?? 0, top: position?.top ?? 0, maxHeight: position?.maxHeight,
        zIndex: overlay.zIndex, visibility: position ? 'visible' : 'hidden' }}
      onPointerEnter={() => { overPanel.current = true; clearClose() }}
      onPointerLeave={event => {
        overPanel.current = false
        if (event.relatedTarget instanceof Node && triggerRef.current?.contains(event.relatedTarget)) return
        scheduleClose()
      }}
      onPointerDown={event => event.stopPropagation()}
      onMouseDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}>
      <div className="hover-detail__content">{content}</div>
    </div>
  </OverlayScope>, document.body) : null

  return { triggerProps, tooltip }
}
