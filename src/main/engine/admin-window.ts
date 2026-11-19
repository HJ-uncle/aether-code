import { BrowserWindow, session, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { engineHost } from './host'
import { adminPageAddress, isAdminWindowRequest, verifyAdminPage } from './admin-address'

let opened: BrowserWindow | undefined
let opening: Promise<void> | undefined

/** Only the trusted settings action may invoke this. Remote services never receive desktop credentials. */
export async function openEngineAdmin(parent: BrowserWindow): Promise<void> {
  if (opening) return opening
  const job = open(parent)
  opening = job
  try { await job } finally { if (opening === job) opening = undefined }
}

async function open(parent: BrowserWindow): Promise<void> {
  const snapshot = engineHost.getSnapshot()
  if (snapshot.phase !== 'ready') throw new Error('请先连接引擎。')
  const signal = engineHost.requestSignal, page = adminPageAddress(snapshot.baseUrl)
  const current = (): boolean => !signal.aborted && !parent.isDestroyed() && engineHost.getSnapshot().phase === 'ready' && engineHost.getSnapshot().instanceId === snapshot.instanceId && engineHost.getSnapshot().baseUrl === snapshot.baseUrl
  await verifyAdminPage(page, signal, snapshot.mode === 'embedded' && /[\\/]\.tmp[\\/]aether-code-dev[\\/]/i.test(snapshot.entryPath ?? ''))
  if (!current()) throw new Error('引擎连接已变化，请重新打开。')
  if (snapshot.mode !== 'embedded' || snapshot.adopted) { await shell.openExternal(page.href); return }
  if (opened && !opened.isDestroyed()) { opened.focus(); return }
  const gate = engineHost.ownedAdminGate()
  if (!gate || !isAdminWindowRequest(page.href, page)) throw new Error('无法确认本机引擎的所有权，请重新连接引擎。')
  const isolated = session.fromPartition('aether-admin-' + randomUUID(), { cache: false })
  const panel = new BrowserWindow({ parent, show: false, width: 1120, height: 770, minWidth: 440, minHeight: 420, title: '引擎管理', autoHideMenuBar: true,
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, webviewTag: false, spellcheck: false } })
  opened = panel
  const contents = panel.webContents, ownerId = contents.id
  const close = (): void => { if (!panel.isDestroyed()) panel.destroy() }
  signal.addEventListener('abort', close, { once: true })
  const checkNavigation = (e: Electron.Event, url: string): void => { if (!isAdminWindowRequest(url, page) || new URL(url).pathname !== page.pathname) e.preventDefault() }
  contents.on('will-navigate', checkNavigation)
  contents.on('will-redirect', checkNavigation)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  isolated.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  isolated.setPermissionCheckHandler(() => false)
  const isSamePanel = (id: number | undefined, url: string): boolean => id === ownerId && current() && isAdminWindowRequest(url, page)
  // Browser-generated JSON archives have no HTTP destination or instance authority.
  const localBlob = (id: number | undefined, url: string): boolean => id === ownerId && current() && url.startsWith('blob:'+page.origin+'/')
  isolated.on('will-download', (event,item,source) => {
    if (!localBlob(source.id,item.getURL()) || item.getFilename() !== 'aether-monitor-rules.json') event.preventDefault()
  })
  isolated.webRequest.onBeforeRequest((details, done) => done({ cancel: !isSamePanel(details.webContentsId, details.url) && !localBlob(details.webContentsId, details.url) }))
  isolated.webRequest.onBeforeSendHeaders((details, done) => {
    if (localBlob(details.webContentsId, details.url)) { done({}); return }
    const token = isSamePanel(details.webContentsId, details.url) ? gate() : undefined
    if (!token) { done({ cancel: true }); return }
    for (const name of Object.keys(details.requestHeaders)) if (name.toLowerCase() === 'x-aether-instance-token') delete details.requestHeaders[name]
    details.requestHeaders['X-Aether-Instance-Token'] = token
    done({ requestHeaders: details.requestHeaders })
  })
  panel.once('closed', () => {
    if (opened === panel) opened = undefined
    signal.removeEventListener('abort', close)
    isolated.webRequest.onBeforeRequest(null); isolated.webRequest.onBeforeSendHeaders(null)
    void isolated.clearStorageData().catch(() => {})
  })
  try { await panel.loadURL(page.href); if (!current() || panel.isDestroyed()) throw new Error(); panel.show() }
  catch { close(); throw new Error('管理窗口加载失败。请确认引擎仍在运行，然后重新打开。') }
}
