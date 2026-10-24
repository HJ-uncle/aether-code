/**
 * 长期记忆设置客户端。
 *
 * 记忆设置由引擎按 tenant + sessionId 持久化，渲染层不复制一份到
 * localStorage。这样本地与远端连接的会话都以服务端确认值为准。
 */
import { request } from './client'
import { assertEngineSource, getEngineSource } from './source'

export type MemoryScope = 'off' | 'global' | 'session'
export type MemoryReadScope = 'global' | 'session'

export interface MemoryPreferences {
  globalEnabled: boolean
  sessionDefaultEnabled: boolean
  enabled: boolean
}
export type MemoryPreferencesPatch = Partial<Pick<MemoryPreferences, 'globalEnabled' | 'sessionDefaultEnabled'>>

export interface MemorySettings {
  sessionId: string
  memoryScope: MemoryScope
  effectiveScope: MemoryScope
  /** 引擎是否启用了长期记忆能力（环境变量关闭时为 false）。 */
  enabled: boolean
  /** New engines expose independent global and session policies. */
  globalEnabled?: boolean
  sessionDefaultEnabled?: boolean
  sessionOverride?: boolean | null
  sessionEnabled?: boolean
  effectiveScopes?: MemoryReadScope[]
}

export const MEMORY_DISABLED_REASON = 'MEMORY_DISABLED_BY_SERVER'
export const MEMORY_DISABLED_MESSAGE = '服务端已关闭长期记忆，请在服务端启用后重试。'

/** A rejected capability change confirms that the requested scope was not saved. */
export class MemoryDisabledError extends Error {
  constructor(readonly settings?: MemorySettings, readonly preferences?: MemoryPreferences) {
    super(MEMORY_DISABLED_MESSAGE)
    this.name = 'MemoryDisabledError'
  }
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
  const enabled = value.enabled !== false
  const effectiveScope = !enabled ? 'off' : isMemoryScope(value.effectiveScope) ? value.effectiveScope : memoryScope
  for (const field of ['globalEnabled', 'sessionDefaultEnabled', 'sessionEnabled'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') throw new Error('引擎返回了无效的记忆开关')
  }
  if (value.sessionOverride !== undefined && value.sessionOverride !== null && typeof value.sessionOverride !== 'boolean') {
    throw new Error('引擎返回了无效的会话记忆覆盖值')
  }
  if (value.effectiveScopes !== undefined && (!Array.isArray(value.effectiveScopes) ||
    value.effectiveScopes.some(scope => scope !== 'global' && scope !== 'session') || new Set(value.effectiveScopes).size !== value.effectiveScopes.length)) {
    throw new Error('引擎返回了未知的有效记忆范围')
  }
  return {
    sessionId,
    memoryScope,
    effectiveScope,
    enabled,
    ...(typeof value.globalEnabled === 'boolean' ? { globalEnabled: value.globalEnabled } : {}),
    ...(typeof value.sessionDefaultEnabled === 'boolean' ? { sessionDefaultEnabled: value.sessionDefaultEnabled } : {}),
    ...(value.sessionOverride === null || typeof value.sessionOverride === 'boolean' ? { sessionOverride: value.sessionOverride } : {}),
    ...(typeof value.sessionEnabled === 'boolean' ? { sessionEnabled: value.sessionEnabled } : {}),
    ...(Array.isArray(value.effectiveScopes) ? { effectiveScopes: enabled ? value.effectiveScopes as MemoryReadScope[] : [] } : {})
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
  if (!result.ok) throw memoryRequestError(result, '切换记忆范围失败', sessionId)
  // Older compatible engines may acknowledge a successful PUT with no body.
  // The requested scope is still the confirmed value in that case.
  if (result.data === undefined || result.data === null) {
    return { sessionId, memoryScope, effectiveScope: memoryScope, enabled: true }
  }
  return parseMemorySettings(result.data, sessionId)
}

function memoryRequestError(result: { code: number; message: string; data: unknown }, fallback: string, sessionId?: string): Error {
  const data = result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : undefined
  // Older engines expose this capability refusal only as English prose.
  // Unrelated 409 conflicts and transport failures retain their actual cause.
  if ([409, 40900].includes(result.code) && (data?.reason === MEMORY_DISABLED_REASON ||
    /^Long-term memory is disabled by server configuration(?:;|$)/i.test(result.message))) {
    let settings: MemorySettings | undefined
    if (data?.enabled === false && sessionId) {
      try { settings = parseMemorySettings(data, sessionId) } catch { /* The store re-reads unverified details. */ }
    }
    let preferences: MemoryPreferences | undefined
    if (data?.enabled === false && !sessionId) {
      try { preferences = parseMemoryPreferences(data) } catch { /* Keep the last confirmed preferences with disabled capability. */ }
    }
    return new MemoryDisabledError(settings, preferences)
  }
  return new Error(result.message || fallback)
}

export function parseMemoryPreferences(data: unknown): MemoryPreferences {
  if (!data || typeof data !== 'object') throw new Error('引擎返回了无效的记忆默认设置')
  const value = data as Record<string, unknown>
  if (typeof value.globalEnabled !== 'boolean' || typeof value.sessionDefaultEnabled !== 'boolean' || typeof value.enabled !== 'boolean') {
    throw new Error('引擎未提供有效的独立记忆开关，请升级引擎后重试')
  }
  return { globalEnabled: value.globalEnabled, sessionDefaultEnabled: value.sessionDefaultEnabled, enabled: value.enabled }
}

export async function getMemoryPreferences(): Promise<MemoryPreferences> {
  const source = getEngineSource()
  const result = await request({ method: 'GET', path: '/memory/preferences' })
  assertEngineSource(source)
  if (!result.ok) throw memoryRequestError(result, '读取记忆默认设置失败')
  return parseMemoryPreferences(result.data)
}

export async function setMemoryPreferences(patch: MemoryPreferencesPatch): Promise<MemoryPreferences> {
  const keys = Object.keys(patch)
  if (!keys.length || keys.some(key => key !== 'globalEnabled' && key !== 'sessionDefaultEnabled') ||
    (patch.globalEnabled !== undefined && typeof patch.globalEnabled !== 'boolean') ||
    (patch.sessionDefaultEnabled !== undefined && typeof patch.sessionDefaultEnabled !== 'boolean')) {
    throw new Error('记忆默认设置必须包含有效的布尔值')
  }
  const source = getEngineSource()
  const result = await request({ method: 'PUT', path: '/memory/preferences', body: patch })
  assertEngineSource(source)
  if (!result.ok) throw memoryRequestError(result, '保存记忆默认设置失败')
  return parseMemoryPreferences(result.data)
}

export async function setSessionMemoryEnabled(sessionId: string, sessionEnabled: boolean | null): Promise<MemorySettings> {
  if (!sessionId) throw new Error('缺少会话 ID，无法切换会话记忆')
  if (sessionEnabled !== null && typeof sessionEnabled !== 'boolean') throw new Error('会话记忆开关必须为布尔值或 null')
  const source = getEngineSource()
  const result = await request({ method: 'PUT', path: '/memory/settings', body: { sessionId, sessionEnabled } })
  assertEngineSource(source)
  if (!result.ok) throw memoryRequestError(result, '切换会话记忆失败', sessionId)
  return parseMemorySettings(result.data, sessionId)
}
