import { requestOrThrow, upload } from './client'
import { getEngineStorageKey } from './source'

export const MAX_KNOWLEDGE_DOCUMENT_BYTES = 1024 * 1024
export const MAX_KNOWLEDGE_UPLOAD_BYTES = 2 * 1024 * 1024
export const KNOWLEDGE_SUPPORTED_FORMATS = '文本/代码：.txt .md .markdown .json .html .htm .xml .svg .csv .ts .tsx .js .jsx .py .go .java .c .cpp .h .hpp .rs .css .scss .less .sh .yaml .yml .toml .ini .lock .log；表格：.xlsx .xls；文档：.docx .doc；PDF：.pdf（扫描件按 OCR 处理）；图片 OCR：.png .jpg .jpeg .gif .webp .bmp .tiff。'
export function knowledgeDocumentByteLength(value: string): number { return new Blob([value]).size }
export function validateKnowledgeDocumentText(value: string): void {
  if (!value.trim()) throw new Error('文档正文不能为空')
  if (knowledgeDocumentByteLength(value) > MAX_KNOWLEDGE_DOCUMENT_BYTES) throw new Error('文档正文不能超过 1 MiB')
}
export function isKnowledgeSourceCurrent(requestSource: number, currentSource: number): boolean { return requestSource === currentSource }

export interface KnowledgeBase {
  id: string
  name: string
  description: string
  documentCount?: number
  chunkCount?: number
  createdAt: number
  updatedAt?: number
}

export interface KnowledgeDocument {
  id: string
  knowledgeBaseId?: string | null
  filename: string
  contentType: string
  content?: string
  contentExact?: boolean
  chunkCount: number
  status?: 'ready' | 'processing' | 'error'
  error?: string | null
  createdAt: number
  updatedAt?: number
}

export interface KnowledgeSearchResult {
  chunkId: string
  documentId: string
  knowledgeBaseId?: string | null
  filename: string
  content: string
  score: number
  chunkIndex: number
}

export interface KnowledgeDocumentInput {
  filename: string
  content: string
  knowledgeBaseId?: string
  contentType?: string
}

function encode(value: string): string { return encodeURIComponent(value) }

export function listKnowledgeBases(): Promise<KnowledgeBase[]> {
  return requestOrThrow<KnowledgeBase[]>({ method: 'GET', path: '/knowledge/bases' })
}
export function createKnowledgeBase(input: { name: string; description?: string }): Promise<KnowledgeBase> {
  return requestOrThrow<KnowledgeBase>({ method: 'POST', path: '/knowledge/bases', body: input })
}
export function getKnowledgeBase(id: string): Promise<KnowledgeBase> {
  return requestOrThrow<KnowledgeBase>({ method: 'GET', path: '/knowledge/bases/' + encode(id) })
}
export function updateKnowledgeBase(id: string, input: { name?: string; description?: string }): Promise<KnowledgeBase> {
  return requestOrThrow<KnowledgeBase>({ method: 'PUT', path: '/knowledge/bases/' + encode(id), body: input })
}
export function deleteKnowledgeBase(id: string): Promise<{ deleted: boolean }> {
  return requestOrThrow<{ deleted: boolean }>({ method: 'DELETE', path: '/knowledge/bases/' + encode(id) })
}
export function listKnowledgeDocuments(knowledgeBaseId?: string): Promise<KnowledgeDocument[]> {
  return requestOrThrow<KnowledgeDocument[]>({
    method: 'GET', path: '/knowledge/documents',
    query: knowledgeBaseId ? { knowledgeBaseId } : undefined
  })
}
export function getKnowledgeDocument(id: string): Promise<KnowledgeDocument> {
  return requestOrThrow<KnowledgeDocument>({ method: 'GET', path: '/knowledge/documents/' + encode(id) })
}
export function uploadKnowledgeDocument(input: KnowledgeDocumentInput): Promise<KnowledgeDocument> {
  return requestOrThrow<KnowledgeDocument>({ method: 'POST', path: '/knowledge/documents', body: input })
}
export async function uploadKnowledgeFile(file: File, knowledgeBaseId?: string): Promise<KnowledgeDocument> {
  const result = await upload<KnowledgeDocument>({
    path: '/knowledge/documents', fileName: file.name, type: file.type || 'application/octet-stream',
    data: new Uint8Array(await file.arrayBuffer()), fields: knowledgeBaseId ? { knowledgeBaseId } : undefined
  })
  if (!result.ok) throw new Error(result.message || `请求失败（code ${result.code}）`)
  return result.data as KnowledgeDocument
}
export function listKnowledgeFormats(): Promise<{ extensions: string[]; description: string }> {
  return requestOrThrow<{ extensions: string[]; description: string }>({ method: 'GET', path: '/knowledge/formats' })
}
export function updateKnowledgeDocument(id: string, input: Partial<KnowledgeDocumentInput>): Promise<KnowledgeDocument> {
  return requestOrThrow<KnowledgeDocument>({ method: 'PUT', path: '/knowledge/documents/' + encode(id), body: input })
}
export function deleteKnowledgeDocument(id: string): Promise<{ deleted: boolean }> {
  return requestOrThrow<{ deleted: boolean }>({ method: 'DELETE', path: '/knowledge/documents/' + encode(id) })
}
export function searchKnowledge(query: string, limit = 5, knowledgeBaseIds?: readonly string[]): Promise<KnowledgeSearchResult[]> {
  const normalized = query.trim()
  if (!normalized) return Promise.resolve([])
  return requestOrThrow<KnowledgeSearchResult[]>({
    method: 'POST', path: '/knowledge/search',
    body: { query: normalized, limit, knowledgeBaseIds: knowledgeBaseIds?.length ? [...new Set(knowledgeBaseIds)] : undefined }
  })
}

/** Session-local binding consumed by chat payload wiring; no global settings mutation. */
export function knowledgeBindingKey(sessionId: string, source = getEngineStorageKey()): string {
  return 'aether:knowledge-bases:' + (source || 'embedded') + ':' + sessionId
}
export function loadKnowledgeBinding(sessionId: string, source?: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(knowledgeBindingKey(sessionId, source)) || '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch { return [] }
}
export function saveKnowledgeBinding(sessionId: string, ids: readonly string[], source?: string): string[] {
  const normalized = [...new Set(ids.filter(Boolean))]
  try { localStorage.setItem(knowledgeBindingKey(sessionId, source), JSON.stringify(normalized)) } catch { /* optional persistence */ }
  return normalized
}
export function clearKnowledgeBinding(sessionId: string, source?: string): void {
  try { localStorage.removeItem(knowledgeBindingKey(sessionId, source)) } catch { /* optional persistence */ }
}


export function getKnowledgeBaseBindingIds(sessionId: string, source?: string): string[] { return loadKnowledgeBinding(sessionId, source) }
