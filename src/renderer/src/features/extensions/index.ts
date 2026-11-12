import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { extensionRegistry, extensionVisible } from './registry'
import { extensionServices, setExtensionContext } from './host'
import type { ExtensionContext, PluginServiceSnapshot } from './types'
export * from './types'
export { ExtensionPage } from './ExtensionPage'
export { ExtensionRegistry, extensionRegistry, extensionVisible } from './registry'
export { startExtensionHost, refreshExtensionHost, getExtensionHostSnapshot, subscribeExtensionHost, setExtensionContext, unloadExtension } from './host'
export { getExtensionNavigationRequest, subscribeExtensionNavigation, requestExtensionPage } from './navigation'
export const getExtensionPage = (id: string) => extensionRegistry.getPage(id)

export function useExtensionContributions(context: ExtensionContext) {
  const snapshot = useSyncExternalStore(extensionRegistry.subscribe, extensionRegistry.getSnapshot)
  useEffect(() => setExtensionContext(context), [context.sessionId, context.workspacePath, context.engineReady, snapshot.version])
  return useMemo(() => ({
    navigation: snapshot.navigation.filter(entry => extensionVisible(entry.scope, entry.when, context) && snapshot.pages.some(page => page.id === entry.page && extensionVisible(page.scope, page.when, context))),
    pages: snapshot.pages.filter(page => extensionVisible(page.scope, page.when, context)),
    workspaceTabs: snapshot.workspaceTabs.filter(entry => extensionVisible(entry.scope, entry.when, context) && snapshot.pages.some(page => page.id === entry.page && extensionVisible(page.scope, page.when, context))),
  }), [snapshot, context.sessionId, context.workspacePath, context.engineReady])
}
export function useExtensionServices(context: ExtensionContext = {}): readonly PluginServiceSnapshot[] {
  const snapshot = useSyncExternalStore(extensionServices.subscribe, extensionServices.getSnapshot)
  return useMemo(() => snapshot.filter(service => !service.sessionId || service.sessionId === context.sessionId), [snapshot, context.sessionId])
}
