/** IDs select engine-owned capabilities; display text never grants a tool. */
export const AGENT_MANAGEMENT_TOOLKIT = 'agent-management'
export const SKILL_MANAGEMENT_TOOLKIT = 'skill-management'
export const KNOWLEDGE_MANAGEMENT_TOOLKIT = 'knowledge-management'
export const AUTOMATION_TOOLKIT = 'automation'
export const WORK_TOOLKITS = [{
  id: AGENT_MANAGEMENT_TOOLKIT,
  name: 'Agent 管理',
  description: '创建和管理 Agent',
}, {
  id: SKILL_MANAGEMENT_TOOLKIT,
  name: '技能管理',
  description: '创建和管理技能',
}, {
  id: KNOWLEDGE_MANAGEMENT_TOOLKIT,
  name: '知识库管理',
  description: '管理知识库与文档',
}, {
  id: AUTOMATION_TOOLKIT,
  name: '自动化',
  description: '查看和管理定时计划',
}] as const

export interface WorkToolkit {
  id: string
  name: string
  description: string
  toolNames: string[]
  available: boolean
  reason?: string
}

/** Known IDs describe the protocol; only the connected engine declares support. */
export function parseWorkToolkits(raw: unknown): WorkToolkit[] {
  if (!raw || typeof raw !== 'object' || !('toolkits' in raw) || !Array.isArray(raw.toolkits)) return []
  const seen = new Set<string>()
  return raw.toolkits.flatMap((row: unknown) => {
    if (!row || typeof row !== 'object') return []
    const item = row as Record<string, unknown>
    const known = WORK_TOOLKITS.find(toolkit => toolkit.id === item.id)
    if (!known || seen.has(known.id) || typeof item.available !== 'boolean' || !Array.isArray(item.toolNames) ||
      item.toolNames.some(name => typeof name !== 'string')) return []
    seen.add(known.id)
    return [{ ...known, toolNames: [...item.toolNames] as string[], available: item.available,
      ...(typeof item.reason === 'string' && item.reason ? { reason: item.reason } : {}) }]
  })
}

export function parseSessionToolkits(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || !('toolkits' in raw) || !Array.isArray(raw.toolkits) ||
    raw.toolkits.some(id => typeof id !== 'string' || !id.trim())) throw new Error('会话工具包选择尚未读取，请稍后重试。')
  return [...new Set(raw.toolkits as string[])]
}

export function toolkitName(id: string): string {
  return WORK_TOOLKITS.find(toolkit => toolkit.id === id)?.name ?? id
}

export function sameToolkits(left: readonly string[] = [], right: readonly string[] = []): boolean {
  return left.length === right.length && left.every(id => right.includes(id))
}
