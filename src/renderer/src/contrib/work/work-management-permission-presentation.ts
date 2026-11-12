import type { PendingInteraction } from '../../core/engine/pending'
import type {
  PermissionField,
  PermissionPresentation,
  PermissionSection
} from './work-permission-presentation'
import {
  isAutomationConfiguration,
  validateAutomationJob
} from '../automations/automation-response'
import { scheduleLabel } from '../automations/automation-draft'

type Data = Record<string, unknown>
const titles = {
  knowledge_create: '创建知识库',
  knowledge_update: '更新知识库',
  knowledge_delete: '删除知识库',
  knowledge_import: '导入知识文档',
  knowledge_document_update: '更新知识文档',
  knowledge_document_delete: '删除知识文档',
  skill_create: '创建技能',
  skill_update: '编辑技能',
  skill_set_enabled: '启停技能',
  skill_delete: '删除技能',
  cron_create: '创建定时任务',
  cron_update: '更新定时任务',
  cron_delete: '删除定时任务'
} as const
type ToolName = keyof typeof titles
const descriptions: Record<ToolName, string> = {
  knowledge_create: '创建知识库，用于保存和检索资料。',
  knowledge_update: '更新知识库的名称或用途。',
  knowledge_delete: '删除此知识库及其中的文档和检索索引。',
  knowledge_import: '将文档内容导入目标知识库并建立检索索引。',
  knowledge_document_update: '更新文档内容或所属知识库，并重建检索索引。',
  knowledge_document_delete: '删除此知识文档及其检索索引。',
  skill_create: '保存为持久技能，不执行技能脚本。',
  skill_update: '更新技能主文档，保留现有脚本和附件。',
  skill_set_enabled: '调整技能的启用状态，不执行技能脚本。',
  skill_delete: '删除此技能目录及其中的脚本和附件。',
  cron_create: '保存定时任务，按照执行设置运行任务指令。',
  cron_update: '更新此定时任务的执行设置或任务指令。',
  cron_delete: '删除此定时任务并保留运行历史，不会停止已经开始的运行。'
}

function record(value: unknown): Data | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Data)
    : undefined
}
const text = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim())
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const revision = (value: unknown): value is number => integer(value) && value > 0
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
const scope = (value: unknown): boolean => value === 'project' || value === 'global'
const stringFields = (data: Data, keys: string[]): boolean =>
  keys.every((key) => !Object.hasOwn(data, key) || typeof data[key] === 'string')

/** Only the complete, tool-matched server preview is a prepared operation.
 * Knowledge and skills intentionally publish a preview, not the internal envelope. */
function prepared(question: string, tool: ToolName): Data | undefined {
  const reason = question.trim().replace(/^安全策略拦截了此操作，是否允许执行？\r?\n原因：/, '')
  const match = new RegExp(
    `^${titles[tool]}确认\\r?\\n\\r?\\n([\\s\\S]+)\\r?\\n\\r?\\n确认后执行以上操作。$`
  ).exec(reason)
  if (!match) return undefined
  try {
    const value = record(JSON.parse(match[1]))
    if (!value) return undefined
    if (tool.startsWith('cron_')) return validCronPreview(value, tool)
    if (value.action !== tool.replace(/^(knowledge|skill)_/, '')) return undefined
    return tool.startsWith('knowledge_')
      ? validKnowledgePreview(value, tool)
      : validSkillPreview(value, tool)
  } catch {
    return undefined
  }
}

