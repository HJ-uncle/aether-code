import type { BrowserEvent, BrowserSurfaceOwner, BrowserTabState } from '@shared/browser'

type Scope = Pick<BrowserSurfaceOwner, 'mode' | 'sessionId' | 'engineId' | 'pendingSourceId'>
export const browserScopeKey = (scope: Scope): string => JSON.stringify([scope.mode, scope.sessionId ?? null, scope.engineId ?? null, scope.pendingSourceId ?? null])
export const browserPendingSourceId = (mode: 'embedded' | 'remote', endpoint: string, accountId?: string | null): string =>
  JSON.stringify([mode, mode === 'remote' ? endpoint.trim().replace(/\/+$/, '') : '', accountId ?? null])

export function browserTabInScope(tab: BrowserTabState, scope: Scope): boolean {
  return !!tab.presentation && browserScopeKey(tab.presentation) === browserScopeKey(scope)
}

interface Selection {
  activeTabId: string | null
  addressFocusRequest: number
  revealRequest: { tabId: string; requestId: string } | null
}
const emptySelection = (): Selection => ({ activeTabId: null, addressFocusRequest: 0, revealRequest: null })

/** Pages have independent native lifetimes; their selection belongs to one
 * mode, engine and session. Background events cannot select a foreign page. */
export class BrowserScopeRegistry {
  private tabs: BrowserTabState[] = []
  private readonly selections = new Map<string, Selection>()

  replace(tabs: BrowserTabState[], observed = new Set<string>()): void {
    const current = new Map(this.tabs.map(tab => [tab.tabId, tab]))
    const next = tabs.flatMap(tab => observed.has(tab.tabId) ? current.has(tab.tabId) ? [current.get(tab.tabId)!] : [] : [tab])
    const ids = new Set(next.map(tab => tab.tabId))
    for (const tab of this.tabs) if (observed.has(tab.tabId) && !ids.has(tab.tabId)) next.push(tab)
    this.tabs = next
  }

  view(scope: Scope): Selection & { tabs: BrowserTabState[] } {
    const tabs = this.tabs.filter(tab => browserTabInScope(tab, scope))
    const selected = this.selections.get(browserScopeKey(scope)) ?? emptySelection()
    return { ...selected, tabs,
      activeTabId: tabs.some(tab => tab.tabId === selected.activeTabId) ? selected.activeTabId : tabs[0]?.tabId ?? null,
      revealRequest: selected.revealRequest && tabs.some(tab => tab.tabId === selected.revealRequest?.tabId) ? selected.revealRequest : null }
  }

  select(tabId: string, scope: Scope): boolean {
    if (!this.tabs.some(tab => tab.tabId === tabId && browserTabInScope(tab, scope))) return false
    const key = browserScopeKey(scope)
    this.selections.set(key, { ...(this.selections.get(key) ?? emptySelection()), activeTabId: tabId })
    return true
  }

  receive(event: BrowserEvent): BrowserTabState | undefined {
    const previous = this.tabs.find(tab => tab.tabId === event.tabId)
    const tab = 'tab' in event ? event.tab : previous
    if (event.type === 'closed') this.tabs = this.tabs.filter(item => item.tabId !== event.tabId)
    else if ('tab' in event) this.tabs = previous ? this.tabs.map(item => item.tabId === event.tabId ? event.tab : item) : [...this.tabs, event.tab]
    if (!tab?.presentation) return tab
    const key = browserScopeKey(tab.presentation), selected = this.selections.get(key) ?? emptySelection()
    if (event.type === 'changed' && previous?.presentation && !previous.presentation.engineId && tab.presentation.engineId &&
      previous.presentation.mode === tab.presentation.mode && previous.presentation.sessionId === tab.presentation.sessionId) {
      const pending = this.selections.get(browserScopeKey(previous.presentation))
      if (pending?.activeTabId === tab.tabId) this.selections.set(key, { ...pending })
    }
    if (event.type === 'closed') {
      const siblings = this.tabs.filter(item => browserTabInScope(item, tab.presentation!))
      this.selections.set(key, { ...selected,
        activeTabId: selected.activeTabId === event.tabId ? siblings[0]?.tabId ?? null : selected.activeTabId,
        revealRequest: selected.revealRequest?.tabId === event.tabId ? null : selected.revealRequest })
    } else if (event.type !== 'changed') {
      this.selections.set(key, { ...selected, activeTabId: event.tabId,
        ...(event.type === 'reveal' ? { revealRequest: { tabId: event.tabId, requestId: event.requestId } } : {}),
        ...(event.type === 'focus-address' ? { addressFocusRequest: selected.addressFocusRequest + 1 } : {}) })
    }
    return tab
  }
}
