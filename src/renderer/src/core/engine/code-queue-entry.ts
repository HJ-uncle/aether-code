import type { CodeQueueDraft } from '@shared/code-next-turn-api'
import type { NextTurnQueueEntry, QueueResourceSelection } from '@shared/next-turn-queue'
import type { ChatAttachment, QueuedMessage, SendOptions } from './useChat'
import { mentionToken, userMessageDraft } from '@renderer/contrib/chat/mention-context'
import { queuedDraft } from '@renderer/contrib/work/work-next-turn-queue'

const resource = (ids: string[] | undefined): QueueResourceSelection => ids === undefined
  ? { kind: 'inherit' } : ids.length ? { kind: 'override', ids: [...ids] } : { kind: 'none' }

/** Capture the authored draft and every request choice before leaving the renderer. */
export function codeQueueSubmission(text: string, options: SendOptions): CodeQueueDraft {
  const restored = userMessageDraft(text)
  return {
    draft: structuredClone(options.queueDraft ?? queuedDraft(restored.text, restored.mentions, 1)),
    model: options.model ? { kind: 'explicit', modelId: options.model } : { kind: 'engine-default' },
    resources: { skills: resource(options.skills), mcpServers: resource(options.mcpServers), knowledgeBases: resource(options.knowledgeBases) },
    thinking: options.thinkingMode === true ? { kind: 'on' } : options.thinkingMode === false ? { kind: 'off' }
      : typeof options.thinkingMode === 'string' ? { kind: 'effort', effort: options.thinkingMode } : { kind: 'inherit' },
    ...(options.subagentModel ? { subagentModel: options.subagentModel } : {}),
    ...(options.utilityModel ? { utilityModel: options.utilityModel } : {}),
    attachments: structuredClone(options.attachments ?? []),
    code: { ...(options.agentId ? { agentId: options.agentId } : {}),
      ...(options.collaborators !== undefined ? { collaborators: structuredClone(options.collaborators) } : {}),
      ...(options.workspacePaths !== undefined ? { workspacePaths: [...options.workspacePaths] } : {}),
      ...(options.memoryScope !== undefined ? { memoryScope: options.memoryScope } : {}) }
  }
}

export function queueEntryDraft(entry: NextTurnQueueEntry): CodeQueueDraft {
  const envelope = entry.envelope
  if (!envelope.code) throw new Error('这条消息不属于 Code 队列')
  return { draft: structuredClone(envelope.draft), model: structuredClone(envelope.model),
    resources: structuredClone(envelope.resources), thinking: structuredClone(envelope.thinking),
    ...(envelope.subagentModel ? { subagentModel: envelope.subagentModel } : {}),
    ...(envelope.utilityModel ? { utilityModel: envelope.utilityModel } : {}),
    code: structuredClone(envelope.code), attachments: envelope.attachments.map(file => ({
      path: file.path, name: file.name, type: file.mime, size: file.bytes,
      ...(file.attachmentId ? { attachmentId: file.attachmentId } : {}),
      ...(file.referenceLabel ? { referenceLabel: file.referenceLabel } : {})
    })) }
}

export function editCodeQueueDraft(entry: NextTurnQueueEntry, text: string, attachments: ChatAttachment[]): CodeQueueDraft {
  const submission = queueEntryDraft(entry)
  const original = submission.draft.text
  let prefix = 0, suffix = 0
  while (prefix < original.length && prefix < text.length && original[prefix] === text[prefix]) prefix++
  while (suffix < original.length - prefix && suffix < text.length - prefix && original[original.length - suffix - 1] === text[text.length - suffix - 1]) suffix++
  const mentions = submission.draft.mentions.flatMap(mention => {
    const token = mentionToken(mention), end = mention.textOffset + token.length
    // A plain textarea cannot prove chip identity inside the replaced span.
    // Keep only unchanged prefix/suffix chips; never find a new textual @token and promote it.
    const offset = end <= prefix ? mention.textOffset : mention.textOffset >= original.length - suffix ? mention.textOffset + text.length - original.length : -1
    if (offset < 0 || text.slice(offset, offset + token.length) !== token) return []
    return [{ ...mention, textOffset: offset }]
  })
  return { ...submission, draft: queuedDraft(text, mentions, submission.draft.revision + 1), attachments: structuredClone(attachments) }
}

export function visibleCodeQueueEntry(entry: NextTurnQueueEntry): QueuedMessage {
  const submission = queueEntryDraft(entry)
  return { id: entry.id, text: submission.draft.text, attachments: submission.attachments,
    phase: entry.phase, ...(entry.phase === 'admission-unknown' ? { reason: entry.reason } : {}) }
}
