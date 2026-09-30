import { getEngineStorageKey, sessionStorageKey, subscribeEngineSource } from '../../core/engine/source'

/**
 * 本地合成会话（占位条目）
 *
 * 引擎的 GET /conversation/sessions 只列举「有对话记录」的会话（conversations
 * 表按 session_id 分组），而「新建会话」只是换了个 sessionId —— 引擎侧零记录，
 * 拉回来的列表自然还是原来那几条，看起来就像点了新建没反应。
 *
 * 对齐 wuzu-client 的 pendingSynth：在新建这一刻先在本地登记一条占位条目，
 * 列表渲染时与引擎返回的真条目合并（按 sessionId 去重）；第一条消息落库、
 * 引擎开始返回该会话后，占位条目自动退场。
 *
 * 存 sessionStorage 而非 localStorage：与折叠记忆同理属会话语义，刷新即清。
 * 模块级数组即快照本身，无变更时不换引用，保证 useSyncExternalStore 稳定。
 */

const STORAGE_KEY = 'aether-pending-sessions'
/** 上限：连点新建会攒占位条目，超出丢最旧的 */
const PENDING_LIMIT = 20

export interface PendingSession {
  sessionId: string
  createdAt: number
  lastAt: number
}

let entries: PendingSession[] | null = null
let storageSource = getEngineStorageKey()
const listeners = new Set<() => void>()

function isPendingSession(value: unknown): value is PendingSession {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<PendingSession>
  return typeof item.sessionId === 'string' && typeof item.lastAt === 'number'
}

/** 首次访问时从 sessionStorage 水合；之后以内存数组为准 */
function load(): PendingSession[] {
  if (entries) return entries
  try {
    const raw = sessionStorage.getItem(sessionStorageKey(STORAGE_KEY, storageSource))
    const parsed: unknown = raw ? JSON.parse(raw) : null
    entries = Array.isArray(parsed) ? parsed.filter(isPendingSession) : []
  } catch {
    entries = []
  }
  return entries
}

function commit(next: PendingSession[]): void {
  entries = next.length > PENDING_LIMIT ? next.slice(next.length - PENDING_LIMIT) : next
  try {
    sessionStorage.setItem(sessionStorageKey(STORAGE_KEY, storageSource), JSON.stringify(entries))
  } catch {
    // 存储满/被禁用时降级为会话内记忆，不影响列表显示
  }
  for (const listener of listeners) listener()
}

/** 新建会话时登记占位条目（重复登记视为无操作） */
export function registerPendingSession(sessionId: string): void {
  if (!sessionId) return
  const list = load()
  if (list.some((item) => item.sessionId === sessionId)) return
  const now = Date.now()
  commit([...list, { sessionId, createdAt: now, lastAt: now }])
}

/** 发出首条消息后调用：刷新时间戳，让该条目继续待在列表顶部 */
export function touchPendingSession(sessionId: string): void {
  const list = load()
  const index = list.findIndex((item) => item.sessionId === sessionId)
  if (index < 0) return
  const next = list.slice()
  next[index] = { ...next[index], lastAt: Date.now() }
  commit(next)
}

/** 删除本地占位条目（引擎侧尚无记录时直接删本地） */
export function removePendingSession(sessionId: string): void {
  const list = load()
  if (!list.some((item) => item.sessionId === sessionId)) return
  commit(list.filter((item) => item.sessionId !== sessionId))
}

/** 引擎已经返回的会话：对应占位条目退场，避免同一条会话出现两行 */
export function prunePendingSessions(known: Set<string>): void {
  const list = load()
  const next = list.filter((item) => !known.has(item.sessionId))
  if (next.length !== list.length) commit(next)
}

export function subscribePendingSessions(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function listPendingSessions(): PendingSession[] {
  return load()
}

/**
 * 「会话列表该重新拉一次」的信号
 *
 * 占位条目只在引擎返回真条目后才退场，而引擎落库发生在首条消息发出之后
 * （回合结束前后），此时 lastSessionId 并没有变化，列表页的既有刷新 effect
 * 不会被触发。ChatView 在流结束时发一次信号，列表页收到后重新拉取。
 */
const refreshListeners = new Set<() => void>()

export function requestSessionListRefresh(): void {
  for (const listener of refreshListeners) listener()
}

export function subscribeSessionListRefresh(listener: () => void): () => void {
  refreshListeners.add(listener)
  return () => {
    refreshListeners.delete(listener)
  }
}

subscribeEngineSource(() => {
  const next = getEngineStorageKey()
  if (next === storageSource) return
  storageSource = next
  entries = null
  for (const listener of listeners) listener()
})