function baseSnapshot(value: unknown): Data | undefined {
  const before = record(value)
  return before &&
    text(before.id) &&
    text(before.name) &&
    typeof before.description === 'string' &&
    revision(before.revision) &&
    integer(before.documentCount)
    ? before
    : undefined
}
function documentSnapshot(value: unknown): Data | undefined {
  const before = record(value)
  return before &&
    text(before.id) &&
    text(before.filename) &&
    text(before.contentType) &&
    revision(before.revision) &&
    (before.knowledgeBaseId === null || text(before.knowledgeBaseId))
    ? before
    : undefined
}
function validKnowledgeInput(input: Data, tool: ToolName, isPreview: boolean): boolean {
  if (!stringFields(input, ['name', 'description', 'filename', 'content', 'contentType', 'path']))
    return false
  if (
    Object.hasOwn(input, 'knowledgeBaseId') &&
    input.knowledgeBaseId !== null &&
    !text(input.knowledgeBaseId)
  )
    return false
  if (tool === 'knowledge_create') return text(input.name)
  if (tool === 'knowledge_update')
    return (
      (text(input.name) || typeof input.description === 'string') &&
      (!Object.hasOwn(input, 'name') || text(input.name))
    )
  if (tool === 'knowledge_import')
    return (
      text(input.knowledgeBaseId) &&
      (isPreview
        ? text(input.filename) &&
          text(input.content) &&
          text(input.contentType) &&
          !Object.hasOwn(input, 'path')
        : Object.hasOwn(input, 'path') !== Object.hasOwn(input, 'content') &&
          (text(input.path) || (text(input.content) && text(input.filename))))
    )
  if (tool === 'knowledge_document_update')
    return (
      ['filename', 'content', 'contentType', 'knowledgeBaseId'].some((key) =>
        Object.hasOwn(input, key)
      ) &&
      ['filename', 'content', 'contentType'].every(
        (key) => !Object.hasOwn(input, key) || text(input[key])
      )
    )
  return true
}
function validKnowledgePreview(value: Data, tool: ToolName): Data | undefined {
  const input = record(value.input)
  if (!text(value.id) || !input || !validKnowledgeInput(input, tool, true)) return undefined
  if (Object.hasOwn(input, 'content') && (!integer(input.bytes) || !hash(input.sha256)))
    return undefined
  if (value.warning !== undefined && typeof value.warning !== 'string') return undefined
  if (value.source !== undefined) {
    const source = record(value.source)
    if (
      tool !== 'knowledge_import' ||
      !source ||
      !text(source.path) ||
      !text(source.submittedPath) ||
      !hash(source.hash)
    )
      return undefined
  }
  if (tool === 'knowledge_create') return value.before === undefined ? value : undefined
  const before = tool.includes('document_')
    ? documentSnapshot(value.before)
    : baseSnapshot(value.before)
  if (!before || before.id !== (tool === 'knowledge_import' ? input.knowledgeBaseId : value.id))
    return undefined
  if (tool.endsWith('delete') && Object.keys(input).length) return undefined
  return value
}

function skillBefore(value: unknown): Data | undefined {
  const before = record(value)
  return before &&
    text(before.name) &&
    typeof before.description === 'string' &&
    typeof before.enabled === 'boolean' &&
    hash(before.hash) &&
    Array.isArray(before.files) &&
    before.files.every((file) => {
      const item = record(file)
      return item && text(item.path) && integer(item.size)
    })
    ? before
    : undefined
}
function validSkillPreview(value: Data, tool: ToolName): Data | undefined {
  if (
    !text(value.id) ||
    !/^skill-[a-f0-9]{32}$/.test(value.id) ||
    !scope(value.scope) ||
    !text(value.name) ||
    !text(value.directory)
  )
    return undefined
  if (tool === 'skill_create')
    return text(value.content) && value.before === undefined ? value : undefined
  const before = skillBefore(value.before)
  if (!before || before.name !== value.name) return undefined
  if (tool === 'skill_update' && !text(value.content)) return undefined
  if (tool === 'skill_set_enabled' && typeof value.enabled !== 'boolean') return undefined
  return value
}
function validArguments(args: Data | undefined, tool: ToolName): Data | undefined {
  if (!args) return undefined
  if (tool.startsWith('cron_')) {
    if (tool !== 'cron_create' && !text(args.id)) return undefined
    return tool === 'cron_delete' || validCronInput(args, tool === 'cron_create') ? args : undefined
  }
  if (tool.startsWith('knowledge_')) {
    if (!['knowledge_create', 'knowledge_import'].includes(tool) && !text(args.id)) return undefined
    return validKnowledgeInput(args, tool, false) ? args : undefined
  }
  if (args.scope !== undefined && !scope(args.scope)) return undefined
  if (tool === 'skill_create')
    return text(args.name) && text(args.description) && text(args.content) ? args : undefined
  if (!text(args.id) || !/^skill-[a-f0-9]{32}$/.test(args.id)) return undefined
  if (tool === 'skill_update')
    return text(args.content) && hash(args.expectedHash) ? args : undefined
  if (tool === 'skill_set_enabled') return typeof args.enabled === 'boolean' ? args : undefined
  return args
}

