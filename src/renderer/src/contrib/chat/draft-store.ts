import { getEngineStorageKey, sessionStorageKey } from '../../core/engine/source'
import { isStoredMention, type Mention } from './mention-context'

/**
 * 每会话输入草稿持久化（对齐 wuzu lobster-chat:draft）
 *
 * 保存文本和引用快照，兼容旧的纯文本槽位；防抖与退出前刷新由调用方控制。
 */

const DRAFTS_KEY = 'aether:chatDrafts'
/** 草稿槽位上限：超出时丢最旧的，防止无限增长 */
const MAX_SLOTS = 100

export interface ChatDraft { text: string; mentions: Mention[] }

function readTable(source: string): Record<string, ChatDraft> {
  try {
    const raw = localStorage.getItem(sessionStorageKey(DRAFTS_KEY, source))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const table: Record<string, ChatDraft> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value) table[key] = { text: value, mentions: [] }
      else if (value && typeof value === 'object' && 'text' in value && typeof value.text === 'string') {
        const mentions = 'mentions' in value && Array.isArray(value.mentions)
          ? value.mentions.filter(isStoredMention) : []
        table[key] = { text: value.text, mentions }
      }
    }
    return table
  } catch {
    return {}
  }
}

export function loadChatDraft(sessionId: string, source = getEngineStorageKey()): string {
  return loadChatDraftState(sessionId, source).text
}

export function loadChatDraftState(sessionId: string, source = getEngineStorageKey()): ChatDraft {
  return readTable(source)[sessionId] ?? { text: '', mentions: [] }
}

export function saveChatDraft(sessionId: string, text: string, source = getEngineStorageKey(), mentions: Mention[] = []): void {
  if (!sessionId) return
  const table = readTable(source)
  if (!text.trim()) {
    delete table[sessionId]
  } else {
    // 重新插入以刷新键序（Object 键序即插入序，当 LRU 用）
    delete table[sessionId]
    table[sessionId] = { text, mentions }
    const keys = Object.keys(table)
    while (keys.length > MAX_SLOTS) {
      delete table[keys.shift() as string]
    }
  }
  try {
    localStorage.setItem(sessionStorageKey(DRAFTS_KEY, source), JSON.stringify(table))
  } catch {
    // 存储写失败不打断输入
  }
}
