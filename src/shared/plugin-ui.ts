export const PLUGIN_UI_SCHEME = 'aether-plugin-ui'
export const PLUGIN_UI_IPC = { create: 'plugin-ui:create', release: 'plugin-ui:release' } as const
// allow-forms enables native validation/submit events; form-action still blocks submission and navigation.
export const PLUGIN_UI_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-forms"
export const PLUGIN_UI_THEME_TOKENS = ['--bg-app', '--bg-surface', '--bg-elevated', '--bg-input', '--bg-hover', '--bg-active',
  '--fg', '--fg-strong', '--fg-muted', '--fg-faint', '--accent', '--accent-hover', '--accent-fg', '--accent-soft', '--border', '--border-strong'] as const
export interface PluginUiDocument { url: string }
export interface PluginUiApi { create(html: string): Promise<PluginUiDocument>; release(url: string): Promise<void> }
