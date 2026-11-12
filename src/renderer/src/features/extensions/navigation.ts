let request: { pageId: string; sessionId?: string; revision: number } | null = null
const listeners = new Set<() => void>()
export function requestExtensionPage(pageId: string, sessionId?: string): void {
  request = { pageId, sessionId, revision: (request?.revision ?? 0) + 1 }
  for (const listener of listeners) listener()
}
export const getExtensionNavigationRequest = (): typeof request => request
export function subscribeExtensionNavigation(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) }
