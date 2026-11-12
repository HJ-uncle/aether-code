import { extensionId, type ExtensionContext, type ExtensionIdentity, type ExtensionPage, type ExtensionRegistration, type ExtensionSnapshot, type PluginContributionWhen } from './types'

export function extensionVisible(scope: 'global' | 'session', when: PluginContributionWhen | undefined, context: ExtensionContext): boolean {
  if (scope === 'session' && !context.sessionId) return false
  return (!when || (when.session === undefined || when.session === Boolean(context.sessionId)) &&
    (when.workspace === undefined || when.workspace === Boolean(context.workspacePath)) &&
    (when.engineReady === undefined || when.engineReady === Boolean(context.engineReady)))
}

/** Each replace has a new token. Cleanup from a previous revision cannot remove its successor. */
export class ExtensionRegistry {
  private readonly registrations = new Map<string, { token: object; registration: ExtensionRegistration; dispose?: () => void }>()
  private readonly listeners = new Set<() => void>()
  private snapshot: ExtensionSnapshot = { version: 0, pages: [], navigation: [], workspaceTabs: [] }
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  readonly getSnapshot = (): ExtensionSnapshot => this.snapshot
  register(registration: ExtensionRegistration, dispose?: () => void): () => void {
    const { identity, contributes } = registration
    const pageIds = new Set<string>()
    for (const page of contributes.pages ?? []) {
      if (pageIds.has(page.id)) throw new Error(`插件页面标识重复：${page.id}`)
      pageIds.add(page.id)
    }
    for (const target of [...contributes.navigation ?? [], ...contributes.workspaceTabs ?? []]) {
      if (!pageIds.has(target.page)) throw new Error(`插件页面不存在：${target.page}`)
    }
    for (const collection of [contributes.navigation, contributes.workspaceTabs, contributes.services]) {
      const ids = new Set<string>()
      for (const entry of collection ?? []) { if (ids.has(entry.id)) throw new Error(`插件贡献标识重复：${entry.id}`); ids.add(entry.id) }
    }
    const previous = this.registrations.get(identity.pluginId)
    previous?.dispose?.()
    const token = {}
    this.registrations.set(identity.pluginId, { token, registration, dispose })
    this.rebuild()
    return () => {
      if (this.registrations.get(identity.pluginId)?.token !== token) return
      this.registrations.delete(identity.pluginId); dispose?.(); this.rebuild()
    }
  }
  clear(): void {
    for (const value of this.registrations.values()) value.dispose?.()
    this.registrations.clear(); this.rebuild()
  }
  unregister(pluginId: string): void {
    const current = this.registrations.get(pluginId)
    if (!current) return
    this.registrations.delete(pluginId); current.dispose?.(); this.rebuild()
  }
  getRegistrations(): readonly ExtensionRegistration[] { return [...this.registrations.values()].map(value => value.registration) }
  has(identity: ExtensionIdentity): boolean { return this.registrations.get(identity.pluginId)?.registration.identity === identity }
  getRegistration(pluginId: string): ExtensionRegistration | undefined { return this.registrations.get(pluginId)?.registration }
  getPage(id: string): ExtensionPage | undefined { return this.snapshot.pages.find(page => page.id === id) }
  private rebuild(): void {
    const pages: ExtensionPage[] = [], navigation: ExtensionSnapshot['navigation'][number][] = [], workspaceTabs: ExtensionSnapshot['workspaceTabs'][number][] = []
    for (const { registration } of this.registrations.values()) {
      const { identity, contributes, application, components } = registration
      for (const page of contributes.pages ?? []) pages.push({ id: extensionId(identity.pluginId, page.id), localId: page.id, title: page.title,
        identity, scope: page.scope ?? 'global', when: page.when, application, declaration: page, component: components?.[page.id] })
      for (const [entries, target] of [[contributes.navigation, navigation], [contributes.workspaceTabs, workspaceTabs]] as const) {
        for (const entry of entries ?? []) target.push({ id: extensionId(identity.pluginId, entry.id), title: entry.title, page: extensionId(identity.pluginId, entry.page),
          icon: entry.icon ?? 'puzzle', order: entry.order ?? 100, scope: entry.scope ?? 'global', when: entry.when, identity })
      }
    }
    const sort = (a: { order: number; id: string }, b: { order: number; id: string }): number => a.order - b.order || a.id.localeCompare(b.id)
    this.snapshot = { version: this.snapshot.version + 1, pages, navigation: navigation.sort(sort), workspaceTabs: workspaceTabs.sort(sort) }
    for (const listener of this.listeners) listener()
  }
}
export const extensionRegistry = new ExtensionRegistry()
