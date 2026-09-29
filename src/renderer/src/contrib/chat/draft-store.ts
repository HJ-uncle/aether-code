/**
 * 每会话输入草稿持久化（对齐 wuzu lobster-chat:draft）
 *
 * localStorage 单 key 聚合：{ [sessionId]: 文本 }，防抖写入由调用方控制。
 * 只存序列化后的纯文本（@路径 token 形式），恢复时由 MentionInput 重建 chip。
 */

const DRAFTS_KEY = 'aether:chatDrafts'
/** 草稿槽位上限：超出时丢最旧的，防止无限增长 */
const MAX_SLOTS = 100

function readTable(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const table: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value) table[key] = value
    }
    return table
  } catch {
    return {}
  }
}

export function loadChatDraft(sessionId: string): string {
  return readTable()[sessionId] ?? ''
}

export function saveChatDraft(sessionId: string, text: string): void {
  if (!sessionId) return
  const table = readTable()
  if (!text.trim()) {
    delete table[sessionId]
  } else {
    // 重新插入以刷新键序（Object 键序即插入序，当 LRU 用）
    delete table[sessionId]
    table[sessionId] = text
    const keys = Object.keys(table)
    while (keys.length > MAX_SLOTS) {
      delete table[keys.shift() as string]
    }
  }
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(table))
  } catch {
    // 存储写失败不打断输入
  }
}
