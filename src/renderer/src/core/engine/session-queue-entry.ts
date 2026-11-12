/**
 * Pure helpers for queue fixtures. They serialize the shared Work draft shape
 * without installing a second mode-specific queue runtime.
 */
import type { SessionQueueDraft } from '@shared/session-next-turn-api'
import type { NextTurnQueueEntry, QueueResourceSelection } from '@shared/next-turn-queue'
import { queueResourcesAfterDraftEdit, queueDraftRemovesToolkit } from '@shared/next-turn-queue-state'
import type { ChatAttachment, QueuedMessage, SendOptions } from './useChat'
import { mentionToken, userMessageDraft } from '@renderer/features/conversation/shared/mention-context'
import { queuedDraft } from '@renderer/features/conversation/next-turn-queue'

const resource = (ids: string[] | undefined): QueueResourceSelection => ids === undefined
  ? { kind: 'inherit' } : ids.length ? { kind: 'override', ids: [...ids] } : { kind: 'none' }

export function queueSubmission(text: string, options: SendOptions): SessionQueueDraft {
  const restored = userMessageDraft(text)
  return {
    draft: structuredClone(options.queueDraft ?? queuedDraft(restored.text, restored.mentions, 1)),
    model: options.model ? { kind: 'explicit', modelId: options.model } : { kind: 'engine-default' },
    resources: { skills: resource(options.skills), mcpServers: resource(options.mcpServers), knowledgeBases: resource(options.knowledgeBases),
      ...(options.toolkits !== undefined ? { toolkits: resource(options.toolkits) } : {}) },
    thinking: options.thinkingMode === true ? { kind: 'on' } : options.thinkingMode === false ? { kind: 'off' }
      : typeof options.thinkingMode === 'string' ? { kind: 'effort', effort: options.thinkingMode } : { kind: 'inherit' },
    ...(options.subagentModel ? { subagentModel: options.subagentModel } : {}),
    ...(options.utilityModel ? { utilityModel: options.utilityModel } : {}),
    attachments: structuredClone(options.attachments ?? [])
  }
}

export function queueEntryDraft(entry: NextTurnQueueEntry): SessionQueueDraft {
  const envelope = entry.envelope
  return { draft: structuredClone(envelope.draft), model: structuredClone(envelope.model),
    resources: structuredClone(envelope.resources), thinking: structuredClone(envelope.thinking),
    ...(envelope.subagentModel ? { subagentModel: envelope.subagentModel } : {}),
    ...(envelope.utilityModel ? { utilityModel: envelope.utilityModel } : {}),
    attachments: envelope.attachments.map(file => ({ path: file.path, name: file.name, type: file.mime, size: file.bytes,
      ...(file.attachmentId ? { attachmentId: file.attachmentId } : {}), ...(file.referenceLabel ? { referenceLabel: file.referenceLabel } : {}) })) }
}

export function editQueueDraft(entry: NextTurnQueueEntry, text: string, attachments: ChatAttachment[]): SessionQueueDraft {
  const submission = queueEntryDraft(entry), original = submission.draft.text
  let prefix = 0, suffix = 0
  while (prefix < original.length && prefix < text.length && original[prefix] === text[prefix]) prefix++
  while (suffix < original.length - prefix && suffix < text.length - prefix && original[original.length - suffix - 1] === text[text.length - suffix - 1]) suffix++
  const mentions = submission.draft.mentions.flatMap(mention => {
    const token = mentionToken(mention), end = mention.textOffset + token.length
    const offset = end <= prefix ? mention.textOffset : mention.textOffset >= original.length - suffix ? mention.textOffset + text.length - original.length : -1
    if (offset < 0 || text.slice(offset, offset + token.length) !== token) return []
    return [{ ...mention, textOffset: offset }]
  })
  const draft = queuedDraft(text, mentions, submission.draft.revision + 1)
  const selection = submission.resources.toolkits
  const inheritedRemoval = (!selection || selection.kind === 'inherit') && queueDraftRemovesToolkit(submission.draft, draft)
  if (!inheritedRemoval)
    return { ...submission, draft, resources: queueResourcesAfterDraftEdit(submission.draft, draft, submission.resources), attachments: structuredClone(attachments) }
  // Ordinary resource chips can still be revoked while an inherited toolkit
  // selection waits for main-process resolution. Resolve with an empty
  // snapshot only to compute those independent changes, then preserve the
  // unresolved toolkit binding exactly as authored.
  const resolved = queueResourcesAfterDraftEdit(submission.draft, draft, submission.resources, [])
  if (selection === undefined) {
    const { toolkits: _toolkits, ...resources } = resolved
    return { ...submission, draft, resources, attachments: structuredClone(attachments) }
  }
  return { ...submission, draft, resources: { ...resolved, toolkits: selection }, attachments: structuredClone(attachments) }
}

export function visibleQueueEntry(entry: NextTurnQueueEntry): QueuedMessage {
  const submission = queueEntryDraft(entry)
  return { id: entry.id, text: submission.draft.text, attachments: submission.attachments, phase: entry.phase,
    ...(entry.phase === 'admission-unknown' ? { reason: entry.reason } : {}) }
}
