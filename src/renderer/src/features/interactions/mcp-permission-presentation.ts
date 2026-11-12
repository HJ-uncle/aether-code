import type { PendingInteraction } from '../../core/engine/pending'
import type { PermissionField, PermissionPresentation } from './permission-presentation'

type Data = Record<string, unknown>
const titles = {
  mcp_server_create: '创建 MCP 服务器',
  mcp_server_update: '编辑 MCP 服务器',
  mcp_server_set_enabled: '启停 MCP 服务器',
  mcp_server_delete: '删除 MCP 服务器',
  mcp_server_test: '测试 MCP 连接'
} as const
type Action = keyof typeof titles
const descriptions: Record<Action, string> = {
  mcp_server_create: '保存服务器配置，创建后处于停用状态。',
  mcp_server_update: '保存本次服务器配置修改。',
  mcp_server_set_enabled: '更改服务器的启用状态。',
  mcp_server_delete: '删除所选范围内的服务器配置。',
  mcp_server_test: '连接服务器并读取工具目录，完成后关闭连接。'
}
function record(value: unknown): Data | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Data)
    : undefined
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim())
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}
function scope(value: unknown): boolean {
  return value === 'project' || value === 'global'
}
function configFields(value: Data): boolean {
  return Object.entries(value).every(([key, item]) => {
    if (['name', 'description', 'transportType', 'command', 'url'].includes(key))
      return typeof item === 'string'
    if (['args', 'disabledTools'].includes(key)) return strings(item)
    if (key === 'enabled') return typeof item === 'boolean'
    if (key === 'timeoutMs')
      return item === null || (typeof item === 'number' && Number.isFinite(item))
    return true
  })
}
function originalInput(args: Data | undefined, action: Action): Data | undefined {
  if (!args || !nonempty(args.id) || (args.scope !== undefined && !scope(args.scope)))
    return undefined
  if (action === 'mcp_server_create')
    return nonempty(args.transportType) && configFields(args) ? args : undefined
  if (action === 'mcp_server_update') {
    const changes = record(args.changes)
    return changes && configFields(changes) ? args : undefined
  }
  if (action === 'mcp_server_set_enabled')
    return typeof args.enabled === 'boolean' ? args : undefined
  return args
}
function view(value: unknown, id: unknown, location: unknown): Data | undefined {
  const config = record(value),
    connection = record(config?.connection)
  return config &&
    config.id === id &&
    config.scope === location &&
    typeof config.name === 'string' &&
    typeof config.description === 'string' &&
    typeof config.enabled === 'boolean' &&
    typeof config.transportType === 'string' &&
    nonempty(config.revision) &&
    strings(config.disabledTools) &&
    configFields(config) &&
    connection &&
    strings(connection.envKeys) &&
    strings(connection.headerKeys) &&
    Object.entries(connection).every(([key, item]) => {
      if (['command', 'endpoint'].includes(key)) return typeof item === 'string'
      if (key === 'argumentCount') return typeof item === 'number' && Number.isFinite(item)
      if (['hasQuery', 'hasCredentials'].includes(key)) return typeof item === 'boolean'
      return true
    })
    ? config
    : undefined
}
function prepared(question: string, action: Action): Data | undefined {
  const text = question.trim().replace(/^安全策略拦截了此操作，是否允许执行？\r?\n原因：/, '')
  const match = new RegExp(
    `^${titles[action]}确认\\r?\\n\\r?\\n([\\s\\S]+)\\r?\\n\\r?\\n确认后执行以上操作。$`
  ).exec(text)
  if (!match) return undefined
  try {
    const data = record(JSON.parse(match[1]))
    if (
      !data ||
      data.action !== action.slice('mcp_server_'.length) ||
      !nonempty(data.id) ||
      !scope(data.scope) ||
      !nonempty(data.configFile)
    )
      return undefined
    const before = view(data.before, data.id, data.scope),
      after = view(data.after, data.id, data.scope)
    if (action === 'mcp_server_create') return after && data.before === undefined ? data : undefined
    if (!before) return undefined
    if (action === 'mcp_server_update' || action === 'mcp_server_set_enabled')
      return after ? data : undefined
    return data.after === undefined ? data : undefined
  } catch {
    return undefined
  }
}
function display(key: string, value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (key === 'scope')
    return value === 'global' ? '本机全局' : value === 'project' ? '当前项目' : undefined
  if (key === 'enabled') return typeof value === 'boolean' ? (value ? '启用' : '停用') : undefined
  if (key === 'timeoutMs')
    return value === null
      ? '默认'
      : typeof value === 'number'
        ? value === 0
          ? '不限时'
          : `${value} 毫秒`
        : undefined
  if (strings(value)) return value.length ? value.join('\n') : '无'
  if (typeof value === 'boolean') return value ? '是' : '否'
  return typeof value === 'string' || typeof value === 'number'
    ? String(value) || '（空）'
    : undefined
}
const configLabels: Record<string, string> = {
  name: '名称',
  description: '用途',
  transportType: '传输方式',
  enabled: '状态',
  command: '启动命令',
  args: '启动参数',
  url: '连接地址',
  timeoutMs: '调用超时',
  disabledTools: '停用工具'
}
const connectionLabels: Record<string, string> = {
  command: '启动程序',
  argumentCount: '参数数量',
  endpoint: '连接地址',
  hasQuery: '包含查询参数',
  hasCredentials: '包含连接凭据',
  envKeys: '环境变量',
  headerKeys: '请求头'
}
function factsFor(config: Data, before?: Data, editing = false): PermissionField[] {
  const facts: PermissionField[] = []
  const add = (key: string, label: string, value: unknown, previous?: unknown): void => {
    // Empty optional lists add no connection detail; keep explicit removals visible.
    if (strings(value) && !value.length && (!strings(previous) || !previous.length)) return
    let formatted = display(key, value)
    const old = display(key, previous)
    // Full public snapshots omit fields removed by a transport change or timeout reset.
    if (value === undefined && old !== undefined)
      formatted =
        key === 'timeoutMs'
          ? '默认'
          : ['hasQuery', 'hasCredentials'].includes(key)
            ? '不适用'
            : '无'
    if (formatted === undefined) return
    facts.push({
      label,
      value: formatted,
      ...(old !== undefined && old !== formatted ? { previous: old } : {})
    })
  }
  for (const [key, label] of Object.entries(configLabels)) {
    if (['name', 'description'].includes(key) && (!editing || config[key] === before?.[key]))
      continue
    add(key, label, config[key], before?.[key])
  }
  const connection = record(config.connection),
    oldConnection = record(before?.connection)
  for (const [key, label] of Object.entries(connectionLabels))
    add(key, label, connection?.[key], oldConnection?.[key])
  return facts
}

