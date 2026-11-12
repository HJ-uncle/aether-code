/** IDs select engine-owned capabilities; display text never grants a tool. */
export const AGENT_MANAGEMENT_TOOLKIT = 'agent-management'
export const SKILL_MANAGEMENT_TOOLKIT = 'skill-management'
export const KNOWLEDGE_MANAGEMENT_TOOLKIT = 'knowledge-management'
export const AUTOMATION_TOOLKIT = 'automation'
export const PLUGIN_MANAGEMENT_TOOLKIT = 'plugin-management'
export const MCP_MANAGEMENT_TOOLKIT = 'mcp-management'
export const SESSION_TOOLKITS = [{
  id: AGENT_MANAGEMENT_TOOLKIT,
  name: 'Agent 管理',
  description: '创建和管理 Agent',
}, {
  id: SKILL_MANAGEMENT_TOOLKIT,
  name: 'Skill 管理',
  description: '创建和管理技能',
}, {
  id: KNOWLEDGE_MANAGEMENT_TOOLKIT,
  name: '知识库管理',
  description: '管理知识库与文档',
}, {
  id: AUTOMATION_TOOLKIT,
  name: '自动化',
  description: '查看和管理定时计划',
}, {
  id: MCP_MANAGEMENT_TOOLKIT,
  name: 'MCP 管理',
  description: '配置和测试 MCP 服务',
}, {
  id: PLUGIN_MANAGEMENT_TOOLKIT,
  name: '插件管理',
  description: '创建和管理自定义插件',
}] as const

/** Versioned identities are admitted by the engine; text labels never grant tools. */
export function isPluginToolkitId(id: unknown): id is string {
  return pluginToolkitIdentity(id) !== undefined
}
export function pluginToolkitIdentity(id: unknown): string | undefined {
  return typeof id === 'string' ? /^plugin-([a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?)--r[1-9][0-9]{0,8}$/.exec(id)?.[1] : undefined
}
/** Selecting a new revision replaces the same plugin's prior revision. */
export function withToolkitSelection(current: readonly string[], selected: string): string[] {
  const identity = pluginToolkitIdentity(selected)
  return [...new Set([...current.filter(id => !identity || pluginToolkitIdentity(id) !== identity), selected])]
}
export function isToolkitId(id: unknown): id is string {
  return SESSION_TOOLKITS.some(toolkit => toolkit.id === id) || isPluginToolkitId(id)
}

export interface SessionToolkit {
  id: string
  name: string
  description: string
  toolNames: string[]
  available: boolean
  reason?: string
}

/** Known IDs describe the protocol; only the connected engine declares support. */
export function parseToolkitCatalogue(raw: unknown): SessionToolkit[] {
  if (!raw || typeof raw !== 'object' || !('toolkits' in raw) || !Array.isArray(raw.toolkits)) return []
  const seen = new Set<string>()
  return raw.toolkits.flatMap((row: unknown) => {
    if (!row || typeof row !== 'object') return []
    const item = row as Record<string, unknown>
    const known = SESSION_TOOLKITS.find(toolkit => toolkit.id === item.id)
    const identity = known ?? (isPluginToolkitId(item.id) && typeof item.name === 'string' && item.name.trim() && item.name.length <= 200 &&
      typeof item.description === 'string' && item.description.length <= 2000
      ? { id: item.id, name: item.name, description: item.description } : null)
    if (!identity || seen.has(identity.id) || typeof item.available !== 'boolean' || !Array.isArray(item.toolNames) ||
      item.toolNames.some(name => typeof name !== 'string')) return []
    seen.add(identity.id)
    return [{ ...identity, toolNames: [...item.toolNames] as string[], available: item.available,
      ...(typeof item.reason === 'string' && item.reason ? { reason: item.reason } : {}) }]
  })
}

export function parseSessionToolkits(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || !('toolkits' in raw) || !Array.isArray(raw.toolkits) ||
    raw.toolkits.some(id => typeof id !== 'string' || !id.trim())) throw new Error('会话工具包选择尚未读取，请稍后重试。')
  return [...new Set(raw.toolkits as string[])]
}

export function toolkitName(id: string, fallback?: string): string {
  return SESSION_TOOLKITS.find(toolkit => toolkit.id === id)?.name ?? fallback ?? id
}

/** Spaces inside a known label stay part of @ completion, rather than ending it as prose. */
export function isToolkitNameQuery(keyword: string): boolean {
  const normalized = keyword.replace(/[ \u00a0\u3000]+/g, ' ').toLowerCase()
  return normalized.includes(' ') && SESSION_TOOLKITS.some(toolkit => toolkit.name.toLowerCase().startsWith(normalized))
}

export function sameToolkits(left: readonly string[] = [], right: readonly string[] = []): boolean {
  return left.length === right.length && left.every(id => right.includes(id))
}
