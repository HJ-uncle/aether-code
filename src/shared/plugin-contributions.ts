/** Declarative UI capabilities of one immutable plugin revision. No host modules are executable here. */
export type PluginContributionScope = 'global' | 'session'
export interface PluginContributionWhen { session?: boolean; workspace?: boolean; engineReady?: boolean }
export interface PluginContributionBase { id: string; title: string; scope?: PluginContributionScope; when?: PluginContributionWhen; order?: number }
export type PluginPageContribution = PluginContributionBase & (
  | { kind: 'tool'; tool?: string }
  | { kind: 'webview'; entry: string; tools: string[] }
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
}
