import type { JSX } from 'react'
import { BrowserView } from '@renderer/features/browser/BrowserView'

/**
 * Work uses the same browser components with its own mode/session tab set.
 * WorkView owns AI identity even while this panel is closed, so opening a page
 * cannot reconnect its tools to Code's unrelated session. Navigation also
 * belongs to WorkView: remounting this surface must not replay a reveal.
 */
export function Browser({
  hideTabStrip = false,
  tabId
}: {
  hideTabStrip?: boolean
  tabId?: string
}): JSX.Element {
  return <BrowserView surfaceMode="work" hideTabStrip={hideTabStrip} tabId={tabId} />
}
