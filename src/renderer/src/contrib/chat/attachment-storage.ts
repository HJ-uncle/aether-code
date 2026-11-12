import type { ChatAttachment } from '../../core/engine/useChat'

/** Upload tokens belong to the live main process; replay uses the checked path. */
export function storedAttachments(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return []
    const file = item as Record<string, unknown>
    if (typeof file.path !== 'string' || typeof file.name !== 'string' || typeof file.type !== 'string' ||
      typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size < 0) return []
    return [{ path: file.path, name: file.name, type: file.type, size: file.size,
      ...(file.inlineReference === true ? { inlineReference: true } : {}),
      ...(typeof file.attachmentId === 'string' && file.attachmentId && file.attachmentId.length <= 4096 ? { attachmentId: file.attachmentId } : {}),
      ...(typeof file.referenceLabel === 'string' && file.referenceLabel && file.referenceLabel.length <= 512 ? { referenceLabel: file.referenceLabel } : {}) }]
  })
}