function validCronInput(input: Data, create: boolean): boolean {
  if (!stringFields(input, ['name', 'description', 'message', 'cronExpr', 'sessionId']))
    return false
  if (
    ['name', 'message', 'cronExpr', 'sessionId'].some(
      (key) => Object.hasOwn(input, key) && !text(input[key])
    )
  )
    return false
  if (input.configuration !== undefined && !isAutomationConfiguration(input.configuration))
    return false
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') return false
  if (input.agentId !== undefined && input.agentId !== null && !text(input.agentId)) return false
  if (
    input.timeoutSeconds !== undefined &&
    input.timeoutSeconds !== null &&
    !integer(input.timeoutSeconds)
  )
    return false
  if (
    input.thinkingMode !== undefined &&
    input.thinkingMode !== null &&
    typeof input.thinkingMode !== 'boolean' &&
    !['low', 'medium', 'high'].includes(String(input.thinkingMode))
  )
    return false
  if (input.expectedRevision !== undefined && !revision(input.expectedRevision)) return false
  return create
    ? text(input.name) &&
        text(input.message) &&
        (isAutomationConfiguration(input.configuration) || text(input.cronExpr))
    : [
        'name',
        'description',
        'message',
        'cronExpr',
        'sessionId',
        'configuration',
        'enabled',
        'agentId',
        'thinkingMode',
        'timeoutSeconds'
      ].some((key) => Object.hasOwn(input, key))
}
function validCronPreview(value: Data, tool: ToolName): Data | undefined {
  if (tool === 'cron_create')
    return validCronInput(value, true) && isAutomationConfiguration(value.configuration)
      ? value
      : undefined
  const before = tool === 'cron_delete' ? value : record(value.before)
  if (!before || !isAutomationConfiguration(before.configuration)) return undefined
  try {
    validateAutomationJob(before)
  } catch {
    return undefined
  }
  if (tool === 'cron_delete') return value
  const changes = record(value.changes)
  return changes && validCronInput(changes, false) && changes.expectedRevision === before.revision
    ? value
    : undefined
}

function display(value: unknown): string {
  return value === null ? '未归属知识库' : value === '' ? '（空）' : String(value)
}
function field(
  presentation: PermissionPresentation,
  label: string,
  value: unknown,
  previous?: unknown
): void {
  if (value === undefined) return
  const item: PermissionField = {
    label,
    value: display(value),
    ...(previous === undefined ? {} : { previous: display(previous) })
  }
  if (
    item.value.length > 180 ||
    /[\r\n]/.test(item.value) ||
    (item.previous?.length ?? 0) > 180 ||
    /[\r\n]/.test(item.previous ?? '')
  ) {
    presentation.sections.push({
      id: `management-${presentation.sections.length}`,
      label,
      text: item.value,
      ...(item.previous === undefined ? {} : { previous: item.previous })
    })
  } else presentation.fields.push(item)
}
function section(
  presentation: PermissionPresentation,
  label: string,
  values: Omit<PermissionSection, 'id' | 'label'>
): void {
  presentation.sections.push({ id: `management-${presentation.sections.length}`, label, ...values })
}

function knowledge(
  presentation: PermissionPresentation,
  tool: ToolName,
  preview: Data | undefined,
  args: Data | undefined
): void {
  const input = preview ? record(preview.input)! : args
  if (!input) return
  const before = record(preview?.before)
  const document = tool === 'knowledge_import' || tool.includes('document_')
  presentation.summary =
    tool === 'knowledge_create'
      ? String(input.name)
      : tool === 'knowledge_import'
        ? text(input.filename)
          ? input.filename
          : undefined
        : before
          ? String(document ? before.filename : before.name)
          : undefined
  field(
    presentation,
    document ? '文档 ID' : '知识库 ID',
    preview?.id ?? (tool === 'knowledge_import' ? undefined : input.id)
  )
  if (tool === 'knowledge_create') field(presentation, '用途', input.description)
  if (tool === 'knowledge_update') {
    field(presentation, '名称', input.name, before?.name)
    field(presentation, '用途', input.description, before?.description)
  }
  if (tool === 'knowledge_delete') {
    field(presentation, '用途', before?.description)
    field(presentation, '文档数量', before?.documentCount)
  }
  if (document) {
    const updating = tool === 'knowledge_document_update'
    field(presentation, '文件名', input.filename, updating ? before?.filename : undefined)
    const baseId =
      input.knowledgeBaseId !== undefined ? input.knowledgeBaseId : before?.knowledgeBaseId
    field(
      presentation,
      '所属知识库',
      tool === 'knowledge_import' && before ? `${before.name}（${baseId}）` : baseId,
      updating && Object.hasOwn(input, 'knowledgeBaseId') ? before?.knowledgeBaseId : undefined
    )
    field(
      presentation,
      '内容类型',
      input.contentType ?? before?.contentType,
      updating && Object.hasOwn(input, 'contentType') ? before?.contentType : undefined
    )
  }
  if (typeof input.content === 'string') {
    const facts: PermissionField[] = []
    if (integer(input.bytes)) facts.push({ label: '内容大小', value: `${input.bytes} 字节` })
    if (hash(input.sha256)) facts.push({ label: 'SHA-256', value: input.sha256 })
    // The document preview deliberately omits old content; never invent a diff.
    section(presentation, tool === 'knowledge_document_update' ? '更新内容' : '文档内容', {
      text: input.content,
      ...(facts.length ? { facts } : {})
    })
  }
  const source = record(preview?.source)
  if (source)
    section(presentation, '来源文件', {
      facts: [
        { label: '文件路径', value: String(source.path) },
        ...(source.path === source.submittedPath
          ? []
          : [{ label: '请求路径', value: String(source.submittedPath) }]),
        { label: '文件校验', value: String(source.hash) }
      ]
    })
  else if (text(input.path)) field(presentation, '来源文件', input.path)
  if (text(preview?.warning)) section(presentation, '导入说明', { text: preview.warning })
}

