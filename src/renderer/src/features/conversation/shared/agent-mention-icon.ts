import { BUILTIN_AGENTS, parseBuiltinAgentReference } from '../../../../../shared/builtin-agents'
import type { BuiltinAgentRole } from '../../../../../shared/subagent'
import type { AgentReferenceIconName } from '../../../ui/icons'
import type { Mention } from './mention-context'

/** Persisted role identities survive renamed labels and repeated instances. */
export function agentReferenceIcon(path?: string, role?: BuiltinAgentRole): AgentReferenceIconName {
  const builtinRole = role ?? (path ? parseBuiltinAgentReference(path)?.builtinRole : undefined)
  return BUILTIN_AGENTS.find(agent => agent.role === builtinRole)?.icon ?? 'account-outline'
}

export function agentMentionIcon(mention: Pick<Mention, 'source' | 'path'>): AgentReferenceIconName | undefined {
  return mention.source === 'agent' ? agentReferenceIcon(mention.path) : undefined
}
