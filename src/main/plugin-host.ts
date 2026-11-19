import { clipboard, dialog, ipcMain, Notification, type IpcMainInvokeEvent } from 'electron'
import { PLUGIN_HOST_IPC, type PluginHostIdentity } from '../shared/plugin-host'
import { assertTrustedRenderer } from './ipc-security'
import { engineHost } from './engine/host'

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const dialogs = new Set<number>()
const notifications = new Map<string, number[]>()
function string(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}无效或过长。`)
  return value
}
function identity(input: unknown): PluginHostIdentity {
  if (!object(input) || typeof input.pluginId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(input.pluginId) || !Number.isInteger(input.revision) || Number(input.revision) < 1) throw new Error('插件身份无效。')
  if (input.devSessionId !== undefined && (typeof input.devSessionId !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.devSessionId))) throw new Error('插件开发会话无效。')
  if (input.hash !== undefined && (typeof input.hash !== 'string' || input.hash.length > 100)) throw new Error('插件修订无效。')
  if (input.sessionId !== undefined && input.sessionId !== null && (typeof input.sessionId !== 'string' || input.sessionId.length > 256)) throw new Error('插件会话无效。')
  return input as unknown as PluginHostIdentity
}

/** Permission is checked against the current engine revision in main, not against an iframe claim. */
async function authorize(event: IpcMainInvokeEvent, input: unknown, capability: string): Promise<{ plugin: PluginHostIdentity; current: () => void }> {
  const owner = assertTrustedRenderer(event, '插件系统操作'), plugin = identity(input)
  const snapshot = engineHost.getSnapshot(), signal = engineHost.requestSignal
  if (snapshot.phase !== 'ready' || !snapshot.baseUrl) throw new Error('引擎尚未就绪。')
  const base = plugin.devSessionId ? `/api/v1/plugins/dev/${plugin.devSessionId}` : `/api/v1/plugins/${plugin.pluginId}`
  const headers = await engineHost.prepareRequestHeaders(snapshot.baseUrl)
  const current = (): void => {
    assertTrustedRenderer(event, '插件系统操作')
    const active = engineHost.getSnapshot()
    if (owner.isDestroyed() || signal.aborted || engineHost.requestSignal !== signal || active.phase !== 'ready' || active.baseUrl !== snapshot.baseUrl || active.instanceId !== snapshot.instanceId) throw new Error('插件所连接的引擎已变化。')
  }
  current()
  const response = await fetch(`${snapshot.baseUrl.replace(/\/+$/, '')}${base}/capabilities/invoke`, { method: 'POST', redirect: 'error', headers: { ...headers, 'Content-Type': 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), body: JSON.stringify({ capability, method: 'host.authorize', args: {}, expectedRevision: plugin.revision,
      ...(plugin.devSessionId ? { hash: plugin.hash } : {}), ...(plugin.sessionId ? { sessionId: plugin.sessionId } : {}) }) })
  const body: unknown = await response.json()
  current()
  if (!response.ok || !object(body) || body.code !== 200 || !object(body.data) || !object(body.data.result) || body.data.result.authorized !== true) throw new Error('插件尚未获得此系统能力的授权，或当前版本已经失效。')
  return { plugin, current }
}

export function registerPluginHost(): void {
  ipcMain.handle(PLUGIN_HOST_IPC.dialog, async (event, input: unknown, value: unknown) => {
    const owner = assertTrustedRenderer(event, '插件对话框')
    if (!object(value)) throw new Error('对话框参数无效。')
    const title = string(value.title, 120, '标题'), message = string(value.message, 10_000, '消息')
    const kind = value.kind ?? 'info'
    if (!['info', 'warning', 'error', 'question'].includes(String(kind))) throw new Error('对话框类型无效。')
    const buttons = value.buttons ?? ['好']
    if (!Array.isArray(buttons) || buttons.length < 1 || buttons.length > 4) throw new Error('对话框需要 1 至 4 个按钮。')
    const labels = buttons.map(item => string(item, 40, '按钮'))
    if (dialogs.has(owner.id)) throw new Error('当前窗口已有插件对话框。')
    dialogs.add(owner.id)
    try {
      const { plugin, current } = await authorize(event, input, 'ui.dialogs')
      const result = await dialog.showMessageBox(owner, { type: kind as 'info' | 'warning' | 'error' | 'question', title: `${plugin.pluginId} · ${title}`, message,
        buttons: labels, defaultId: 0, cancelId: labels.length - 1, noLink: true })
      current()
      return { response: result.response, canceled: labels.length > 1 && result.response === labels.length - 1 }
    } finally { dialogs.delete(owner.id) }
  })
  ipcMain.handle(PLUGIN_HOST_IPC.notify, async (event, input: unknown, value: unknown) => {
    assertTrustedRenderer(event, '插件系统通知')
    if (!object(value)) throw new Error('通知参数无效。')
    const title = string(value.title, 120, '标题'), body = string(value.body, 2000, '内容')
    const { plugin, current } = await authorize(event, input, 'ui.notifications')
    const now = Date.now(), key = `${event.sender.id}:${plugin.pluginId}`
    for (const [id, values] of notifications) if (!values.some(time => time > now - 60_000)) notifications.delete(id)
    const times = (notifications.get(key) ?? []).filter(time => time > now - 60_000)
    if (times.length >= 5) throw new Error('插件通知过于频繁，请稍后再试。')
    if (!Notification.isSupported()) return { shown: false }
    current(); times.push(now); notifications.set(key, times)
    const notification = new Notification({ title: `${plugin.pluginId} · ${title}`, body })
    notification.on('click', () => { try { const owner = assertTrustedRenderer(event, '打开插件通知'); owner.show(); owner.focus() } catch { /* The owning window may already have closed. */ } })
    notification.show()
    return { shown: true }
  })
  ipcMain.handle(PLUGIN_HOST_IPC.clipboard, async (event, input: unknown, value: unknown) => {
    assertTrustedRenderer(event, '插件剪贴板')
    if (!object(value) || !['read', 'write'].includes(String(value.action))) throw new Error('剪贴板参数无效。')
    if (value.action === 'write' && typeof value.text !== 'string') throw new Error('剪贴板文本无效。')
    const { current } = await authorize(event, input, 'ui.clipboard'); current()
    if (value.action === 'write') { clipboard.writeText(value.text as string); return { written: true } }
    const text = clipboard.readText()
    return { text }
  })
}
