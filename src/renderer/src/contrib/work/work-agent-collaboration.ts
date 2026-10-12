import type { AgentCollaborator } from '../../../../shared/subagent'
import { buildMentionMessage, parseMentionContent, type Mention } from '../chat/mention-context'

/** Only references actually present in the submitted text can delegate work. */
export function buildWorkAgentMessage(text: string, mentions: readonly Mention[]): { message: string; collaborators: AgentCollaborator[] } {
  const message = buildMentionMessage(text, mentions, { includeAgentRefs: true })
  const { refs } = parseMentionContent(message)
  const ids = [...new Set(refs.filter(ref => ref.t === 'agent' && ref.p.trim()).map(ref => ref.p))]
  return { message, collaborators: ids.map(agentId => ({ agentId })) }
}
