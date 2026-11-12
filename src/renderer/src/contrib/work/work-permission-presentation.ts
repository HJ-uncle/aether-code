import type { PendingInteraction } from '../../core/engine/pending'
import { toolDisplayName } from '../../core/engine/tool-labels'
import { pluginPermissionPresentation } from './work-plugin-permission-presentation'
import { appendManagementPresentation } from './work-management-permission-presentation'
import { appendMcpPresentation } from './work-mcp-permission-presentation'
import { appendToolPresentation } from './work-tool-permission-presentation'
import { permissionValueTree } from './work-permission-value-tree'

export interface PermissionField {
  label: string
  value: string
  previous?: string
}

export interface PermissionValueNode {
  label: string
  kind: 'string' | 'number' | 'boolean' | 'null' | 'undefined' | 'array' | 'object'
  value?: string
  children?: PermissionValueNode[]
}

export interface PermissionSection {
  id: string
  label: string
  text?: string
  items?: string[]
  entries?: Array<{ id: string; label: string }>
  previous?: string
  previousEntries?: Array<{ id: string; label: string }>
  pluginTools?: Array<{ name: string; description: string; entry: string; inputSchema: string }>
  files?: Array<{ path: string; content: string }>
  facts?: PermissionField[]
  tree?: PermissionValueNode[]
  code?: boolean
}

export interface PermissionPresentation {
  kind?: 'plugin' | 'management' | 'tool'
  title: string
  summary?: string
  confirmLabel: string
  destructive: boolean
  fields: PermissionField[]
  sections: PermissionSection[]
  reason?: string
  raw: string
}

type AgentAction = 'create' | 'update' | 'delete'
interface AgentPreview {
  config: Record<string, unknown>
  id?: string
  before?: Record<string, unknown>
}

const actionLabels: Record<AgentAction, string> = {
  create: '创建',
  update: '更新',
  delete: '删除'
}
const agentLabels: Record<string, string> = {
  name: '名称',
  description: '用途',
  model: '模型',
  temperature: '温度',
  systemPrompt: '工作指令',
  allowedTools: '工具权限',
  skills: '技能',
  mcpServers: 'MCP 服务',
  knowledgeBases: '知识库'
}
const listKeys = ['allowedTools', 'skills', 'mcpServers', 'knowledgeBases']

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim())
}

function validConfig(config: Record<string, unknown>): boolean {
  return Object.entries(config).every(([key, value]) => {
    if (['name', 'description', 'model', 'systemPrompt'].includes(key))
      return typeof value === 'string' && (key !== 'name' || Boolean(value.trim()))
    if (key === 'temperature')
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2
    if (listKeys.includes(key))
      return Array.isArray(value) && value.every((item) => typeof item === 'string')
    return true
  })
}

function permissionReason(question: string): string {
  return question.trim().replace(/^安全策略拦截了此操作，是否允许执行？\r?\n原因：/, '')
}

function repeatsArguments(reason: string, args: Record<string, unknown> | undefined): boolean {
  if (!args) return false
  try { return JSON.stringify(JSON.parse(reason)) === JSON.stringify(args) }
  catch { return false }
}

/** Only the engine's complete, action-matched preview envelope is authoritative.
 * Arbitrary JSON in a tool's explanation must never become an Agent mutation. */
function preparedAgentPreview(question: string, action: AgentAction): AgentPreview | undefined {
  const text = permissionReason(question)
  const match = new RegExp(
    `^Agent ${actionLabels[action]}确认\\r?\\n\\r?\\n([\\s\\S]+)\\r?\\n\\r?\\n确认后执行以上配置。$`
  ).exec(text)
  if (!match) return undefined
  let data: Record<string, unknown> | undefined
  try {
    data = record(JSON.parse(match[1]))
  } catch {
    return undefined
  }
  if (!data) return undefined
  if (action === 'create')
    return nonempty(data.name) && validConfig(data) ? { config: data } : undefined
  if (!nonempty(data.id)) return undefined
  const before = record(action === 'delete' ? data.agent : data.before)
  if (!before || before.id !== data.id || !nonempty(before.name) || !validConfig(before))
    return undefined
  if (action === 'delete') return { config: before, id: data.id }
  const changes = record(data.changes)
  const after = record(data.after)
  if (!changes || !Object.keys(changes).length || !after || !validConfig(changes)) return undefined
  const expected = { ...before, ...changes }
  if (
    Object.keys(expected).length !== Object.keys(after).length ||
    !Object.keys(expected).every(
      (key) =>
        Object.hasOwn(after, key) && JSON.stringify(expected[key]) === JSON.stringify(after[key])
    )
  )
    return undefined
  return { config: changes, id: data.id, before }
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value || '（空）'
  if (value === null) return 'null'
  return JSON.stringify(value, null, 2) ?? '未提供'
}

