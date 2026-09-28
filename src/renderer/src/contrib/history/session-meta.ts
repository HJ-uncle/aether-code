/**
 * 会话本地元数据（对齐 wuzu-client codeSessionMeta.ts）
 *
 * 引擎只知道「会话有哪些消息」，置顶 / 自定义名称 / 收藏 / 标记颜色 /
 * 绑定的工作区目录 这些纯界面层的偏好引擎不该背 —— 存渲染端 localStorage，
 * 单 key 整表读写（会话量级几十上百条，性能无压力）。
 *
 * 订阅模式照 app-settings-navigation：模块级快照 + Set<listener>，
 * 组件用 useSyncExternalStore 接入，跨组件改动即时生效。
 */

export interface SessionMeta {
  /** 用户自定义名称（重命名）；优先于引擎侧标题展示 */
  name?: string
  /** 置顶：永远排在列表最前 */
  pinned?: boolean
  /** 收藏（本地标记；头部 ☆ 过滤用） */
  favorite?: boolean
  /** 标记颜色 key（SESSION_TAG_COLORS 之一）；undefined = 无标记 */
  color?: string
  /** 该会话最近发消息时所在的工作区目录（「打开项目目录」用） */
  workspacePath?: string
}

/** 标记色板（对齐 wuzu SESSION_TAG_COLORS，顺序即排序时的颜色顺序） */
export const SESSION_TAG_COLORS: ReadonlyArray<{ key: string; dot: string; label: string }> = [
  { key: 'red', dot: '#ff453a', label: '红' },
  { key: 'orange', dot: '#ff9f0a', label: '橙' },
  { key: 'yellow', dot: '#ffd60a', label: '黄' },
  { key: 'green', dot: '#30d158', label: '绿' },
  { key: 'blue', dot: '#0a84ff', label: '蓝' },
  { key: 'purple', dot: '#bf5af2', label: '紫' }
]

const STORAGE_KEY = 'aether:sessionMeta'

let table: Record<string, SessionMeta> = load()
const listeners = new Set<() => void>()

function load(): Record<string, SessionMeta> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, SessionMeta>)
      : {}
  } catch {
    return {}
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(table))
  } catch {
    // 存储满等极端情况：丢了偏好不影响主流程，静默
  }
}

function notify(): void {
  for (const listener of listeners) listener()
}

/** useSyncExternalStore 快照：整表（引用在 patch 后必变） */
export function getSessionMetaTable(): Record<string, SessionMeta> {
  return table
}

export function getSessionMeta(sessionId: string): SessionMeta {
  return table[sessionId] ?? {}
}

/**
 * 合并写一条会话的元数据。传入 undefined 值表示清除该字段；
 * 合并后为空对象的键直接从表里删掉，避免无限膨胀。
 */
export function patchSessionMeta(sessionId: string, patch: Partial<SessionMeta>): void {
  const merged: SessionMeta = { ...table[sessionId] }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete (merged as Record<string, unknown>)[key]
    else (merged as Record<string, unknown>)[key] = value
  }
  const next = { ...table }
  if (Object.keys(merged).length === 0) delete next[sessionId]
  else next[sessionId] = merged
  table = next
  persist()
  notify()
}

export function subscribeSessionMeta(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 删除整条元数据（会话被删除时清理残留偏好） */
export function removeSessionMeta(sessionId: string): void {
  if (!(sessionId in table)) return
  const next = { ...table }
  delete next[sessionId]
  table = next
  persist()
  notify()
}
