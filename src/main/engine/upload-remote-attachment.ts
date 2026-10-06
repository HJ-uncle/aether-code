import { randomUUID } from 'node:crypto'
import { dialog } from 'electron'
import { engineHost } from './host'
import { engineTargetError } from './protocol'
import { rememberRemoteAttachment } from './remote-attachments'
import { validateRemoteWorkspaceRoot } from './remote-workspace'
import type { RemoteAttachmentInput, RemoteAttachmentResult } from '../../shared/ipc'

/** A native confirmation binds each upload to its concrete file and destination. */
export async function uploadRemoteAttachment(input: RemoteAttachmentInput): Promise<RemoteAttachmentResult> {
  const target = engineHost.getSnapshot()
  const changed = engineTargetError(target, input.expectedEngine)
  if (!input.expectedEngine || changed) throw new Error(changed || '附件缺少目标连接身份')
  if (target.mode !== 'remote' || target.phase !== 'ready') throw new Error('请先连接远端引擎')
  if (typeof input.sessionId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(input.sessionId)) throw new Error('附件会话 ID 无效')
  if (typeof input.fileName !== 'string' || !input.fileName.trim() || typeof input.type !== 'string') throw new Error('附件信息无效')
  if (!(input.data instanceof Uint8Array) || input.data.byteLength > 20 * 1024 * 1024) throw new Error('附件必须是至多 20MB 的文件')
  const signal = AbortSignal.any([engineHost.requestSignal, AbortSignal.timeout(120000)])
  const headers = engineHost.requestHeaders()
  const confirmation = await dialog.showMessageBox({
    type: 'question', title: '上传附件到远端引擎',
    message: `将“${input.fileName}”上传到远端引擎？`,
    detail: `目标：${target.baseUrl}\n文件大小：${input.data.byteLength} 字节\n文件将保存在该服务的当前会话目录中。`,
    buttons: ['取消', '上传'], defaultId: 0, cancelId: 0, noLink: true
  })
  if (confirmation.response !== 1) throw new Error('已取消远端附件上传')
  signal.throwIfAborted()
  const suffix = input.fileName.match(/\.[a-zA-Z0-9]{1,12}$/)?.[0] ?? ''
  const fileName = `${randomUUID()}${suffix}`
  const serverPath = `uploads/${fileName}`
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
    // Keep the renderer's attachment path relative to the server workspace so
    // previews use the same session-relative contract as Explorer/editor.
    path: serverPath, name: input.fileName, type: input.type, size: input.data.byteLength
  }
}
