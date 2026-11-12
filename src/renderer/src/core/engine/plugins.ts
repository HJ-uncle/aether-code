import { requestOrThrow } from './client'
import type { PluginContributions } from '@shared/plugin-contributions'

export interface PluginTool { name: string; description: string; inputSchema: Record<string, unknown>; entry: string }
export interface PluginManifest {
  apiVersion: 1; id: string; name: string; version: string; description: string; runtime: 'node'; tools: PluginTool[]; contributes?: PluginContributions
}
export interface PluginRecord {
  id: string; name: string; description: string; enabled: boolean; revision: number; publishedRevision?: number
  manifest: PluginManifest; files?: Record<string, string>; revisions: Array<{ revision: number; hash: string; createdAt: number }>
  source?: unknown; createdAt: number; updatedAt: number
}
export interface PluginImport { jobId: string; status: string; manifest?: PluginManifest; source?: unknown; requirements?: unknown; error?: string; failureStage?: 'prepare' | 'install' }
export interface PluginTemplateSummary { id: string; name: string; description: string }
export interface PluginProtocol { apiVersion: 1; runtime: 'node'; [key: string]: string | number }
export interface PluginTemplate extends PluginTemplateSummary { manifest: PluginManifest; files: Record<string, string>; protocol: PluginProtocol }
export interface PluginApplication {
  id: string; name: string; description: string; revision: number; hash: string; manifest: PluginManifest
  examples: Array<{ name: string; tool: string; args: Record<string, unknown> }>
  execution: { allowed: boolean; reason?: string }
  uiDocuments?: Record<string, string>
}
export interface PluginInvocation {
  result: unknown; artifacts: Array<{ path: string; content: string; encoding?: 'utf8' | 'base64' }>; stderr: string; durationMs: number
  plugin: { id: string; revision: number; hash: string }
}
export const pluginApplicationPath = (id: string): string => `/plugins/runtime/apps/${encodeURIComponent(id)}`
export async function getPluginApplication(id: string, revision: number): Promise<PluginApplication> {
  const data = await requestOrThrow<{ application: PluginApplication }>({ method: 'GET', path: `${pluginApplicationPath(id)}?revision=${revision}` })
  const application = data?.application
  if (!application || application.id !== id || application.revision !== revision || application.manifest?.id !== id ||
    !Array.isArray(application.manifest.tools) || !application.manifest.tools.length || !Array.isArray(application.examples) || typeof application.execution?.allowed !== 'boolean')
    throw new Error('插件运行信息无效，请刷新插件列表后重试。')
  return application
}
export async function invokePluginApplication(application: PluginApplication, tool: string, args: Record<string, unknown>): Promise<PluginInvocation> {
  const result = await requestOrThrow<PluginInvocation>({ method: 'POST', path: `${pluginApplicationPath(application.id)}/invoke`, body: { revision: application.revision, tool, args } })
  if (!result?.plugin || result.plugin.id !== application.id || result.plugin.revision !== application.revision || result.plugin.hash !== application.hash)
    throw new Error('插件运行回执与打开的版本不一致，请重新打开插件。')
  return result
}
export const pluginPath = (id: string): string => `/plugins/${encodeURIComponent(id)}`
export async function listPlugins(): Promise<PluginRecord[]> {
  const data = await requestOrThrow<{ plugins: PluginRecord[] }>({ method: 'GET', path: '/plugins' })
  if (!Array.isArray(data?.plugins)) throw new Error('插件目录格式无效，请检查引擎版本。')
  return data.plugins
}
export async function listPluginTemplates(): Promise<PluginTemplateSummary[]> {
  const data = await requestOrThrow<{ templates: PluginTemplateSummary[] }>({ method: 'GET', path: '/plugins/project/templates' })
  if (!Array.isArray(data?.templates) || !data.templates.length) throw new Error('引擎没有可用的插件模板，请更新引擎后重试。')
  return data.templates
}
export async function getPluginTemplate(id: string): Promise<PluginTemplate> {
  const data = await requestOrThrow<{ template: PluginTemplate }>({ method: 'GET', path: `/plugins/project/templates/${encodeURIComponent(id)}` })
  if (!data?.template?.manifest || !data.template.files || !data.template.protocol) throw new Error('插件模板格式无效，请检查引擎版本。')
  return data.template
}
/** Keep editor JSON as authored; syntax errors remain visible without discarding buffers. */
export function parsePluginDraft(manifest: string, files: Record<string, string>): { manifest: PluginManifest; files: Record<string, string> } {
  const value: unknown = JSON.parse(manifest)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('插件清单必须为 JSON 对象。')
  const item = value as Record<string, unknown>
  if (item.apiVersion !== 1 || item.runtime !== 'node' || typeof item.id !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(item.id) ||
    typeof item.name !== 'string' || !item.name.trim() || typeof item.version !== 'string' || typeof item.description !== 'string' || !Array.isArray(item.tools))
    throw new Error('请检查清单中的标识、名称、版本、用途与工具列表。')
  if (!Object.keys(files).length || Object.entries(files).some(([path, content]) => !path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || typeof content !== 'string'))
    throw new Error('插件文件必须使用安全的相对路径。')
  return { manifest: value as PluginManifest, files: { ...files } }
}

/** Examples are authored files; malformed/incomplete drafts remain editable. */
export function pluginExampleArgs(files: Record<string, string>, tool: string): string {
  try {
    const value: unknown = JSON.parse(files['examples/cases.json'] ?? '{}')
    if (!value || typeof value !== 'object' || !('cases' in value) || !Array.isArray(value.cases)) return '{}'
    const example = value.cases.find(item => item && typeof item === 'object' && item.tool === tool && item.args && typeof item.args === 'object' && !Array.isArray(item.args))
    return example ? JSON.stringify(example.args, null, 2) : '{}'
  } catch { return '{}' }
}
