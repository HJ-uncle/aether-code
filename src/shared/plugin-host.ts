/** Native operations are named, permission checked and never expose ipcRenderer. */
export const PLUGIN_HOST_IPC = { dialog: 'plugin-host:dialog', notify: 'plugin-host:notify', clipboard: 'plugin-host:clipboard' } as const
export interface PluginHostIdentity { pluginId: string; revision: number; hash?: string; devSessionId?: string; sessionId?: string | null }
export interface PluginDialogInput { kind?: 'info' | 'warning' | 'error' | 'question'; title: string; message: string; buttons?: string[] }
export interface PluginNotificationInput { title: string; body: string }
export interface PluginClipboardInput { action: 'read' | 'write'; text?: string }
export interface PluginHostApi {
  dialog(identity: PluginHostIdentity, input: PluginDialogInput): Promise<{ response: number; canceled: boolean }>
  notify(identity: PluginHostIdentity, input: PluginNotificationInput): Promise<{ shown: boolean }>
  clipboard(identity: PluginHostIdentity, input: PluginClipboardInput): Promise<{ text?: string; written?: boolean }>
}
