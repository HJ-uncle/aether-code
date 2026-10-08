import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { BROWSER_IPC, type BrowserConnectInput } from '../shared/browser-api'
import type { BrowserAction, BrowserBoundsInput, BrowserCreateInput, BrowserReadKind, BrowserSettings } from '../shared/browser'
import type { BrowserNetworkQuery, BrowserNetworkDetailOptions } from '../shared/browser-network'
import { BrowserService } from './browser/service'
import { BrowserEngineBridge } from './browser-bridge'
import { BrowserPreviewServer } from './browser-preview'
import { engineHost } from './engine/host'

/** The embedded website has no preload and never receives the IDE's IPC capabilities. */
export function registerBrowserIpc(window: BrowserWindow): () => void {
  const send = (channel: string, value: unknown): void => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, value)
  }
  const service = new BrowserService(() => window.isDestroyed() ? undefined : window, event => send(BROWSER_IPC.event, event))
  const bridge = new BrowserEngineBridge(service, state => send(BROWSER_IPC.connection, state))
  const preview = new BrowserPreviewServer()
  const handler = async (event: IpcMainInvokeEvent, method: string, ...args: unknown[]): Promise<unknown> => {
    try {
      if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
        throw new Error('浏览器操作只能从 Aether 工作台发起')
      }
      let value: unknown
      switch (method) {
        case 'list': value = service.list(); break
        case 'create': value = await service.create({ url: (args[0] as BrowserCreateInput | undefined)?.url, context: bridge.getContext() }); break
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
          value = service.bindContext(String(args[0]), context); break
        }
        case 'getSettings': value = service.getSettings(); break
        case 'updateSettings': value = service.updateSettings(args[0] as Partial<BrowserSettings>); await bridge.refresh(); break
        case 'clearData': value = await service.clearData(); break
        case 'read': value = await service.read(String(args[0]), args[1] as BrowserReadKind); break
        case 'network': value = await service.network(String(args[0]), args[1] as BrowserNetworkQuery | undefined); break
        case 'networkRequest': value = await service.networkRequest(String(args[0]), String(args[1]), args[2] as BrowserNetworkDetailOptions | undefined); break
        case 'openFile': {
          if (engineHost.getSnapshot().mode === 'remote') throw new Error('远端项目请启动开发服务器，并使用本机可访问的预览地址')
          const url = await preview.open(String(args[0]), String(args[1]))
          value = await service.create({ url, context: bridge.getContext() }); break
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
