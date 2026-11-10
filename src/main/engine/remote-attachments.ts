import { randomUUID } from 'node:crypto'
import type { EngineSnapshot } from '../../shared/ipc'

type Target = Pick<EngineSnapshot, 'mode' | 'baseUrl' | 'instanceId' | 'accountId'>
interface UploadedAttachment { sessionId: string; target: string; path: string; type: string }
interface RequestAttachment { name: string; type: string; attachmentId?: string; referenceLabel?: string; displayName?: string; size?: number }
const uploaded = new Map<string, UploadedAttachment>()
const targetKey = (target: Target): string => JSON.stringify([target.mode, target.baseUrl, target.instanceId, target.accountId ?? null])

export function rememberRemoteAttachment(target: Target, sessionId: string, path: string, type: string): string {
  const id = randomUUID()
  uploaded.set(id, { target: targetKey(target), sessionId, path, type })
  return id
}

/** Only explicit uploads made to this session on this server can become attachments. */
export function remoteAttachmentsForRequest(input: unknown, target: Target, sessionId: string): RequestAttachment[] {
  if (!Array.isArray(input)) return []
  return input.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const candidate = value as Record<string, unknown>
    const metadata = {
      ...(typeof candidate.attachmentId === 'string' && candidate.attachmentId && candidate.attachmentId.length <= 4096 ? { attachmentId: candidate.attachmentId } : {}),
      ...(typeof candidate.referenceLabel === 'string' && candidate.referenceLabel && candidate.referenceLabel.length <= 512 ? { referenceLabel: candidate.referenceLabel } : {}),
      ...(typeof candidate.displayName === 'string' && candidate.displayName.length <= 512 ? { displayName: candidate.displayName } : {}),
      ...(typeof candidate.size === 'number' && Number.isSafeInteger(candidate.size) && candidate.size >= 0 ? { size: candidate.size } : {})
    }
    // Persisted history has the server-relative attachment name but not the
    // in-memory upload token. Accept only a strictly relative workspace path;
    // absolute paths and traversal can never cross the session sandbox.
    if (typeof candidate.name === 'string' && candidate.name.trim()) {
      const name = candidate.name.replace(/\\/g, '/')
      if (!name.startsWith('/') && !/^[A-Za-z]:\//.test(name) && !name.split('/').includes('..')) {
        return [{ name, type: typeof candidate.type === 'string' ? candidate.type : 'application/octet-stream', ...metadata }]
      }
    }
    if (typeof candidate.remoteUploadId !== 'string') return []
    const saved = uploaded.get(candidate.remoteUploadId)
    if (!saved || saved.sessionId !== sessionId || saved.target !== targetKey(target)) {
      throw new Error('远端附件所属连接或会话已变化，请重新选择文件上传')
    }
    return [{ name: saved.path, type: saved.type, ...metadata }]
  })
}

export function clearRemoteAttachments(): void { uploaded.clear() }
