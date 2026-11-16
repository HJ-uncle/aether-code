import type { ExtensionContext } from './types'
import { getEngineSource } from '@renderer/core/engine/source'
let request: { pageId: string; sessionId?: string; revision: number; context?: ExtensionContext; source: number } | null = null
const listeners = new Set<() => void>()
export function requestExtensionPage(pageId: string, sessionId?: string, context?: ExtensionContext): void {
  request = { pageId, sessionId, context: context ? { ...context } : undefined, source: getEngineSource(), revision: (request?.revision ?? 0) + 1 }
  for (const listener of listeners) listener()
}
export const getExtensionNavigationRequest = (): typeof request => request
export function subscribeExtensionNavigation(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) }
