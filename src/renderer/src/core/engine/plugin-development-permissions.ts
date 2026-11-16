import { requestOrThrow } from './client'
import { pluginDevelopmentPath, type PluginDevelopmentSession } from './plugins'
import type { PluginAgentTool } from './plugin-permissions'

export type PluginDevelopmentPermissionSession = PluginDevelopmentSession & { permissionGrants?: string[] }

export async function listDevelopmentAgentTools(session: PluginDevelopmentSession): Promise<PluginAgentTool[]> {
  const value = await requestOrThrow<{ tools: PluginAgentTool[] }>({ method: 'GET', path: `${pluginDevelopmentPath(session.devSessionId)}/agent-tools` })
  if (!Array.isArray(value?.tools) || value.tools.some(tool => !tool || typeof tool.name !== 'string' || typeof tool.description !== 'string' || typeof tool.enabled !== 'boolean' || typeof tool.available !== 'boolean')) throw new Error('开发模式 Agent 工具目录不可用，请刷新后重试。')
  return value.tools
}
export async function setDevelopmentAgentTools(session: PluginDevelopmentSession, disabledTools: string[]): Promise<PluginDevelopmentSession> {
  const unique = [...new Set(disabledTools)]
  const result = await requestOrThrow<{ session: PluginDevelopmentSession }>({ method: 'PUT', path: `${pluginDevelopmentPath(session.devSessionId)}/agent-tools`, body: { disabledTools: unique, revision: session.revision, hash: session.hash } })
  const value = result?.session
  if (!value || value.devSessionId !== session.devSessionId || value.manifest?.id !== session.manifest.id || value.revision !== session.revision || value.hash !== session.hash || !Array.isArray(value.agentDisabledTools) || JSON.stringify([...value.agentDisabledTools].sort()) !== JSON.stringify(unique.sort())) throw new Error('开发模式 Agent 工具回执与当前工程版本不一致，请刷新后检查。')
  return value
}

export function requestedDevelopmentPermissions(session: PluginDevelopmentPermissionSession): string[] {
  const manifest = session.manifest as PluginDevelopmentSession['manifest'] & { permissions?: { requested: string[] } }
  return Array.isArray(manifest.permissions?.requested) ? [...new Set(manifest.permissions.requested.filter((value): value is string => typeof value === 'string'))] : []
}
export function grantedDevelopmentPermissions(session: PluginDevelopmentPermissionSession): string[] {
  const requested = new Set(requestedDevelopmentPermissions(session))
  return Array.isArray(session.permissionGrants) ? [...new Set(session.permissionGrants.filter(id => requested.has(id)))] : []
}
export async function setDevelopmentPermission(session: PluginDevelopmentPermissionSession, capability: string, enabled: boolean): Promise<PluginDevelopmentPermissionSession> {
  if (!requestedDevelopmentPermissions(session).includes(capability)) throw new Error('本地工程未声明此权限。')
  const grants = new Set(grantedDevelopmentPermissions(session))
  if (enabled) grants.add(capability)
  else grants.delete(capability)
  const result = await requestOrThrow<{ session: PluginDevelopmentPermissionSession }>({ method: 'PUT', path: `${pluginDevelopmentPath(session.devSessionId)}/permissions`, body: { grants: [...grants], revision: session.revision, hash: session.hash } })
  const value = result?.session
  if (!value || value.devSessionId !== session.devSessionId || value.manifest?.id !== session.manifest.id || value.revision !== session.revision || value.hash !== session.hash || !Array.isArray(value.permissionGrants) || JSON.stringify([...new Set(value.permissionGrants)].sort()) !== JSON.stringify([...grants].sort())) throw new Error('开发权限回执与当前工程版本不一致，请刷新工程后检查。')
  return value
}
