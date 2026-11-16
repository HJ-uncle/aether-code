import type { ComponentType } from 'react'
import type { PluginApplication } from '@renderer/core/engine/plugins'
import type { PluginContributions, PluginContributionWhen, PluginPageContribution, PluginCommandContribution, PluginMenuContribution, PluginViewContribution, PluginStatusBarContribution, PluginSettingsContribution, PluginEditorDecorationContribution } from '@shared/plugin-contributions'
export type { PluginContributions, PluginContributionWhen, PluginPageContribution, PluginServiceContribution } from '@shared/plugin-contributions'

export interface ExtensionContext { sessionId?: string | null; workspacePath?: string | null; engineReady?: boolean; messageId?: string; messageRole?: string; filePath?: string; selectionText?: string; targetId?: string }
export interface ExtensionIdentity { pluginId: string; revision: number; hash: string; source: number; instanceId: string }
export interface ExtensionPageProps { context: ExtensionContext; onNavigate?: (pageId: string) => void }
export interface ExtensionPage {
  id: string; localId: string; title: string; identity: ExtensionIdentity; scope: 'global' | 'session'; when?: PluginContributionWhen
  application?: PluginApplication; declaration?: PluginPageContribution; component?: ComponentType<ExtensionPageProps>
}
export interface ExtensionNavigation { id: string; title: string; page: string; icon: string; order: number; scope: 'global' | 'session'; when?: PluginContributionWhen; identity: ExtensionIdentity }
export interface ExtensionWorkspaceTab extends ExtensionNavigation {}
export interface ExtensionRegistration {
  identity: ExtensionIdentity
  application?: PluginApplication
  contributes: PluginContributions
  components?: Record<string, ComponentType<ExtensionPageProps>>
}
export type PluginServiceStatus = 'idle' | 'running' | 'waiting' | 'completed' | 'stopped' | 'error'
export interface PluginServiceSnapshot {
  id: string; pluginId: string; instanceId: string; revision: number; label: string; status: PluginServiceStatus
  detail?: string; updatedAt: number; sessionId?: string; open?: () => void | Promise<void>; stop?: () => Promise<void>
  notification?: boolean
}
export type ExtensionContribution<T> = T & { localId: string; identity: ExtensionIdentity }
export interface ExtensionSnapshot { version: number; pages: readonly ExtensionPage[]; navigation: readonly ExtensionNavigation[]; workspaceTabs: readonly ExtensionWorkspaceTab[];
  commands: readonly ExtensionContribution<PluginCommandContribution>[]; menus: readonly ExtensionContribution<PluginMenuContribution>[];
  views: readonly ExtensionContribution<PluginViewContribution>[]; statusBar: readonly ExtensionContribution<PluginStatusBarContribution>[];
  settings: readonly ExtensionContribution<PluginSettingsContribution>[]; editorDecorations: readonly ExtensionContribution<PluginEditorDecorationContribution>[] }
export const extensionId = (pluginId: string, localId: string): string => `plugin:${pluginId}:${localId}`
