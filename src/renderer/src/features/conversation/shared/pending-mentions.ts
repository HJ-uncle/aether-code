import { getEngineSource, getEngineStorageKey } from '@renderer/core/engine/source'
import { flushSessionDrafts, getSessionDraft, getSessionState, updateSessionDraft } from '../../sessions/state'
import { mentionToken, type Mention } from './mention-context'

interface MentionScope { sessionId: string; source: number }

/** 入队一条待插入输入框的引用（终端选中文本 / 编辑器选区） */
export function pushPendingMention(mention: Mention, scope?: MentionScope): void {
  pushPendingMentions([mention], scope)
}

/** External references update the owning draft even while its composer is unmounted. */
export function pushPendingMentions(mentions: Mention[], scope?: MentionScope): void {
  if (!mentions.length) return
  const storage = getEngineStorageKey()
  const state = getSessionState(storage)
  const sessionId = state.activeTaskId ?? state.homeSessionId
  if (scope && (scope.source !== getEngineSource() || scope.sessionId !== sessionId)) {
    throw new Error('当前会话或连接已切换，请重新添加引用')
  }
  const taskId = state.activeTaskId
  const draft = getSessionDraft(storage, taskId)
  let text = draft.text
  const nextMentions = [...draft.mentions]
  for (const mention of mentions) {
    if (text && !/\s$/.test(text)) text += ' '
    nextMentions.push({ ...mention, textOffset: text.length })
    text += mentionToken(mention) + ' '
  }
  updateSessionDraft(storage, taskId, text, nextMentions)
  flushSessionDrafts(storage)
}
