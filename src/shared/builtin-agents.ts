import type { AgentCollaborator, BuiltinAgentRole } from './subagent'

export type BuiltinAgentIconName = 'agent-research' | 'agent-executor' | 'agent-general'

export const BUILTIN_AGENTS: ReadonlyArray<{ role: BuiltinAgentRole; name: string; description: string; icon: BuiltinAgentIconName }> = [
  { role: 'research', name: '调研', description: '只读调查与分析，返回结论和证据', icon: 'agent-research' },
  { role: 'executor', name: '执行', description: '完成代码、文档与附件，也可负责集成', icon: 'agent-executor' },
  { role: 'general', name: '通用', description: '处理综合需求与特殊任务', icon: 'agent-general' }
]

export function builtinAgentName(role: unknown): string | undefined {
  return BUILTIN_AGENTS.find(item => item.role === role)?.name
}

/** The reference is authored by a selected chip. Plain prompt text never creates a collaborator. */
export function builtinAgentReference(role: BuiltinAgentRole, instanceKey: string): string {
  return `builtin-agent:${role}:${instanceKey}`
}

export function parseBuiltinAgentReference(value: string): { builtinRole: BuiltinAgentRole; instanceKey: string } | undefined {
  const match = /^builtin-agent:(research|executor|general):([a-zA-Z0-9_-]{1,128})$/.exec(value)
  return match ? { builtinRole: match[1] as BuiltinAgentRole, instanceKey: match[2] } : undefined
}

export function collaboratorIdentity(value: AgentCollaborator): string {
  return value.resumeRunId ? `resume:${value.resumeRunId}` : value.builtinRole
    ? builtinAgentReference(value.builtinRole, value.instanceKey ?? '') : `agent:${value.agentId ?? ''}`
}
