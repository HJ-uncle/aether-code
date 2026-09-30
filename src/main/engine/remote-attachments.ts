import { randomUUID } from 'node:crypto'
import type { EngineSnapshot } from '../../shared/ipc'

type Target = Pick<EngineSnapshot, 'mode' | 'baseUrl' | 'instanceId'>
interface UploadedAttachment { sessionId: string; target: string; path: string; type: string }
const uploaded = new Map<string, UploadedAttachment>()
const targetKey = (target: Target): string => JSON.stringify([target.mode, target.baseUrl, target.instanceId])

export function rememberRemoteAttachment(target: Target, sessionId: string, path: string, type: string): string {
  const id = randomUUID()
  uploaded.set(id, { target: targetKey(target), sessionId, path, type })
  return id
}

/** Only explicit uploads made to this session on this server can become attachments. */
export function remoteAttachmentsForRequest(input: unknown, target: Target, sessionId: string): Array<{ name: string; type: string }> {
  if (!Array.isArray(input)) return []
  return input.flatMap(value => {
    if (!value || typeof value !== 'object' || typeof value.remoteUploadId !== 'string') return []
    const saved = uploaded.get(value.remoteUploadId)
    if (!saved || saved.sessionId !== sessionId || saved.target !== targetKey(target)) {
      throw new Error('远端附件所属连接或会话已变化，请重新选择文件上传')
    }
    return [{ name: saved.path, type: saved.type }]
  })
}

export function clearRemoteAttachments(): void { uploaded.clear() }
