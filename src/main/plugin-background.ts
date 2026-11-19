import { app, Menu, Tray, type BrowserWindow } from 'electron'
import { engineHost } from './engine/host'

let quitting = false, tray: Tray | undefined
const show = (window: BrowserWindow): void => { if (!window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus() } }
async function backgroundTaskCount(): Promise<number> {
  const snapshot = engineHost.getSnapshot(), signal = engineHost.requestSignal
  if (snapshot.phase !== 'ready' || !snapshot.baseUrl) return 0
  const headers = await engineHost.prepareRequestHeaders(snapshot.baseUrl)
  const response = await fetch(`${snapshot.baseUrl.replace(/\/+$/, '')}/api/v1/plugins/runtime/background`, {
    headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(3000)])
  })
  if (!response.ok || signal.aborted || engineHost.requestSignal !== signal) return 0
  const result = await response.json() as { code?: number; data?: { enabled?: boolean; tasks?: unknown[] } }
  return result.code === 200 && result.data?.enabled === true && Array.isArray(result.data.tasks) ? result.data.tasks.length : 0
}

/** Closing a window keeps explicitly granted schedules alive; Quit always stops the process. */
export function attachPluginBackground(window: BrowserWindow, icon: string): void {
  let closing = false, allowClose = false
  const updateTray = (count: number): void => {
    if (!tray) { tray = new Tray(icon); tray.on('double-click', () => show(window)); tray.on('click', () => show(window)) }
    tray.setToolTip(`Aether · ${count} 个后台插件任务`)
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 Aether', click: () => show(window) },
      { label: `${count} 个后台插件任务`, enabled: false },
      { label: '刷新任务状态', click: () => { void backgroundTaskCount().then(updateTray).catch(() => updateTray(0)) } },
      { type: 'separator' },
      { label: '退出 Aether', click: () => app.quit() }
    ]))
  }
  window.on('close', event => {
    if (quitting || allowClose) return
    event.preventDefault()
    if (closing) return
    closing = true
    void backgroundTaskCount().then(count => {
      if (window.isDestroyed() || quitting) return
      if (count > 0) { updateTray(count); window.hide() }
      else { allowClose = true; window.close() }
    }).catch(() => { if (!window.isDestroyed() && !quitting) { allowClose = true; window.close() } }).finally(() => { closing = false })
  })
}
app.on('before-quit', () => { quitting = true })
app.on('will-quit', () => { tray?.destroy(); tray = undefined })
