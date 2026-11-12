import type { PluginInvocation } from '@renderer/core/engine/plugins'
import { extensionRegistry, extensionVisible } from './registry'
import { extensionId, type ExtensionContext, type ExtensionIdentity, type ExtensionRegistration, type PluginServiceContribution, type PluginServiceSnapshot, type PluginServiceStatus } from './types'
import { requestExtensionPage } from './navigation'

type Invoke = (registration: ExtensionRegistration, tool: string, args: Record<string, unknown>) => Promise<PluginInvocation>
interface ServiceEntry { identity: ExtensionIdentity; declaration: PluginServiceContribution; registration: ExtensionRegistration; context: ExtensionContext; snapshot: PluginServiceSnapshot; timer?: ReturnType<typeof setTimeout>; operation: number; activity: number }
const statuses = new Set<PluginServiceStatus>(['idle', 'running', 'waiting', 'completed', 'stopped', 'error'])
const retainedInactiveServices = 64
const active = (entry: ServiceEntry): boolean => entry.snapshot.status === 'running' || entry.snapshot.status === 'waiting'
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

/** Owns service view state and deadlines. Tool code always runs on the selected engine, never in the renderer. */
export class ExtensionServices {
  private readonly entries = new Map<string, ServiceEntry>()
  private readonly listeners = new Set<() => void>()
  private snapshot: readonly PluginServiceSnapshot[] = []
  private context: ExtensionContext = {}
  private activity = 0
  constructor(private readonly invoke: Invoke, private readonly current = (identity: ExtensionIdentity) => extensionRegistry.has(identity),
    private readonly registrationFor = (pluginId: string) => extensionRegistry.getRegistration(pluginId)) {}
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  readonly getSnapshot = (): readonly PluginServiceSnapshot[] => this.snapshot
  ensure(registration: ExtensionRegistration, context: ExtensionContext): void {
    this.context = { ...context }
    let changed = this.prune()
    for (const declaration of registration.contributes.services ?? []) {
      if (!extensionVisible(declaration.scope ?? 'global', declaration.when, context)) continue
      const sessionId = declaration.scope === 'session' ? context.sessionId ?? undefined : undefined
      const id = extensionId(registration.identity.pluginId, declaration.id) + (sessionId ? `:session:${sessionId}` : '')
      // Global services follow the active workspace without retaining a previous session.
      const serviceContext = sessionId ? { ...context } : { workspacePath: context.workspacePath, engineReady: context.engineReady }
      const existing = this.entries.get(id)
      if (existing) { existing.context = serviceContext; existing.activity = ++this.activity; continue }
      const entry: ServiceEntry = { identity: registration.identity, declaration, registration, context: serviceContext, operation: 0, activity: ++this.activity,
        snapshot: { id, pluginId: registration.identity.pluginId, instanceId: registration.identity.instanceId, revision: registration.identity.revision,
          label: declaration.title, status: 'idle', updatedAt: Date.now(), ...(sessionId ? { sessionId } : {}) } }
      if (declaration.page) entry.snapshot.open = () => requestExtensionPage(extensionId(registration.identity.pluginId, declaration.page!), sessionId)
      if (declaration.stopTool) entry.snapshot.stop = () => this.run(entry, 'stop', {})
      this.entries.set(id, entry); changed = true
    }
    if (changed) this.publish()
  }
  remove(identity: ExtensionIdentity): void {
    let changed = false
    for (const [id, entry] of this.entries) if (entry.identity === identity) { entry.operation++; clearTimeout(entry.timer); this.entries.delete(id); changed = true }
    if (changed) this.publish()
  }
  clear(): void { for (const entry of this.entries.values()) { entry.operation++; clearTimeout(entry.timer) }; this.entries.clear(); this.publish() }
  async action(id: string, context: ExtensionContext, action: 'start' | 'stop' | 'status', args: Record<string, unknown> = {}): Promise<void> {
    const registration = this.registrationFor(id.split(':')[1] ?? '')
    if (!registration || !this.current(registration.identity)) throw new Error('插件已卸载，请重新打开。')
    this.ensure(registration, context)
    const declaration = registration.contributes.services?.find(item => extensionId(registration.identity.pluginId, item.id) === id)
    if (!declaration || !extensionVisible(declaration.scope ?? 'global', declaration.when, context)) throw new Error('当前会话没有此服务。')
    const key = id + (declaration.scope === 'session' ? `:session:${context.sessionId}` : '')
    const entry = this.entries.get(key)
    if (!entry) throw new Error('服务未就绪。')
    await this.run(entry, action, args)
  }
  private async run(entry: ServiceEntry, action: 'start' | 'stop' | 'status', args: Record<string, unknown>): Promise<void> {
    if (!this.current(entry.identity) || this.entries.get(entry.snapshot.id) !== entry) throw new Error('插件版本已变化。')
    const tool = action === 'start' ? entry.declaration.tool : action === 'stop' ? entry.declaration.stopTool : entry.declaration.statusTool
    if (!tool) throw new Error('插件未提供此服务操作。')
    const operation = ++entry.operation
    clearTimeout(entry.timer)
    this.update(entry, { status: action === 'start' ? 'waiting' : entry.snapshot.status, detail: action === 'start' ? '正在启动…' : entry.snapshot.detail })
    try {
      const result = await this.invoke(entry.registration, tool, { ...entry.declaration.args, ...args })
      if (operation !== entry.operation || !this.current(entry.identity) || this.entries.get(entry.snapshot.id) !== entry) return
      const value = object(result.result) ? result.result : {}
      const status = typeof value.status === 'string' && statuses.has(value.status as PluginServiceStatus) ? value.status as PluginServiceStatus : action === 'stop' ? 'stopped' : 'completed'
      this.update(entry, { status, detail: typeof value.detail === 'string' ? value.detail.slice(0, 2000) : undefined })
      if ((status === 'running' || status === 'waiting') && typeof value.completesAt === 'number' && Number.isFinite(value.completesAt)) {
        const delay = value.completesAt - Date.now()
        if (delay <= 0) this.update(entry, { status: 'completed', detail: '已完成' })
        else if (delay <= 7 * 24 * 60 * 60 * 1000) entry.timer = setTimeout(() => {
          if (operation === entry.operation && this.current(entry.identity) && this.entries.get(entry.snapshot.id) === entry)
            this.update(entry, { status: 'completed', detail: '已完成' })
        }, delay)
      }
    } catch (error) {
      if (operation === entry.operation && this.current(entry.identity) && this.entries.get(entry.snapshot.id) === entry)
        this.update(entry, { status: 'error', detail: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
  private prune(): boolean {
    let changed = false
    for (const [id, entry] of this.entries) {
      if (entry.snapshot.status !== 'idle' || !entry.snapshot.sessionId || entry.snapshot.sessionId === this.context.sessionId) continue
      entry.operation++; clearTimeout(entry.timer); this.entries.delete(id); changed = true
    }
    const inactive = [...this.entries.values()].filter(entry => !active(entry) && entry.snapshot.sessionId !== this.context.sessionId)
      .sort((left, right) => right.activity - left.activity)
    for (const entry of inactive.slice(retainedInactiveServices)) {
      entry.operation++; clearTimeout(entry.timer); this.entries.delete(entry.snapshot.id); changed = true
    }
    return changed
  }
  private update(entry: ServiceEntry, patch: Partial<PluginServiceSnapshot>): void { entry.activity = ++this.activity; entry.snapshot = { ...entry.snapshot, ...patch, updatedAt: Date.now() }; this.prune(); this.publish() }
  private publish(): void { this.snapshot = [...this.entries.values()].map(entry => entry.snapshot); for (const listener of this.listeners) listener() }
}
