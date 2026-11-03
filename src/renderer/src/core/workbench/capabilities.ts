export const WORKBENCH_ACTIONS = ['artifact.open', 'workspace.context', 'terminal.read'] as const
export const PREVIEW_FORMATS = ['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'tsv', 'md', 'txt', 'json', 'html', 'htm', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'mp4', 'webm'] as const
const connected = new Map<string, string>()
const key = (source: number, sessionId: string) => JSON.stringify([source, sessionId])
export function setWorkbenchConnected(source: number, sessionId: string, owner: string, value: boolean): void {
  const id = key(source, sessionId)
  if (value) connected.set(id, owner)
  else if (connected.get(id) === owner) connected.delete(id)
}
export function clientCapabilities(source: number, sessionId: string, mode: 'work' | 'code') {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform
  return {
    version: 1 as const, application: 'aether' as const, mode,
    platform: /Win/i.test(platform) ? 'win32' as const : /Mac/i.test(platform) ? 'darwin' as const : /Linux/i.test(platform) ? 'linux' as const : 'unknown' as const,
    previewFormats: [...PREVIEW_FORMATS], actions: [...WORKBENCH_ACTIONS], connected: connected.has(key(source, sessionId))
  }
}
