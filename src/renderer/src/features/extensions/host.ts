import { getPluginApplication, invokePluginApplication, listPlugins, type PluginApplication, type PluginInvocation, type PluginRecord } from '@renderer/core/engine/plugins'
import { getEngineSource, isEngineReady, subscribeEngineReadiness, subscribeEngineSource } from '@renderer/core/engine/source'
import { subscribeResourceCatalogueChanges, type ResourceCatalogueChange } from '@renderer/core/engine/resource-catalogue'
import { startPluginCatalogueSync } from '@renderer/core/engine/plugin-catalogue-sync'
import { extensionRegistry } from './registry'
import { ExtensionServices } from './services'
import type { ExtensionContext, ExtensionRegistration } from './types'
import { extensionHostContext, publishExtensionEvent, registerExtensionCommands } from './interactions'
import { subscribeFileMutations } from '@renderer/core/workspace/file-mutation-events'

export async function invokeExtensionTool(registration: ExtensionRegistration, tool: string, args: Record<string, unknown>, context?: ExtensionContext): Promise<PluginInvocation> {
  if (!extensionRegistry.has(registration.identity) || registration.identity.source !== getEngineSource() || !isEngineReady()) throw new Error('插件已卸载或引擎连接已变化。')
  if (!registration.application?.manifest.tools.some(item => item.name === tool)) throw new Error('插件工具不存在。')
  const output = await invokePluginApplication(registration.application, tool, args, context?.sessionId, context ? extensionHostContext(context) : undefined)
  if (!extensionRegistry.has(registration.identity) || registration.identity.source !== getEngineSource()) throw new Error('插件版本已变化，此结果已失效。')
  return output
}
export const extensionServices = new ExtensionServices(invokeExtensionTool)
let activeContext: ExtensionContext = {}
const contextListeners = new Set<() => void>()
export const getExtensionContextSnapshot = (): ExtensionContext => activeContext
export const subscribeExtensionContext = (listener: () => void): (() => void) => { contextListeners.add(listener); return () => contextListeners.delete(listener) }
export function getExtensionContext(): ExtensionContext { return { ...activeContext } }
export function setExtensionContext(context: ExtensionContext): void {
  if (JSON.stringify(activeContext) === JSON.stringify(context)) return
  activeContext = context
  for (const listener of contextListeners) listener()
  for (const registration of extensionRegistry.getRegistrations()) extensionServices.ensure(registration, context)
}
let loadGeneration = 0, references = 0, disposeHost: (() => void) | undefined
let hostSnapshot: { loading: boolean; errors: readonly { pluginId: string; message: string }[] } = { loading: false, errors: [] }
const hostListeners = new Set<() => void>()
const applicationReads = new Map<string, { pluginId: string; promise: Promise<PluginApplication> }>()
let refreshScheduled = false
const retryDelays = [500, 1500, 4000]
let retryAttempt = 0, retryTimer: ReturnType<typeof setTimeout> | undefined
export const getExtensionHostSnapshot = (): typeof hostSnapshot => hostSnapshot
export function subscribeExtensionHost(listener: () => void): () => void { hostListeners.add(listener); return () => hostListeners.delete(listener) }
function publish(loading: boolean, errors: typeof hostSnapshot.errors): void { hostSnapshot = { loading, errors }; for (const listener of hostListeners) listener() }

function publishedHash(record: PluginRecord): string | undefined {
  return record.revisions.find(item => item.revision === record.publishedRevision)?.hash
}
function hasCurrentApplication(record: PluginRecord, source: number): boolean {
  const current = extensionRegistry.getRegistration(record.id)
  return Boolean(current && current.identity.source === source && current.identity.revision === record.publishedRevision &&
    current.identity.hash === publishedHash(record))
}
/** Source and readiness can change in the same notification. Start one reconciliation. */
function scheduleHostRefresh(): void {
  // Fence already-running reads at notification time, before the microtask starts.
  loadGeneration++
  clearRetry()
  retryAttempt = 0
  if (refreshScheduled) return
  refreshScheduled = true
  queueMicrotask(() => { refreshScheduled = false; if (references > 0) void refreshExtensionHost() })
}
function clearRetry(): void { if (retryTimer) clearTimeout(retryTimer); retryTimer = undefined }
function retryRefresh(): void {
  if (references === 0 || retryTimer || retryAttempt >= retryDelays.length) return
  retryTimer = setTimeout(() => { retryTimer = undefined; void reconcileExtensionHost() }, retryDelays[retryAttempt++])
}
function catalogueChanged(change: ResourceCatalogueChange): void {
  // An enable can race a delayed failure from the disabled incarnation of the same revision.
  for (const [key, read] of applicationReads) if (change.id === '*' || read.pluginId === change.id) applicationReads.delete(key)
  scheduleHostRefresh()
}
function readApplication(record: PluginRecord, source: number): Promise<PluginApplication> {
  const key = JSON.stringify([source, record.id, record.publishedRevision, publishedHash(record)])
  const pending = applicationReads.get(key)
  if (pending) return pending.promise
  const operation = getPluginApplication(record.id, record.publishedRevision!).finally(() => {
    if (applicationReads.get(key)?.promise === operation) applicationReads.delete(key)
  })
  applicationReads.set(key, { pluginId: record.id, promise: operation })
  return operation
}

