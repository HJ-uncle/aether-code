import { invokePluginCapability, invokePluginDevelopment, type PluginDevelopmentSession } from '@renderer/core/engine/plugins'
import { requestOrThrow } from '@renderer/core/engine/client'
import { getEngineSource, isEngineReady, subscribeEngineSource } from '@renderer/core/engine/source'
import { registerCommand } from '@renderer/core/platform/commands'
import { registerKeybinding } from '@renderer/core/platform/keybindings'
import { registerSettings } from '@renderer/features/settings/settings-registry'
import { toast } from '@renderer/core/toast'
import type { PluginHostEventName } from '@shared/plugin-contributions'
import type { PluginClipboardInput, PluginDialogInput, PluginNotificationInput } from '@shared/plugin-host'
import { extensionRegistry, extensionVisible } from './registry'
import { extensionServices, getExtensionContext, invokeExtensionTool } from './host'
import { requestExtensionPage } from './navigation'
import { extensionId, type ExtensionContext, type ExtensionRegistration } from './types'

export function extensionHostContext(context: ExtensionContext): Record<string, string> {
  return Object.fromEntries(['messageId', 'messageRole', 'filePath', 'selectionText', 'targetId'].flatMap(key => {
    const value = context[key as keyof ExtensionContext]
    return typeof value === 'string' ? [[key, value]] : []
  }))
}
export function assertExtensionActive(registration: ExtensionRegistration, development?: PluginDevelopmentSession): void {
  if (!isEngineReady() || registration.identity.source !== getEngineSource() || (!development && !extensionRegistry.has(registration.identity))) throw new Error('插件已关闭、版本或引擎连接已变化。')
}
export async function executeExtensionCommand(registration: ExtensionRegistration, commandId: string, context: ExtensionContext, args: Record<string, unknown> = {}, development?: PluginDevelopmentSession, navigate = (page: string) => requestExtensionPage(page, context.sessionId ?? undefined, context)): Promise<unknown> {
  assertExtensionActive(registration, development)
  const command = registration.contributes.commands?.find(item => item.id === commandId)
  if (!command || !extensionVisible(command.scope ?? 'global', command.when, context)) throw new Error('插件命令当前不可用。')
  if (command.page) {
    const page = registration.contributes.pages?.find(item => item.id === command.page)
    if (!page || !extensionVisible(page.scope ?? 'global', page.when, context)) throw new Error('插件页面当前不可用。')
    navigate(extensionId(registration.identity.pluginId, command.page)); return null
  }
  const input = { ...command.args, ...args }
  return development ? invokePluginDevelopment(development, command.tool!, input, context.sessionId, extensionHostContext(context)) : invokeExtensionTool(registration, command.tool!, input, context)
}
export function runExtensionAction(action: () => Promise<unknown>): void { void action().catch(error => toast.error(error instanceof Error ? error.message : String(error))) }

/** Palette and shortcuts use the existing command registry, so disposal removes every entry point. */
export function registerExtensionCommands(registration: ExtensionRegistration): () => void {
  const disposeSettings = registerSettings((registration.contributes.settings ?? []).map(setting => ({
    key: `${extensionId(registration.identity.pluginId, setting.id)}:settings`, label: setting.title,
    description: `${registration.application?.name ?? registration.identity.pluginId} 的插件设置`, section: extensionId(registration.identity.pluginId, setting.id),
    category: '插件', scope: 'user' as const, keywords: ['插件', registration.identity.pluginId, registration.application?.name ?? '']
  })))
  const disposers = (registration.contributes.commands ?? []).flatMap(command => {
    const id = extensionId(registration.identity.pluginId, command.id)
    const off = registerCommand({ id, title: command.title, category: registration.application?.name ?? registration.identity.pluginId,
      enabled: () => extensionRegistry.has(registration.identity) && registration.identity.source === getEngineSource() && isEngineReady() && extensionVisible(command.scope ?? 'global', command.when, getExtensionContext()),
      run: async () => { try { await executeExtensionCommand(registration, command.id, getExtensionContext()) } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) } } })
    return command.shortcut ? [off, registerKeybinding({ key: command.shortcut, command: id })] : [off]
  })
  return () => { disposeSettings(); disposers.forEach(dispose => dispose()) }
}

