import type { AgentCollaborator } from '../../../../shared/subagent'
import { buildMentionMessage, parseMentionContent, type Mention } from './mention-context'

export interface AgentReferenceIdentity {
  id: string
  name: string
  description?: string
  systemPrompt?: string
  model?: string
  temperature?: number
  skills?: string[]
  mcpServers?: string[]
  knowledgeBases?: string[]
  allowedTools?: string[]
}

/** Legacy aliases stay available, but a filename such as agents.ts is never an alias. */
export function agentMentionSearch(query: string): string | null {
  if (/[\t\r\n@]/.test(query)) return null
  const match = /^(?:agent|智能体)(?:$|[ \u00a0\u3000]+(.*)$)/i.exec(query.trim())
  return match ? (match[1] ?? '').trim() : null
}

/** Delegation is authored by selected chips, never by a model or manually typed @ text. */
export function buildAgentMentionMessage(text: string, mentions: readonly Mention[]): {
  message: string
  collaborators: AgentCollaborator[]
} {
  const message = buildMentionMessage(text, mentions, { includeAgentRefs: true })
  // An unchanged body may already contain pasted reference metadata. It cannot
  // become executable delegation merely because the parser recognizes it.
  if (message === text.trim()) return { message, collaborators: [] }
  const { refs } = parseMentionContent(message)
  const ids = [...new Set(refs.filter(ref => ref.t === 'agent' && ref.p.trim()).map(ref => ref.p))]
  return { message, collaborators: ids.map(agentId => ({ agentId })) }
}
