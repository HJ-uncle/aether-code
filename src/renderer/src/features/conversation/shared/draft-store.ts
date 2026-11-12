import { getEngineStorageKey, sessionStorageKey } from '../../../core/engine/source'
import { isStoredMention, type Mention } from './mention-context'
import type { ChatAttachment } from '../../../core/engine/useChat'
import { storedAttachments } from './attachment-storage'

/**
 * 每会话输入草稿持久化（对齐 wuzu lobster-chat:draft）
 *
 * 保存文本和引用快照，兼容旧的纯文本槽位；防抖与退出前刷新由调用方控制。
 */

const DRAFTS_KEY = 'aether:chatDrafts'
/** 草稿槽位上限：超出时丢最旧的，防止无限增长 */
const MAX_SLOTS = 100

export interface ChatDraft { text: string; mentions: Mention[]; revision: number; attachments?: ChatAttachment[]; attachmentRoot?: string }
export interface ChatDraftAttachmentState { attachments: readonly ChatAttachment[]; root: string | null }
export const nextChatDraftRevision = (previous = 0): number => Math.max(Date.now(), previous + 1)

function readTable(source: string): Record<string, ChatDraft> {
  try {
    const raw = localStorage.getItem(sessionStorageKey(DRAFTS_KEY, source))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const table: Record<string, ChatDraft> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value) table[key] = { text: value, mentions: [], revision: nextChatDraftRevision() }
      else if (value && typeof value === 'object' && 'text' in value && typeof value.text === 'string') {
        const mentions = 'mentions' in value && Array.isArray(value.mentions)
          ? value.mentions.filter(isStoredMention) : []
        const revision = 'revision' in value && typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : nextChatDraftRevision()
        table[key] = { text: value.text, mentions, revision,
          ...('attachments' in value ? { attachments: storedAttachments(value.attachments) } : {}),
          ...('attachmentRoot' in value && typeof value.attachmentRoot === 'string' ? { attachmentRoot: value.attachmentRoot } : {}) }
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
  return readTable(source)[sessionId] ?? { text: '', mentions: [], revision: nextChatDraftRevision() }
}

function attachmentFields(previous: ChatDraft | undefined, text: string, mentions: Mention[], state?: ChatDraftAttachmentState): Pick<ChatDraft, 'attachments' | 'attachmentRoot'> {
  if (state) return { attachments: storedAttachments(state.attachments), ...(state.root !== null ? { attachmentRoot: state.root } : {}) }
  // Existing callers use an empty draft to acknowledge a completed submission.
  if (!text.trim() && !mentions.length) return {}
  return previous ? { ...(previous.attachments ? { attachments: previous.attachments } : {}),
    ...(previous.attachmentRoot !== undefined ? { attachmentRoot: previous.attachmentRoot } : {}) } : {}
}

function writeDraft(sessionId: string, text: string, source: string, mentions: Mention[], revision: number, attachmentState?: ChatDraftAttachmentState): ChatDraft {
  if (!sessionId) throw new Error('缺少草稿所属会话，未发送消息')
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('草稿修订无效，未发送消息')
  const table = readTable(source)
  const saved = { text, mentions, revision, ...attachmentFields(table[sessionId], text, mentions, attachmentState) }
  // Empty drafts keep their revision, so clearing/retyping identical text is a
  // different authored intent after reload as well as within this window.
  delete table[sessionId]
  table[sessionId] = saved
  const keys = Object.keys(table)
  while (keys.length > MAX_SLOTS) delete table[keys.shift() as string]
  localStorage.setItem(sessionStorageKey(DRAFTS_KEY, source), JSON.stringify(table))
  return saved
}
export function saveChatDraft(sessionId: string, text: string, source = getEngineStorageKey(), mentions: Mention[] = [], revision?: number, attachmentState?: ChatDraftAttachmentState): number {
  const previous = readTable(source)[sessionId]
  const selected = !text.trim() ? nextChatDraftRevision(Math.max(previous?.revision ?? 0, revision ?? 0)) : revision
    ?? (previous && previous.text === text && JSON.stringify(previous.mentions) === JSON.stringify(mentions) &&
      JSON.stringify(attachmentFields(previous, text, mentions)) === JSON.stringify(attachmentFields(previous, text, mentions, attachmentState))
      ? previous.revision : nextChatDraftRevision(previous?.revision))
  try { writeDraft(sessionId, text, source, mentions, selected, attachmentState) } catch { /* Editing remains usable; submission uses the strict writer below. */ }
  return selected
}
export function saveChatDraftForSubmission(sessionId: string, text: string, source: string, mentions: Mention[], revision: number, attachmentState?: ChatDraftAttachmentState): void {
  try {
    const expected = writeDraft(sessionId, text, source, mentions, revision, attachmentState)
    const saved = readTable(source)[sessionId]
    if (!saved || JSON.stringify(saved) !== JSON.stringify(expected)) throw new Error('Draft confirmation mismatch')
  } catch {
    throw new Error('无法保存本次草稿及修订，尚未发送。请释放本地存储空间后重试。')
  }
}
