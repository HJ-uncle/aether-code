/**
 * 长期记忆设置客户端。
 *
 * 记忆设置由引擎按 tenant + sessionId 持久化，渲染层不复制一份到
 * localStorage。这样本地与远端连接的会话都以服务端确认值为准。
 */
import { request } from './client'
import { assertEngineSource, getEngineSource } from './source'

export type MemoryScope = 'off' | 'global' | 'session'

export interface MemorySettings {
  sessionId: string
  memoryScope: MemoryScope
  effectiveScope: MemoryScope
  /** 引擎是否启用了长期记忆能力（环境变量关闭时为 false）。 */
  enabled: boolean
}

export const MEMORY_SCOPES: readonly MemoryScope[] = ['off', 'global', 'session']

export interface MemoryScopeDescriptor {
  value: MemoryScope
  label: string
  summary: string
}

export const MEMORY_SCOPE_DESCRIPTORS: readonly MemoryScopeDescriptor[] = [
  { value: 'off', label: '关闭记忆', summary: '不读取或写入长期记忆' },
  { value: 'global', label: '全局记忆', summary: '可供其他会话使用的共享记忆' },
  { value: 'session', label: '仅本会话', summary: '只在当前会话中读取和写入' }
]

export function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === 'string' && (MEMORY_SCOPES as readonly string[]).includes(value)
}

/** 兼容服务端将 scope 命名为 memoryScope 的两种响应包装。 */
export function parseMemorySettings(data: unknown, expectedSessionId: string): MemorySettings {
  if (!data || typeof data !== 'object') throw new Error('引擎返回了无效的记忆设置')
  const value = data as Record<string, unknown>
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId : expectedSessionId
  if (sessionId !== expectedSessionId) throw new Error('记忆设置响应的会话不匹配，请重新读取')
  const memoryScope = value.memoryScope ?? value.scope
  if (!isMemoryScope(memoryScope)) throw new Error('引擎返回了未知的记忆范围，请重新读取')
  const effectiveScope = isMemoryScope(value.effectiveScope) ? value.effectiveScope : memoryScope
  return {
    sessionId,
    memoryScope,
    effectiveScope,
    enabled: value.enabled !== false
  }
}

export async function getMemorySettings(sessionId: string): Promise<MemorySettings> {
  if (!sessionId) throw new Error('缺少会话 ID，无法读取记忆设置')
  const source = getEngineSource()
  const result = await request({ method: 'GET', path: '/memory/settings', query: { sessionId } })
  assertEngineSource(source)
  if (!result.ok) throw new Error(result.message || '读取记忆设置失败')
  return parseMemorySettings(result.data, sessionId)
}

export async function setMemoryScope(sessionId: string, memoryScope: MemoryScope): Promise<MemorySettings> {
  if (!sessionId) throw new Error('缺少会话 ID，无法切换记忆范围')
  if (!isMemoryScope(memoryScope)) throw new Error(`未知的记忆范围：${String(memoryScope)}`)
  const source = getEngineSource()
  const result = await request({
    method: 'PUT',
    path: '/memory/settings',
    body: { sessionId, memoryScope }
  })
  assertEngineSource(source)
  if (!result.ok) throw new Error(result.message || '切换记忆范围失败')
  // Older compatible engines may acknowledge a successful PUT with no body.
  // The requested scope is still the confirmed value in that case.
  if (result.data === undefined || result.data === null) {
    return { sessionId, memoryScope, effectiveScope: memoryScope, enabled: true }
  }
  return parseMemorySettings(result.data, sessionId)
}
