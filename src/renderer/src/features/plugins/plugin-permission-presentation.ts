import type { PendingInteraction } from '../../core/engine/pending'
import type { PermissionField, PermissionPresentation } from '../interactions/permission-presentation'
import { permissionValueNode } from '../interactions/permission-value-tree'

const pluginActions = {
  plugin_create: '创建插件',
  plugin_update: '编辑插件',
  plugin_publish: '发布插件',
  plugin_set_enabled: '启停插件',
  plugin_delete: '删除插件',
  plugin_test: '测试插件',
  plugin_import_install: '安装插件'
} as const
type PluginAction = keyof typeof pluginActions
interface PluginTool {
  name: string
  description: string
  entry: string
  inputSchema: Record<string, unknown>
}
interface PluginManifest {
  apiVersion: 1
  id: string
  name: string
  description: string
  version: string
  runtime: 'node'
  tools: PluginTool[]
}
interface PreparedPluginOperation extends Record<string, unknown> {
  input: Record<string, unknown>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim())
}
function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
function manifest(value: unknown): value is PluginManifest {
  const data = record(value)
  return Boolean(
    data &&
    data.apiVersion === 1 &&
    nonempty(data.id) &&
    nonempty(data.name) &&
    nonempty(data.version) &&
    typeof data.description === 'string' &&
    data.runtime === 'node' &&
    Array.isArray(data.tools) &&
    data.tools.every((value) => {
      const tool = record(value)
      return (
        tool &&
        nonempty(tool.name) &&
        typeof tool.description === 'string' &&
        nonempty(tool.entry) &&
        record(tool.inputSchema)
      )
    })
  )
}

// These checks recognize displayable data, not execution policy. The engine
// owns validation and approval; unknown extensions remain in the complete raw text.
function validInput(
  action: PluginAction,
  input: Record<string, unknown>,
  prepared: boolean
): boolean {
  if (action === 'plugin_create' || action === 'plugin_update') {
    const files = record(input.files)
    if (
      !manifest(input.manifest) ||
      !files ||
      !Object.values(files).every((value) => typeof value === 'string')
    )
      return false
    if (action === 'plugin_create') return true
    return nonempty(input.id) && input.id === input.manifest.id && revision(input.expectedRevision)
  }
  if (action === 'plugin_import_install') return nonempty(input.jobId)
  if (!nonempty(input.id)) return false
  if (action === 'plugin_publish') return revision(input.expectedRevision)
  if (action === 'plugin_set_enabled') return typeof input.enabled === 'boolean'
  if (action === 'plugin_test') {
    if (!(input.revision === undefined ? !prepared : revision(input.revision))) return false
    if (Object.hasOwn(input, 'cases')) {
      return !Object.hasOwn(input, 'tool') && !Object.hasOwn(input, 'args') && Array.isArray(input.cases) && input.cases.length >= 1 && input.cases.length <= 20 && input.cases.every(value => {
        const example = record(value)
        return example && nonempty(example.tool) && Boolean(record(example.args)) && (example.name === undefined || nonempty(example.name))
      })
    }
    return nonempty(input.tool) && Boolean(record(input.args))
  }
  return true
}

function preparedOperation(
  question: string,
  action: PluginAction
): PreparedPluginOperation | undefined {
  const text = question.trim().replace(/^安全策略拦截了此操作，是否允许执行？\r?\n原因：/, '')
  const match = new RegExp(
    `^${pluginActions[action]}确认\\r?\\n\\r?\\n([\\s\\S]+)\\r?\\n\\r?\\n确认后执行以上操作。$`
  ).exec(text)
  if (!match) return undefined
  try {
    const operation = record(JSON.parse(match[1]))
    const input = record(operation?.input)
    if (
      !operation ||
      operation.version !== 1 ||
      !nonempty(operation.tenantId) ||
      operation.action !== action ||
      !input ||
      !validInput(action, input, true)
    )
      return undefined
    if (operation.expectedRevision !== undefined && !revision(operation.expectedRevision))
      return undefined
    if (
      operation.expectedUpdatedAt !== undefined &&
      (typeof operation.expectedUpdatedAt !== 'number' ||
        !Number.isFinite(operation.expectedUpdatedAt))
    )
      return undefined
    if (
      (action === 'plugin_update' || action === 'plugin_publish') &&
      operation.expectedRevision !== undefined &&
      operation.expectedRevision !== input.expectedRevision
    )
      return undefined
    return { ...operation, input }
  } catch {
    return undefined
  }
}

function fact(facts: PermissionField[], label: string, value: unknown): void {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    facts.push({ label, value: String(value) })
}

