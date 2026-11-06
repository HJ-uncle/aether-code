/** A delivery is an explicit immutable publication, never a file-change receipt. */
export interface FinalResultItem {
  producerChildSessionId?: string
  producerRunId?: string
  producerArtifactId?: string
  id: string
  name: string
  path: string
  mimeType: string
  size: number
  sha256: string
  assetId: string
  kind: 'image' | 'file'
}

export interface FinalResult {
  schemaVersion: 1
  sessionId: string
  turnId: string
  runId: string
  assistantMessageId: string
  text: string
  items: FinalResultItem[]
  publishedAt: number
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\u0000-\u001f]/.test(value)

/** Reject the whole manifest on ambiguity rather than mixing verified and foreign assets. */
export function normalizeFinalResult(value: unknown): FinalResult | undefined {
  if (!record(value) || value.schemaVersion !== 1 || !identity(value.sessionId) || !identity(value.turnId) ||
    !identity(value.runId) || !identity(value.assistantMessageId) || typeof value.text !== 'string' ||
    !Array.isArray(value.items) || value.items.length > 64 || typeof value.publishedAt !== 'number' ||
    !Number.isFinite(value.publishedAt) || value.publishedAt <= 0) return undefined
  const ids = new Set<string>(), assets = new Set<string>()
  const items: FinalResultItem[] = []
  for (const item of value.items) {
    if (!record(item) || !identity(item.id) || !identity(item.assetId) || !identity(item.name) || !identity(item.path) ||
      !identity(item.mimeType) || !/^[a-z\d.+-]+\/[a-z\d.+-]+$/i.test(item.mimeType) ||
      typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0 ||
      typeof item.sha256 !== 'string' || !/^(?:sha256:)?[a-f\d]{64}$/i.test(item.sha256) ||
      !['image', 'file'].includes(String(item.kind)) || ids.has(item.id) || assets.has(item.assetId)) return undefined
    if (item.kind === 'image' && !item.mimeType.startsWith('image/')) return undefined
    const producerKeys = ['producerChildSessionId', 'producerRunId', 'producerArtifactId'] as const
    if (producerKeys.some(key => item[key] !== undefined && !identity(item[key]))) return undefined
    if (producerKeys.some(key => item[key] !== undefined) && producerKeys.some(key => item[key] === undefined)) return undefined
    ids.add(item.id); assets.add(item.assetId)
    items.push({ id: item.id, name: item.name, path: item.path, mimeType: item.mimeType, size: item.size,
      sha256: item.sha256, assetId: item.assetId, kind: item.kind as FinalResultItem['kind'],
      ...(item.producerChildSessionId ? { producerChildSessionId: String(item.producerChildSessionId),
        producerRunId: String(item.producerRunId), producerArtifactId: String(item.producerArtifactId) } : {}) })
  }
  return { schemaVersion: 1, sessionId: value.sessionId, turnId: value.turnId, runId: value.runId,
    assistantMessageId: value.assistantMessageId, text: value.text, items, publishedAt: value.publishedAt }
}
