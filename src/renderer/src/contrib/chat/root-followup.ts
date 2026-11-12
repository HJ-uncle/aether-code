import type { RootRun } from '../../../../shared/root-run'
import type { ChatMessage, ChatAttachment } from '../../core/engine/useChat'
import { buildMentionMessage, type Mention } from './mention-context'

/** An unresolved capability probe is not a refusal. Submit performs its own
 * authoritative check before posting, so an early Enter must not disappear. */
export function rootFollowupCanSubmit(active: boolean, capability: boolean | undefined): boolean {
  return active && capability !== false
}

/** The composer may only target the run independently bound to this session. */
export function rootFollowupRun(messages: readonly Pick<ChatMessage, 'run' | 'runId'>[], sessionId: string | null, runId: string | undefined): RootRun | undefined {
  if (!sessionId || !runId) return undefined
  let latest: RootRun | undefined
  for (const message of messages) {
    const run = message.run
    if (!run || run.sessionId !== sessionId || run.runId !== runId || (message.runId && message.runId !== runId)) continue
    if (!latest || run.version > latest.version) latest = run
  }
  return latest
}

export function rootFollowupLimitation(mentions: readonly Mention[], attachments: readonly ChatAttachment[], resourceChanges = false): string {
  if (attachments.length) return '附件请排到下一轮；立即补充支持文字和文件引用。'
  if (mentions.some(item => item.source === 'agent')) return '新增协作 Agent 请排到下一轮；当前任务可立即补充文字和文件引用。'
  if (resourceChanges) return '技能、MCP 和知识库的变更请排到下一轮，资源选择会随下一轮指令生效。'
  return ''
}

export function rootFollowupMessage(text: string, mentions: readonly Mention[], attachments: readonly ChatAttachment[], resourceChanges = false): string {
  const limitation = rootFollowupLimitation(mentions, attachments, resourceChanges)
  if (limitation) throw new Error(limitation)
  return buildMentionMessage(text, mentions)
}