function importSections(
  presentation: PermissionPresentation,
  operation: PreparedPluginOperation
): void {
  const source = record(operation.source)
  if (source) {
    const labels: Record<string, string> = {
      type: '来源类型',
      path: '路径',
      repository: '仓库',
      url: '网址',
      requestedRef: '请求引用',
      subdirectory: '子目录',
      format: '格式',
      adapter: '适配器',
      resolvedCommit: '提交',
      archiveSha256: '压缩包 SHA-256',
      importJobId: '导入作业 ID'
    }
    const sourceTypes: Record<string, string> = {
      local: '本地目录',
      zip: '压缩包',
      github: 'GitHub'
    }
    const facts: PermissionField[] = []
    for (const [key, value] of Object.entries(source)) {
      if (Object.hasOwn(labels, key))
        fact(
          facts,
          labels[key],
          key === 'type' && typeof value === 'string' ? (sourceTypes[value] ?? value) : value
        )
    }
    if (facts.length) presentation.sections.push({ id: 'plugin-source', label: '安装来源', facts })
  }
  if (Array.isArray(operation.requirements)) {
    const facts: PermissionField[] = []
    for (const entry of operation.requirements) {
      const requirement = record(entry)
      if (!requirement) continue
      fact(facts, '依赖管理器', requirement.type)
      const packages = record(requirement.packages)
      if (packages)
        for (const [name, version] of Object.entries(packages)) fact(facts, name, version)
      if (requirement.scripts === 'disabled') fact(facts, '生命周期脚本', '禁用')
      else fact(facts, '生命周期脚本', requirement.scripts)
    }
    if (facts.length)
      presentation.sections.push({ id: 'plugin-dependencies', label: '依赖', facts })
  }
}

/** Only exact builtin management identities opt into the plugin approval layout. */
export function pluginPermissionPresentation(
  pending: PendingInteraction,
  base: PermissionPresentation
): PermissionPresentation | undefined {
  if (!Object.hasOwn(pluginActions, pending.toolName)) return undefined
  const action = pending.toolName as PluginAction
  const operation = preparedOperation(pending.question, action)
  const args = record(pending.args)
  const input = operation?.input ?? (args && validInput(action, args, false) ? args : undefined)
  const title = pluginActions[action]
  const result: PermissionPresentation = {
    ...base,
    kind: 'plugin',
    title,
    confirmLabel: title,
    destructive: action === 'plugin_delete',
    fields: [],
    sections: []
  }
  if (!input) return result
  const details: PermissionField[] = []
  if (action === 'plugin_create' || action === 'plugin_update') {
    const config = input.manifest
    if (!manifest(config)) return result
    result.summary = config.name
    result.fields.push(
      { label: '用途', value: config.description },
      { label: '版本', value: config.version },
      { label: '运行环境', value: config.runtime === 'node' ? 'Node.js' : config.runtime }
    )
    fact(details, '插件 ID', config.id)
    fact(details, 'API 版本', config.apiVersion)
    fact(details, '当前修订', operation?.expectedRevision ?? input.expectedRevision)
    result.sections.push({
      id: 'plugin-tools',
      label: '功能',
      pluginTools: config.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        entry: tool.entry,
        inputSchema: JSON.stringify(tool.inputSchema, null, 2)
      })),
      ...(!config.tools.length ? { text: '无工具' } : {})
    })
    const files = Object.entries(record(input.files) ?? {}).flatMap(([path, content]) =>
      typeof content === 'string' ? [{ path, content }] : []
    )
    result.sections.push({
      id: 'plugin-files',
      label: '文件',
      files,
      ...(!files.length ? { text: '无文件' } : {})
    })
  } else {
    if (nonempty(input.id)) result.summary = input.id
    fact(details, '插件 ID', input.id)
    fact(details, '当前修订', operation?.expectedRevision ?? input.expectedRevision)
    let description = ''
    if (action === 'plugin_publish') description = '发布当前草稿并启用插件。'
    if (action === 'plugin_delete') description = '删除插件及其版本。'
    if (action === 'plugin_set_enabled') {
      result.title = result.confirmLabel = input.enabled ? '启用插件' : '停用插件'
      description = input.enabled ? '启用已发布的插件。' : '停用插件，停止后续调用。'
    }
    if (action === 'plugin_test') {
      const cases = Array.isArray(input.cases) ? input.cases : undefined
      description = cases ? `顺序运行 ${cases.length} 个测试用例，并核对预期结果。` : '运行指定插件功能，查看测试结果。'
      if (cases) fact(details, '测试用例', cases.length)
      else fact(details, '测试功能', input.tool)
      fact(details, '测试修订', input.revision)
      result.sections.push({
        id: 'plugin-test-args',
        label: cases ? '测试用例与预期结果' : '测试参数',
        tree: [permissionValueNode(cases ? '用例' : '参数', cases ?? input.args)]
      })
    }
    if (action === 'plugin_import_install') {
      description = '安装已预览的导入作业，生成插件草稿。'
      fact(details, '导入作业 ID', input.jobId)
      if (operation) importSections(result, operation)
    }
    result.sections.unshift({ id: 'plugin-operation', label: '操作说明', text: description })
  }
  if (details.length)
    result.sections.push({ id: 'plugin-details', label: '插件信息', facts: details })
  return result
}
