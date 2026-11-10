import { BrowserWindow, ipcMain, session, type WebContents } from 'electron'
import { OFFICE_RENDER_IPC, validateOfficePageRender, type OfficePageRenderInput, type OfficePageRenderResult } from '../shared/office-render'
import { assertTrustedRenderer } from './ipc-security'
import { engineHost } from './engine/host'
import { engineTargetError } from './engine/protocol'

const active = new Set<number>()
let renderSession: Electron.Session | undefined
function offlineRenderSession(): Electron.Session {
  if (renderSession) return renderSession
  // One memory-only, network-disabled partition avoids accumulating a session
  // object for every page during long inspection runs.
  renderSession = session.fromPartition('aether-office-render', { cache: false })
  renderSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  renderSession.setPermissionCheckHandler(() => false)
  renderSession.on('will-download', event => event.preventDefault())
  renderSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('data:') }))
  return renderSession
}
export async function captureOfficePage(input: OfficePageRenderInput, owner: WebContents): Promise<OfficePageRenderResult> {
  validateOfficePageRender(input)
  const assertCurrent = (): void => {
    const snapshot = engineHost.getSnapshot()
    if (owner.isDestroyed() || snapshot.phase !== 'ready' || engineTargetError(snapshot, input.expectedEngine)) throw new Error('引擎或客户端已变化，本次画面作废。')
  }
  assertCurrent()
  if (active.has(owner.id)) throw new Error('正在渲染另一页，请等待画面返回。')
  active.add(owner.id)
  const isolated = offlineRenderSession()
  let view: BrowserWindow | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const destroy = (): void => { if (view && !view.isDestroyed()) view.destroy() }
  owner.once('destroyed', destroy)
  try {
    view = new BrowserWindow({ show: false, width: 960, height: 540, useContentSize: true,
      webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, backgroundThrottling: false, offscreen: true, devTools: false, spellcheck: false } })
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('will-navigate', event => event.preventDefault())
    view.webContents.on('will-attach-webview', event => event.preventDefault())
    const work = async (): Promise<OfficePageRenderResult> => {
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'"><style>html,body{margin:0;width:960px;height:540px;overflow:hidden;background:white;color:black;color-scheme:light}*{animation:none!important;transition:none!important}</style></head><body>${input.html}</body></html>`
      await view!.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      const complete = await view!.webContents.executeJavaScript(`(async()=>{await document.fonts.ready;await Promise.all(Array.from(document.images).map(image=>image.decode().catch(()=>{})));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return document.body.children.length>0})()`)
      if (!complete) throw new Error('办公文件未生成可绘制的页面。')
      assertCurrent()
      const screenshot = await view!.webContents.capturePage({ x: 0, y: 0, width: 960, height: 540 })
      assertCurrent()
      if (screenshot.isEmpty()) throw new Error('办公文件画面为空，不能作为验收证据。')
      const png = screenshot.resize({ width: 960, height: 540, quality: 'best' }).toPNG()
      if (png.length > 4 * 1024 * 1024) throw new Error('办公文件画面超过单次返回预算。')
      return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, width: 960, height: 540 }
    }
    return await Promise.race([work(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { destroy(); reject(new Error('幻灯片绘制超时。')) }, 15_000) })])
  } finally {
    clearTimeout(timer); owner.removeListener('destroyed', destroy); destroy(); active.delete(owner.id)
  }
}
export function registerOfficeRender(): void {
  ipcMain.handle(OFFICE_RENDER_IPC, (event, input: OfficePageRenderInput) => {
    assertTrustedRenderer(event, '办公文件画面检查')
    return captureOfficePage(input, event.sender)
  })
}
