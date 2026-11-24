import { BrowserWindow, session, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { engineHost } from './host'
import { nativeWindowIcon } from '../window-icon'
import { adminPageAddress, isAdminWindowRequest, verifyAdminPage } from './admin-address'
import type { AdminWindowLease } from './admin-lease'

let opened: BrowserWindow | undefined
let opening: Promise<void> | undefined

/** Only the trusted settings action may invoke this. Each panel is bound to a single live service and identity. */
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
  const assertCurrent = (): void => { if (!current()) throw new Error('引擎连接或账号已变化，请重新打开。') }
  if (opened && !opened.isDestroyed()) { opened.focus(); return }
  const desktopEntry = await verifyAdminPage(page, signal, snapshot.mode === 'embedded' && /[\\/]\.tmp[\\/]aether-code-dev[\\/]/i.test(snapshot.entryPath ?? ''))
  assertCurrent()
  const owned = snapshot.mode === 'embedded' && !snapshot.adopted
  const access = owned ? engineHost.ownedAdminAccess() : undefined
  if (owned && (!access?.token() || page.protocol !== 'http:' || page.hostname !== '127.0.0.1')) throw new Error('无法确认本机引擎的所有权，请重新连接引擎。')
  if (owned && !desktopEntry) throw new Error('当前本机引擎还不支持桌面直接进入后台。请更新本机引擎；开发模式请退出桌面后重新运行 npm run dev。')
  // A process adopted by address has no parent control pipe. A legacy/anonymous remote site uses its own login.
  if (snapshot.adopted || !desktopEntry) { await shell.openExternal(page.href); return }
  const headers = await engineHost.prepareRequestHeaders(snapshot.baseUrl)
  assertCurrent()
  const signedIn = !!(headers.Authorization || headers['X-API-Key'])
  if (!owned && !signedIn) { await shell.openExternal(page.href); return }
  const lease = !signedIn ? await access?.grant() : undefined
  try {
    assertCurrent()
    await showPanel(parent, page, signal, current, signedIn, access?.token, lease, snapshot.baseUrl)
  } catch (error) { lease?.revoke(); throw error }
}

async function showPanel(parent: BrowserWindow, page: URL, signal: AbortSignal, current: () => boolean, signedIn: boolean,
  instanceToken: (() => string | undefined) | undefined, lease: AdminWindowLease | undefined, service: string): Promise<void> {
  const automatic = !!lease || signedIn
  const isolated = session.fromPartition('aether-admin-' + randomUUID(), { cache: false })
  const panel = new BrowserWindow({ parent, show: false, width: 1120, height: 770, minWidth: 440, minHeight: 420, title: '引擎管理', autoHideMenuBar: true,
    icon: nativeWindowIcon,
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, webviewTag: false, spellcheck: false } })
  opened = panel
  const contents = panel.webContents, ownerId = contents.id
  const close = (): void => { if (!panel.isDestroyed()) panel.destroy() }
  signal.addEventListener('abort', close, { once: true })
  parent.once('closed', close); contents.once('render-process-gone', close)
  const permitted = (id: number | undefined, raw: string): boolean => id === ownerId && current() && !panel.isDestroyed() && isAdminWindowRequest(raw, page)
  const checkNavigation = (e: Electron.Event, url: string): void => { if (url !== page.href) e.preventDefault() }
  contents.on('will-navigate', checkNavigation); contents.on('will-redirect', checkNavigation)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  isolated.setPermissionRequestHandler((_wc, _permission, cb) => cb(false)); isolated.setPermissionCheckHandler(() => false)
  const localBlob = (id: number | undefined, url: string): boolean => id === ownerId && current() && url.startsWith('blob:'+page.origin+'/')
  isolated.on('will-download', (event,item,source) => {
    if (!localBlob(source.id,item.getURL()) || item.getFilename() !== 'aether-monitor-rules.json') event.preventDefault()
  })
  isolated.webRequest.onBeforeRequest((details, done) => done({ cancel: !permitted(details.webContentsId, details.url) && !localBlob(details.webContentsId, details.url) }))
  isolated.webRequest.onBeforeSendHeaders((details, done) => {
    if (localBlob(details.webContentsId, details.url)) { done({}); return }
    const allowed = (): boolean => permitted(details.webContentsId, details.url) && (!instanceToken || !!instanceToken())
    if (!allowed()) { done({ cancel: true }); return }
    const out = details.requestHeaders
    for (const k of Object.keys(out)) if (/^x-aether-(instance-token|admin-entry)$/i.test(k) || (automatic && /^(x-aether-admin-key|x-api-key|authorization)$/i.test(k))) delete out[k]
    if (automatic && details.resourceType === 'mainFrame' && details.url === page.href) out['X-Aether-Admin-Entry'] = 'current'
    if (details.resourceType !== 'xhr') { done({requestHeaders:out}); return }
    const finish = (authorized: Record<string,string>): void => {
      if (!allowed()) { done({ cancel: true }); return }
      // Never forward arbitrary engine headers, including tool/workspace context, to a management page.
      for (const name of ['X-Aether-Instance-Token','Authorization','X-API-Key','X-Aether-Admin-Key']) if (authorized[name]) out[name] = authorized[name]
      done({ requestHeaders: out })
    }
    if (signedIn) { void engineHost.prepareRequestHeaders(service).then(result => {
      if (!result.Authorization && !result['X-API-Key']) { done({cancel:true}); return }
      finish(result)
    }, () => done({cancel:true})); return }
    const token = instanceToken?.()
    if (!token) { done({cancel:true}); return }
    finish({ 'X-Aether-Instance-Token': token, ...(lease ? { 'X-Aether-Admin-Key': lease.key } : {}) })
  })
  panel.once('closed', () => {
    lease?.revoke(); if (opened === panel) opened = undefined
    signal.removeEventListener('abort', close); parent.off('closed', close)
    isolated.webRequest.onBeforeRequest(null); isolated.webRequest.onBeforeSendHeaders(null)
    void isolated.clearStorageData().catch(() => {})
  })
  try { await panel.loadURL(page.href); if (!current() || panel.isDestroyed()) throw new Error(); panel.show() }
  catch { close(); throw new Error('管理窗口加载失败。请确认引擎仍在运行，然后重新打开。') }
}