function skill(
  presentation: PermissionPresentation,
  tool: ToolName,
  preview: Data | undefined,
  args: Data | undefined
): void {
  const input = preview ?? args
  if (!input) return
  const before = record(preview?.before)
  if (text(input.name)) presentation.summary = input.name
  field(presentation, '技能 ID', input.id)
  if (scope(input.scope))
    field(presentation, '范围', input.scope === 'global' ? '本机全局' : '当前项目')
  field(presentation, '技能目录', preview?.directory)
  if (tool === 'skill_create') {
    const description =
      preview && typeof input.content === 'string'
        ? input.content.match(/^---\r?\nname: [^\r\n]+\r?\ndescription: ([^\r\n]+)\r?\n---/)?.[1]
        : input.description
    field(presentation, '用途', description)
  }
  if (tool === 'skill_set_enabled') {
    presentation.title = presentation.confirmLabel = input.enabled ? '启用技能' : '停用技能'
    field(
      presentation,
      '启用状态',
      input.enabled ? '启用' : '停用',
      before ? (before.enabled ? '启用' : '停用') : undefined
    )
  }
  if (tool === 'skill_delete' || tool === 'skill_set_enabled')
    field(presentation, '用途', before?.description)
  if (typeof input.content === 'string')
    section(presentation, tool === 'skill_update' ? '更新内容' : '技能内容', {
      text: input.content
    })
  if (before && Array.isArray(before.files) && before.files.length)
    section(presentation, tool === 'skill_delete' ? '将删除的文件' : '现有文件', {
      items: before.files.map((file) => {
        const entry = record(file)!
        return `${entry.path} · ${entry.size} 字节`
      })
    })
}

