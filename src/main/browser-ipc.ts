import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { BROWSER_IPC, type BrowserConnectInput } from '../shared/browser-api'
import type { BrowserAction, BrowserBoundsInput, BrowserContext, BrowserCreateInput, BrowserReadKind, BrowserSettings } from '../shared/browser'
import type { BrowserNetworkQuery, BrowserNetworkDetailOptions } from '../shared/browser-network'
import { BrowserService } from './browser/service'
import { BrowserEngineBridge } from './browser-bridge'
import { contextsMatch, validateContext } from './browser/validation'
import { BrowserPreviewServer } from './browser-preview'
import { engineHost } from './engine/host'
import { readAccountCredential } from './account/credential-store'
import { NativeBrowserHostManager } from './browser/native-host-manager'

const bridges = new Set<BrowserEngineBridge>()
const nativeHosts = new Set<NativeBrowserHostManager>()

function pendingBrowserEngine(): BrowserConnectInput['expectedEngine'] | undefined {
  const snapshot = engineHost.getSnapshot()
  if (snapshot.phase === 'ready') return { mode: snapshot.mode, baseUrl: snapshot.baseUrl, instanceId: snapshot.instanceId, accountId: snapshot.accountId }
  // The public engine snapshot deliberately has no URL before its handshake.
  // Capture the selected server/account now instead of treating an empty URL as
  // permission to hand this page to whichever remote server connects next.
  try {
    const target = engineHost.accountTarget()
    return {
      mode: target.scope === 'embedded' ? 'embedded' : 'remote',
      baseUrl: target.scope === 'embedded' ? '' : target.url,
      accountId: readAccountCredential(target.scope).credential?.user.id ?? null
    }
  } catch {
    // Invalid server settings or locked account storage must not break ordinary
    // browsing. An unknown owner requires the user's later explicit share action.
    return undefined
  }
}
export async function disconnectBrowserClients(): Promise<string[]> {
  const messages = await Promise.all([
    ...[...bridges].map(bridge => bridge.disconnectAndWait()),
    ...[...nativeHosts].map(host => host.disconnectAndWait())
  ])
  return messages.filter((message): message is string => message !== null)
}

/** The embedded website has no preload and never receives the IDE's IPC capabilities. */
export function registerBrowserIpc(window: BrowserWindow): () => void {
  const send = (channel: string, value: unknown): void => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, value)
  }
  const service = new BrowserService(() => window.isDestroyed() ? undefined : window, event => send(BROWSER_IPC.event, event))
  const bridge = new BrowserEngineBridge(service, state => send(BROWSER_IPC.connection, state))
  const nativeHost = new NativeBrowserHostManager(service, () => engineHost.nativeBrowserHostTransports())
  const refreshNativeHost = (): void => { void nativeHost.refresh().catch(() => { /* Transport handshakes remain unavailable until their owner is ready. */ }) }
  engineHost.on('snapshot', refreshNativeHost)
  nativeHosts.add(nativeHost)
  refreshNativeHost()
  bridges.add(bridge)
  const preview = new BrowserPreviewServer()
  const handler = async (event: IpcMainInvokeEvent, method: string, ...args: unknown[]): Promise<unknown> => {
    try {
      if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
        throw new Error('浏览器操作只能从 Aether 工作台发起')
      }
      let value: unknown
      switch (method) {
        case 'list': value = service.list(); break
        case 'create': value = await service.create({ url: (args[0] as BrowserCreateInput | undefined)?.url, context: bridge.getContext() }, pendingBrowserEngine()); break
        case 'action': value = await service.action(args[0] as BrowserAction); break
        case 'setBounds': {
          const input = args[0] as BrowserBoundsInput
          const zoom = event.sender.getZoomFactor()
          value = service.setBounds({ ...input, bounds: {
            x: input.bounds.x * zoom, y: input.bounds.y * zoom,
            width: input.bounds.width * zoom, height: input.bounds.height * zoom
          } }); break
        }
        case 'close': value = service.close(String(args[0])); break
        case 'share': {
          const context = bridge.getContext()
          if (!context) throw new Error('请先连接引擎并选择会话')
          if (!contextsMatch(context, validateContext(args[1] as BrowserContext))) throw new Error('当前会话或引擎已变化，请重新选择“添加到当前会话”')
          if (!service.getSettings().aiEnabled) throw new Error('请先在浏览器设置中启用 AI 操作')
          value = service.bindContext(String(args[0]), context); break
        }
        case 'getSettings': value = service.getSettings(); break
        case 'updateSettings': value = service.updateSettings(args[0] as Partial<BrowserSettings>); await bridge.refresh(); await nativeHost.refresh(); break
        case 'clearData': value = await service.clearData(); break
        case 'read': value = await service.read(String(args[0]), args[1] as BrowserReadKind); break
        case 'network': value = await service.network(String(args[0]), args[1] as BrowserNetworkQuery | undefined); break
        case 'networkRequest': value = await service.networkRequest(String(args[0]), String(args[1]), args[2] as BrowserNetworkDetailOptions | undefined); break
        case 'openFile': {
          if (engineHost.getSnapshot().mode === 'remote') throw new Error('远端项目请启动开发服务器，并使用本机可访问的预览地址')
          const url = await preview.open(String(args[0]), String(args[1]))
          value = await service.create({ url, context: bridge.getContext() }, pendingBrowserEngine()); break
        }
        case 'connect': value = await bridge.connect(args[0] as BrowserConnectInput); break
        case 'disconnect': bridge.disconnect(); break
        case 'getConnection': value = bridge.getState(); break
        default: throw new Error('不支持的浏览器操作')
      }
      return { ok: true, value }
    } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) } }
  }
  ipcMain.handle(BROWSER_IPC.invoke, handler)
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    ipcMain.removeHandler(BROWSER_IPC.invoke)
    bridges.delete(bridge)
    nativeHosts.delete(nativeHost)
    engineHost.off('snapshot', refreshNativeHost)
    nativeHost.dispose()
    bridge.dispose()
    service.dispose()
    preview.dispose()
  }
  window.once('closed', dispose)
  // Reload removes the DOM geometry and its selected session until bootstrap completes again.
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return
    for (const tab of service.list()) service.setBounds({ tabId: tab.tabId, bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false })
    bridge.disconnect()
  })
  return dispose
}
