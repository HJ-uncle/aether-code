import { ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import { parseConversationLink, type ConversationLink } from '../shared/conversation-link'
import { isTrustedWorkbenchUrl } from '../shared/workbench-url'
import { assertTrustedRenderer, workbenchEntryUrl } from './ipc-security'

const MAX_PENDING_LINKS = 32
const pending: ConversationLink[] = []
let window: BrowserWindow | null = null

function announce(): void {
  if (!pending.length || !window || window.isDestroyed() || window.webContents.isDestroyed()) return
  if (!isTrustedWorkbenchUrl(window.webContents.getURL(), workbenchEntryUrl())) return
  window.webContents.send(IPC.event.conversationLinkAvailable)
}

/** OS links are navigation requests only. The renderer must verify the current source. */
export function queueConversationLink(value: unknown): boolean {
  const link = parseConversationLink(value)
  if (!link) return false
  const previous = pending.at(-1)
  if (!previous || previous.sessionId !== link.sessionId || previous.source !== link.source || previous.mode !== link.mode) {
    pending.push(link)
    if (pending.length > MAX_PENDING_LINKS) pending.shift()
  }
  announce()
  return true
}

export function queueConversationLinkArguments(argv: readonly string[]): void {
  for (const argument of argv) queueConversationLink(argument)
}

export function bindConversationLinkWindow(owner: BrowserWindow): void {
  window = owner
  owner.webContents.on('did-finish-load', announce)
  owner.on('closed', () => { if (window === owner) window = null })
}

export function registerConversationLinkIpc(): void {
  ipcMain.handle(IPC.invoke.conversationLinksTake, event => {
    assertTrustedRenderer(event, '读取会话链接')
    // A durable in-memory inbox avoids losing a cold-start link before React mounts.
    return pending.splice(0)
  })
}
