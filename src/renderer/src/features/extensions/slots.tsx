import { useEffect, useId, useSyncExternalStore, type JSX } from 'react'
import { Icon } from '@renderer/ui/icons'
import type { PluginMenuLocation, PluginViewLocation } from '@shared/plugin-contributions'
import { extensionRegistry, extensionVisible } from './registry'
import { extensionId, type ExtensionContext } from './types'
import { executeExtensionCommand, runExtensionAction } from './interactions'
import { ExtensionPage } from './ExtensionPage'

export interface ExtensionMenuItem { id: string; label: string; icon?: string; disabled?: boolean; onSelect: () => void; onSelectWithContext?: (context: ExtensionContext) => void }
let expandedSlots: readonly string[] = []
const expansionListeners = new Set<() => void>()
const subscribeExpansion = (listener: () => void): (() => void) => { expansionListeners.add(listener); return () => expansionListeners.delete(listener) }
function changeExpansion(id: string, open: boolean): void { expandedSlots = [...expandedSlots.filter(value => value !== id), ...(open ? [id] : [])]; for (const listener of expansionListeners) listener() }
export function useExtensionMenuItems(location: PluginMenuLocation, context: ExtensionContext): ExtensionMenuItem[] {
  const snapshot = useSyncExternalStore(extensionRegistry.subscribe, extensionRegistry.getSnapshot)
  return snapshot.menus.filter(item => item.location === location && extensionVisible(item.scope ?? 'global', item.when, context)).flatMap(item => {
    const registration = extensionRegistry.getRegistration(item.identity.pluginId)
    const command = registration?.contributes.commands?.find(command => command.id === item.command)
    if (!registration || !command || !extensionVisible(command.scope ?? 'global', command.when, context)) return []
    const captured = { ...context }
    const onSelectWithContext = (target: ExtensionContext): void => runExtensionAction(() => executeExtensionCommand(registration, item.command, { ...target }))
    return [{ id: item.id, label: item.title, onSelect: () => onSelectWithContext(captured), onSelectWithContext }]
  })
}
export function ExtensionSlot({ location, context }: { location: PluginViewLocation; context: ExtensionContext }): JSX.Element | null {
  const snapshot = useSyncExternalStore(extensionRegistry.subscribe, extensionRegistry.getSnapshot)
  const owner = useId(), expanded = useSyncExternalStore(subscribeExpansion, () => expandedSlots)
  useEffect(() => () => { for (const id of expandedSlots.filter(value => value.startsWith(owner + ':'))) changeExpansion(id, false) }, [owner])
  const entries = snapshot.views.filter(item => item.location === location && extensionVisible(item.scope ?? 'global', item.when, context) &&
    snapshot.pages.some(page => page.id === extensionId(item.identity.pluginId, item.page) && extensionVisible(page.scope, page.when, context)))
  if (!entries.length) return null
  return <div className="extension-slots" data-extension-slot={location}>{entries.map(item => {
    const id = `${owner}:${item.identity.instanceId}:${item.id}`, open = expanded.includes(id)
    return <section key={id} className="extension-slot" aria-label={item.title}>
      <button type="button" className="extension-slot__toggle" aria-expanded={open} onClick={() => changeExpansion(id, !open)}><Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} /><span>{item.title}</span></button>
      {open ? <div className="extension-slot__body" style={{ height: item.height ?? 280 }}><ExtensionPage contributionId={extensionId(item.identity.pluginId, item.page)} context={context} /></div> : null}
    </section>
  })}</div>
}
export function useExtensionEditorDecorations(context: ExtensionContext) {
  const snapshot = useSyncExternalStore(extensionRegistry.subscribe, extensionRegistry.getSnapshot)
  return snapshot.editorDecorations.filter(item => extensionVisible(item.scope ?? 'global', item.when, context))
}