function permissionItems(key: string, values: string[]): string[] {
  return key === 'allowedTools'
    ? values.map((id) => {
        const name = toolDisplayName(id)
        return name === id ? id : `${name}（${id}）`
      })
    : values
}

function configValue(key: string, value: unknown): string {
  if (key === 'model' && value === '') return '使用任务模型'
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    if (!value.length) return key === 'allowedTools' ? '仅对话' : '无'
    return permissionItems(key, value).join('\n')
  }
  return valueText(value)
}

function appendAgentConfig(
  presentation: PermissionPresentation,
  config: Record<string, unknown>,
  before?: Record<string, unknown>
): void {
  const extra: Record<string, unknown> = Object.create(null)
  for (const [key, value] of Object.entries(config)) {
    if (key === 'name' && !before && value === presentation.summary) continue
    const label = Object.hasOwn(agentLabels, key) ? agentLabels[key] : undefined
    if (!label) {
      // Identity is shown separately; storage metadata stays in the full preview.
      if (!['id', 'tenantId', 'createdAt', 'updatedAt'].includes(key)) extra[key] = value
      continue
    }
    const previous = before
      ? { previous: Object.hasOwn(before, key) ? configValue(key, before[key]) : '未提供' }
      : {}
    if (
      listKeys.includes(key) &&
      Array.isArray(value) &&
      value.every((item) => typeof item === 'string')
    ) {
      if (!value.length && key === 'allowedTools' && !before) {
        presentation.fields.push({ label, value: '仅对话', ...previous })
        continue
      }
      if (!value.length && !before) continue
      const previousTools = before?.allowedTools
      presentation.sections.push({
        id: key,
        label,
        ...(value.length
          ? { items: permissionItems(key, value) }
          : { text: configValue(key, value) }),
        ...previous,
        ...(key === 'allowedTools'
          ? {
              entries: value.map((id) => ({ id, label: toolDisplayName(id) })),
              ...(Array.isArray(previousTools) &&
              previousTools.every((id) => typeof id === 'string')
                ? {
                    previousEntries: previousTools.map((id) => ({ id, label: toolDisplayName(id) }))
                  }
                : {})
            }
          : {})
      })
    } else if (
      key === 'systemPrompt' ||
      (typeof value === 'string' && (value.length > 180 || /[\r\n]/.test(value))) ||
      (value !== null && typeof value === 'object')
    ) {
      presentation.sections.push({ id: key, label, text: valueText(value), ...previous })
    } else {
      presentation.fields.push({ label, value: configValue(key, value), ...previous })
    }
  }
  if (Object.keys(extra).length)
    presentation.sections.push({
      id: 'additional-config',
      label: '其他配置',
      tree: permissionValueTree(extra)
    })
}

/** Presentation only: approval identity, parameter payload and response values are untouched. */
export function permissionPresentation(pending: PendingInteraction): PermissionPresentation {
  const args = record(pending.args)
  const presentation: PermissionPresentation = {
    title: toolDisplayName(pending.toolName),
    confirmLabel: '允许执行',
    destructive: false,
    fields: [],
    sections: [],
    raw: args
      ? `${pending.question}\n\n原始调用参数\n${JSON.stringify(args, null, 2)}`
      : pending.question
  }
  const plugin = pluginPermissionPresentation(pending, presentation)
  if (plugin) return plugin
  const action = /^agent_(?:do_)?(create|update|delete)$/.exec(pending.toolName)?.[1] as
    AgentAction | undefined
  if (action) {
    const preview = preparedAgentPreview(pending.question, action)
    const config = preview?.config ?? args ?? {}
    const target = action === 'update' ? preview?.before?.name : config.name
    presentation.title = `${actionLabels[action]} Agent`
    presentation.confirmLabel = `${actionLabels[action]} Agent`
    presentation.destructive = action === 'delete'
    if (nonempty(target)) presentation.summary = target
    const id = preview?.id ?? (nonempty(config.id) ? config.id : undefined)
    if (id) presentation.fields.push({ label: 'Agent ID', value: id })
    appendAgentConfig(presentation, config, preview?.before)
    return presentation
  }

  if (appendManagementPresentation(presentation, pending)) return presentation
  if (appendMcpPresentation(presentation, pending)) return presentation

  appendToolPresentation(presentation, pending)
  const reason = permissionReason(pending.question)
  if (repeatsArguments(reason, args)) return presentation
  if (reason.length > 280 || /\r?\n\s*\r?\n/.test(reason))
    presentation.sections.push({ id: 'description', label: '请求说明', text: reason })
  else if (reason) presentation.reason = reason
  return presentation
}
