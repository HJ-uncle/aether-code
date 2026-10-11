import { useEffect, useRef, type JSX } from 'react'
import { setBrowserSessionOverride } from '@renderer/core/browser/connection'
import { BrowserView } from '@renderer/contrib/browser/BrowserView'
import { useBrowserState } from '@renderer/contrib/browser/browser-store'
import { useAppMode } from '@renderer/core/platform/app-mode'

/**
 * The Work browser is the same native WebContentsView as Code's browser.  The
 * wrapper only changes ownership of layout bounds and the AI session identity;
 * navigation, tabs, console and network tools therefore behave identically in
 * both modes.
 */
export function WorkBrowser({
  sessionId,
  onReveal
}: {
  sessionId?: string | null
  /** Select Work's browser workspace before an AI operation waits for native bounds. */
  onReveal?: () => void
}): JSX.Element {
  const browser = useBrowserState()
  const appMode = useAppMode()
  const revealRef = useRef<string | null>(null)
  useEffect(() => {
    setBrowserSessionOverride(appMode === 'work' ? sessionId : null)
  }, [appMode, sessionId])
  useEffect(() => () => setBrowserSessionOverride(null), [])
  useEffect(() => {
    const requestId = browser.revealRequest?.requestId
    if (!requestId || revealRef.current === requestId) return
    // A reveal emitted while Code owns the native page must not unexpectedly
    // switch a hidden Work workspace when the user later changes modes.
    if (appMode !== 'work') {
      revealRef.current = requestId
      return
    }
    revealRef.current = requestId
    onReveal?.()
  }, [appMode, browser.revealRequest?.requestId, onReveal])

  return <BrowserView surfaceMode="work" />
}
