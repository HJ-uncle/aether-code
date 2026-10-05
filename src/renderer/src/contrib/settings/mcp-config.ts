export type McpTransport = 'stdio' | 'http' | 'streamableHttp' | 'sse'

export interface McpServer {
  id: string
  name: string
  description: string
  enabled: boolean
  transportType: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  disabledTools?: string[]
  scope?: 'project' | 'global'
}

export interface McpTool {
  name: string
  description?: string
}

export interface McpDraft {
  id: string
  name: string
  description: string
  transportType: McpTransport
  command: string
  args: string
  env: string
  url: string
  headers: string
  scope: 'project' | 'global'
}

export function mcpDraft(server?: McpServer): McpDraft {
  return {
    id: server?.id ?? '', name: server?.name ?? '', description: server?.description ?? '',
    transportType: server?.transportType ?? 'stdio', command: server?.command ?? '',
    args: JSON.stringify(server?.args ?? []), env: JSON.stringify(server?.env ?? {}, null, 2),
    url: server?.url ?? '', headers: JSON.stringify(server?.headers ?? {}, null, 2), scope: server?.scope ?? 'project'
  }
}

function stringRecord(value: string, label: string): Record<string, string> {
  let parsed: unknown
  try { parsed = JSON.parse(value.trim() || '{}') } catch { throw new Error(`${label}必须是 JSON 对象`) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(item => typeof item !== 'string')) {
    throw new Error(`${label}必须是值为字符串的 JSON 对象`)
  }
  return parsed as Record<string, string>
}

export function mcpPayload(draft: McpDraft): Omit<McpServer, 'enabled'> {
  const id = draft.id.trim()
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error('标识只能使用小写字母、数字、下划线和连字符')
  if (!draft.name.trim()) throw new Error('请填写名称')
  const common = { id, name: draft.name.trim(), description: draft.description.trim(), transportType: draft.transportType, scope: draft.scope }
  if (draft.transportType === 'stdio') {
    if (!draft.command.trim()) throw new Error('请填写启动命令')
    let args: unknown
    try { args = JSON.parse(draft.args.trim() || '[]') } catch { throw new Error('启动参数必须是 JSON 字符串数组，例如 ["-y", "包名"]') }
    if (!Array.isArray(args) || args.some(item => typeof item !== 'string')) throw new Error('启动参数必须是 JSON 字符串数组')
    return { ...common, command: draft.command.trim(), args, env: stringRecord(draft.env, '环境变量') }
  }
  let url: URL
  try { url = new URL(draft.url.trim()) } catch { throw new Error('请填写有效的 HTTP(S) 地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('地址必须为 HTTP(S)，认证信息请填入请求头')
  return { ...common, url: url.href, headers: stringRecord(draft.headers, '请求头') }
}

export function mcpDefinitionName(serverId: string, toolName: string): string {
  const prefix = `mcp_${serverId}_`
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName
}
