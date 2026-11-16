/** Declarative UI capabilities of one immutable plugin revision. No host modules are executable here. */
export type PluginContributionScope = 'global' | 'session'
export interface PluginContributionWhen { session?: boolean; workspace?: boolean; engineReady?: boolean }
export interface PluginContributionBase { id: string; title: string; scope?: PluginContributionScope; when?: PluginContributionWhen; order?: number }
export type PluginPageContribution = PluginContributionBase & (
  | { kind: 'tool'; tool?: string }
  | { kind: 'webview'; entry: string; tools: string[] }
  | { kind: 'native'; entry: string; tools: string[] }
)
export interface PluginNavigationContribution extends PluginContributionBase { page: string; icon?: string }
export interface PluginWorkspaceTabContribution extends PluginContributionBase { page: string; icon?: string }
export interface PluginServiceContribution extends PluginContributionBase {
  tool: string
  stopTool?: string
  statusTool?: string
  page?: string
  args?: Record<string, unknown>
}
export interface PluginContributions {
  pages?: PluginPageContribution[]
  navigation?: PluginNavigationContribution[]
  workspaceTabs?: PluginWorkspaceTabContribution[]
  services?: PluginServiceContribution[]
  commands?: PluginCommandContribution[]
  menus?: PluginMenuContribution[]
  views?: PluginViewContribution[]
  statusBar?: PluginStatusBarContribution[]
  settings?: PluginSettingsContribution[]
  editorDecorations?: PluginEditorDecorationContribution[]
  hooks?: PluginHookContribution[]
  background?: PluginBackgroundContribution[]
}

export type PluginMenuLocation = 'message.actions' | 'session.context' | 'file.context' | 'editor.context' | 'editor.toolbar' | 'app.menu' | 'service.context' | 'composer.toolbar'
export type PluginViewLocation = 'message.inline' | 'composer.panel' | 'workspace.panel'
export type PluginHostEventName = 'app.started' | 'app.stopping' | 'session.opened' | 'session.closed' | 'session.changed' | 'message.created' | 'message.completed' | 'workspace.changed' | 'file.changed' | 'editor.selectionChanged' | 'composer.changed'
/** Agent lifecycle facts originate in the engine; hooks may subscribe without widening host publishers. */
export type PluginEventName = PluginHostEventName | 'agent.started' | 'agent.completed' | 'agent.failed' | 'agent.cancelled'
export type PluginCommandContribution = PluginContributionBase & ({ tool: string; page?: never } | { page: string; tool?: never }) & { args?: Record<string, unknown>; shortcut?: string }
export interface PluginMenuContribution extends PluginContributionBase { location: PluginMenuLocation; command: string }
export interface PluginViewContribution extends PluginContributionBase { location: PluginViewLocation; page: string; height?: number }
export interface PluginStatusBarContribution extends PluginContributionBase { command: string; icon?: string }
export interface PluginSettingsContribution extends PluginContributionBase { page: string }
export interface PluginEditorDecorationContribution extends PluginContributionBase { pattern?: string; text: string; tooltip?: string; severity?: 'info' | 'warning' | 'error' }
export interface PluginHookContribution extends PluginContributionBase { event: PluginEventName; tool: string; args?: Record<string, unknown> }
export interface PluginBackgroundContribution extends PluginContributionBase { tool: string; args?: Record<string, unknown>; intervalMs: number; runOnStartup?: boolean }
