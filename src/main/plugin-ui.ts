import { dialog, ipcMain, protocol, type WebContents } from 'electron'
import { writeFile } from 'node:fs/promises'
import './protocol-schemes'
import { PLUGIN_UI_CSP, PLUGIN_UI_IPC, PLUGIN_UI_SCHEME } from '../shared/plugin-ui'
import { assertTrustedRenderer } from './ipc-security'
import { PluginUiDocuments } from './plugin-ui-documents'
import { decodePluginDownload } from './plugin-download'

// A network-style document has its own policy container; srcdoc/blob would inherit the workbench's script CSP.
const documents = new PluginUiDocuments(), owners = new Map<number, WebContents>()
const saving = new Set<number>()

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
  ipcMain.handle(PLUGIN_UI_IPC.download, async (event, url: unknown, input: unknown) => {
    const owner = assertTrustedRenderer(event, '保存插件文件')
    const assertCurrent = (): void => {
      assertTrustedRenderer(event, '保存插件文件')
      if (typeof url !== 'string' || documents.read(url)?.ownerId !== owner.webContents.id) throw new Error('插件页面已关闭，请重新打开后保存。')
    }
    assertCurrent()
    if (saving.has(owner.id)) throw new Error('当前窗口已有插件文件正在保存。')
    const { fileName, bytes } = decodePluginDownload(input)
    saving.add(owner.id)
    try {
      const result = await dialog.showSaveDialog(owner, { title: '保存插件文件', defaultPath: fileName,
        buttonLabel: '保存', properties: ['showOverwriteConfirmation', 'createDirectory'] })
      if (result.canceled || !result.filePath) return { saved: false }
      assertCurrent()
      await writeFile(result.filePath, bytes)
      // A sandboxed plugin receives no local destination path.
      return { saved: true, bytes: bytes.length }
    } finally { saving.delete(owner.id) }
  })
}
