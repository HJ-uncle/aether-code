import { ipcMain, protocol, type WebContents } from 'electron'
import './protocol-schemes'
import { PLUGIN_UI_CSP, PLUGIN_UI_IPC, PLUGIN_UI_SCHEME } from '../shared/plugin-ui'
import { assertTrustedRenderer } from './ipc-security'
import { PluginUiDocuments } from './plugin-ui-documents'

// A network-style document has its own policy container; srcdoc/blob would inherit the workbench's script CSP.
const documents = new PluginUiDocuments(), owners = new Map<number, WebContents>()

export function registerPluginUi(): void {
  protocol.handle(PLUGIN_UI_SCHEME, request => {
    const entry = documents.read(request.url), owner = entry && owners.get(entry.ownerId)
    if (!entry || !owner || owner.isDestroyed() || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 })
    return new Response(request.method === 'HEAD' ? null : entry.html, { headers: { 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': PLUGIN_UI_CSP, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } })
  })
  ipcMain.handle(PLUGIN_UI_IPC.create, (event, html: unknown) => {
    const owner = assertTrustedRenderer(event, '打开插件页面').webContents
    if (!owners.has(owner.id)) {
      owners.set(owner.id, owner)
      owner.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) documents.releaseOwner(owner.id) })
      owner.on('render-process-gone', () => documents.releaseOwner(owner.id))
      owner.once('destroyed', () => { documents.releaseOwner(owner.id); owners.delete(owner.id) })
    }
    return documents.create(owner.id, html)
  })
  ipcMain.handle(PLUGIN_UI_IPC.release, (event, url: unknown) => {
    const owner = assertTrustedRenderer(event, '关闭插件页面').webContents
    documents.release(owner.id, url)
  })
}
