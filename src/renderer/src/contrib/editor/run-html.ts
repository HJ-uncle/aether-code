import type { BrowserSurfaceOwner, BrowserTabState } from '@shared/browser'
import { getBrowserSurfaceOwner } from '@renderer/core/browser/presentation'
import { browserScopeKey, browserTabInScope } from '@renderer/core/browser/scope'
import { openViewToRight } from '@renderer/core/editor/editor-groups'
import { acceptBrowserTab, initializeBrowser, revealBrowserTab, selectBrowserTab } from '../browser/browser-store'

interface HtmlRunTarget { path: string; root: string; sessionId?: string }
interface HtmlRunHost {
  owner(): BrowserSurfaceOwner
  initialize(): Promise<void>
  open(target: HtmlRunTarget, owner: BrowserSurfaceOwner): Promise<BrowserTabState>
  accept(tab: BrowserTabState): void
  reveal(tab: BrowserTabState, owner: BrowserSurfaceOwner): void
}

const host: HtmlRunHost = {
  owner: getBrowserSurfaceOwner,
  initialize: initializeBrowser,
  open: ({ path, root, sessionId }, owner) => window.aether.browser.openFile(path, root, { owner, sessionId }),
  accept: acceptBrowserTab,
  reveal: (tab, owner) => {
    selectBrowserTab(tab.tabId)
    if (owner.mode === 'code') openViewToRight('browser')
    else revealBrowserTab(tab.tabId)
  }
}

/** Preserve the initiating task across saves and IPC. Select the actual file
 * returned by openFile, even when a prior browser tab is already selected. */
export async function runHtmlFile(
  target: HtmlRunTarget,
  prepare?: () => Promise<void>,
  runtime: HtmlRunHost = host
): Promise<void> {
  const owner = { ...runtime.owner() }
  const current = (): boolean => owner.generation === runtime.owner().generation &&
    browserScopeKey(owner) === browserScopeKey(runtime.owner())
  const assertCurrent = (): void => {
    if (!current()) throw new Error('会话或引擎已切换，请在当前文件中重新点击运行。')
  }
  await prepare?.()
  assertCurrent()
  await runtime.initialize()
  assertCurrent()
  const tab = await runtime.open(target, owner)
  runtime.accept(tab)
  // The native page retains its original scope if the user switches while it loads.
  if (!current()) return
  if (!browserTabInScope(tab, owner)) throw new Error('网页未关联到当前会话，请重新点击运行。')
  runtime.reveal(tab, owner)
}
