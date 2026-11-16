import { requestOrThrow } from './client'
import { pluginPath, type PluginRecord } from './plugins'

export interface PluginCapability {
  id: string
  title: string
  description: string
  category: string
  access: 'read' | 'write' | 'execute'
  defaultGranted: false
  bridge: string[]
  available?: boolean
}
export interface PluginAgentTool {
  name: string; description: string; parameters: Record<string, unknown>; source: string
  enabled: boolean; available: boolean; reason?: string
}
export async function listPluginAgentTools(plugin: Pick<PluginRecord, 'id'>): Promise<PluginAgentTool[]> {
  const value = await requestOrThrow<{ tools: PluginAgentTool[] }>({ method: 'GET', path: `${pluginPath(plugin.id)}/agent-tools` })
  if (!Array.isArray(value?.tools) || value.tools.some(tool => !tool || typeof tool.name !== 'string' || typeof tool.description !== 'string' || typeof tool.enabled !== 'boolean' || typeof tool.available !== 'boolean')) throw new Error('Agent 工具目录不可用，请刷新后重试。')
  return value.tools
}
export async function setPluginAgentTools(plugin: PluginRecord, disabledTools: string[]): Promise<PluginRecord> {
  const unique = [...new Set(disabledTools)]
  const value = await requestOrThrow<{ plugin: PluginRecord }>({ method: 'PUT', path: `${pluginPath(plugin.id)}/agent-tools`, body: { disabledTools: unique, expectedRevision: plugin.revision } })
  if (!value?.plugin || value.plugin.id !== plugin.id || value.plugin.revision !== plugin.revision || !Array.isArray(value.plugin.agentDisabledTools) || JSON.stringify([...value.plugin.agentDisabledTools].sort()) !== JSON.stringify(unique.sort())) throw new Error('Agent 工具修改回执无效，请刷新后检查。')
  return value.plugin
}
export type PluginPermissionRecord = PluginRecord & {
  permissionGrants?: string[]
  permissionRevision?: number
  manifest: PluginRecord['manifest'] & { permissions?: { requested: string[] } }
}

export function requestedPluginPermissions(plugin: PluginRecord): string[] {
  const requested = (plugin as PluginPermissionRecord).manifest.permissions?.requested
  return Array.isArray(requested) ? [...new Set(requested.filter((id): id is string => typeof id === 'string'))] : []
}
export function grantedPluginPermissions(plugin: PluginRecord): string[] {
  const value = plugin as PluginPermissionRecord
  if (value.permissionRevision !== undefined && value.permissionRevision !== plugin.revision) return []
  const requested = new Set(requestedPluginPermissions(plugin)), grants = value.permissionGrants
  return Array.isArray(grants) ? [...new Set(grants.filter(id => requested.has(id)))] : []
}
export function hasPreviousPluginPermissions(plugin: PluginRecord): boolean {
  const value = plugin as PluginPermissionRecord
  return typeof value.permissionRevision === 'number' && value.permissionRevision !== plugin.revision && Boolean(value.permissionGrants?.length)
}
export async function listPluginCapabilities(): Promise<PluginCapability[]> {
  const value = await requestOrThrow<{ catalogue: { capabilities: PluginCapability[] } }>({ method: 'GET', path: '/plugins/project/capabilities' })
  const capabilities = value?.catalogue?.capabilities
  if (!Array.isArray(capabilities) || capabilities.some(item => !item || typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.description !== 'string')) throw new Error('插件权限目录不可用，请检查引擎版本。')
  return capabilities
}
export async function setPluginPermission(plugin: PluginRecord, capability: string, enabled: boolean): Promise<PluginRecord> {
  if (!requestedPluginPermissions(plugin).includes(capability)) throw new Error('该插件未声明此权限。')
  const grants = new Set(grantedPluginPermissions(plugin))
  if (enabled) grants.add(capability)
  else grants.delete(capability)
  return savePluginPermissions(plugin, [...grants])
}
export async function revokePluginPermissions(plugin: PluginRecord): Promise<PluginRecord> { return savePluginPermissions(plugin, []) }
function allPluginPermissionGrants(plugin: PluginRecord, enabled: boolean, capabilities: readonly PluginCapability[]): string[] {
  if (!enabled) return []
  const available = new Set(capabilities.filter(capability => capability.available !== false).map(capability => capability.id))
  return [...new Set([...grantedPluginPermissions(plugin), ...requestedPluginPermissions(plugin).filter(id => available.has(id))])]
}
export function canSetAllPluginPermissions(plugin: PluginRecord, enabled: boolean, capabilities: readonly PluginCapability[]): boolean {
  if (!enabled) return Boolean((plugin as PluginPermissionRecord).permissionGrants?.length)
  const current = new Set(grantedPluginPermissions(plugin))
  return allPluginPermissionGrants(plugin, true, capabilities).some(id => !current.has(id))
}
export async function setAllPluginPermissions(plugin: PluginRecord, enabled: boolean, capabilities: readonly PluginCapability[]): Promise<PluginRecord> {
  if (!canSetAllPluginPermissions(plugin, enabled, capabilities)) return plugin
  return savePluginPermissions(plugin, allPluginPermissionGrants(plugin, enabled, capabilities))
}
async function savePluginPermissions(plugin: PluginRecord, grants: string[]): Promise<PluginRecord> {
  const value = await requestOrThrow<{ plugin: PluginRecord }>({ method: 'PUT', path: `${pluginPath(plugin.id)}/permissions`, body: { grants, expectedRevision: plugin.revision } })
  if (!value?.plugin || value.plugin.id !== plugin.id || value.plugin.revision !== plugin.revision || JSON.stringify(grantedPluginPermissions(value.plugin).sort()) !== JSON.stringify([...grants].sort()) || hasPreviousPluginPermissions(value.plugin)) throw new Error('权限修改回执无效，请刷新插件后检查。')
  return value.plugin
}
