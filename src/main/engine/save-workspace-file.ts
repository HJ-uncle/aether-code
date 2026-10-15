import { dialog, type BrowserWindow } from 'electron'
import { basename } from 'node:path'
import type { EngineFileSaveInput, EngineFileSaveResult } from '../../shared/ipc'
import { engineHost } from './host'
import { engineTargetError } from './protocol'
import { downloadWorkspaceToFile } from './workspace-download'

const saves = new Set<number>()

function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    pending.then(value => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(signal.reason); else resolve(value)
    }, error => { signal.removeEventListener('abort', abort); reject(error) })
    if (signal.aborted) abort()
  })
}

/** Keep credentials and binary bytes in the main process; selecting a native
 * save location authorizes exactly one file, not a renderer-selected path. */
export async function saveWorkspaceFile(input: EngineFileSaveInput, owner: BrowserWindow): Promise<EngineFileSaveResult> {
  if (!input || typeof input !== 'object' || !input.expectedEngine ||
      typeof input.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(input.sessionId) ||
      typeof input.path !== 'string' || !input.path.trim() || input.path.length > 4096 ||
      /[\u0000-\u001f\u007f]/.test(input.path) ||
      /^(?:[A-Za-z]:|\/|\\)/.test(input.path) || input.path.replace(/\\/g, '/').split('/').some(part => part === '..' || part === '.') ||
      typeof input.workspaceRoot !== 'string' || !input.workspaceRoot.trim()) throw new Error('成果下载参数无效')
  const snapshot = engineHost.getSnapshot()
  const controller = new AbortController()
  const transportSignal = engineHost.requestSignal
  const assertCurrent = (): void => {
    if (owner.isDestroyed() || owner.webContents.isDestroyed()) throw new Error('发起下载的窗口已关闭')
    const current = engineHost.getSnapshot()
    const changed = engineTargetError(current, input.expectedEngine)
    if (changed || current.phase !== 'ready' || transportSignal.aborted) throw new Error(changed || '引擎连接已变化，请重新下载')
  }
  assertCurrent()
  if (saves.has(owner.id)) throw new Error('当前窗口已有文件正在另存')
  saves.add(owner.id)
  const abort = (): void => controller.abort(new Error('下载窗口已关闭'))
  owner.once('closed', abort)
  try {
    const name = basename(input.path.replace(/\\/g, '/'))
    const result = await dialog.showSaveDialog(owner, { title: '下载原文件', defaultPath: name,
      buttonLabel: '保存', properties: ['showOverwriteConfirmation', 'createDirectory'] })
    if (result.canceled || !result.filePath) return { saved: false }
    assertCurrent()
    const signal = AbortSignal.any([controller.signal, transportSignal, AbortSignal.timeout(120_000)])
    const headers = await untilAborted(engineHost.prepareRequestHeaders(snapshot.baseUrl, 'general'), signal)
    signal.throwIfAborted()
    assertCurrent()
    const saved = await downloadWorkspaceToFile({ ...input, destination: result.filePath,
      baseUrl: snapshot.baseUrl, headers, signal, assertCurrent })
    return { saved: true, path: result.filePath, ...saved }
  } finally {
    owner.removeListener('closed', abort)
    saves.delete(owner.id)
  }
}