function cronSettings(value: unknown): Record<string, string> {
  if (!isAutomationConfiguration(value)) return {}
  const target = value.target
  return {
    执行规则: scheduleLabel({ configuration: value, cronExpr: null }),
    ...(value.schedule.kind === 'interval'
      ? { 间隔起点: new Date(value.schedule.anchorAt).toISOString() }
      : {}),
    执行位置:
      target.kind === 'session'
        ? `已有会话 · ${target.sessionId}`
        : target.kind === 'workspace'
          ? `项目工作区 · 来源会话 ${target.sourceSessionId}`
          : '每次创建独立会话',
    运行通知: value.notificationPolicy === 'silent' ? '静默' : '每次运行',
    工具范围: value.toolProfile === 'code' ? '代码' : '通用'
  }
}
function thinkingLabel(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (value === null) return '使用运行默认设置'
  if (typeof value === 'boolean') return value ? '开启' : '关闭'
  return ({ low: '低', medium: '中', high: '高' } as Record<string, string>)[String(value)]
}
function timeoutLabel(value: unknown): string | undefined {
  return value === undefined ? undefined : value === null || value === 0 ? '不限时' : `${value} 秒`
}
function cron(
  presentation: PermissionPresentation,
  tool: ToolName,
  preview: Data | undefined,
  args: Data | undefined
): void {
  const before = preview && (tool === 'cron_delete' ? preview : record(preview.before))
  const input = preview ? (tool === 'cron_update' ? record(preview.changes) : preview) : args
  if (!input) return
  const updating = tool === 'cron_update'
  const previous = updating ? before : undefined
  presentation.summary =
    before && text(before.name) ? before.name : text(input.name) ? input.name : undefined
  field(presentation, '任务 ID', before?.id ?? (tool === 'cron_create' ? undefined : input.id))
  if (updating) field(presentation, '名称', input.name, previous?.name)
  field(presentation, '用途', input.description, previous?.description)
  if (text(input.message))
    section(presentation, '任务指令', {
      text: input.message,
      ...(previous && typeof previous.message === 'string' ? { previous: previous.message } : {})
    })
  const settings = cronSettings(input.configuration)
  const priorSettings = cronSettings(previous?.configuration)
  for (const [label, value] of Object.entries(settings))
    field(presentation, label, value, priorSettings[label])
  if (!isAutomationConfiguration(input.configuration)) {
    field(presentation, 'Cron 规则', input.cronExpr, previous?.cronExpr ?? undefined)
    field(presentation, '目标会话', input.sessionId, previous?.sessionId ?? undefined)
  }
  const enabled = input.enabled ?? (tool === 'cron_create' ? true : undefined)
  field(
    presentation,
    '计划状态',
    typeof enabled === 'boolean' ? (enabled ? '启用' : '暂停') : undefined,
    previous ? (previous.enabled ? '启用' : '暂停') : undefined
  )
  if (tool === 'cron_create' && enabled === false)
    presentation.reason = '保存为暂停的定时任务，启用前不会按计划运行。'
  if (
    updating &&
    typeof input.enabled === 'boolean' &&
    Object.keys(input).every((key) => ['id', 'enabled', 'expectedRevision'].includes(key))
  ) {
    presentation.title = presentation.confirmLabel = input.enabled ? '启用定时任务' : '暂停定时任务'
    presentation.reason = input.enabled
      ? '启用此定时任务，按既定规则运行任务指令。'
      : '暂停此定时任务，不会停止已经开始的运行。'
  }
  field(
    presentation,
    'Agent',
    input.agentId === null ? '清除 Agent 选择' : input.agentId,
    previous && Object.hasOwn(input, 'agentId') ? (previous.agentId ?? '未指定') : undefined
  )
  field(
    presentation,
    '思考模式',
    thinkingLabel(input.thinkingMode),
    previous ? thinkingLabel(previous.thinkingMode) : undefined
  )
  field(
    presentation,
    '运行时限',
    timeoutLabel(input.timeoutSeconds),
    previous ? timeoutLabel(previous.timeoutSeconds) : undefined
  )
}

function finishDetails(presentation: PermissionPresentation, tool: ToolName): void {
  // Keep the overview small; identifiers and exact changes belong in the inspector.
  const facts = presentation.fields.filter(
    (item) => item.label !== '用途' || item.previous !== undefined
  )
  presentation.fields = presentation.fields.filter((item) => !facts.includes(item))
  const label = tool.startsWith('cron_')
    ? '执行设置'
    : tool.startsWith('skill_')
      ? '技能信息'
      : tool === 'knowledge_import' || tool.includes('document_')
        ? '文档信息'
        : '知识库信息'
  presentation.sections.push({
    id: 'management-operation',
    label,
    text: presentation.reason,
    ...(facts.length ? { facts } : {})
  })
  presentation.reason = undefined
}

/** Presentation never changes approval values or the prepared operation kept by the engine. */
export function appendManagementPresentation(
  presentation: PermissionPresentation,
  pending: PendingInteraction
): boolean {
  if (!Object.hasOwn(titles, pending.toolName)) return false
  const tool = pending.toolName as ToolName
  presentation.kind = 'management'
  presentation.title = presentation.confirmLabel = titles[tool]
  presentation.destructive = tool.endsWith('_delete')
  presentation.reason = descriptions[tool]
  const preview = prepared(pending.question, tool)
  const args = validArguments(record(pending.args), tool)
  if (tool.startsWith('knowledge_')) knowledge(presentation, tool, preview, args)
  else if (tool.startsWith('skill_')) skill(presentation, tool, preview, args)
  else cron(presentation, tool, preview, args)
  if (!preview && !args) presentation.reason += ' 请展开完整参数核对具体内容。'
  finishDetails(presentation, tool)
  return true
}
