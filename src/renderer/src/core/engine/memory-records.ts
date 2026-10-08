import { request } from './client'
import { assertEngineSource, getEngineSource } from './source'

export type MemoryRecordScope = 'global' | 'session'
export type MemoryRecordType = 'fact' | 'preference' | 'decision' | 'lesson' | 'narrative' | 'milestone'

export interface MemoryRecord {
  id: string
  scope: MemoryRecordScope
  sessionId?: string
  type: MemoryRecordType
  summary: string
  detail?: string | null
  importance?: number
  tags?: string[]
  createdAt?: number
  updatedAt?: number
  timestamp?: number
  sourceSessionId?: string | null
  sourceContextSnapshot?: string | null
  [key: string]: unknown
}

export interface MemoryRecordPage {
  data: MemoryRecord[]
  pagination: { current: number; pageSize: number; total: number; totalPages: number }
}

export interface MemoryRecordInput {
  summary: string
  type?: MemoryRecordType
  detail?: string | null
  importance?: number
  tags?: string[]
}

function scopeQuery(scope: MemoryRecordScope, sessionId?: string): Record<string, string> {
  if (scope === 'session' && !sessionId?.trim()) throw new Error('选择会话记忆前需要提供会话 ID')
  return { scope, ...(scope === 'session' ? { sessionId: sessionId!.trim() } : {}) }
}

function check<T>(source: number, result: { ok: boolean; message: string; data: T | null }): T {
  assertEngineSource(source)
  if (!result.ok) throw new Error(result.message || '记忆请求失败')
  return result.data as T
}

export async function listMemoryRecords(input: {
  scope: MemoryRecordScope
  sessionId?: string
  keyword?: string
  type?: MemoryRecordType | ''
  current?: number
  pageSize?: number
}): Promise<MemoryRecordPage> {
  const source = getEngineSource()
  const result = await request<MemoryRecord[]>({
    method: 'GET',
    path: '/memory/list',
    query: {
      ...scopeQuery(input.scope, input.sessionId),
      keyword: input.keyword?.trim() || undefined,
      type: input.type || undefined,
      current: input.current ?? 1,
      pageSize: input.pageSize ?? 20
    }
  })
  const data = check(source, result) ?? []
  return {
    data: Array.isArray(data) ? data : [],
    pagination: result.pagination ?? { current: input.current ?? 1, pageSize: input.pageSize ?? 20, total: Array.isArray(data) ? data.length : 0, totalPages: 1 }
  }
}

export async function getMemoryRecord(id: string, scope: MemoryRecordScope, sessionId?: string): Promise<MemoryRecord> {
  const source = getEngineSource()
  const result = await request<MemoryRecord>({ method: 'GET', path: `/memory/${encodeURIComponent(id)}`, query: scopeQuery(scope, sessionId) })
  return check(source, result)
}

export async function createMemoryRecord(scope: MemoryRecordScope, sessionId: string | undefined, input: MemoryRecordInput): Promise<MemoryRecord> {
  const source = getEngineSource()
  const result = await request<MemoryRecord>({ method: 'POST', path: '/memory/nodes', query: scopeQuery(scope, sessionId), body: { ...input, type: input.type ?? 'fact', importance: input.importance ?? 0.5 } })
  return check(source, result)
}

export async function updateMemoryRecord(id: string, scope: MemoryRecordScope, sessionId: string | undefined, input: MemoryRecordInput): Promise<MemoryRecord> {
  const source = getEngineSource()
  const result = await request<MemoryRecord>({ method: 'PUT', path: `/memory/${encodeURIComponent(id)}`, query: scopeQuery(scope, sessionId), body: input })
  return check(source, result)
}

export async function deleteMemoryRecord(id: string, scope: MemoryRecordScope, sessionId?: string): Promise<void> {
  const source = getEngineSource()
  const result = await request({ method: 'DELETE', path: `/memory/${encodeURIComponent(id)}`, query: scopeQuery(scope, sessionId) })
  check(source, result)
}

export interface MemorySessionOption { sessionId: string; title?: string; lastAt?: number }

export async function listMemorySessions(): Promise<MemorySessionOption[]> {
  const source = getEngineSource()
  const result = await request<MemorySessionOption[]>({ method: 'GET', path: '/conversation/sessions' })
  const rows = check(source, result)
  return Array.isArray(rows) ? rows.filter(row => typeof row?.sessionId === 'string' && row.sessionId.trim()) : []
}
