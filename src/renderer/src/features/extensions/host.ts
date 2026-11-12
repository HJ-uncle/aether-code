import { getPluginApplication, invokePluginApplication, listPlugins, type PluginApplication, type PluginInvocation } from '@renderer/core/engine/plugins'
import { getEngineSource, isEngineReady, subscribeEngineReadiness, subscribeEngineSource } from '@renderer/core/engine/source'
import { subscribeResourceCatalogueChanges } from '@renderer/core/engine/resource-catalogue'
import { extensionRegistry } from './registry'
import { ExtensionServices } from './services'
import type { ExtensionContext, ExtensionRegistration } from './types'

export async function invokeExtensionTool(registration: ExtensionRegistration, tool: string, args: Record<string, unknown>): Promise<PluginInvocation> {
  if (!extensionRegistry.has(registration.identity) || registration.identity.source !== getEngineSource() || !isEngineReady()) throw new Error('插件已卸载或引擎连接已变化。')
  if (!registration.application?.manifest.tools.some(item => item.name === tool)) throw new Error('插件工具不存在。')
  const output = await invokePluginApplication(registration.application, tool, args)
  if (!extensionRegistry.has(registration.identity) || registration.identity.source !== getEngineSource()) throw new Error('插件版本已变化，此结果已失效。')
  return output
}
export const extensionServices = new ExtensionServices(invokeExtensionTool)
let activeContext: ExtensionContext = {}
export function setExtensionContext(context: ExtensionContext): void {
  activeContext = context
  for (const registration of extensionRegistry.getRegistrations()) extensionServices.ensure(registration, context)
}
let loadGeneration = 0, references = 0, disposeHost: (() => void) | undefined
let hostSnapshot: { loading: boolean; errors: readonly { pluginId: string; message: string }[] } = { loading: false, errors: [] }
const hostListeners = new Set<() => void>()
export const getExtensionHostSnapshot = (): typeof hostSnapshot => hostSnapshot
export function subscribeExtensionHost(listener: () => void): () => void { hostListeners.add(listener); return () => hostListeners.delete(listener) }
function publish(loading: boolean, errors: typeof hostSnapshot.errors): void { hostSnapshot = { loading, errors }; for (const listener of hostListeners) listener() }

/** Reconcile enabled published revisions; failed or disabled contributions never remain active. */
export async function refreshExtensionHost(): Promise<void> {
  const generation = ++loadGeneration, source = getEngineSource()
  if (!isEngineReady()) { extensionRegistry.clear(); extensionServices.clear(); publish(false, []); return }
  publish(true, [])
  try {
    const records = await listPlugins()
    if (generation !== loadGeneration || source !== getEngineSource()) return
    const enabled = records.filter(record => record.enabled && record.publishedRevision)
    const keep = new Set(enabled.map(record => record.id))
    for (const current of extensionRegistry.getRegistrations()) if (!keep.has(current.identity.pluginId) ||
      enabled.find(record => record.id === current.identity.pluginId)?.publishedRevision !== current.identity.revision) unloadExtension(current.identity.pluginId)
    const applications = await Promise.allSettled(enabled.map(record => getPluginApplication(record.id, record.publishedRevision!)))
    if (generation !== loadGeneration || source !== getEngineSource()) return
    const errors: { pluginId: string; message: string }[] = []
    const retained = new Set<string>()
    for (let index = 0; index < applications.length; index++) {
      const response = applications[index], record = enabled[index]
      if (response.status !== 'fulfilled') { errors.push({ pluginId: record.id, message: response.reason instanceof Error ? response.reason.message : String(response.reason) }); continue }
      const application: PluginApplication = response.value
      const previous = extensionRegistry.getRegistration(application.id)
      retained.add(application.id)
      if (previous?.identity.source === source && previous.identity.revision === application.revision && previous.identity.hash === application.hash) continue
      const identity = { pluginId: application.id, source, revision: application.revision, hash: application.hash, instanceId: crypto.randomUUID() }
      const registration = { identity, application, contributes: application.manifest.contributes ?? {} }
      try { extensionRegistry.register(registration, () => extensionServices.remove(identity)); extensionServices.ensure(registration, { ...activeContext, engineReady: true }) }
      catch (error) { errors.push({ pluginId: application.id, message: error instanceof Error ? error.message : String(error) }) }
    }
    // Rebuild only retained registrations. Token-aware disposers protect replacements from old cleanups.
    for (const registration of extensionRegistry.getRegistrations()) if (!retained.has(registration.identity.pluginId)) unloadExtension(registration.identity.pluginId)
    publish(false, errors)
  } catch (error) {
    if (generation !== loadGeneration || source !== getEngineSource()) return
    extensionRegistry.clear(); extensionServices.clear()
    publish(false, [{ pluginId: '', message: error instanceof Error ? error.message : String(error) }])
  }
}
export function unloadExtension(pluginId: string): void { extensionRegistry.unregister(pluginId) }

/** A reference-counted renderer lifetime, independent of whether the management page was visited. */
export function startExtensionHost(): () => void {
  references++
  if (!disposeHost) {
    let catalogueOff = subscribeResourceCatalogueChanges(['plugin'], () => { void refreshExtensionHost() })
    const sourceOff = subscribeEngineSource(() => { catalogueOff(); catalogueOff = subscribeResourceCatalogueChanges(['plugin'], () => { void refreshExtensionHost() }); activeContext = {}; extensionRegistry.clear(); extensionServices.clear(); void refreshExtensionHost() })
    const readyOff = subscribeEngineReadiness(() => { void refreshExtensionHost() })
    disposeHost = () => { catalogueOff(); sourceOff(); readyOff(); loadGeneration++; activeContext = {}; extensionRegistry.clear(); extensionServices.clear(); publish(false, []) }
    void refreshExtensionHost()
  }
  let disposed = false
  return () => { if (disposed) return; disposed = true; if (--references === 0) { disposeHost?.(); disposeHost = undefined } }
}
