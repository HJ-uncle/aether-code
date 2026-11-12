/** Real isolated Work approval/question regression: prepared Agent configuration, bounded
 * disclosures, accessible decisions, exact durable request identity and session
 * full-access ordering. HTTP/SSE records side effects; no Agent or command is
 * actually executed, and opening details cannot authorize a response or write. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RootPending, RootRun } from '../src/shared/root-run'
import type { ChatSsePayload } from '../src/shared/ipc'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp')
const token = 'permission-card-ui-token', modelId = 'permission-card-model', workspaceRoot = '/remote/permission-card-fixture'
const longPrompt = '按事实逐项核对资料，保留完整来源并区分待确认信息。\n'.repeat(140) + '完整工作指令结尾：保留这句话以核对全部内容。'
const preparedTools = [
  'read_file', 'write_file', 'edit_file', 'list_files', 'delete_file', 'create_dir', 'glob', 'grep',
  'office_document', 'office_inspect', 'office_environment', 'deliver_files', 'workbench_context', 'workbench_open', 'workbench_render',
  'execute_cmd', 'command_output', 'cancel_command', 'web_fetch', 'http_request', 'browser_tabs', 'browser_open', 'browser_navigate',
  'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_fill', 'browser_scroll', 'browser_press_key', 'browser_wait',
  'browser_console', 'browser_network', 'browser_network_request', 'browser_set_viewport', 'browser_close', 'code_diagnose', 'codegraph',
  'agent_list', 'agent_get', 'agent_create', 'agent_update', 'agent_delete', 'remember', 'recall', 'list_memories', 'forget', 'link_memories', 'search_history',
]
const preparedCreate = { name: '项目交付审阅助手', description: '检查项目说明、数据依据与交付文件。', systemPrompt: longPrompt,
  model: modelId, temperature: 0.35, skills: ['文档审阅'], mcpServers: ['fixture-docs'], knowledgeBases: ['fixture-knowledge'], allowedTools: preparedTools }
const previousAgent = { id: 'agent-permission-target', name: '原项目助手', description: '保留事实来源。', systemPrompt: '原始工作指令。',
  model: modelId, temperature: 0.2, skills: [], mcpServers: [], knowledgeBases: [], allowedTools: ['read_file'] }
const updateChanges = { name: '更新后的项目助手', description: '补充改动核对与交付检查。', systemPrompt: '更新指令：先核对来源，再汇总本次改动。', allowedTools: ['read_file', 'write_file'] }
const questionGroups = [
  { tab: '交付形式', question: '这次先交付哪一种材料？', multiSelect: false, allowInput: false,
    options: [{ label: '项目说明', description: '先完成可阅读的项目背景、目标与使用说明。' },
      { label: '演示文稿', description: '先整理用于评审展示的内容与结论。' }] },
  { tab: '检查范围', question: '本次需要核对哪些内容？', multiSelect: true, allowInput: true,
    options: [{ label: '功能清单', description: '逐项确认现有功能与交付范围，保留完整核对结果。' },
      { label: '数据来源', description: '记录数据出处、引用链接与最后核对时间。' },
      ...Array.from({ length: 12 }, (_, index) => ({ label: `附加核对 ${index + 1}`, description: `完整保留第 ${index + 1} 项的检查依据与后续处理要求。` }))] },
  { question: '还有哪些必须保留的要求？', options: [], allowInput: true },
]
const singleQuestion = '请补充需要保留的交付要求。'
const longMultiQuestion = { question: '这次项目交付需要重点检查哪些方面？可以选择多项，并补充需要保留的要求。', multiSelect: true, allowInput: true,
  options: [
    { label: '功能范围与交付完整性', description: '逐项核对本次计划中的功能、实际完成的内容与尚未处理的事项，说明每一项交付的对应文件、适用场景和检查方式。对于暂时不能验证的部分，保留原因与后续处理建议，方便继续跟进。' },
    { label: '资料来源与关键数据', description: '检查引用材料、原始数据和结论之间是否一致，保留可访问的来源链接、采集时间与必要的上下文。存在不同口径、缺失记录或需要再次确认的数据时，应明确标注，避免把推测写成已经确认的事实。' },
    { label: '文档结构与阅读体验', description: '按阅读顺序检查标题、段落、表格和图片的关系，让项目背景、主要结论与后续行动容易查找。保留完整说明和图片原始比例，确保较窄窗口下文字能自然换行，不会被截断或遮挡。' },
    { label: '可编辑文件与后续维护', description: '核对最终材料是否包含可继续编辑的源文件、必要附件与使用说明，并检查文件之间的引用关系。对于后续需要更新的内容，说明维护位置、修改方式和验证步骤，让接手者可以直接继续工作。' },
  ] }
const pluginSource = Array.from({ length: 72 }, (_, index) => `// 插件源码核对 ${index + 1}：保留完整内容。`).join('\n') +
  '\nlet input = "";\nfor await (const chunk of process.stdin) input += chunk;\nconst request = JSON.parse(input);\nconsole.log(JSON.stringify({ result: request.args }));\n// PLUGIN_SOURCE_END_完整源码末尾'
const pluginManifest = { apiVersion: 1, id: 'permission-report-plugin', name: '项目资料整理插件', version: '1.0.0',
  description: '汇总项目资料并生成可核对的交付说明。', runtime: 'node', tools: [
    { name: 'summarize', description: '汇总资料中的重点与待确认信息。', entry: 'main.mjs',
      inputSchema: { type: 'object', properties: { text: { type: 'string', description: '待整理的资料正文' } }, required: ['text'], additionalProperties: false } },
    { name: 'export_report', description: '生成包含来源与结论的交付说明。', entry: 'main.mjs',
      inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } },
  ] }
const pluginFiles = { 'main.mjs': pluginSource, 'README.md': '# 项目资料整理插件\n只读取本次调用传入的资料。\nREADME_END_文件末尾' }
const updatedPluginManifest = { ...pluginManifest, name: '项目资料整理与审阅插件', version: '1.1.0', description: '增加来源复核与交付审阅。' }
const updatedPluginFiles = { ...pluginFiles, 'main.mjs': `${pluginSource}\n// UPDATE_SOURCE_END_更新源码末尾` }
const knowledgeCreateArgs = { name: '项目交付知识库', description: '保存项目背景、资料来源与交付核对记录。' }
const knowledgeCreateId = '6b9a04f4-a1fd-4da1-b1de-dbd0041d9cb5'
const knowledgeDocumentId = 'b719ae24-c753-477b-9d57-25b27a8c8464'
const knowledgeBefore = { id: 'cc365864-7310-4847-888b-926e5aca3345', tenantId: 'permission-card-tenant', revision: 5,
  name: '现有项目资料库', description: '保留来源信息。', documentCount: 3, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000 }
const knowledgeContent = Array.from({ length: 92 }, (_, index) => `第 ${index + 1} 条核对记录：来源、证据与待确认信息都必须完整保留。`).join('\n') + '\nKNOWLEDGE_CONTENT_END_完整知识文档末尾'
const knowledgeContentHash = `sha256:${createHash('sha256').update(knowledgeContent).digest('hex')}`
const knowledgeImportArgs = { knowledgeBaseId: knowledgeBefore.id, filename: '项目交付核对记录.txt', content: knowledgeContent }
const skillArgs = { name: 'delivery-review', description: '核对交付资料与来源，保留完整审阅记录。', scope: 'project',
  content: '# 交付审阅\n\n' + '逐项检查资料、来源和待确认信息。\n'.repeat(45) + 'SKILL_CONTENT_END_技能正文末尾' }
const skillId = `skill-${'a1'.repeat(16)}`, skillDirectory = `${workspaceRoot}/.aether/skills/${skillArgs.name}`
const preparedSkillContent = `---\nname: ${skillArgs.name}\ndescription: ${skillArgs.description}\n---\n\n${skillArgs.content.trim()}\n`
const cronArgs = { name: '工作日资料核对', description: '整理项目新增资料并记录待确认事项。',
  message: '检查资料来源并核对本次新增内容。\n'.repeat(45) + 'CRON_MESSAGE_END_任务指令末尾',
  configuration: { version: 2, schedule: { kind: 'calendar', localTime: '09:30', timeZone: 'Asia/Shanghai', daysOfWeek: [1, 2, 3, 4, 5] },
    target: { kind: 'standalone' }, notificationPolicy: 'silent', toolProfile: 'general' }, enabled: false, thinkingMode: 'high', timeoutSeconds: 120 }
const mcpArgs = { id: 'delivery-docs', scope: 'project', name: '交付资料服务', description: '提供交付资料的只读检索。',
  transportType: 'stdio', command: 'node', args: ['fixture-server.mjs', '--read-only'], timeoutMs: 15000, disabledTools: [] }
const mcpConfigFile = `${workspaceRoot}/.aether/mcp.json`
const commandScript = 'const reports = [];\n' + Array.from({ length: 60 }, (_, index) =>
  `reports.push({ index: ${index}, message: "保留第 ${index + 1} 项的原始内容与空格" });`).join('\n') +
  '\nconsole.log(JSON.stringify({ reports, note: "原样保留分号 ; 和空格" }));\n// COMMAND_ARGV_END_完整脚本末尾'
const commandArgvArgs = { command: 'node', args: ['-e', commandScript], cwd: 'mcp-test-server', timeoutMs: 120000,
  options: { keepOriginal: true, limits: { retries: 0, label: null }, destinations: ['第一处', '第二处'] } }
type Scenario = 'create' | 'update' | 'delete' | 'command' | 'command-argv' | 'questions' | 'single-question' | 'long-multi-question' | 'plugin-create' | 'plugin-update' | 'plugin-delete' | 'knowledge-create' | 'knowledge-import' | 'skill-create' | 'cron-create' | 'mcp-create'
type Decision = 'approved' | 'rejected'
const errors: string[] = [], forbidden: string[] = [], history: EngineHistoryRow[] = [], projection: ChatSsePayload[] = []
const chats: Record<string, unknown>[] = [], decisions: Array<{ sessionId: string; runId: string; toolResponse: Record<string, unknown> }> = []
const securityWrites: Array<{ sessionId: string; mode: string }> = [], audit: string[] = []
const admissions = new Map<string, { admission: Record<string, unknown>; run: RootRun }>()
let current: RootRun | undefined, activeStream: ServerResponse | undefined, ordinal = 0, scenario: Scenario = 'create'
let expectedDecision: string | null = null, allowFullAccess = false, securityMode = 'safe'
let app: ElectronApplication | undefined, page: Page, fixture = ''
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const attempt = (): string => `permission-attempt-${current?.runId ?? 'none'}-${current?.version ?? 0}`

function pendingFor(kind: Scenario, sequence: number): RootPending {
  const common = { requestId: `permission-request-${sequence}`, toolCallId: `permission-tool-call-${sequence}`, kind: 'permission' as const, status: 'pending' as const }
  if (kind === 'questions') return { ...common, kind: 'ask', toolName: 'ask_user', args: { questions: questionGroups } }
  if (kind === 'single-question') return { ...common, kind: 'ask', toolName: 'ask_user', args: { question: singleQuestion, options: [] }, question: singleQuestion }
  if (kind === 'long-multi-question') return { ...common, kind: 'ask', toolName: 'ask_user', args: { questions: [longMultiQuestion] } }
  if (kind === 'command') return { ...common, toolName: 'execute_cmd', args: { command: 'printf "permission-fixture-only"', cwd: workspaceRoot },
    description: '需要执行这条命令以检查工作目录，实际命令只在隔离夹具中展示。' }
  if (kind === 'command-argv') return { ...common, toolName: 'execute_cmd', args: commandArgvArgs,
    description: '需要检查本地测试服务的输入参数；仅展示待确认的程序和完整脚本，不执行真实命令。' }
  if (kind === 'skill-create' || kind === 'cron-create' || kind === 'mcp-create') {
    const revision = `sha256:${'b'.repeat(64)}`
    const after = { id: mcpArgs.id, scope: mcpArgs.scope, name: mcpArgs.name, description: mcpArgs.description,
      enabled: false, transportType: 'stdio', revision, connection: { command: 'node', argumentCount: 2, envKeys: [], headerKeys: [] },
      timeoutMs: 15000, disabledTools: [], isBuiltIn: false }
    const specs = {
      'skill-create': { title: '创建技能', toolName: 'skill_create', args: skillArgs,
        operation: { version: 1, tenantId: 'permission-card-tenant', action: 'create', scope: 'project', projectRoot: workspaceRoot,
          root: `${workspaceRoot}/.aether/skills`, anchor: workspaceRoot, configPath: `${workspaceRoot}/.aether/skills/skills.config.json`,
          file: `${skillDirectory}/SKILL.md`, dir: skillDirectory, id: skillId, name: skillArgs.name, expectedHash: 'missing', revision, content: preparedSkillContent },
        preview: { action: 'create', id: skillId, scope: 'project', name: skillArgs.name, directory: skillDirectory, content: preparedSkillContent } },
      'cron-create': { title: '创建定时任务', toolName: 'cron_create', args: cronArgs,
        operation: { version: 1, tenantId: 'permission-card-tenant', id: '552775bc-7f91-49aa-90b5-d4d37bd5e840', input: cronArgs }, preview: cronArgs },
      'mcp-create': { title: '创建 MCP 服务器', toolName: 'mcp_server_create', args: mcpArgs,
        operation: { version: 1, tenantId: 'permission-card-tenant', action: 'create', id: mcpArgs.id, scope: 'project', projectRoot: workspaceRoot,
          source: mcpConfigFile, target: mcpConfigFile, revision, argsHash: `sha256:${createHash('sha256').update(JSON.stringify(mcpArgs)).digest('hex')}`, after },
        preview: { action: 'create', id: mcpArgs.id, scope: 'project', configFile: mcpConfigFile, after } },
    }
    const spec = specs[kind], reason = `${spec.title}确认\n\n${JSON.stringify(spec.preview, null, 2)}\n\n确认后执行以上操作。`
    return { ...common, toolName: spec.toolName, args: spec.args,
      description: `安全策略拦截了此操作，是否允许执行？\n原因：${reason}`,
      pendingAction: { type: spec.toolName, operation: spec.operation, reason } }
  }
  if (kind === 'knowledge-create' || kind === 'knowledge-import') {
    const creating = kind === 'knowledge-create', action = creating ? 'create' : 'import', toolName = `knowledge_${action}`
    const args = creating ? knowledgeCreateArgs : knowledgeImportArgs
    const input = creating ? knowledgeCreateArgs : { ...knowledgeImportArgs, contentType: 'text/plain' }
    const operation = { version: 1, tenantId: 'permission-card-tenant', action, id: creating ? knowledgeCreateId : knowledgeDocumentId, input,
      ...(!creating ? { before: knowledgeBefore, expectedRevision: knowledgeBefore.revision } : {}) }
    // The knowledge preview adds content bytes/hash while the durable operation
    // retains the exact text and generated resource ID for the later approval.
    const preview = { action, id: operation.id, ...(!creating ? { before: knowledgeBefore } : {}),
      input: creating ? input : { ...input, bytes: Buffer.byteLength(knowledgeContent, 'utf8'), sha256: knowledgeContentHash } }
    const reason = `${creating ? '创建知识库' : '导入知识文档'}确认\n\n${JSON.stringify(preview, null, 2)}\n\n确认后执行以上操作。`
    return { ...common, toolName, args, description: `安全策略拦截了此操作，是否允许执行？\n原因：${reason}`,
      pendingAction: { type: toolName, operation, reason } }
  }
  if (kind === 'plugin-create' || kind === 'plugin-update' || kind === 'plugin-delete') {
    const toolName = kind.replace('-', '_')
    const args = kind === 'plugin-create' ? { manifest: pluginManifest, files: pluginFiles }
      : kind === 'plugin-update' ? { id: pluginManifest.id, manifest: updatedPluginManifest, files: updatedPluginFiles, expectedRevision: 3 }
        : { id: pluginManifest.id }
    // Plugin management uses the complete prepared operation as its preview;
    // deletion intentionally contains identity/revision only, not a made-up manifest.
    const operation = { version: 1, tenantId: 'permission-card-tenant', action: toolName, input: args,
      ...(kind !== 'plugin-create' ? { expectedRevision: 3, expectedUpdatedAt: 1_700_000_000_000 } : {}) }
    const title = { 'plugin-create': '创建插件', 'plugin-update': '编辑插件', 'plugin-delete': '删除插件' }[kind]
    const reason = `${title}确认\n\n${JSON.stringify(operation, null, 2)}\n\n确认后执行以上操作。`
    return { ...common, toolName, args, description: `安全策略拦截了此操作，是否允许执行？\n原因：${reason}`,
      pendingAction: { type: toolName, operation, reason } }
  }
  const toolName = `agent_${kind}`, args = kind === 'create'
    ? { name: preparedCreate.name, description: preparedCreate.description, systemPrompt: longPrompt }
    : kind === 'update' ? { id: previousAgent.id, ...updateChanges } : { id: previousAgent.id }
  const config = kind === 'create' ? preparedCreate : kind === 'update'
    ? { id: previousAgent.id, before: previousAgent, changes: updateChanges, after: { ...previousAgent, ...updateChanges } }
    : { id: previousAgent.id, agent: previousAgent }
  const reason = `Agent ${{ create: '创建', update: '更新', delete: '删除' }[kind]}确认\n\n${JSON.stringify(config, null, 2)}\n\n确认后执行以上配置。`
  const description = `安全策略拦截了此操作，是否允许执行？\n原因：${reason}`
  return { ...common, toolName, args, description, pendingAction: { type: toolName, reason,
    operation: { version: 1, action: kind, tenantId: 'permission-card-tenant',
      ...(kind === 'create' ? { input: preparedCreate } : { id: previousAgent.id, before: previousAgent, ...(kind === 'update' ? { input: updateChanges } : {}) }) } } }
}
function updateRun(patch: Partial<RootRun>): RootRun {
  if (!current) throw new Error('Missing permission fixture root')
  current = { ...current, ...patch, version: current.version + 1, updatedAt: Date.now() }
  return current
}
function publish(payload: ChatSsePayload): void {
  if (!current || !activeStream || activeStream.writableEnded) throw new Error('Missing owned permission stream')
  projection.push(payload)
  activeStream.write(`id: ${current.runId}:${projection.length}\ndata: ${JSON.stringify(payload)}\n\n`)
}
function requestPermission(): void {
  if (!current) throw new Error('Missing permission fixture root')
  const pending = pendingFor(scenario, current.seq)
  if (pending.kind === 'ask') publish({ ask_user: { toolCallId: pending.toolCallId, ...pending.args } })
  else {
    publish({ ask_user: { toolCallId: pending.toolCallId, question: pending.description, options: ['approved', 'rejected'] } })
    publish({ permissionRequest: { ...pending, requestId: pending.toolCallId } })
  }
  publish({ run: updateRun({ status: 'waiting', pending: [pending] }) })
  activeStream!.end('data: [DONE]\n\n'); activeStream = undefined
}
function finishDecision(output: string): void {
  if (!current || !activeStream) throw new Error('Missing decision stream')
  const pending = current.pending[0]
  publish({ run: updateRun({ status: 'running', pending: [{ ...pending, status: 'answered', output }] }) })
  const text = `PERMISSION_FINISHED_${current.seq}：已记录${pending.kind === 'ask' ? '回答' : output === 'approved' ? '允许' : '拒绝'}，未执行真实操作。`
  const finalResult = { schemaVersion: 1 as const, sessionId: current.sessionId, turnId: current.turnId, runId: current.runId,
    assistantMessageId: current.assistantMessageId, text, publishedAt: Date.now(), items: [] }
  const assistant = history.find(row => row.id === current!.assistantMessageId)!
  assistant.content = text; assistant.metadata = { ...assistant.metadata, finalResult }
  // The engine emits response text before the manifest; Code displays that
  // transcript while Work uses the final-result projection.
  publish({ content: `\n\n${text}` })
  publish({ finalResult }); publish({ run: updateRun({ status: 'succeeded', finishedAt: Date.now() }) })
  activeStream.end('data: [DONE]\n\n'); activeStream = undefined
}

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname, sessionId = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  let raw = ''; for await (const part of request) raw += part.toString()
  const value: unknown = raw ? JSON.parse(raw) : {}, input = record(value) ? value : {}
  if (path === '/api/v1/chat/admission/context') {
    const matching = current?.sessionId === sessionId ? { ...current, attemptId: attempt() } : null
    response.end(envelope({ protocolVersion: 1, tenantId: 'permission-card-tenant', sessionId,
      namespace: { id: 'permission-card-db', generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general',
        runLifetime: 'durable', subagentProtocol: 2 }, root: matching,
      predecessor: matching ? { runId: matching.runId, attemptId: matching.attemptId, version: matching.version } : null })); return
  }
  if (path === '/api/v1/chat/admission/receipt') {
    const accepted = admissions.get(String(input.requestKey))
    response.end(envelope(accepted ? { protocolVersion: 1, status: 'accepted', receipt: { ...accepted.admission, sessionId: accepted.run.sessionId,
      rootRunId: accepted.run.runId, turnId: accepted.run.turnId, userMessageId: accepted.run.userMessageId, assistantMessageId: accepted.run.assistantMessageId },
      run: accepted.run, projection: { rootVersion: accepted.run.version, rootAttemptId: attempt(),
        user: { messageId: accepted.run.userMessageId, state: 'projected' }, assistant: { anchorMessageId: accepted.run.assistantMessageId, state: 'persisted', messageId: accepted.run.assistantMessageId } } }
      : { protocolVersion: 1, status: 'absent', namespace: input.namespace, sessionId: input.sessionId, requestKey: input.requestKey })); return
  }
  if (path === '/api/v1/chat' && request.method === 'POST') {
    chats.push(input)
    if (activeStream) throw new Error('Another chat was sent before the prior stream completed')
    if (record(input.toolResponse)) {
      const result = input.toolResponse, pending = current?.pending[0]
      if (!current || current.status !== 'waiting' || !expectedDecision || input.sessionId !== current.sessionId || input.runId !== current.runId ||
        result.requestId !== pending?.requestId || result.runId !== current.runId || result.toolCallId !== pending.toolCallId ||
        result.name !== pending.toolName || result.output !== expectedDecision) throw new Error(`Unexpected permission response: ${JSON.stringify(input)}`)
      decisions.push({ sessionId: current.sessionId, runId: current.runId, toolResponse: result }); audit.push('decision')
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); activeStream = response
      finishDecision(expectedDecision); expectedDecision = null; return
    }
    if (typeof input.sessionId !== 'string' || input.message !== `PERMISSION_SCENARIO_${scenario}`) throw new Error('Unexpected initial message')
    const now = Date.now(), sequence = ++ordinal
    current = { schemaVersion: 1, runId: `permission-run-${sequence}`, sessionId: input.sessionId, turnId: `permission-turn-${sequence}`,
      userMessageId: `permission-user-${sequence}`, assistantMessageId: `permission-assistant-${sequence}`, seq: sequence, version: 1,
      status: 'running', modelId, pending: [], workspacePaths: [workspaceRoot], createdAt: now, updatedAt: now, startedAt: now }
    history.length = 0; projection.length = 0
    const user: EngineHistoryRow = { id: current.userMessageId, role: 'user', content: input.message, createdAt: now,
      conversationId: current.turnId, metadata: { rootRunId: current.runId, turnId: current.turnId } }
    history.push(user, { id: current.assistantMessageId, role: 'assistant', content: `PERMISSION_ACTIVE_${sequence}`,
      createdAt: now + 1, conversationId: current.turnId, metadata: { rootRunId: current.runId, turnId: current.turnId } })
    if (record(input.admission)) admissions.set(String(input.admission.requestKey), { admission: input.admission, run: current })
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); activeStream = response
    publish({ run: current }); publish({ userMessage: user }); publish({ content: `PERMISSION_ACTIVE_${sequence}` }); return
  }
  if (path === '/api/v1/security/mode' && request.method === 'PUT') {
    if (!current || current.status !== 'waiting' || !allowFullAccess || input.sessionId !== current.sessionId || input.mode !== 'full-access')
      throw new Error(`Unexpected security write: ${JSON.stringify(input)}`)
    securityWrites.push({ sessionId: current.sessionId, mode: input.mode }); audit.push('security')
    securityMode = input.mode; response.end(envelope({ sessionId: current.sessionId, mode: securityMode })); return
  }
  if (path === '/api/v1/workspace/bind' && request.method === 'POST') {
    if (typeof input.sessionId !== 'string' || input.workspaceRoot !== workspaceRoot) throw new Error('Unexpected workspace binding')
    response.end(envelope({ workspaceRoot, bindingEpoch: 'one', contractVersion: 2 })); return
  }
  if (['/api/v1/cron/capabilities', '/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/terminal/create', '/api/v1/lsp/request'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET') { forbidden.push(`${request.method} ${path}`); throw new Error(`Unexpected mutation: ${path}`) }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const matching = current?.sessionId === sessionId ? current : undefined
  if (path === '/api/v1/conversation/display') {
    response.end(envelope({ schemaVersion: 1, grouping: 'root', turns: matching ? [{ userMessageId: matching.userMessageId,
      conversationId: matching.turnId, preview: history[0].content, createdAt: matching.createdAt }] : [], messages: matching ? history : [],
      loadedTurnIds: matching ? [matching.userMessageId] : [], revision: `permission-history-${matching?.version ?? 0}`, mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' })); return
  }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'d'.repeat(64)}`, protocolVersion: 1,
      toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: 'permission-card-fixture' }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '权限卡片测试模型', isEnabled: true, capabilities: { toolCalling: true, contextWindow: 200000 } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId, source: matching ? 'live' : 'persisted', eventId: matching ? `${matching.runId}:${projection.length}` : null,
      finished: matching?.status !== 'running', projection: matching ? projection : [], history: matching ? history : [], run: matching,
      runs: matching ? [matching] : [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: matching?.status === 'running', finished: matching?.status !== 'running', run: matching,
      lastEventId: matching ? `${matching.runId}:${projection.length}` : null }
    : path === '/api/v1/chat/runs' ? { runs: matching ? [matching] : [] }
    : path === '/api/v1/conversation/history' ? matching ? history : []
    : path === '/api/v1/conversation/sessions' ? []
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: Boolean(matching), agentId: null, metadata: null, agent: null }
    : path === '/api/v1/security/mode' ? { mode: securityMode, sessionId }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'session', effectiveScope: 'session', enabled: false, sessionId }
    : path === '/api/v1/workspace/directory' ? { root: workspaceRoot, bindingEpoch: 'one', entries: [] }
    : path === '/api/v1/settings' ? {} : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const work = (): Locator => page.locator('.work-view')
const conversation = (): Locator => work().getByRole('region', { name: '协作对话', exact: true })
const card = (): Locator => conversation().getByRole('form', { name: '操作确认', exact: true })
const questionCard = (): Locator => conversation().getByRole('form', { name: '补充信息', exact: true })
const questionNavigation = (): Locator => questionCard().getByRole('group', { name: '问题导航', exact: true })
const questionTab = (label: string): Locator => questionNavigation().getByRole('button', { name: label, exact: true })
const body = (): Locator => card().getByRole('region', { name: '操作详情', exact: true })
const detailbar = (): Locator => card().getByRole('group', { name: '配置详情', exact: true })
const detail = (label: string): Locator => card().getByRole('button', { name: label, exact: true })
async function resize(width: number): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, width) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(520, 600); win.setContentSize(width, 900) }, width)
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
}
async function shot(name: string): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
    await Promise.allSettled(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished))
  })
  const path = test.info().outputPath(`${name}.png`); await page.screenshot({ path }); await test.info().attach(name, { path, contentType: 'image/png' })
}
async function start(kind: Scenario, appearance: 'light' | 'dark' = 'light', width = 1440): Promise<RootPending> {
  scenario = kind; expectedDecision = null; allowFullAccess = false; securityMode = 'safe'
  chats.length = 0; decisions.length = 0; securityWrites.length = 0; audit.length = 0
  await page.locator('.menu-bar').getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  await settings.getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).toHaveCount(0)
  await resize(width)
  const next = ordinal + 1
  await work().getByRole('button', { name: '新任务', exact: true }).click()
  await work().getByRole('textbox', { name: '任务目标', exact: true }).fill(`PERMISSION_SCENARIO_${kind}`)
  await work().getByRole('button', { name: '开始任务', exact: true }).click()
  await expect(conversation()).toContainText(`PERMISSION_ACTIVE_${next}`)
  requestPermission()
  if (kind === 'questions' || kind === 'single-question' || kind === 'long-multi-question') {
    await expect(questionCard()).toHaveCount(1)
    const submit = questionCard().getByRole('button', { name: '提交回复', exact: true })
    await expect(submit).toBeDisabled()
  } else {
    await expect(card()).toHaveCount(1)
    await expect(card().getByRole('button', { name: '拒绝', exact: true })).toBeEnabled()
  }
  return current!.pending[0]
}
function expectUntouched(): void {
  expect(decisions).toEqual([]); expect(securityWrites).toEqual([]); expect(forbidden).toEqual([])
  expect(chats.filter(item => record(item.toolResponse))).toEqual([])
}
async function decide(pending: RootPending, output: string, button: Locator, fullAccess = false): Promise<void> {
  const owned = current!
  expectedDecision = output; allowFullAccess = fullAccess
  await button.click()
  await expect.poll(() => decisions).toEqual([{ sessionId: owned.sessionId, runId: owned.runId,
    toolResponse: { requestId: pending.requestId, runId: owned.runId, toolCallId: pending.toolCallId, name: pending.toolName, output } }])
  await expect(conversation()).toContainText(`PERMISSION_FINISHED_${owned.seq}`)
  await expect(card()).toHaveCount(0)
  await expect(questionCard()).toHaveCount(0)
  if (!fullAccess) expect(securityWrites).toEqual([])
}
async function expectDecisionsVisible(confirmLabel: string): Promise<void> {
  await expect(card().getByRole('button', { name: confirmLabel, exact: true })).toBeInViewport({ ratio: 1 })
  await expect(card().getByRole('button', { name: '拒绝', exact: true })).toBeInViewport({ ratio: 1 })
  await expect(card().getByRole('button', { name: '本会话改为完全访问并放行', exact: true })).toBeInViewport({ ratio: 1 })
}
async function expectSinglePanel(label: string): Promise<void> {
  await expect(detail(label)).toHaveAttribute('aria-expanded', 'true')
  await expect(body()).toHaveCount(1)
  await expect(card().locator('button[aria-controls][aria-expanded="true"]')).toHaveCount(1)
}
async function openDetail(label: string): Promise<Locator> {
  const button = detail(label)
  await expect(button).toHaveAttribute('aria-expanded', 'false')
  await button.click()
  await expectSinglePanel(label)
  await expect.poll(() => body().evaluate(element => element.scrollTop)).toBe(0)
  return body()
}
async function repeatCurrentDetail(label: string): Promise<void> {
  await expectSinglePanel(label)
  await detail(label).click()
  await expectSinglePanel(label)
}
async function verifyBoundedScroll(confirmLabel: string): Promise<void> {
  const dimensions = await body().evaluate(element => ({ height: element.getBoundingClientRect().height,
    scroll: element.scrollHeight, client: element.clientHeight, limit: Math.min(innerHeight * 0.36, 300) }))
  expect(dimensions.height).toBeLessThanOrEqual(dimensions.limit + 2)
  expect(dimensions.scroll - dimensions.client).toBeGreaterThan(100)
  const footer = card().locator('.work-permission__footer'), before = await footer.boundingBox()
  await body().evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect.poll(() => body().evaluate(element => element.scrollTop)).toBeGreaterThan(100)
  const after = await footer.boundingBox()
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(2)
  await expectDecisionsVisible(confirmLabel)
  expect(await card().evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
}

test.beforeAll(async () => {
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing permission fixture port')
  mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'permission-card-profile-'))
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: `http://127.0.0.1:${address.port}`,
    remoteWorkspaceRoot: workspaceRoot, autoStartEngine: true, lastSessionId: '', lastFolder: '', lastModelId: modelId, thinkingMode: 'off', appearance: 'light' }))
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY',
    'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL', 'AETHER_IDE_REMOTE_INSTANCE_TOKEN'].includes(key.toUpperCase())) delete env[key]
  env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
  app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1440, 900); win.show(); win.focus() })
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
})
test.afterEach(async ({}, info) => {
  if (page && !page.isClosed()) await shot('permission-card-final')
  await info.attach('permission-side-effects', { body: JSON.stringify({ chats, decisions, securityWrites, audit, errors, forbidden }, null, 2), contentType: 'application/json' })
  expect(errors).toEqual([]); expect(forbidden).toEqual([])
})
test.afterAll(async () => {
  try { await app?.close() } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    if (fixture) {
      const target = resolve(fixture)
      if (dirname(target) !== fixtureRoot || !basename(target).startsWith('permission-card-profile-')) throw new Error('Unsafe permission fixture cleanup')
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

for (const appearance of ['light', 'dark'] as const) for (const width of [1440, 760]) {
  test(`${appearance} / ${width}：创建 Agent 使用单行详情栏，面板互斥且保留完整配置和审批`, async () => {
    const pending = await start('create', appearance, width)
    expect(pending.args).not.toHaveProperty('allowedTools')
    await expect(card().getByRole('heading', { name: '创建 Agent', exact: true })).toBeVisible()
    await expect(card().locator('.work-permission__summary')).toHaveText(preparedCreate.name)
    await expect(card().locator('.work-permission__description')).toHaveText(preparedCreate.description)
    await expect(card().locator('.work-permission__metadata')).toContainText('权限卡片测试模型')
    await expect(card().locator('.work-permission__metadata')).toContainText('0.35')
    await expect(card()).not.toContainText('确认后继续当前任务'); await expect(card()).not.toContainText('等待确认')
    await expectSinglePanel('工作指令')
    for (const label of ['资源', '工具权限', '完整参数']) await expect(detail(label)).toHaveAttribute('aria-expanded', 'false')
    await expect(detailbar().getByRole('button')).toHaveCount(4)
    const rows = await detailbar().getByRole('button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().y))
    expect(Math.max(...rows) - Math.min(...rows)).toBeLessThan(5)
    await expectDecisionsVisible('创建 Agent'); expectUntouched()
    await shot(`create-${appearance}-${width}-default`)

    const instructions = body()
    await expect(instructions.locator('[data-section="systemPrompt"]')).toBeVisible()
    expect(await instructions.locator('[data-section="systemPrompt"] > p').textContent()).toBe(longPrompt)
    await verifyBoundedScroll('创建 Agent')
    await shot(`create-${appearance}-${width}-instructions`)
    await repeatCurrentDetail('工作指令'); expectUntouched()
    const resources = await openDetail('资源')
    await expect(detail('工作指令')).toHaveAttribute('aria-expanded', 'false')
    await expect(resources.locator('[data-section="systemPrompt"]')).toHaveCount(0)
    await expect(resources.getByRole('region', { name: '技能', exact: true })).toContainText('文档审阅')
    await expect(resources.getByRole('region', { name: 'MCP 服务', exact: true })).toContainText('fixture-docs')
    await expect(resources.getByRole('region', { name: '知识库', exact: true })).toContainText('fixture-knowledge')
    await expectDecisionsVisible('创建 Agent'); expectUntouched()
    const tools = await openDetail('工具权限')
    await expect(detail('资源')).toHaveAttribute('aria-expanded', 'false')
    await expect(tools.locator('[data-section="skills"]')).toHaveCount(0)
    const toolList = tools.locator('[data-section="allowedTools"]')
    await expect(toolList.locator('.work-permission__tool-group')).toHaveCount(7)
    await expect(toolList.locator('.work-permission__tool-group > h5')).toContainText(['文件与搜索', '办公与预览', '终端命令', '网页与网络', '代码分析', 'Agent 管理', '记忆与历史'])
    await expect(toolList.locator('li')).toHaveCount(preparedTools.length)
    const entries = await toolList.locator('li').evaluateAll(items => items.map(item => ({ text: item.textContent ?? '', id: item.getAttribute('title') })))
    expect(entries.map(item => item.id).sort()).toEqual([...preparedTools].sort())
    for (const entry of entries) { expect(entry.text).toMatch(/\p{Script=Han}/u); expect(entry.text).not.toContain(entry.id); expect(entry.text).not.toMatch(/[（(].*[）)]/) }
    await expect(toolList.locator('li[title="read_file"]')).toHaveText('读取文件')
    await expect(toolList.locator('li[title="execute_cmd"]')).toHaveText('执行命令')
    await verifyBoundedScroll('创建 Agent'); await shot(`create-${appearance}-${width}-tools`)
    const raw = await openDetail('完整参数')
    await expect(detail('工具权限')).toHaveAttribute('aria-expanded', 'false')
    await expect(raw.locator('[data-section="allowedTools"]')).toHaveCount(0)
    const complete = await raw.locator('.work-permission__raw').textContent()
    expect(complete).toContain(pending.description)
    expect(complete).toContain(JSON.stringify(pending.args, null, 2))
    expect(complete).toContain('search_history')
    await verifyBoundedScroll('创建 Agent'); expectUntouched()
    await shot(`create-${appearance}-${width}-expanded`)
    await repeatCurrentDetail('完整参数')
    await expectDecisionsVisible('创建 Agent'); expectUntouched()
    const output: Decision = width === 760 ? 'rejected' : 'approved'
    await decide(pending, output, card().getByRole('button', { name: output === 'approved' ? '创建 Agent' : '拒绝', exact: true }))
  })
}

test('更新 Agent 显示目标身份与前后改动，批准保持原始请求标识', async () => {
  const pending = await start('update')
  await expect(card().getByRole('heading', { name: '更新 Agent', exact: true })).toBeVisible()
  await expect(card().locator('.work-permission__summary')).toHaveText(previousAgent.name)
  const fields = card().locator('.work-permission__fields')
  await expect(fields).toContainText(previousAgent.id)
  await expect(fields).toContainText(previousAgent.name); await expect(fields).toContainText(updateChanges.name)
  await expect(fields).toContainText(previousAgent.description); await expect(fields).toContainText(updateChanges.description)
  await expectSinglePanel('工作指令')
  const instructions = body()
  await expect(instructions).toContainText(previousAgent.systemPrompt); await expect(instructions).toContainText(updateChanges.systemPrompt)
  const tools = await openDetail('工具权限')
  await expect(tools.locator('[data-section="systemPrompt"]')).toHaveCount(0)
  await expect(tools.locator('.work-permission__before li[title="read_file"]')).toHaveText('读取文件')
  await expect(tools.locator('[data-section="allowedTools"] > .work-permission__tool-groups li')).toHaveCount(2)
  await expect(tools.locator('[data-section="allowedTools"] > .work-permission__tool-groups li[title="write_file"]')).toHaveText('写入文件')
  await expectDecisionsVisible('更新 Agent'); expectUntouched(); await shot('update-agent-changes')
  await decide(pending, 'approved', card().getByRole('button', { name: '更新 Agent', exact: true }))
})

test('删除 Agent 清楚标识目标并使用删除语义，批准只恢复对应调用', async () => {
  const pending = await start('delete', 'dark', 760)
  await expect(card().getByRole('heading', { name: '删除 Agent', exact: true })).toBeVisible()
  await expect(card().locator('.work-permission__summary')).toHaveText(previousAgent.name)
  await expect(card().locator('.work-permission__fields')).toContainText(previousAgent.id)
  const confirm = card().getByRole('button', { name: '删除 Agent', exact: true })
  await expect(confirm).toHaveClass(/\bbtn--danger\b/)
  await expectSinglePanel('工作指令')
  const raw = await openDetail('完整参数'); await expect(raw.locator('pre')).toContainText(pending.description!)
  await expectDecisionsVisible('删除 Agent'); expectUntouched(); await shot('delete-agent-confirmation')
  await decide(pending, 'approved', confirm)
})

for (const output of ['approved', 'rejected'] as const) test(`普通命令显示命令与原因，${output}沿用原审批响应`, async () => {
  const pending = await start('command')
  await expect(card().locator('pre[aria-label="程序"], pre[aria-label="命令"]')).toHaveText(String(pending.args.command))
  await expect(body()).toHaveCount(0)
  await expect(card().locator('.work-permission__raw')).toHaveCount(0)
  await expect(detail('完整参数')).toHaveAttribute('aria-expanded', 'false')
  await expect(card().locator('.work-permission__reason')).toHaveText(pending.description!)
  await expect(card().locator('.work-permission__fields')).toContainText(workspaceRoot)
  await expectDecisionsVisible('允许执行'); expectUntouched(); await shot(`command-${output}`)
  const raw = await openDetail('完整参数')
  expect(await raw.locator('.work-permission__raw').textContent()).toContain(pending.description)
  expect(await raw.locator('.work-permission__raw').textContent()).toContain(JSON.stringify(pending.args, null, 2))
  expectUntouched()
  await decide(pending, output, card().getByRole('button', { name: output === 'approved' ? '允许执行' : '拒绝', exact: true }))
})

test('完全访问仅在明确点击后写当前会话权限，再放行原始请求', async () => {
  const pending = await start('command')
  const sessionId = current!.sessionId
  await expect(body()).toHaveCount(0)
  await expect(card().locator('.work-permission__raw')).toHaveCount(0)
  const raw = await openDetail('完整参数')
  expect(await raw.locator('.work-permission__raw').textContent()).toContain(JSON.stringify(pending.args, null, 2))
  await repeatCurrentDetail('完整参数'); expectUntouched()
  await decide(pending, 'approved', card().getByRole('button', { name: '本会话改为完全访问并放行', exact: true }), true)
  expect(securityWrites).toEqual([{ sessionId, mode: 'full-access' }])
  expect(audit).toEqual(['security', 'decision'])
})

for (const [appearance, width] of [['light', 1440], ['dark', 760]] as const) {
  test(`${appearance} / ${width}：创建插件以功能和文件摘要展示，完整源码按需展开且审批身份不变`, async () => {
    const pending = await start('plugin-create', appearance, width)
    await expect(card().getByRole('heading', { name: '创建插件', exact: true })).toBeVisible()
    await expect(card().locator('.work-permission__summary')).toHaveText(pluginManifest.name)
    await expect(card().locator('.work-permission__description')).toHaveText(pluginManifest.description)
    await expect(card().locator('.work-permission__metadata')).toContainText(pluginManifest.version)
    await expect(card().locator('.work-permission__metadata')).toContainText(/node/i)
    await expectSinglePanel('功能')
    await expect(detailbar().getByRole('button')).toHaveCount(4)
    for (const label of ['文件', '插件信息', '完整参数']) await expect(detail(label)).toHaveAttribute('aria-expanded', 'false')
    await expect(body().locator('[data-section="plugin-tools"]')).toBeVisible()
    for (const tool of pluginManifest.tools) {
      await expect(body()).toContainText(tool.name); await expect(body()).toContainText(tool.description)
    }
    await expect(card().locator('pre:visible')).toHaveCount(0)
    expect(await card().innerText()).not.toContain('"apiVersion"')
    expect(await card().innerText()).not.toContain('PLUGIN_SOURCE_END_完整源码末尾')
    await repeatCurrentDetail('功能'); expectUntouched()
    await expectDecisionsVisible('创建插件'); await shot(`plugin-create-${appearance}-${width}-summary`)
    const toolParameters = body().locator('[data-section="plugin-tools"] details').first()
    await expect(toolParameters.locator('summary')).toHaveText('参数与入口')
    await toolParameters.locator('summary').click()
    await expect(toolParameters).toHaveAttribute('open', '')
    await expect(toolParameters).toContainText('main.mjs')
    await expect(toolParameters).toContainText('待整理的资料正文')
    expectUntouched()

    const fileBody = await openDetail('文件'), fileSection = fileBody.locator('[data-section="plugin-files"]')
    await expect(fileBody.locator('[data-section="plugin-tools"]')).toHaveCount(0)
    await expect(fileSection.locator('details')).toHaveCount(2)
    await expect(fileSection.locator('details[open]')).toHaveCount(0)
    await expect(fileSection.locator('pre:visible')).toHaveCount(0)
    const source = fileSection.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'main.mjs' }) })
    const readme = fileSection.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'README.md' }) })
    await expect(source.locator('summary')).toContainText(new RegExp(`${pluginSource.split('\n').length}\\s*行`))
    await expect(readme.locator('summary')).toContainText('README.md')
    expect(await card().innerText()).not.toContain('PLUGIN_SOURCE_END_完整源码末尾')
    await source.locator('summary').click(); await expect(source).toHaveAttribute('open', '')
    await expect(source.locator('pre')).toBeVisible()
    expect(await source.locator('pre').textContent()).toBe(pluginSource)
    await verifyBoundedScroll('创建插件'); expectUntouched()
    await shot(`plugin-create-${appearance}-${width}-source`)
    const info = await openDetail('插件信息')
    await expect(info.locator('[data-section="plugin-details"]')).toContainText(pluginManifest.id)
    await expect(info.locator('[data-section="plugin-files"]')).toHaveCount(0)
    await expectDecisionsVisible('创建插件'); expectUntouched()

    const raw = await openDetail('完整参数')
    const complete = await raw.locator('.work-permission__raw').textContent()
    expect(complete).toContain(pending.description)
    expect(complete).toContain(JSON.stringify(pending.args, null, 2))
    expect(complete).toContain('PLUGIN_SOURCE_END_完整源码末尾')
    expect(complete).toContain('README_END_文件末尾')
    await verifyBoundedScroll('创建插件')
    await repeatCurrentDetail('完整参数'); expectUntouched()
    await decide(pending, 'approved', card().getByRole('button', { name: '创建插件', exact: true }))
    expect(decisions[0].toolResponse.name).toBe('plugin_create'); expect(audit).toEqual(['decision'])
  })
}

test('编辑插件展示新清单及精确源码，原始版本约束完整保留', async () => {
  const pending = await start('plugin-update')
  await expect(card().getByRole('heading', { name: '编辑插件', exact: true })).toBeVisible()
  await expect(card().locator('.work-permission__summary')).toHaveText(updatedPluginManifest.name)
  await expect(card().locator('.work-permission__description')).toHaveText(updatedPluginManifest.description)
  await expect(card().locator('.work-permission__metadata')).toContainText(updatedPluginManifest.version)
  await expectSinglePanel('功能')
  await expect(card().locator('pre:visible')).toHaveCount(0)
  const files = await openDetail('文件')
  const source = files.locator('[data-section="plugin-files"] details').filter({ has: page.locator('summary').filter({ hasText: 'main.mjs' }) })
  await expect(source.locator('pre')).not.toBeVisible()
  await source.locator('summary').click()
  expect(await source.locator('pre').textContent()).toBe(updatedPluginFiles['main.mjs'])
  const info = await openDetail('插件信息')
  await expect(info.locator('[data-section="plugin-details"]')).toContainText(pluginManifest.id)
  const raw = await openDetail('完整参数')
  expect(await raw.locator('.work-permission__raw').textContent()).toContain(pending.description)
  expect(await raw.locator('.work-permission__raw').textContent()).toContain(JSON.stringify(pending.args, null, 2))
  expect(await raw.locator('.work-permission__raw').textContent()).toContain('"expectedRevision": 3')
  await expectDecisionsVisible('编辑插件'); expectUntouched(); await shot('plugin-update-preview')
  await decide(pending, 'approved', card().getByRole('button', { name: '编辑插件', exact: true }))
  expect(decisions[0].toolResponse.name).toBe('plugin_update'); expect(audit).toEqual(['decision'])
})

test('创建知识库显示名称用途与结构化信息，确认保留原始请求标识', async () => {
  const pending = await start('knowledge-create', 'light', 760)
  expect(pending.args).toEqual(knowledgeCreateArgs)
  expect(pending.args).not.toHaveProperty('id')
  await expect(card().getByRole('heading', { name: '创建知识库', exact: true })).toBeVisible()
  await expect(card().locator('.work-permission__summary')).toHaveText(knowledgeCreateArgs.name)
  await expect(card().locator('.work-permission__description')).toHaveText(knowledgeCreateArgs.description)
  await expectSinglePanel('知识库信息')
  await expect(body().getByRole('region', { name: '知识库信息', exact: true })).toContainText(knowledgeCreateId)
  await expect(card().locator('pre:visible')).toHaveCount(0)
  expect(await card().innerText()).not.toContain('"action"')
  expect(await card().innerText()).not.toContain('"input"')
  await expect(detail('完整参数')).toHaveAttribute('aria-expanded', 'false')
  await repeatCurrentDetail('知识库信息'); expectUntouched()
  await expectDecisionsVisible('创建知识库'); await shot('knowledge-create-structured')
  const raw = await openDetail('完整参数')
  expect(await raw.locator('.work-permission__raw').textContent()).toContain(pending.description)
  expect(await raw.locator('.work-permission__raw').textContent()).toContain(JSON.stringify(pending.args, null, 2))
  await openDetail('知识库信息'); expectUntouched()
  await decide(pending, 'approved', card().getByRole('button', { name: '创建知识库', exact: true }))
  expect(decisions[0].toolResponse.name).toBe('knowledge_create'); expect(audit).toEqual(['decision'])
})

test('导入知识文档展示完整正文和归属信息，浏览不提交且批准身份不变', async () => {
  const pending = await start('knowledge-import', 'dark', 760)
  expect(pending.args).toEqual(knowledgeImportArgs)
  expect(pending.args).not.toHaveProperty('contentType')
  await expect(card().getByRole('heading', { name: '导入知识文档', exact: true })).toBeVisible()
  await expect(card().locator('.work-permission__summary')).toHaveText(knowledgeImportArgs.filename)
  await expectSinglePanel('文档内容')
  const content = body().getByRole('region', { name: '文档内容', exact: true })
  expect(await content.locator('.work-permission__detail-content > p').textContent()).toBe(knowledgeContent)
  await expect(content).toContainText(knowledgeContentHash)
  await expect(card().locator('pre:visible')).toHaveCount(0)
  expect(await card().innerText()).not.toContain('"content"')
  await verifyBoundedScroll('导入知识文档')
  await repeatCurrentDetail('文档内容'); expectUntouched()
  await shot('knowledge-import-complete-content')
  const details = await openDetail('文档信息')
  await expect(details).toContainText(knowledgeDocumentId)
  await expect(details).toContainText(knowledgeBefore.name)
  await expect(details).toContainText(knowledgeBefore.id)
  await expect(details).toContainText('text/plain')
  const raw = await openDetail('完整参数')
  const full = await raw.locator('.work-permission__raw').textContent()
  expect(full).toContain(pending.description); expect(full).toContain(JSON.stringify(pending.args, null, 2))
  expect(full).toContain(knowledgeContentHash); expect(full).toContain('KNOWLEDGE_CONTENT_END_完整知识文档末尾')
  expect(full).toContain(`"bytes": ${Buffer.byteLength(knowledgeContent, 'utf8')}`)
  await openDetail('文档内容')
  expect(await content.locator('.work-permission__detail-content > p').textContent()).toBe(knowledgeContent)
  await expectDecisionsVisible('导入知识文档'); expectUntouched()
  await decide(pending, 'approved', card().getByRole('button', { name: '导入知识文档', exact: true }))
  expect(decisions[0].toolResponse.name).toBe('knowledge_import'); expect(audit).toEqual(['decision'])
})

test('创建技能展示完整技能文档与作用域，批准仍对应原始工具调用', async () => {
  const pending = await start('skill-create', 'light', 760)
  await expect(card().getByRole('heading', { name: '创建技能', exact: true })).toBeVisible()
  await expect(card().locator('.work-permission__summary')).toHaveText(skillArgs.name)
  await expect(card().locator('.work-permission__description')).toHaveText(skillArgs.description)
  await expectSinglePanel('技能内容')
  const content = body().getByRole('region', { name: '技能内容', exact: true })
  expect(await content.locator('.work-permission__detail-content > p').textContent()).toBe(preparedSkillContent)
  await expect(card().locator('pre:visible')).toHaveCount(0)
  expect(await card().innerText()).not.toContain('"action"')
  await shot('skill-create-complete-content'); await verifyBoundedScroll('创建技能'); expectUntouched()
  const details = await openDetail('技能信息')
  await expect(details).toContainText(skillId); await expect(details).toContainText(skillDirectory)
  await expect(details).toContainText('当前项目')
  const raw = await openDetail('完整参数')
  expect(await raw.locator('.work-permission__raw').textContent()).toContain(pending.description)
  expect(await raw.locator('.work-permission__raw').textContent()).toContain(JSON.stringify(pending.args, null, 2))
  await openDetail('技能内容'); await expectDecisionsVisible('创建技能'); expectUntouched()
  await decide(pending, 'approved', card().getByRole('button', { name: '创建技能', exact: true }))
  expect(decisions[0].toolResponse.name).toBe('skill_create'); expect(audit).toEqual(['decision'])
})

test('创建定时任务分别显示任务指令和暂停计划设置，批准身份保持原样', async () => {
  const pending = await start('cron-create', 'dark', 760)
  await expect(card().getByRole('heading', { name: '创建定时任务', exact: true })).toBeVisible()
  await expect(card().locator('.work-permission__summary')).toHaveText(cronArgs.name)
  await expect(card().locator('.work-permission__description')).toHaveText(cronArgs.description)
  await expectSinglePanel('任务指令')
  const instructions = body().getByRole('region', { name: '任务指令', exact: true })
  expect(await instructions.locator('.work-permission__detail-content > p').textContent()).toBe(cronArgs.message)
  await expect(card().locator('pre:visible')).toHaveCount(0)
  await verifyBoundedScroll('创建定时任务'); expectUntouched()
  const settings = await openDetail('执行设置')
  await expect(settings).toContainText('09:30')
  await expect(settings).toContainText('每次创建独立会话')
  await expect(settings).toContainText('静默'); await expect(settings).toContainText('通用')
  await expect(settings).toContainText('暂停'); await expect(settings).toContainText('启用前不会按计划运行')
  await expect(settings).toContainText('120 秒')
  await expect(settings).toContainText('思考模式')
  expect(await settings.innerText()).not.toContain('"configuration"')
  await shot('cron-create-execution-settings')
  const raw = await openDetail('完整参数')
  expect(await raw.locator('.work-permission__raw').textContent()).toContain(pending.description)
  expect(await raw.locator('.work-permission__raw').textContent()).toContain(JSON.stringify(pending.args, null, 2))
  await openDetail('任务指令'); await expectDecisionsVisible('创建定时任务'); expectUntouched()
  await decide(pending, 'approved', card().getByRole('button', { name: '创建定时任务', exact: true }))
  expect(decisions[0].toolResponse.name).toBe('cron_create'); expect(audit).toEqual(['decision'])
})

test('创建 MCP 服务器展示脱敏连接摘要与精确服务器信息，批准不改原参数', async () => {
  const pending = await start('mcp-create', 'light', 760)
  await expect(card().getByRole('heading', { name: '创建 MCP 服务器', exact: true })).toBeVisible()
  await expect(card().locator('.work-permission__summary')).toHaveText(mcpArgs.name)
  await expect(card().locator('.work-permission__description')).toHaveText(mcpArgs.description)
  await expectSinglePanel('连接配置')
  const connection = body().getByRole('region', { name: '连接配置', exact: true })
  await expect(connection).toContainText('stdio'); await expect(connection).toContainText('node')
  await expect(connection).toContainText('参数数量'); await expect(connection).toContainText('2')
  await expect(connection).toContainText('15000 毫秒'); await expect(connection).toContainText('停用')
  await expect(card().locator('pre:visible')).toHaveCount(0)
  expect(await card().innerText()).not.toContain('fixture-server.mjs')
  expect(await card().innerText()).not.toContain('"transportType"')
  await expectDecisionsVisible('创建 MCP 服务器'); expectUntouched(); await shot('mcp-create-connection-summary')
  const details = await openDetail('服务器信息')
  await expect(details).toContainText(mcpArgs.id); await expect(details).toContainText('当前项目')
  await expect(details).toContainText(mcpConfigFile)
  const raw = await openDetail('完整参数')
  expect(await raw.locator('.work-permission__raw').textContent()).toContain(pending.description)
  expect(await raw.locator('.work-permission__raw').textContent()).toContain(JSON.stringify(pending.args, null, 2))
  expect(await raw.locator('.work-permission__raw').textContent()).toContain('fixture-server.mjs')
  await openDetail('连接配置'); expectUntouched()
  await decide(pending, 'approved', card().getByRole('button', { name: '创建 MCP 服务器', exact: true }))
  expect(decisions[0].toolResponse.name).toBe('mcp_server_create'); expect(audit).toEqual(['decision'])
})

test('删除插件仅展示真实标识与操作说明，批准沿用原删除请求', async () => {
  const pending = await start('plugin-delete', 'dark', 760)
  expect(pending.args).toEqual({ id: pluginManifest.id })
  await expect(card().getByRole('heading', { name: '删除插件', exact: true })).toBeVisible()
  await expect(card().locator('.work-permission__summary')).toHaveText(pluginManifest.id)
  await expectSinglePanel('操作说明')
  await expect(detail('功能')).toHaveCount(0); await expect(detail('文件')).toHaveCount(0)
  await expect(card()).not.toContainText(pluginManifest.name)
  await expect(card().locator('pre:visible')).toHaveCount(0)
  await expect(body()).toContainText('删除')
  const confirm = card().getByRole('button', { name: '删除插件', exact: true })
  await expect(confirm).toHaveClass(/\bbtn--danger\b/)
  await repeatCurrentDetail('操作说明'); expectUntouched(); await shot('plugin-delete-summary')
  const raw = await openDetail('完整参数')
  expect(await raw.locator('.work-permission__raw').textContent()).toContain(pending.description)
  expect(await raw.locator('.work-permission__raw').textContent()).toContain(JSON.stringify(pending.args, null, 2))
  expect(await raw.locator('.work-permission__raw').textContent()).toContain('"expectedRevision": 3')
  await expectDecisionsVisible('删除插件'); expectUntouched()
  await decide(pending, 'approved', confirm)
  expect(decisions[0].toolResponse.name).toBe('plugin_delete'); expect(audit).toEqual(['decision'])
})

for (const appearance of ['light', 'dark'] as const) for (const width of [1440, 760]) {
  test(`${appearance} / ${width}：多组提问保留选择和草稿，键盘操作不提交并精确回复原请求`, async () => {
    const pending = await start('questions', appearance, width)
    const question = questionCard(), submit = question.getByRole('button', { name: '提交回复', exact: true })
    const progress = question.locator('.work-question__progress')
    const questionBody = question.locator('.work-question__body')
    const supplement = '保留来源链接与核对日期。', freeAnswer = '核心数据不得省略。\n缺失的信息请标注待确认。'
    expect(pending.requestId).not.toBe(pending.toolCallId)
    await expect(question.getByRole('heading', { name: '需要你的意见', exact: true })).toBeVisible()
    await expect(card()).toHaveCount(0)
    await expect(questionNavigation().getByRole('button')).toHaveCount(3)
    await expect(questionTab('交付形式')).toHaveAttribute('aria-pressed', 'true')
    await expect(questionNavigation().locator('button[aria-pressed="true"]')).toHaveCount(1)
    await expect(question.locator('fieldset')).toHaveCount(1)
    await expect(question.getByRole('group', { name: questionGroups[0].question, exact: true })).toBeVisible()
    await expect(progress).toHaveText('已回答 0 / 3')
    await expect(submit).toBeDisabled()
    const firstChoice = question.getByRole('radio', { name: /^项目说明/ })
    const secondChoice = question.getByRole('radio', { name: /^演示文稿/ })
    await expect(firstChoice).toHaveAccessibleName(/先完成可阅读的项目背景、目标与使用说明。/)
    await expect(question.getByRole('textbox')).toHaveCount(0)
    await firstChoice.focus(); await firstChoice.press('Space')
    await expect(firstChoice).toBeChecked(); await expect(secondChoice).not.toBeChecked()
    await firstChoice.press('ArrowRight')
    await expect(secondChoice).toBeChecked(); await expect(firstChoice).not.toBeChecked()
    await expect(progress).toHaveText('已回答 1 / 3'); await expect(submit).toBeDisabled()
    expectUntouched(); await shot(`questions-${appearance}-${width}-single-choice`)

    await question.getByRole('button', { name: '下一题', exact: true }).click()
    await expect(questionTab('检查范围')).toHaveAttribute('aria-pressed', 'true')
    await expect(questionNavigation().locator('button[aria-pressed="true"]')).toHaveCount(1)
    await expect(question.locator('fieldset')).toHaveCount(1)
    await expect(question.getByRole('radio')).toHaveCount(0)
    await expect(question.getByRole('checkbox')).toHaveCount(14)
    await expect.poll(() => questionBody.evaluate(element => element.scrollTop)).toBe(0)
    const functions = question.getByRole('checkbox', { name: /^功能清单/ })
    const sources = question.getByRole('checkbox', { name: /^数据来源/ })
    await functions.focus(); await functions.press('Space')
    await sources.focus(); await sources.press('Space')
    await expect(functions).toBeChecked(); await expect(sources).toBeChecked()
    await sources.press('Space'); await expect(sources).not.toBeChecked()
    await sources.press('Space'); await expect(sources).toBeChecked()
    const extra = question.getByRole('textbox', { name: `补充回答：${questionGroups[1].question}`, exact: true })
    await extra.fill(`  ${supplement}  `)
    await expect(extra).toHaveCSS('font-size', '13px')
    await expect(progress).toHaveText('已回答 2 / 3'); await expect(submit).toBeDisabled()
    const footer = question.locator('.work-question__footer'), before = await footer.boundingBox()
    const legend = question.locator('legend'), titleBefore = await legend.boundingBox()
    await expect(legend).toHaveText(questionGroups[1].question)
    await expect.poll(() => questionBody.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(100)
    await questionBody.evaluate(element => { element.scrollTop = 0 })
    await expect.poll(async () => Math.abs((await legend.boundingBox())!.y - titleBefore!.y)).toBeLessThan(2)
    await questionBody.evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect.poll(() => questionBody.evaluate(element => element.scrollTop)).toBeGreaterThan(100)
    const after = await footer.boundingBox()
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(2)
    expect(Math.abs((await legend.boundingBox())!.y - titleBefore!.y)).toBeLessThan(2)
    await expect(legend).toBeInViewport({ ratio: 1 })
    await expect(submit).toBeInViewport({ ratio: 1 })
    expect(await question.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    expectUntouched(); await shot(`questions-${appearance}-${width}-multiple-choice`)

    const nextQuestion = question.getByRole('button', { name: '下一题', exact: true })
    await nextQuestion.focus(); await nextQuestion.press('Enter')
    await expect(questionTab('问题 3')).toHaveAttribute('aria-pressed', 'true')
    await expect(questionNavigation().locator('button[aria-pressed="true"]')).toHaveCount(1)
    await expect(question.locator('fieldset')).toHaveCount(1)
    await expect(question.getByRole('checkbox')).toHaveCount(0)
    await expect(question.getByRole('button', { name: '下一题', exact: true })).toHaveCount(0)
    const answer = question.getByRole('textbox', { name: `补充回答：${questionGroups[2].question}`, exact: true })
    const finalQuestion = question.locator('legend')
    await expect(finalQuestion).toHaveText(questionGroups[2].question)
    await expect(finalQuestion).toBeFocused()
    await page.keyboard.press('Tab'); await expect(answer).toBeFocused()
    expectUntouched()
    await answer.fill('  '); await expect(submit).toBeDisabled(); await expect(progress).toHaveText('已回答 2 / 3')
    await answer.fill(freeAnswer)
    await expect(progress).toHaveText('已回答 3 / 3'); await expect(submit).toBeEnabled()
    expectUntouched()
    await questionTab('交付形式').focus(); await questionTab('交付形式').press('Enter')
    await expect(secondChoice).toBeChecked(); await expect(firstChoice).not.toBeChecked()
    await expect(question.locator('fieldset')).toHaveCount(1)
    await questionTab('检查范围').focus(); await questionTab('检查范围').press('Space')
    await expect(functions).toBeChecked(); await expect(sources).toBeChecked()
    await expect(extra).toHaveValue(`  ${supplement}  `)
    await questionTab('检查范围').click()
    await expect(questionTab('检查范围')).toHaveAttribute('aria-pressed', 'true')
    await expect(questionNavigation().locator('button[aria-pressed="true"]')).toHaveCount(1)
    await expect(question.locator('fieldset')).toHaveCount(1)
    await questionTab('问题 3').click(); await expect(answer).toHaveValue(freeAnswer)
    await expect(submit).toBeInViewport({ ratio: 1 })
    expectUntouched(); await shot(`questions-${appearance}-${width}-ready`)

    // Each group's choices and free text use the Work answer separator; the
    // engine response contract joins the resulting groups with a comma.
    await decide(pending, `演示文稿,功能清单、数据来源、${supplement},${freeAnswer}`, submit)
    expect(audit).toEqual(['decision'])
  })
}

test('单组自由提问无需导航，换行保留且仅提交按钮发送回答', async () => {
  const pending = await start('single-question', 'light', 760)
  const question = questionCard(), submit = question.getByRole('button', { name: '提交回复', exact: true })
  await expect(questionNavigation()).toHaveCount(0)
  await expect(question.locator('fieldset')).toHaveCount(1)
  await expect(question.getByRole('group', { name: singleQuestion, exact: true })).toBeVisible()
  await expect(question.getByRole('radio')).toHaveCount(0); await expect(question.getByRole('checkbox')).toHaveCount(0)
  await expect(question.getByRole('button', { name: '下一题', exact: true })).toHaveCount(0)
  const input = question.getByRole('textbox', { name: `补充回答：${singleQuestion}`, exact: true })
  await expect(input).toHaveJSProperty('tagName', 'TEXTAREA')
  await input.fill('   '); await expect(submit).toBeDisabled()
  await input.fill('保留完整来源'); await input.press('End'); await input.press('Enter'); await input.pressSequentially('需要可编辑文件')
  await expect(input).toHaveValue('保留完整来源\n需要可编辑文件')
  await expect(submit).toBeEnabled(); expectUntouched()
  await shot('single-question-free-text')
  await decide(pending, '保留完整来源\n需要可编辑文件', submit)
  expect(audit).toEqual(['decision'])
})

for (const { appearance, width } of [{ appearance: 'light', width: 1440 }, { appearance: 'dark', width: 760 }] as const) {
  test(`${appearance} / ${width}：四项长说明整行可选，滚动保留完整问题与提交入口`, async () => {
    const pending = await start('long-multi-question', appearance, width)
    const question = questionCard(), submit = question.getByRole('button', { name: '提交回复', exact: true })
    const questionBody = question.locator('.work-question__body'), legend = question.locator('legend')
    const footer = question.locator('.work-question__footer'), rows = question.locator('.work-question__option')
    const progress = question.locator('.work-question__progress')
    const supplement = '保留源文件和完整引用。\n尚未确认的信息请单独标注。'
    const input = question.getByRole('textbox', { name: `补充回答：${longMultiQuestion.question}`, exact: true })
    await expect(questionNavigation()).toHaveCount(0)
    await expect(question.locator('fieldset')).toHaveCount(1)
    await expect(legend).toHaveText(longMultiQuestion.question)
    await expect(legend).toHaveAttribute('tabindex', '-1')
    await expect(rows).toHaveCount(4)
    await expect(question.getByRole('checkbox')).toHaveCount(4)
    await expect(question.getByRole('radio')).toHaveCount(0)
    await expect(input).toHaveCSS('font-size', '13px')
    await expect.poll(() => questionBody.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(40)
    const titleBefore = await legend.boundingBox(), footerBefore = await footer.boundingBox()

    // Hit the explanation and the row's trailing padding, rather than the small
    // checkbox, to exercise the two otherwise ambiguous targets from the report.
    const first = rows.nth(0).getByRole('checkbox'), third = rows.nth(2).getByRole('checkbox')
    await expect(first).not.toBeChecked(); await expect(third).not.toBeChecked()
    await rows.nth(0).locator('small').click(); await expect(first).toBeChecked()
    await rows.nth(2).scrollIntoViewIfNeeded()
    const thirdBounds = await rows.nth(2).boundingBox()
    await rows.nth(2).click({ position: { x: thirdBounds!.width - 8, y: 12 } })
    await expect(third).toBeChecked(); await expect(progress).toHaveText('已选 2 项')
    await expect(rows.nth(1).getByRole('checkbox')).not.toBeChecked()
    await expect(rows.nth(3).getByRole('checkbox')).not.toBeChecked()
    await expect(submit).toBeEnabled(); expectUntouched()
    await input.fill(`  ${supplement}  `)
    await expect(input).toHaveValue(`  ${supplement}  `)
    await rows.nth(2).locator('small').click(); await expect(third).not.toBeChecked()
    await expect(progress).toHaveText('已选 1 项')
    await rows.nth(2).locator('strong').click(); await expect(third).toBeChecked()
    await expect(progress).toHaveText('已选 2 项')
    await expect(input).toHaveValue(`  ${supplement}  `)
    await expect(first).toBeChecked(); expectUntouched()

    // Full text may extend vertically inside the scrollable body, but each line
    // must remain within its own row; clipping cannot masquerade as compactness.
    const textGeometry = await rows.evaluateAll(elements => elements.map(row => {
      const bounds = row.getBoundingClientRect()
      return [...row.querySelectorAll('strong, small')].map(text => {
        const range = document.createRange(); range.selectNodeContents(text)
        const lines = [...range.getClientRects()]
        return { text: text.textContent, horizontalOverflow: text.scrollWidth - text.clientWidth,
          verticalOverflow: text.scrollHeight - text.clientHeight,
          withinRow: lines.every(line => line.left >= bounds.left - 1 && line.right <= bounds.right + 1 &&
            line.top >= bounds.top - 1 && line.bottom <= bounds.bottom + 1) }
      })
    }))
    for (const [index, texts] of textGeometry.entries()) {
      expect(texts.map(text => text.text)).toEqual([longMultiQuestion.options[index].label, longMultiQuestion.options[index].description])
      for (const text of texts) {
        expect(text.horizontalOverflow).toBeLessThanOrEqual(1)
        expect(text.verticalOverflow).toBeLessThanOrEqual(1)
        expect(text.withinRow).toBe(true)
      }
    }

    for (const position of ['top', 'bottom'] as const) {
      await questionBody.evaluate((element, position) => { element.scrollTop = position === 'top' ? 0 : element.scrollHeight }, position)
      if (position === 'bottom') await expect.poll(() => questionBody.evaluate(element => element.scrollTop)).toBeGreaterThan(40)
      else await expect.poll(() => questionBody.evaluate(element => element.scrollTop)).toBe(0)
      expect(Math.abs((await legend.boundingBox())!.y - titleBefore!.y)).toBeLessThan(2)
      expect(Math.abs((await footer.boundingBox())!.y - footerBefore!.y)).toBeLessThan(2)
      await expect(legend).toBeInViewport({ ratio: 1 }); await expect(submit).toBeInViewport({ ratio: 1 })
      const titleGeometry = await legend.evaluate(element => {
        const bounds = element.getBoundingClientRect(), range = document.createRange()
        range.selectNodeContents(element)
        const body = element.parentElement!.querySelector('.work-question__body')!.getBoundingClientRect()
        const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        return { aboveBody: bounds.bottom <= body.top + 1, unobscured: hit === element || element.contains(hit),
          complete: [...range.getClientRects()].every(line => line.left >= bounds.left - 1 && line.right <= bounds.right + 1 &&
            line.top >= bounds.top - 1 && line.bottom <= bounds.bottom + 1) }
      })
      expect(titleGeometry).toEqual({ aboveBody: true, unobscured: true, complete: true })
      expect(await question.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      expect(await questionBody.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      expectUntouched(); await shot(`questions-${appearance}-${width}-four-long-options-${position}`)
    }
    await expect(input).toHaveValue(`  ${supplement}  `)
    await decide(pending, `${longMultiQuestion.options[0].label}、${longMultiQuestion.options[2].label}、${supplement}`, submit)
    expect(audit).toEqual(['decision'])
  })
}

test('Work：命令程序与每个启动参数分开呈现，完整脚本和嵌套配置可查且审批身份不变', async () => {
    const pending = await start('command-argv')
    expect(pending.args).toEqual(commandArgvArgs)
    const program = card().locator('pre[aria-label="程序"], pre[aria-label="命令"]')
    await expect(program).toHaveText('node')
    await expect(card().locator('.work-permission__fields')).toContainText('工作目录')
    await expect(card().locator('.work-permission__fields')).toContainText('mcp-test-server')
    await expect(card().locator('.work-permission__fields')).toContainText('120000 毫秒')
    await expect(card().locator('.work-permission__reason')).toHaveText(pending.description!)
    await expectSinglePanel('启动参数')
    await expect(card().locator('.work-permission__raw')).toHaveCount(0)
    const argumentsPanel = body().locator('[data-section="command-arguments"]')
    await expect(argumentsPanel.locator('pre')).toHaveCount(2)
    expect(await argumentsPanel.locator('pre').allTextContents()).toEqual(commandArgvArgs.args)
    expect(await program.textContent()).not.toContain('-e')
    expect(await program.textContent()).not.toContain(commandScript)
    await expect(card().getByRole('heading', { name: '执行命令', exact: true })).toBeInViewport({ ratio: 1 })
    expectUntouched(); await shot('command-argv-work-separate-arguments')
    await verifyBoundedScroll('允许执行')
    await expect(card().getByRole('heading', { name: '执行命令', exact: true })).toBeInViewport({ ratio: 1 })
    await expect(argumentsPanel.getByText('COMMAND_ARGV_END_完整脚本末尾', { exact: false })).toBeVisible()

    const tree = (await openDetail('其他参数')).locator('[data-section="arguments"]')
    await expect(tree.locator('pre')).toHaveCount(0)
    await expect(tree.getByText('options', { exact: true })).toBeVisible()
    await expect(tree.getByText('keepOriginal', { exact: true })).toBeVisible()
    await expect(tree.getByText('true', { exact: true })).toBeVisible()
    const limits = tree.locator('dt').filter({ hasText: /^limits$/ }).locator('..')
    await limits.locator('summary').click()
    await expect(limits.getByText('retries', { exact: true })).toBeVisible()
    await expect(limits.getByText('0', { exact: true })).toBeVisible()
    await expect(limits.getByText('null', { exact: true })).toBeVisible()
    const destinations = tree.locator('dt').filter({ hasText: /^destinations$/ }).locator('..')
    await destinations.locator('summary').click()
    await expect(destinations.getByText('第一处', { exact: true })).toBeVisible()
    await expect(destinations.getByText('第二处', { exact: true })).toBeVisible()
    expectUntouched(); await shot('command-argv-work-parameter-tree')

    const raw = await openDetail('完整参数')
    expect(await raw.locator('.work-permission__raw').textContent()).toContain(pending.description)
    expect(await raw.locator('.work-permission__raw').textContent()).toContain(JSON.stringify(commandArgvArgs, null, 2))
    await openDetail('启动参数')
    expect(await argumentsPanel.locator('pre').allTextContents()).toEqual(commandArgvArgs.args)
    expectUntouched()
    await decide(pending, 'approved', card().getByRole('button', { name: '允许执行', exact: true }))
    expect(decisions[0].toolResponse.name).toBe('execute_cmd'); expect(audit).toEqual(['decision'])
})
