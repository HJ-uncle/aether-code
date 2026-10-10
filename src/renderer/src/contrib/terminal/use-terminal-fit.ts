import { useEffect, useRef, type RefObject } from 'react'
import { onTerminalPreferencesChanged } from './terminal-preferences'
import type { TerminalSession } from './terminal-store'

/** Keep the visible terminal and its PTY in sync with the panel's actual size. */
export function useTerminalFit(
  containerRef: RefObject<HTMLDivElement | null>,
  session: TerminalSession,
  active: boolean
): void {
  const lastSent = useRef<{ id: string; cols: number; rows: number } | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!active || !container) return

    let disposed = false
    let frame: number | undefined
    const scheduleFit = (): void => {
      if (disposed || frame !== undefined) return
      // Splitter dragging can emit several measurements in one frame. Fitting
      // after layout also avoids feeding the PTY a hidden tab's zero size.
      frame = window.requestAnimationFrame(() => {
        frame = undefined
        if (disposed || !container.isConnected || container.clientWidth <= 0 || container.clientHeight <= 0) return
        if (!session.term.element) return

        // DOM rendering rounds the canvas in device pixels, then derives cell
        // height from the current row count. At fractional DPR a font change can
        // therefore need another fit after resize updates those rounded metrics.
        // Bound convergence and publish only the final geometry to the PTY.
        for (let attempt = 0; attempt < 4; attempt++) {
          session.fit.fit()
          const proposed = session.fit.proposeDimensions()
          if (!proposed || (proposed.cols === session.term.cols && proposed.rows === session.term.rows)) break
        }
        const { cols, rows } = session.term
        if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return
        const previous = lastSent.current
        if (previous?.id === session.id && previous.cols === cols && previous.rows === rows) return
        session.transport.resize(cols, rows)
        lastSent.current = { id: session.id, cols, rows }
      })
    }

    const observer = new ResizeObserver(scheduleFit)
    observer.observe(container)
    // Font preferences change cell metrics without changing the host's bounds.
    const offPreferences = onTerminalPreferencesChanged(scheduleFit)
    const fonts = document.fonts
    fonts.addEventListener('loadingdone', scheduleFit)
    void fonts.ready.then(scheduleFit)
    window.addEventListener('resize', scheduleFit)
    scheduleFit()

    return () => {
      disposed = true
      observer.disconnect()
      offPreferences()
      fonts.removeEventListener('loadingdone', scheduleFit)
      window.removeEventListener('resize', scheduleFit)
      if (frame !== undefined) window.cancelAnimationFrame(frame)
    }
  }, [active, containerRef, session])
}
