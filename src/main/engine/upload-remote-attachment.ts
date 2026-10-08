import { randomUUID } from 'node:crypto'
import { ATTACHMENTS_DIRECTORY } from '../../shared/attachments'
import { engineHost } from './host'
import { engineTargetError } from './protocol'
import { rememberRemoteAttachment } from './remote-attachments'
import { validateRemoteWorkspaceRoot } from './remote-workspace'
import type { RemoteAttachmentInput, RemoteAttachmentResult } from '../../shared/ipc'

const activeUploads = new Map<string, AbortController>()
const UPLOAD_TIMEOUT_MS = 120_000

/** A stalled credential refresh must obey the same deadline as the HTTP transfer. */
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    pending.then(value => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(signal.reason)
      else resolve(value)
    }, error => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    if (signal.aborted) abort()
  })
}

export function cancelRemoteAttachmentUpload(requestId: unknown, senderId: number): void {
  if (typeof requestId !== 'string') return
  activeUploads.get(`${senderId}:${requestId}`)?.abort()
}

/** File selection/drop/paste already expresses the upload intent. Keep the target
 * and session checks here; a second OS dialog can sit hidden behind the IDE forever. */
export async function uploadRemoteAttachment(input: RemoteAttachmentInput, senderId: number): Promise<RemoteAttachmentResult> {
  const target = engineHost.getSnapshot()
  const changed = engineTargetError(target, input.expectedEngine)
  if (!input.expectedEngine || changed) throw new Error(changed || '附件缺少目标连接身份')
  if (target.mode !== 'remote' || target.phase !== 'ready') throw new Error('请先连接远端引擎')
  if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId)) throw new Error('附件请求 ID 无效')
  if (typeof input.sessionId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(input.sessionId)) throw new Error('附件会话 ID 无效')
  if (typeof input.fileName !== 'string' || !input.fileName.trim() || typeof input.type !== 'string') throw new Error('附件信息无效')
  if (!(input.data instanceof Uint8Array) || input.data.byteLength > 20 * 1024 * 1024) throw new Error('附件必须是至多 20MB 的文件')
  const key = `${senderId}:${input.requestId}`
  if (activeUploads.has(key)) throw new Error('附件正在上传，请勿重复提交')
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, engineHost.requestSignal, AbortSignal.timeout(UPLOAD_TIMEOUT_MS)])
  activeUploads.set(key, controller)
  try {
    const headers = await untilAborted(engineHost.prepareRequestHeaders(), signal)
    signal.throwIfAborted()
    const suffix = input.fileName.match(/\.[a-zA-Z0-9]{1,12}$/)?.[0] ?? ''
    const fileName = `${randomUUID()}${suffix}`
    const serverPath = `${ATTACHMENTS_DIRECTORY}/${fileName}`
    const form = new FormData()
    form.set('sessionId', input.sessionId)
    form.set('path', serverPath)
    form.set('file', new Blob([Uint8Array.from(input.data)], { type: input.type || 'application/octet-stream' }), fileName)
    const response = await fetch(`${target.baseUrl}/api/v1/workspace/upload`, { method: 'POST', headers, body: form, signal, redirect: 'error' })
    const result = await response.json() as { code?: number; message?: string }
    if (!response.ok || (result.code !== 0 && result.code !== 200)) throw new Error(result.message || `远端附件上传失败（HTTP ${response.status}）`)
    signal.throwIfAborted()
    const infoResponse = await fetch(`${target.baseUrl}/api/v1/workspace/file/info?${new URLSearchParams({ sessionId: input.sessionId, path: serverPath })}`, { headers, signal, redirect: 'error' })
    const info = await infoResponse.json() as { code?: number; message?: string; data?: { workspacePath?: unknown; size?: number } }
    if (!infoResponse.ok || (info.code !== 0 && info.code !== 200)) throw new Error(info.message || '无法确认远端附件路径')
    const path = validateRemoteWorkspaceRoot(info.data?.workspacePath)
    if (!path || info.data?.size !== input.data.byteLength) throw new Error('远端附件路径或大小校验失败')
    signal.throwIfAborted()
    return {
      remoteUploadId: rememberRemoteAttachment(target, input.sessionId, serverPath, input.type),
      path: serverPath, name: input.fileName, type: input.type, size: input.data.byteLength
    }
  } catch (error) {
    if (signal.aborted) {
      if (signal.reason?.name === 'TimeoutError') throw new Error('附件上传超时，请检查网络连接后重新选择文件')
      if (controller.signal.aborted) throw new Error('已取消附件上传')
      throw new Error('引擎连接已变化，请重新上传附件')
    }
    throw error
  } finally {
    activeUploads.delete(key)
  }
}