/** Reconcile enabled published revisions; failed or disabled contributions never remain active. */
export function refreshExtensionHost(): Promise<void> {
  clearRetry(); retryAttempt = 0
  return reconcileExtensionHost()
}
async function reconcileExtensionHost(): Promise<void> {
  const generation = ++loadGeneration, source = getEngineSource()
  if (!isEngineReady()) { extensionRegistry.clear(); extensionServices.clear(); publish(false, []); return }
  publish(true, [])
  try {
    const records = await listPlugins()
    if (generation !== loadGeneration || source !== getEngineSource()) return
    const enabled = records.filter(record => {
      if (!record.enabled || !record.publishedRevision) return false
      // Tool-only plugins are discovered by the toolkit catalogue, without loading
      // an application document. A newer draft cannot describe the published UI.
      if (record.publishedRevision !== record.revision) return true
      const contributions = record.manifest.contributes
      return Boolean(contributions && Object.values(contributions).some(entries => entries?.length))
    })
    const keep = new Set(enabled.map(record => record.id))
    for (const current of extensionRegistry.getRegistrations()) {
      const record = enabled.find(record => record.id === current.identity.pluginId)
      if (!keep.has(current.identity.pluginId) || !record || !hasCurrentApplication(record, source)) unloadExtension(current.identity.pluginId)
    }
    const errors: { pluginId: string; message: string }[] = []
    const retained = new Set<string>()
    await Promise.all(enabled.map(async record => {
      if (hasCurrentApplication(record, source)) { retained.add(record.id); return }
      try {
        const application = await readApplication(record, source)
        if (generation !== loadGeneration || source !== getEngineSource()) return
        const identity = { pluginId: application.id, source, revision: application.revision, hash: application.hash, instanceId: crypto.randomUUID() }
        const registration = { identity, application, contributes: application.manifest.contributes ?? {} }
        // One slow plugin must not hold back unrelated navigation and workspace tabs.
        let disposeCommands: (() => void) | undefined
        extensionRegistry.register(registration, () => { extensionServices.remove(identity); disposeCommands?.() })
        disposeCommands = registerExtensionCommands(registration)
        retained.add(application.id)
        extensionServices.ensure(registration, { ...activeContext, engineReady: true })
      } catch (error) {
        errors.push({ pluginId: record.id, message: error instanceof Error ? error.message : String(error) })
      }
    }))
    if (generation !== loadGeneration || source !== getEngineSource()) return
    // Rebuild only retained registrations. Token-aware disposers protect replacements from old cleanups.
    for (const registration of extensionRegistry.getRegistrations()) if (!retained.has(registration.identity.pluginId)) unloadExtension(registration.identity.pluginId)
    publish(false, errors)
    if (errors.length) retryRefresh()
    else retryAttempt = 0
  } catch (error) {
    if (generation !== loadGeneration || source !== getEngineSource()) return
    // A transport error is not evidence of removal. Keep healthy registrations until
    // a successful catalogue read confirms disable/delete or a source change clears them.
    publish(false, [{ pluginId: '', message: error instanceof Error ? error.message : String(error) }])
    retryRefresh()
  }
}
export function unloadExtension(pluginId: string): void { extensionRegistry.unregister(pluginId) }

/** A reference-counted renderer lifetime, independent of whether the management page was visited. */
export function startExtensionHost(): () => void {
  references++
  if (!disposeHost) {
    const fileOff = subscribeFileMutations(event => {
      if (event.source === getEngineSource()) publishExtensionEvent('file.changed', { sessionId: event.sessionId, workspacePath: event.workspacePath, filePath: event.path, engineReady: true }, { operation: event.operation, previousPath: event.previousPath })
    })
    let catalogueOff = subscribeResourceCatalogueChanges(['plugin'], catalogueChanged)
    const sourceOff = subscribeEngineSource(() => { catalogueOff(); catalogueOff = subscribeResourceCatalogueChanges(['plugin'], catalogueChanged); applicationReads.clear(); setExtensionContext({}); extensionRegistry.clear(); extensionServices.clear(); scheduleHostRefresh() })
    const readyOff = subscribeEngineReadiness(scheduleHostRefresh)
    const syncOff = startPluginCatalogueSync()
    disposeHost = () => { syncOff(); fileOff(); catalogueOff(); sourceOff(); readyOff(); clearRetry(); loadGeneration++; applicationReads.clear(); setExtensionContext({}); extensionRegistry.clear(); extensionServices.clear(); publish(false, []) }
    void refreshExtensionHost()
  }
  let disposed = false
  return () => { if (disposed) return; disposed = true; if (--references === 0) { disposeHost?.(); disposeHost = undefined } }
}
