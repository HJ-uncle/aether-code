/** Security gates shared by renderer-facing IPC handlers.
 *
 * Every renderer invoke arrives with a WebContents and (when applicable) a
 * WebFrameMain.  Checking only `event.sender` is insufficient: an iframe can
 * share the same WebContents while carrying untrusted page code.  We accept
 * only the main frame of a live BrowserWindow that Electron can resolve from
 * the sender.  The check is deliberately kept in the main process so a
 * compromised renderer cannot opt out of it by changing the preload payload.
 */
import { app, BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isTrustedWorkbenchUrl } from '../shared/workbench-url'

export function workbenchEntryUrl(): string {
  return !app.isPackaged && process.env.ELECTRON_RENDERER_URL
    ? process.env.ELECTRON_RENDERER_URL
    : pathToFileURL(join(__dirname, '../renderer/index.html')).href
}

/** Pure portion of the sender check; kept exportable for contract tests. */
export function isTrustedMainFrameBinding(
  sender: Pick<WebContents, 'isDestroyed' | 'mainFrame'>,
  senderFrame: unknown,
  ownerSender: unknown
): boolean {
  return !sender.isDestroyed() && senderFrame === sender.mainFrame && ownerSender === sender
}

export function assertTrustedRenderer(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  operation = 'IPC 操作'
): BrowserWindow {
  let owner: BrowserWindow | null = null
  try {
    owner = BrowserWindow.fromWebContents(event.sender)
  } catch {
    // fromWebContents can throw when Chromium has already torn down a
    // renderer.  Treat that as an invalid sender instead of leaking a native
    // exception from the handler.
  }
  const sender = event.sender as WebContents
  const valid = owner !== null && !owner.isDestroyed() &&
    isTrustedMainFrameBinding(sender, event.senderFrame, owner.webContents) &&
    isTrustedWorkbenchUrl(event.senderFrame?.url ?? '', workbenchEntryUrl())
  if (!valid) throw new Error(`${operation}只能由 Aether 工作台主窗口发起`)
  return owner!
}

