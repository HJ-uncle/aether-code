import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react'
import './work-process-panel.css'

const positions = new Map<string, { top: number; following: boolean }>()

/** Keep inspection inside its own reading area so a long run never pushes the
 * answer away. Following stops as soon as the reader interacts with the log. */
export function WorkProcessPanel({ children, running, memoryKey }: { children: ReactNode; running: boolean; memoryKey: string }) {
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const following = useRef(positions.get(memoryKey)?.following ?? running)
  const paused = useRef(!following.current)
  const restoreTop = useRef<number | null>(null)
  const firstFrame = useRef(0)
  const cancelPositioning = useCallback((): void => {
    restoreTop.current = null
    cancelAnimationFrame(firstFrame.current)
    firstFrame.current = 0
  }, [])
  const inspect = useCallback((): void => {
    cancelPositioning()
    paused.current = true
    following.current = false
  }, [cancelPositioning])
  useLayoutEffect(() => {
    const scroll = viewport.current, body = content.current
    if (!scroll || !body) return
    let frame = 0
    const update = (): void => {
      frame = 0
      const maximum = Math.max(0, scroll.scrollHeight - scroll.clientHeight)
      const offset = Math.max(0, Math.min(scroll.scrollTop, maximum))
      // Fractional scrolling and display scaling can leave a subpixel remainder
      // at the boundary. It should not leave a hint for nonexistent content.
      const top = scroll.clientHeight > 0 && offset > 1
      const bottom = scroll.clientHeight > 0 && maximum - offset > 1
      const edges = top && bottom ? 'both' : top ? 'top' : bottom ? 'bottom' : ''
      if (edges !== (scroll.dataset.scrollEdges ?? '')) {
        if (edges) scroll.dataset.scrollEdges = edges
        else delete scroll.dataset.scrollEdges
      }
      // Fade only the receipts; the native scrollbar remains fully visible.
      const gutter = `${scroll.offsetWidth - scroll.clientWidth}px`
      if (scroll.style.getPropertyValue('--work-process-scrollbar-gutter') !== gutter)
        scroll.style.setProperty('--work-process-scrollbar-gutter', gutter)
    }
    const schedule = (): void => { if (!frame) frame = requestAnimationFrame(update) }
    const resize = new ResizeObserver(schedule)
    resize.observe(scroll)
    resize.observe(body)
    scroll.addEventListener('scroll', schedule, { passive: true })
    update()
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      scroll.removeEventListener('scroll', schedule)
    }
  }, [memoryKey])
  useLayoutEffect(() => {
    const scroll = viewport.current, body = content.current
    if (!scroll || !body) return
    const saved = positions.get(memoryKey)
    following.current = saved?.following ?? running
    paused.current = !following.current
    restoreTop.current = saved && !following.current ? saved.top : null
    const position = (): void => {
      if (following.current) scroll.scrollTop = scroll.scrollHeight
      else if (restoreTop.current !== null) {
        // Nested disclosures mount at zero height. Retain the requested offset
        // until their entrance layout can actually represent it, instead of
        // remembering the browser's temporary clamp to the top as a user choice.
        scroll.scrollTop = restoreTop.current
        if (scroll.clientHeight > 0 && Math.abs(scroll.scrollTop - restoreTop.current) <= 1)
          restoreTop.current = null
      }
    }
    const first = (): void => {
      inspect()
      scroll.scrollTop = 0
      // Paging replaces the receipts on the next React commit; align the new
      // first page after that replacement, without resuming live following.
      firstFrame.current = requestAnimationFrame(() => { scroll.scrollTop = 0; firstFrame.current = 0 })
    }
    const latest = (): void => { cancelPositioning(); paused.current = false; following.current = true; position() }
    scroll.addEventListener('work-process-inspect', inspect)
    scroll.addEventListener('work-process-first', first)
    scroll.addEventListener('work-process-latest', latest)
    position()
    const resize = new ResizeObserver(position)
    resize.observe(body)
    resize.observe(scroll)
    return () => {
      positions.set(memoryKey, { top: restoreTop.current ?? scroll.scrollTop, following: following.current })
      if (positions.size > 200) positions.delete(positions.keys().next().value!)
      cancelPositioning()
      scroll.removeEventListener('work-process-inspect', inspect)
      scroll.removeEventListener('work-process-first', first)
      scroll.removeEventListener('work-process-latest', latest)
      resize.disconnect()
    }
  }, [memoryKey, running, cancelPositioning, inspect])
  return <div ref={viewport} className="work-message__process-viewport" role="region" aria-label="执行过程" tabIndex={0}
    onPointerDownCapture={inspect}
    onWheelCapture={event => { if (event.deltaY < 0) inspect(); else if (event.deltaY) cancelPositioning() }}
    onKeyDownCapture={event => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) inspect()
      else if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) cancelPositioning()
    }}
    onScroll={event => {
      const scroll = event.currentTarget
      if (!paused.current) following.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 24
    }}>
    <div ref={content} className="work-message__process-content">{children}</div>
  </div>
}
