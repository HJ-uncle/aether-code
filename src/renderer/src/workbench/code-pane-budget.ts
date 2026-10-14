export interface CodePaneRequest {
  width: number
  chromeWidth: number
  sidebarVisible: boolean
  sidebarWidth: number
  chatPanelVisible: boolean
  chatPanelWidth: number
}

export interface CodePaneLimits {
  sidebarMin: number
  sidebarMax: number
  chatPanelMin: number
  chatPanelMax: number
}

/** Resize preferences survive a narrow window; only an explicit drag commits a new width. */
export function codePaneBudget(request: CodePaneRequest, limits: CodePaneLimits) {
  const finiteWidth = Number.isFinite(request.width)
  const chromeWidth = Number.isFinite(request.chromeWidth) ? Math.max(0, request.chromeWidth) : 0
  const available = finiteWidth ? Math.max(0, request.width - chromeWidth) : Infinity
  const minimum = 320 + (request.sidebarVisible ? limits.sidebarMin : 0) + (request.chatPanelVisible ? limits.chatPanelMin : 0)
  // The native minimum window is 940px. Keep geometry bounded even before its
  // first measurement or if a host reports a smaller content viewport.
  const scale = Math.min(1, available / minimum)
  const mainMin = 320 * scale
  const sidebarMin = limits.sidebarMin * scale
  const chatMin = limits.chatPanelMin * scale
  const sidebarMax = Math.min(limits.sidebarMax, Math.max(sidebarMin, available - mainMin - (request.chatPanelVisible ? chatMin : 0)))
  const wantedSidebar = Number.isFinite(request.sidebarWidth) ? request.sidebarWidth : limits.sidebarMin
  const sidebarWidth = request.sidebarVisible ? Math.max(sidebarMin, Math.min(wantedSidebar, sidebarMax)) : 0
  const chatMax = Math.min(limits.chatPanelMax, Math.max(chatMin, available - mainMin - sidebarWidth))
  const wantedChat = Number.isFinite(request.chatPanelWidth) ? request.chatPanelWidth : limits.chatPanelMin
  const chatPanelWidth = request.chatPanelVisible ? Math.max(chatMin, Math.min(wantedChat, chatMax)) : 0
  return { mainMin, sidebarWidth, chatPanelWidth, sidebarMin, sidebarMax, chatMin, chatMax }
}
