import { useLayoutEffect, type RefObject } from 'react'

/** Fit inline inspectors to their conversation, including the status below them. */
export function usePendingCardBodySpace(body: RefObject<HTMLDivElement | null>, page: string | number | null): void {
  useLayoutEffect(() => {
    const content = body.current
    const card = content?.closest<HTMLElement>('.work-pending')
    const viewport = card?.closest<HTMLElement>('.work-conversation__scroll, .chat__messages')
    if (!content || !card || !viewport) return
    // Window vh alone ignores both the composer and the trailing run status;
    // following the conversation bottom would then hide the card's heading.
    const measure = (): void => {
      if (!viewport.clientHeight) return
      const cardBounds = card.getBoundingClientRect()
      const bodyBounds = content.getBoundingClientRect()
      const viewportTop = viewport.getBoundingClientRect().top + viewport.clientTop
      const tail = Math.max(0, viewport.scrollHeight - (cardBounds.bottom - viewportTop + viewport.scrollTop))
      const chrome = cardBounds.height - bodyBounds.height
      const available = `${Math.max(96, Math.floor(viewport.clientHeight - tail - chrome - 16))}px`
      if (content.style.getPropertyValue('--pending-body-space') !== available) {
        content.style.setProperty('--pending-body-space', available)
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(card)
    const flow = card.closest('.chat__turn') ?? viewport.firstElementChild
    if (flow) observer.observe(flow)
    return () => observer.disconnect()
  }, [body, page])
}