/** Render the engine's public MCP view; do not reconstruct hidden connection values. */
export function appendMcpPresentation(
  presentation: PermissionPresentation,
  pending: PendingInteraction
): boolean {
  if (!Object.hasOwn(titles, pending.toolName)) return false
  const action = pending.toolName as Action
  const preview = prepared(pending.question, action),
    args = originalInput(record(pending.args), action)
  const before = record(preview?.before),
    after = record(preview?.after)
  const input = preview ?? args
  const originalConfig =
    action === 'mcp_server_create'
      ? args
      : action === 'mcp_server_update'
        ? record(args?.changes)
        : action === 'mcp_server_set_enabled' && args
          ? { enabled: args.enabled }
          : undefined
  const config = after ?? before ?? originalConfig
  presentation.kind = 'management'
  presentation.title = presentation.confirmLabel = titles[action]
  presentation.destructive = action === 'mcp_server_delete'
  presentation.summary = nonempty(config?.name)
    ? config.name
    : nonempty(input?.id)
      ? input.id
      : undefined
  if (nonempty(config?.description))
    presentation.fields.push({ label: '用途', value: config.description })
  const enabled =
    after?.enabled ?? (action === 'mcp_server_set_enabled' ? args?.enabled : undefined)
  if (action === 'mcp_server_set_enabled' && typeof enabled === 'boolean')
    presentation.title = presentation.confirmLabel = enabled ? '启用 MCP 服务器' : '停用 MCP 服务器'
  const details: PermissionField[] = []
  if (nonempty(input?.id)) details.push({ label: '服务器 ID', value: input.id })
  if (scope(input?.scope)) details.push({ label: '范围', value: display('scope', input?.scope)! })
  if (nonempty(preview?.configFile)) details.push({ label: '配置文件', value: preview.configFile })
  presentation.sections.push({
    id: 'mcp-configuration',
    label: '连接配置',
    text: descriptions[action],
    ...(config
      ? {
          facts: factsFor(
            config,
            action === 'mcp_server_update' || action === 'mcp_server_set_enabled'
              ? before
              : undefined,
            action === 'mcp_server_update'
          )
        }
      : {})
  })
  if (action === 'mcp_server_test' && nonempty(preview?.notice))
    presentation.sections.push({ id: 'mcp-test-notice', label: '测试说明', text: preview.notice })
  if (details.length)
    presentation.sections.push({ id: 'mcp-details', label: '服务器信息', facts: details })
  return true
}
