import { useLayoutEffect, useRef, type ReactNode } from 'react'
import './work-process-panel.css'

const positions = new Map<string, { top: number; following: boolean }>()

/** Keep inspection inside its own reading area so a long run never pushes the
 * answer away. Following stops as soon as the reader interacts with the log. */
export function WorkProcessPanel({ children, running, memoryKey }: { children: ReactNode; running: boolean; memoryKey: string }) {
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const following = useRef(positions.get(memoryKey)?.following ?? running)
  const paused = useRef(!following.current)
  useLayoutEffect(() => {
    const scroll = viewport.current, body = content.current
    if (!scroll || !body) return
    const saved = positions.get(memoryKey)
    if (saved) scroll.scrollTop = saved.top
    const follow = (): void => { if (following.current) scroll.scrollTop = scroll.scrollHeight }
    const inspect = (): void => { paused.current = true; following.current = false }
    const latest = (): void => { paused.current = false; following.current = true; follow() }
    scroll.addEventListener('work-process-inspect', inspect)
    scroll.addEventListener('work-process-latest', latest)
    follow()
    const resize = new ResizeObserver(follow)
    resize.observe(body)
    return () => {
      positions.set(memoryKey, { top: scroll.scrollTop, following: following.current })
      if (positions.size > 200) positions.delete(positions.keys().next().value!)
      scroll.removeEventListener('work-process-inspect', inspect)
      scroll.removeEventListener('work-process-latest', latest)
      resize.disconnect()
    }
  }, [memoryKey])
  return <div ref={viewport} className="work-message__process-viewport" role="region" aria-label="执行过程" tabIndex={0}
    onPointerDownCapture={() => { paused.current = true; following.current = false }}
    onWheelCapture={event => { if (event.deltaY < 0) { paused.current = true; following.current = false } }}
    onKeyDownCapture={event => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) { paused.current = true; following.current = false } }}
    onScroll={event => {
      const scroll = event.currentTarget
      if (!paused.current) following.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 24
    }}>
    <div ref={content} className="work-message__process-content">{children}</div>
  </div>
}