type TargetHandler = (action: string, args: Record<string, unknown>) => unknown | Promise<unknown>
const targets = new Map<object, { kind: 'editor' | 'composer'; context: ExtensionContext; handler: TargetHandler; source: number }>()
export function registerExtensionTarget(kind: 'editor' | 'composer', context: ExtensionContext, handler: TargetHandler): () => void {
  const token = {}; targets.set(token, { kind, context: { ...context }, handler, source: getEngineSource() })
  return () => { targets.delete(token) }
}
subscribeEngineSource(() => { targets.clear(); pendingEvents.clear(); eventInFlight.clear(); clearTimeout(eventTimer); eventTimer = undefined })
export async function authorizeExtensionHost(registration: ExtensionRegistration, context: ExtensionContext, capability: string, development?: PluginDevelopmentSession): Promise<void> {
  assertExtensionActive(registration, development)
  await invokePluginCapability({ pluginId: registration.identity.pluginId, revision: registration.identity.revision, hash: registration.identity.hash, devSessionId: development?.devSessionId, sessionId: context.sessionId, capability, method: 'host.authorize', args: {} })
  assertExtensionActive(registration, development)
}
export async function invokeExtensionHostAction(registration: ExtensionRegistration, context: ExtensionContext, method: string, input: Record<string, unknown>, development?: PluginDevelopmentSession): Promise<unknown> {
  const kind = method.split('.')[0], capability = ({ dialog: 'ui.dialogs', notify: 'ui.notifications', clipboard: 'ui.clipboard', editor: 'ui.editor', composer: 'ui.composer' } as Record<string, string>)[kind]
  if (!capability) throw new Error('此宿主操作不受支持。')
  const captured = { ...context }
  await authorizeExtensionHost(registration, captured, capability, development)
  const identity = { pluginId: registration.identity.pluginId, revision: registration.identity.revision, hash: registration.identity.hash, devSessionId: development?.devSessionId, sessionId: captured.sessionId }
  if (kind === 'dialog') return window.aether.pluginHost.dialog(identity, input as unknown as PluginDialogInput)
  if (kind === 'clipboard') return window.aether.pluginHost.clipboard(identity, input as unknown as PluginClipboardInput)
  if (kind === 'notify') {
    const result = await window.aether.pluginHost.notify(identity, input as unknown as PluginNotificationInput)
    assertExtensionActive(registration, development)
    extensionServices.notify(registration, captured, String(input.title ?? ''), String(input.body ?? ''))
    return result
  }
  const action = method.split('.')[1]
  const allowed = kind === 'editor' ? ['get', 'replaceSelection', 'reveal'] : ['get', 'set', 'insert', 'submit']
  if (!allowed.includes(action)) throw new Error('此编辑操作不受支持。')
  const candidates = [...targets.values()].filter(target => target.kind === kind && target.source === getEngineSource() && target.context.sessionId === captured.sessionId &&
    (!captured.targetId || target.context.targetId === captured.targetId) && (!captured.filePath || target.context.filePath === captured.filePath))
  if (candidates.length !== 1) throw new Error('当前没有唯一可用的编辑目标，请打开对应会话或文件。')
  return candidates[0].handler(action, input)
}

export interface ExtensionHostEvent { id: string; type: PluginHostEventName; sessionId?: string; payload: Record<string, unknown>; timestamp: number }
const eventListeners = new Set<(event: ExtensionHostEvent) => void>()
export const subscribeExtensionEvents = (listener: (event: ExtensionHostEvent) => void): (() => void) => { eventListeners.add(listener); return () => eventListeners.delete(listener) }
const pendingEvents = new Map<string, { event: ExtensionHostEvent; source: number }>()
let eventTimer: ReturnType<typeof setTimeout> | undefined
const eventInFlight = new Set<string>()
export function publishExtensionEvent(type: PluginHostEventName, context: ExtensionContext, payload: Record<string, unknown> = {}): void {
  if (type.startsWith('app.')) return // Lifecycle facts are emitted by the engine.
  if (!isEngineReady() || (!type.startsWith('app.') && !context.sessionId)) return
  const scopedPayload = { ...payload, ...extensionHostContext(context) }
  const event = { id: crypto.randomUUID(), type, sessionId: context.sessionId ?? undefined, payload: scopedPayload, timestamp: Date.now() }
  for (const listener of eventListeners) listener(event)
  if (!eventListeners.size && !extensionRegistry.getRegistrations().some(item => item.contributes.hooks?.some(hook => hook.event === type && extensionVisible(hook.scope ?? 'global', hook.when, context)))) return
  const coalesce = ['composer.changed', 'editor.selectionChanged', 'file.changed', 'workspace.changed'].includes(type)
  const key = `${getEngineSource()}:${context.sessionId ?? ''}:${type}:${coalesce ? context.filePath ?? context.targetId ?? '' : event.id}`
  // A hook's own mutations must not form a recursive hook loop. Coalesce rapid typing/selection updates.
  if (eventInFlight.has(key)) return
  pendingEvents.set(key, { event, source: getEngineSource() })
  if (!eventTimer) eventTimer = setTimeout(() => {
    eventTimer = undefined
    for (const [id, value] of pendingEvents) {
      pendingEvents.delete(id)
      if (value.source !== getEngineSource()) continue
      eventInFlight.add(id)
      void requestOrThrow({ method: 'POST', path: '/plugins/runtime/events', body: { event: value.event.type, eventId: value.event.id, ...(value.event.sessionId ? { sessionId: value.event.sessionId } : {}), payload: value.event.payload } })
        .catch(error => toast.error(error instanceof Error ? error.message : String(error))).finally(() => eventInFlight.delete(id))
    }
  }, 250)
}
