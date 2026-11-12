/** Pure approval-presentation contracts: prepared Agent previews, safe fallbacks,
 * complete details, durable permission arguments and unchanged approval replies. */
import { expect, test } from '@playwright/test'
import {
  buildToolResponse,
  mergePending,
  normalizePending,
  normalizeRunPending,
  type PendingInteraction
} from '../src/renderer/src/core/engine/pending'
import { permissionPresentation } from '../src/renderer/src/features/interactions/permission-presentation'
import { toolDisplayName } from '../src/renderer/src/core/engine/tool-labels'

function pending(
  toolName: string,
  question: string,
  args?: Record<string, unknown>
): PendingInteraction {
  const result = normalizePending({
    permissionRequest: { requestId: 'call-1', toolName, description: question, args }
  })
  if (!result) throw new Error('Fixture must produce a permission')
  return result
}

function preview(action: '创建' | '更新' | '删除', value: Record<string, unknown>): string {
  return `Agent ${action}确认\n\n${JSON.stringify(value, null, 2)}\n\n确认后执行以上配置。`
}

const config = {
  name: '资料研究员',
  description: '核对来源并整理研究结论。',
  model: 'model-actual',
  temperature: 0,
  systemPrompt: '先核对来源。\n\n逐项记录证据，保留完整出处。',
  allowedTools: ['read_file', 'web_fetch', 'custom_report'],
  skills: ['研究方法'],
  mcpServers: [],
  knowledgeBases: ['knowledge-actual']
}

test('permission normalization keeps arguments and approval response protocol unchanged', () => {
  const args = { command: 'Get-Location', options: { timeout: 5000 } }
  const normalized = pending('execute_cmd', '确认运行命令', args)
  expect(normalized.args).toEqual(args)
  expect(buildToolResponse(normalized, ['approved'])).toEqual({
    toolCallId: 'call-1',
    name: 'execute_cmd',
    output: 'approved'
  })
  expect(buildToolResponse(normalized, ['rejected'])).toEqual({
    toolCallId: 'call-1',
    name: 'execute_cmd',
    output: 'rejected'
  })
  const ask = normalizePending({
    ask_user: { toolCallId: 'call-1', question: '批准？', options: ['approved', 'rejected'] }
  })!
  expect(mergePending(ask, normalized)).toEqual(normalized)
  expect(mergePending(normalized, ask)).toEqual(normalized)
})

test('durable permission restoration retains args, prepared question and request identity', () => {
  const question = preview('创建', config)
  const args = { name: config.name }
  const restored = normalizeRunPending(
    {
      requestId: 'approval-1',
      kind: 'permission',
      toolCallId: 'call-1',
      toolName: 'agent_create',
      args,
      question,
      status: 'pending'
    },
    'run-1'
  )!
  expect(restored.args).toEqual(args)
  expect(restored.question).toBe(question)
  expect(buildToolResponse(restored, ['approved'])).toEqual({
    toolCallId: 'call-1',
    name: 'agent_create',
    output: 'approved',
    requestId: 'approval-1',
    runId: 'run-1'
  })
  expect(
    permissionPresentation(restored).sections.find((section) => section.id === 'allowedTools')
      ?.items
  ).toEqual(['读取文件（read_file）', '获取网页内容（web_fetch）', 'custom_report'])
})

test('ask_user remains an ordinary question and malformed permission args are ignored', () => {
  const ask = normalizePending({
    permissionRequest: {
      requestId: 'ask-1',
      toolName: 'ask_user',
      args: { question: '选择格式', options: ['PDF', 'Word'] }
    }
  })!
  expect(ask.kind).toBe('ask')
  expect(ask.args).toBeUndefined()
  expect(ask.question).toBe('选择格式')
  for (const args of [null, [], ['invalid'], 'invalid', 42]) {
    expect(
      normalizePending({
        permissionRequest: { requestId: 'call-1', toolName: 'agent_create', args }
      })?.args
    ).toBeUndefined()
  }
})

test('creation displays prepared defaults instead of incomplete or conflicting call arguments', () => {
  const question = preview('创建', config)
  const args = { name: '原调用名称', temperature: 0.7 }
  const result = permissionPresentation(pending('agent_create', question, args))
  expect(result.title).toBe('创建 Agent')
  expect(result.summary).toBe(config.name)
  expect(result.confirmLabel).toBe('创建 Agent')
  expect(result.destructive).toBe(false)
  expect(result.fields.some((field) => field.label === '名称')).toBe(false)
  expect(result.fields).toContainEqual({ label: '用途', value: config.description })
  expect(result.fields).toContainEqual({ label: '温度', value: '0' })
  expect(result.sections).toContainEqual({
    id: 'systemPrompt',
    label: '工作指令',
    text: config.systemPrompt
  })
  expect(result.sections.some((section) => section.id === 'mcpServers')).toBe(false)
  expect(result.reason).toBeUndefined()
  expect(result.raw).toBe(`${question}\n\n原始调用参数\n${JSON.stringify(args, null, 2)}`)
})

test('updates show only this mutation with actual before and after values', () => {
  const before = { id: 'agent-exact', ...config }
  const changes = {
    name: '新研究员',
    systemPrompt: '新的第一行\n新的第二行',
    allowedTools: [],
    temperature: 0.35
  }
  const result = permissionPresentation(
    pending(
      'agent_update',
      preview('更新', {
        id: before.id,
        before,
        changes,
        after: { ...before, ...changes }
      }),
      { id: before.id, name: 'incomplete' }
    )
  )
  expect(result.summary).toBe(config.name)
  expect(result.fields).toEqual([
    { label: 'Agent ID', value: 'agent-exact' },
    { label: '名称', value: '新研究员', previous: config.name },
    { label: '温度', value: '0.35', previous: '0' }
  ])
  expect(result.sections).toEqual([
    {
      id: 'systemPrompt',
      label: '工作指令',
      text: changes.systemPrompt,
      previous: config.systemPrompt
    },
    {
      id: 'allowedTools',
      label: '工具权限',
      text: '仅对话',
      entries: [],
      previous: '读取文件（read_file）\n获取网页内容（web_fetch）\ncustom_report',
      previousEntries: [
        { id: 'read_file', label: '读取文件' },
        { id: 'web_fetch', label: '获取网页内容' },
        { id: 'custom_report', label: 'custom_report' }
      ]
    }
  ])
  expect(result.confirmLabel).toBe('更新 Agent')
  expect(result.destructive).toBe(false)
})

test('updates distinguish missing previous configuration from explicit empty values', () => {
  const before = { id: 'agent-minimal', name: '旧 Agent', description: '' }
  const changes = { description: '新用途', allowedTools: ['read_file'] }
  const result = permissionPresentation(
    pending(
      'agent_update',
      preview('更新', {
        id: before.id,
        before,
        changes,
        after: { ...before, ...changes }
      })
    )
  )
  expect(result.fields).toContainEqual({ label: '用途', value: '新用途', previous: '（空）' })
  expect(result.sections).toContainEqual({
    id: 'allowedTools',
    label: '工具权限',
    items: ['读取文件（read_file）'],
    entries: [{ id: 'read_file', label: '读取文件' }],
    previous: '未提供'
  })
})

test('delete uses the prepared target identity and exposes its saved configuration', () => {
  const agent = { id: 'target-full-id', ...config }
  const result = permissionPresentation(
    pending('agent_delete', preview('删除', { id: agent.id, agent }), { id: 'different-args-id' })
  )
  expect(result.title).toBe('删除 Agent')
  expect(result.summary).toBe(config.name)
  expect(result.confirmLabel).toBe('删除 Agent')
  expect(result.destructive).toBe(true)
  expect(result.fields[0]).toEqual({ label: 'Agent ID', value: 'target-full-id' })
  expect(result.sections).toContainEqual({
    id: 'systemPrompt',
    label: '工作指令',
    text: config.systemPrompt
  })
  expect(result.raw).toContain('different-args-id')
})

for (const [toolName, action, data] of [
  ['agent_do_create', '创建', config],
  [
    'agent_do_update',
    '更新',
    {
      id: 'legacy',
      before: { id: 'legacy', ...config },
      changes: { name: '已更新' },
      after: { id: 'legacy', ...config, name: '已更新' }
    }
  ],
  ['agent_do_delete', '删除', { id: 'legacy', agent: { id: 'legacy', ...config } }]
] as const)
  test(`${toolName} recognizes the matching prepared preview without changing reply identity`, () => {
    const item = pending(toolName, preview(action, data))
    expect(permissionPresentation(item).reason).toBeUndefined()
    expect(permissionPresentation(item).title).toBe(`${action} Agent`)
    expect(buildToolResponse(item, ['approved']).name).toBe(toolName)
  })

test('invalid, mismatched and embedded previews fall back to args without invented defaults', () => {
  const valid = preview('创建', config)
  const cases = [
    JSON.stringify(config),
    `解释：\n${valid}`,
    `${valid}\n附加说明`,
    preview('更新', config),
    'Agent 创建确认\n\n{invalid}\n\n确认后执行以上配置。',
    preview('创建', { name: config.name, allowedTools: 'read_file' }),
    preview('创建', { description: '无名称' })
  ]
  for (const question of cases) {
    const result = permissionPresentation(pending('agent_create', question, { name: '仅调用参数' }))
    expect(result.summary).toBe('仅调用参数')
    expect(result.fields).toEqual([])
    expect(result.sections).toEqual([])
    expect(result.reason).toBeUndefined()
    expect(result.raw.startsWith(question)).toBe(true)
  }
})

test('inconsistent update/delete target and after snapshots cannot claim a prepared mutation', () => {
  const before = { id: 'agent-exact', ...config }
  for (const question of [
    preview('更新', {
      id: 'other-id',
      before,
      changes: { name: 'new' },
      after: { ...before, name: 'new' }
    }),
    preview('更新', { id: before.id, before, changes: { name: 'new' }, after: before }),
    preview('更新', { id: before.id, before, changes: {}, after: before })
  ]) {
    const result = permissionPresentation(
      pending('agent_update', question, { id: 'args-id', name: '本次名称' })
    )
    expect(result.fields).toEqual([
      { label: 'Agent ID', value: 'args-id' },
      { label: '名称', value: '本次名称' }
    ])
    expect(result.fields.every((field) => field.previous === undefined)).toBe(true)
    expect(result.sections).toEqual([])
  }
  const result = permissionPresentation(
    pending('agent_delete', preview('删除', { id: 'other-id', agent: before }), { id: 'args-id' })
  )
  expect(result.summary).toBeUndefined()
  expect(result.fields).toEqual([{ label: 'Agent ID', value: 'args-id' }])
})

test('Agent-like JSON in other tools is never interpreted as an Agent approval', () => {
  const question = preview('创建', config)
  for (const toolName of [
    'ask_user',
    'custom_agent_create',
    'mcp__server__agent_create',
    'agent_create_extra'
  ]) {
    const result = permissionPresentation(
      pending(toolName, question, { path: 'D:/reports/source.json' })
    )
    expect(result.title).not.toBe('创建 Agent')
    expect(result.confirmLabel).toBe('允许执行')
    expect(result.fields).toEqual([{ label: '路径', value: 'D:/reports/source.json' }])
    expect(result.sections).toContainEqual({ id: 'description', label: '请求说明', text: question })
  }
})

test('generic approval surfaces commands and paths while preserving every complex value', () => {
  const command = 'Write-Output "开始"\nGet-ChildItem -LiteralPath "D:/资料"'
  const args = {
    command,
    cwd: 'D:/资料',
    url: 'https://example.test/a',
    method: 'POST',
    flags: { overwrite: false, nested: ['完整', 0] },
    customValue: 'UNKNOWN-VALUE'
  }
  const result = permissionPresentation(pending('execute_cmd', '运行前请检查工作目录。', args))
  expect(result.title).toBe('执行命令')
  expect(result.fields).toEqual([
    { label: '工作目录', value: args.cwd },
    { label: '网址', value: args.url },
    { label: '请求方法', value: 'POST' }
  ])
  expect(result.sections[0]).toEqual({ id: 'command', label: '程序', text: command, code: true })
  expect(result.sections.find((section) => section.id === 'arguments')!.tree).toEqual([
    { label: 'flags', kind: 'object', children: [
      { label: 'overwrite', kind: 'boolean', value: 'false' },
      { label: 'nested', kind: 'array', children: [
        { label: '第 1 项', kind: 'string', value: '完整' }, { label: '第 2 项', kind: 'number', value: '0' }
      ] }
    ] },
    { label: 'customValue', kind: 'string', value: args.customValue }
  ])
  expect(result.reason).toBe('运行前请检查工作目录。')
})

test('long multiline instructions and unknown configuration stay complete without mutation', () => {
  const systemPrompt = Array.from(
    { length: 1200 },
    (_, index) => `第 ${index} 行完整工作指令`
  ).join('\n')
  const data = { ...config, systemPrompt, futureConfig: { nested: ['全量内容', 0, false] } }
  const item = pending('agent_create', preview('创建', data), { name: config.name })
  const original = JSON.stringify(item)
  const result = permissionPresentation(item)
  expect(result.sections.find((section) => section.id === 'systemPrompt')?.text).toBe(systemPrompt)
  expect(result.sections.find((section) => section.id === 'additional-config')!.tree).toEqual([
    { label: 'futureConfig', kind: 'object', children: [{ label: 'nested', kind: 'array', children: [
      { label: '第 1 项', kind: 'string', value: '全量内容' },
      { label: '第 2 项', kind: 'number', value: '0' },
      { label: '第 3 项', kind: 'boolean', value: 'false' }
    ] }] }
  ])
  expect(result.raw).toContain(JSON.stringify(data, null, 2))
  expect(JSON.stringify(item)).toBe(original)
})

test('exact engine security wrapper recognizes the same prepared configuration and keeps the full raw explanation', () => {
  const direct = preview('创建', config)
  for (const newline of ['\n', '\r\n']) {
    const question = `安全策略拦截了此操作，是否允许执行？\n原因：${direct}`.replace(/\n/g, newline)
    const result = permissionPresentation(pending('agent_create', question, { name: '旧调用名称' }))
    expect(result.summary).toBe(config.name)
    expect(result.fields).toContainEqual({ label: '温度', value: '0' })
    expect(result.sections.find((section) => section.id === 'allowedTools')?.items).toEqual([
      '读取文件（read_file）',
      '获取网页内容（web_fetch）',
      'custom_report'
    ])
    expect(result.raw.startsWith(question)).toBe(true)
  }
  const unknownWrapper = `安全策略提示\n原因：${direct}`
  expect(
    permissionPresentation(pending('agent_create', unknownWrapper, { name: '仅参数' })).summary
  ).toBe('仅参数')
})

test('command aliases use the visible command section and long explanations stay in details', () => {
  for (const key of ['command', 'cmd', 'script']) {
    const question = '说明内容'.repeat(120)
    const result = permissionPresentation(
      pending('custom_command', question, { [key]: 'echo complete' })
    )
    expect(result.sections.find((section) => section.id === 'command')?.text).toBe('echo complete')
    expect(result.reason).toBeUndefined()
    expect(result.sections).toContainEqual({ id: 'description', label: '请求说明', text: question })
  }
})

test('creation and deletion omit empty resource rows but keep explicit conversation-only tools and task model', () => {
  const config = {
    name: '对话助手',
    model: '',
    allowedTools: [],
    skills: [],
    mcpServers: [],
    knowledgeBases: []
  }
  const cases = [
    pending('agent_create', preview('创建', config)),
    pending(
      'agent_delete',
      preview('删除', { id: 'agent-dialogue', agent: { ...config, id: 'agent-dialogue' } })
    )
  ]
  for (const item of cases) {
    const result = permissionPresentation(item)
    expect(result.summary).toBe('对话助手')
    expect(result.fields).toContainEqual({ label: '模型', value: '使用任务模型' })
    expect(result.fields).toContainEqual({ label: '工具权限', value: '仅对话' })
    expect(result.fields.some((field) => field.label === '名称')).toBe(false)
    expect(result.sections).toEqual([])
    expect(result.raw).toContain('"skills": []')
    expect(result.raw).toContain('"mcpServers": []')
    expect(result.raw).toContain('"knowledgeBases": []')
  }
})

test('explicitly cleared resources and model remain visible as update changes', () => {
  const before = { id: 'agent-bound', ...config }
  const changes = { model: '', skills: [], knowledgeBases: [] }
  const result = permissionPresentation(
    pending(
      'agent_update',
      preview('更新', {
        id: before.id,
        before,
        changes,
        after: { ...before, ...changes }
      })
    )
  )
  expect(result.fields).toContainEqual({
    label: '模型',
    value: '使用任务模型',
    previous: config.model
  })
  expect(result.sections).toEqual([
    { id: 'skills', label: '技能', text: '无', previous: '研究方法' },
    { id: 'knowledgeBases', label: '知识库', text: '无', previous: 'knowledge-actual' }
  ])
})

test('generic approvals display the actual brief reason without the engine security wrapper', () => {
  const reason = '命令将覆盖指定文件，请确认输出路径。'
  const question = `安全策略拦截了此操作，是否允许执行？\n原因：${reason}`
  const result = permissionPresentation(
    pending('execute_cmd', question, { command: 'echo approved' })
  )
  expect(result.reason).toBe(reason)
  expect(result.sections.some((section) => section.id === 'description')).toBe(false)
  expect(result.raw.startsWith(question)).toBe(true)
  const paragraphs = `${reason}\n\n请先检查现有文件。`
  const full = `安全策略拦截了此操作，是否允许执行？\n原因：${paragraphs}`
  const expanded = permissionPresentation(pending('execute_cmd', full))
  expect(expanded.reason).toBeUndefined()
  expect(expanded.sections).toContainEqual({
    id: 'description',
    label: '请求说明',
    text: paragraphs
  })
  expect(expanded.raw).toBe(full)
})

test('tool sections expose readable entries and previous entries without losing protocol identifiers', () => {
  const before = { id: 'agent-tools', ...config, allowedTools: ['read_file', 'custom_old'] }
  const changes = { allowedTools: ['web_fetch', 'custom_new'] }
  const question = preview('更新', {
    id: before.id,
    before,
    changes,
    after: { ...before, ...changes }
  })
  const result = permissionPresentation(pending('agent_update', question))
  const section = result.sections.find((item) => item.id === 'allowedTools')!
  expect(section.entries).toEqual([
    { id: 'web_fetch', label: '获取网页内容' },
    { id: 'custom_new', label: 'custom_new' }
  ])
  expect(section.previousEntries).toEqual([
    { id: 'read_file', label: '读取文件' },
    { id: 'custom_old', label: 'custom_old' }
  ])
  expect(section.items).toEqual(['获取网页内容（web_fetch）', 'custom_new'])
  expect(section.previous).toBe('读取文件（read_file）\ncustom_old')
  expect(result.raw).toBe(question)
  const created = permissionPresentation(pending('agent_create', preview('创建', config)))
  expect(
    created.sections
      .filter((item) => item.id !== 'allowedTools')
      .every((item) => item.entries === undefined)
  ).toBe(true)
  expect(
    created.sections.find((item) => item.id === 'allowedTools')?.previousEntries
  ).toBeUndefined()
})

test('clearing a long tool list keeps previous permissions in the tool section instead of the overview', () => {
  const tools = ['read_file', ...Array.from({ length: 80 }, (_, index) => `custom_tool_${index}`)]
  const before = { id: 'agent-long-tools', ...config, allowedTools: tools }
  const changes = { allowedTools: [] }
  const question = preview('更新', {
    id: before.id,
    before,
    changes,
    after: { ...before, ...changes }
  })
  const result = permissionPresentation(pending('agent_update', question))
  expect(result.fields).toEqual([{ label: 'Agent ID', value: before.id }])
  const section = result.sections.find((item) => item.id === 'allowedTools')!
  expect(section.text).toBe('仅对话')
  expect(section.entries).toEqual([])
  expect(section.previousEntries?.map((item) => item.id)).toEqual(tools)
  expect(section.previousEntries?.[0]).toEqual({ id: 'read_file', label: '读取文件' })
  expect(section.previous).toContain('custom_tool_79')
  expect(result.raw).toBe(question)
})

const pluginManifest = {
  apiVersion: 1,
  id: 'report-helper',
  name: '报告助手',
  version: '1.2.0',
  description: '整理资料并生成报告。',
  runtime: 'node',
  tools: [
    {
      name: 'report',
      description: '根据输入生成报告。',
      entry: 'main.mjs',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title']
      }
    }
  ]
}
const pluginInput = {
  manifest: pluginManifest,
  files: {
    'main.mjs':
      'const input = await readInput();\nconsole.log(JSON.stringify({ result: input }));\n'
  }
}
const pluginTitles: Record<string, string> = {
  plugin_create: '创建插件',
  plugin_update: '编辑插件',
  plugin_publish: '发布插件',
  plugin_set_enabled: '启停插件',
  plugin_delete: '删除插件',
  plugin_test: '测试插件',
  plugin_import_install: '安装插件'
}
function pluginPreview(
  action: string,
  input: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): string {
  return `${pluginTitles[action]}确认\n\n${JSON.stringify({ version: 1, tenantId: 'tenant-fixture', action, input, ...extra }, null, 2)}\n\n确认后执行以上操作。`
}

test('plugin creation presents prepared manifest and complete tools and files instead of raw-call values', () => {
  const question = pluginPreview('plugin_create', pluginInput)
  const args = { ...pluginInput, manifest: { ...pluginManifest, name: '原调用名称' } }
  const result = permissionPresentation(pending('plugin_create', question, args))
  expect(result.kind).toBe('plugin')
  expect(result.title).toBe('创建插件')
  expect(result.confirmLabel).toBe('创建插件')
  expect(result.summary).toBe('报告助手')
  expect(result.destructive).toBe(false)
  expect(result.fields).toEqual([
    { label: '用途', value: pluginManifest.description },
    { label: '版本', value: '1.2.0' },
    { label: '运行环境', value: 'Node.js' }
  ])
  expect(result.sections.find((section) => section.id === 'plugin-tools')).toEqual({
    id: 'plugin-tools',
    label: '功能',
    pluginTools: [
      {
        name: 'report',
        description: pluginManifest.tools[0].description,
        entry: 'main.mjs',
        inputSchema: JSON.stringify(pluginManifest.tools[0].inputSchema, null, 2)
      }
    ]
  })
  expect(result.sections.find((section) => section.id === 'plugin-files')).toEqual({
    id: 'plugin-files',
    label: '文件',
    files: [{ path: 'main.mjs', content: pluginInput.files['main.mjs'] }]
  })
  expect(result.sections.find((section) => section.id === 'plugin-details')?.facts).toEqual([
    { label: '插件 ID', value: 'report-helper' },
    { label: 'API 版本', value: '1' }
  ])
  expect(result.raw).toBe(`${question}\n\n原始调用参数\n${JSON.stringify(args, null, 2)}`)
})

test('plugin update accepts the exact engine security wrapper and never invents before values', () => {
  const input = { id: pluginManifest.id, ...pluginInput, expectedRevision: 4 }
  const direct = pluginPreview('plugin_update', input, {
    expectedRevision: 4,
    expectedUpdatedAt: 1000
  })
  for (const question of [
    direct,
    `安全策略拦截了此操作，是否允许执行？\n原因：${direct}`.replace(/\n/g, '\r\n')
  ]) {
    const result = permissionPresentation(pending('plugin_update', question))
    expect(result.title).toBe('编辑插件')
    expect(result.confirmLabel).toBe('编辑插件')
    expect(result.summary).toBe(pluginManifest.name)
    expect(
      result.sections.find((section) => section.id === 'plugin-details')?.facts
    ).toContainEqual({ label: '当前修订', value: '4' })
    expect(result.fields.every((field) => field.previous === undefined)).toBe(true)
    expect(result.sections.every((section) => section.previous === undefined)).toBe(true)
    expect(result.raw).toBe(question)
  }
})

test('plugin test displays the prepared revision and independent test parameters', () => {
  const args = {
    id: pluginManifest.id,
    tool: 'report',
    args: { title: '实际标题', nested: { empty: '', enabled: false } }
  }
  const question = pluginPreview(
    'plugin_test',
    { ...args, revision: 7 },
    { expectedRevision: 9, expectedUpdatedAt: 1000 }
  )
  const result = permissionPresentation(pending('plugin_test', question, args))
  expect(result.title).toBe('测试插件')
  expect(result.summary).toBe(pluginManifest.id)
  expect(result.sections.find((section) => section.id === 'plugin-details')?.facts).toEqual([
    { label: '插件 ID', value: pluginManifest.id },
    { label: '当前修订', value: '9' },
    { label: '测试功能', value: 'report' },
    { label: '测试修订', value: '7' }
  ])
  expect(result.sections.find((section) => section.id === 'plugin-test-args')!.tree).toEqual([
    { label: '参数', kind: 'object', children: [
      { label: 'title', kind: 'string', value: '实际标题' },
      { label: 'nested', kind: 'object', children: [
        { label: 'empty', kind: 'string', value: '' }, { label: 'enabled', kind: 'boolean', value: 'false' }
      ] }
    ] }
  ])
  const fallback = permissionPresentation(pending('plugin_test', '确认测试。', args))
  expect(fallback.sections.find((section) => section.id === 'plugin-details')?.facts).toEqual([
    { label: '插件 ID', value: pluginManifest.id },
    { label: '测试功能', value: 'report' }
  ])
})

test('batched plugin approval preserves every case and expected business result in one request', () => {
  const input = { id: 'text-helper', revision: 3, cases: [
    { name: 'Unicode 示例', tool: 'normalize_text', args: { text: '  你好 🌟  ' }, expected: { text: '你好 🌟', characters: 4 } },
    { name: '空文本', tool: 'normalize_text', args: { text: '' }, expected: { text: '', characters: 0 } }
  ] }
  const question = pluginPreview('plugin_test',input,{ expectedRevision: 3, expectedUpdatedAt: 1000 })
  const result = permissionPresentation(pending('plugin_test',question,input))
  expect(result.summary).toBe('text-helper')
  expect(result.sections.find(section => section.id === 'plugin-details')?.facts).toContainEqual({ label: '测试用例', value: '2' })
  const section = result.sections.find(section => section.id === 'plugin-test-args')!
  expect(section.label).toBe('测试用例与预期结果')
  const items = section.tree![0].children!
  expect(items).toHaveLength(2)
  expect(items[0].children).toEqual([
    { label: 'name', kind: 'string', value: 'Unicode 示例' },
    { label: 'tool', kind: 'string', value: 'normalize_text' },
    { label: 'args', kind: 'object', children: [{ label: 'text', kind: 'string', value: '  你好 🌟  ' }] },
    { label: 'expected', kind: 'object', children: [{ label: 'text', kind: 'string', value: '你好 🌟' },{ label: 'characters', kind: 'number', value: '4' }] }
  ])
  expect(items[1].children!.find(node => node.label === 'expected')?.children).toContainEqual({ label: 'characters', kind: 'number', value: '0' })
  expect(result.raw).toContain(question)
  for (const cases of [[],[{ tool: 'normalize_text',args: [] }]]) {
    const malformed = permissionPresentation(pending('plugin_test','保留原始确认。',{ id:'text-helper',cases }))
    expect(malformed.sections).toEqual([])
    expect(malformed.raw).toContain('保留原始确认。')
  }
  expect(toolDisplayName('plugin_get_template')).toBe('插件工程模板')
  expect(toolDisplayName('plugin_export_archive')).toBe('plugin_export_archive')
})

test('plugin publish and deletion use exact IDs and known revisions without invented names or states', () => {
  for (const [action, input] of [
    ['plugin_publish', { id: pluginManifest.id, expectedRevision: 6 }],
    ['plugin_delete', { id: pluginManifest.id }]
  ] as const) {
    const result = permissionPresentation(
      pending(
        action,
        pluginPreview(action, input, { expectedRevision: 6, expectedUpdatedAt: 1000 })
      )
    )
    expect(result.title).toBe(pluginTitles[action])
    expect(result.confirmLabel).toBe(pluginTitles[action])
    expect(result.destructive).toBe(action === 'plugin_delete')
    expect(result.summary).toBe(pluginManifest.id)
    expect(result.fields).toEqual([])
    expect(result.sections.find((section) => section.id === 'plugin-details')?.facts).toEqual([
      { label: '插件 ID', value: pluginManifest.id },
      { label: '当前修订', value: '6' }
    ])
    expect(result.sections.map((section) => section.id)).toEqual([
      'plugin-operation',
      'plugin-details'
    ])
  }
})

test('plugin enable and disable display the requested boolean state, not a guessed current state', () => {
  for (const enabled of [true, false]) {
    const input = { id: pluginManifest.id, enabled }
    const result = permissionPresentation(
      pending('plugin_set_enabled', pluginPreview('plugin_set_enabled', input), {
        ...input,
        enabled: !enabled
      })
    )
    expect(result.title).toBe(enabled ? '启用插件' : '停用插件')
    expect(result.confirmLabel).toBe(result.title)
    expect(result.summary).toBe(pluginManifest.id)
    expect(result.sections.find((section) => section.id === 'plugin-details')?.facts).toEqual([
      { label: '插件 ID', value: pluginManifest.id }
    ])
    expect(result.sections.every((section) => section.previous === undefined)).toBe(true)
  }
})

test('plugin imports expose only actual prepared sources and dependencies without an invented manifest', () => {
  const input = { jobId: 'immutable-job-1' }
  const source = {
    type: 'github',
    repository: 'example/report',
    url: 'https://github.com/example/report',
    requestedRef: 'v1',
    resolvedCommit: 'a'.repeat(40),
    archiveSha256: 'b'.repeat(64),
    subdirectory: 'plugin',
    format: 'remark',
    adapter: 'remark-v1',
    importJobId: input.jobId
  }
  const requirements = [
    { type: 'npm', packages: { 'remark-gfm': '4.0.1', unified: '^11' }, scripts: 'disabled' }
  ]
  const question = pluginPreview('plugin_import_install', input, { source, requirements })
  const result = permissionPresentation(pending('plugin_import_install', question, input))
  expect(result.title).toBe('安装插件')
  expect(result.summary).toBeUndefined()
  expect(result.fields).toEqual([])
  expect(result.sections.find((section) => section.id === 'plugin-source')?.facts).toEqual([
    { label: '来源类型', value: 'GitHub' },
    { label: '仓库', value: source.repository },
    { label: '网址', value: source.url },
    { label: '请求引用', value: source.requestedRef },
    { label: '提交', value: source.resolvedCommit },
    { label: '压缩包 SHA-256', value: source.archiveSha256 },
    { label: '子目录', value: source.subdirectory },
    { label: '格式', value: source.format },
    { label: '适配器', value: source.adapter },
    { label: '导入作业 ID', value: source.importJobId }
  ])
  expect(result.sections.find((section) => section.id === 'plugin-dependencies')?.facts).toEqual([
    { label: '依赖管理器', value: 'npm' },
    { label: 'remark-gfm', value: '4.0.1' },
    { label: 'unified', value: '^11' },
    { label: '生命周期脚本', value: '禁用' }
  ])
  expect(
    result.sections.some(
      (section) => section.id === 'plugin-tools' || section.id === 'plugin-files'
    )
  ).toBe(false)
  const fallback = permissionPresentation(pending('plugin_import_install', '确认安装', input))
  expect(fallback.sections.map((section) => section.id)).toEqual([
    'plugin-operation',
    'plugin-details'
  ])
  expect(fallback.sections.find((section) => section.id === 'plugin-details')?.facts).toEqual([
    { label: '导入作业 ID', value: input.jobId }
  ])
})

test('plugin import source types display local directories and ZIP archives with actual paths', () => {
  for (const [type, label, path] of [
    ['local', '本地目录', 'D:\\plugins\\report-helper'],
    ['zip', '压缩包', 'D:\\plugins\\report-helper.zip']
  ] as const) {
    const source = { type, path, format: 'native', ...(type === 'zip' ? { archiveSha256: 'c'.repeat(64) } : {}) }
    const input = { jobId: `job-${type}` }
    const result = permissionPresentation(
      pending('plugin_import_install', pluginPreview('plugin_import_install', input, { source }))
    )
    expect(result.summary).toBeUndefined()
    const facts = result.sections.find((section) => section.id === 'plugin-source')?.facts
    expect(facts).toContainEqual({ label: '来源类型', value: label })
    expect(facts).toContainEqual({ label: '路径', value: path })
    expect(facts?.some((entry) => entry.label === '压缩包 SHA-256')).toBe(type === 'zip')
  }
})

for (const [action, args] of [
  ['plugin_create', pluginInput],
  ['plugin_update', { id: pluginManifest.id, ...pluginInput, expectedRevision: 2 }],
  ['plugin_publish', { id: pluginManifest.id, expectedRevision: 2 }],
  ['plugin_delete', { id: pluginManifest.id }],
  ['plugin_set_enabled', { id: pluginManifest.id, enabled: false }],
  ['plugin_test', { id: pluginManifest.id, tool: 'report', args: {} }],
  ['plugin_import_install', { jobId: 'job-fallback' }]
] as const)
  test(`${action} uses valid original arguments when there is no prepared preview`, () => {
    const result = permissionPresentation(pending(action, '请确认操作', args))
    expect(result.kind).toBe('plugin')
    expect(result.sections.length).toBeGreaterThan(0)
    expect(result.raw).toContain(JSON.stringify(args, null, 2))
    expect(buildToolResponse(pending(action, '请确认操作', args), ['approved']).name).toBe(action)
  })

test('plugin prepared parsing rejects action, envelope, wrapper and structure mismatches', () => {
  const fallback = { ...pluginInput, manifest: { ...pluginManifest, name: '兜底参数名称' } }
  const correct = pluginPreview('plugin_create', pluginInput)
  const invalid = [
    correct.replace('"action": "plugin_create"', '"action": "plugin_update"'),
    correct.replace('"version": 1,', '"version": 2,'),
    correct.replace('"tenantId": "tenant-fixture"', '"tenantId": ""'),
    correct.replace('创建插件确认', '编辑插件确认'),
    correct.replace('确认后执行以上操作。', '确认后执行以上配置。'),
    `来源说明：\n${correct}`,
    `${correct}\n额外文字`,
    pluginPreview('plugin_create', { ...pluginInput, files: ['not-a-map'] }),
    pluginPreview('plugin_create', {
      ...pluginInput,
      manifest: { ...pluginManifest, tools: [{ name: 'broken' }] }
    }),
    '创建插件确认\n\n{invalid json}\n\n确认后执行以上操作。'
  ]
  for (const question of invalid) {
    const result = permissionPresentation(pending('plugin_create', question, fallback))
    expect(result.summary).toBe('兜底参数名称')
    expect(result.raw.startsWith(question)).toBe(true)
  }
  const updateInput = { id: pluginManifest.id, ...fallback, expectedRevision: 2 }
  const conflicting = pluginPreview(
    'plugin_update',
    { ...updateInput, manifest: pluginManifest },
    { expectedRevision: 3 }
  )
  expect(permissionPresentation(pending('plugin_update', conflicting, updateInput)).summary).toBe(
    '兜底参数名称'
  )
})

test('plugin-like tools outside the exact management whitelist keep generic presentation', () => {
  const question = pluginPreview('plugin_create', pluginInput)
  for (const tool of [
    'plugin_create_extra',
    'plugin_report_create',
    'mcp__server__plugin_create',
    'custom_plugin_create',
    'plugin_import_preview',
    'plugin_get'
  ]) {
    const result = permissionPresentation(pending(tool, question, pluginInput))
    expect(result.kind).toBeUndefined()
    expect(result.sections.some((section) => section.pluginTools || section.files)).toBe(false)
    expect(result.raw).toContain(question)
  }
  for (const [tool, title] of Object.entries(pluginTitles))
    expect(toolDisplayName(tool)).toBe(title)
})

test('malformed plugin arguments cannot invent disabled state, name, revision or an empty manifest', () => {
  for (const [action, args] of [
    ['plugin_create', { manifest: { name: '不完整' } }],
    ['plugin_set_enabled', { id: 'plugin-id', enabled: 'false' }],
    ['plugin_test', { id: 'plugin-id', tool: 'report', args: [] }],
    ['plugin_publish', { id: 'plugin-id', expectedRevision: 0 }]
  ] as const) {
    const result = permissionPresentation(pending(action, '审批原文', args))
    expect(result.title).toBe(pluginTitles[action])
    expect(result.summary).toBeUndefined()
    expect(result.fields).toEqual([])
    expect(result.sections).toEqual([])
    expect(result.raw).toContain(JSON.stringify(args, null, 2))
  }
})

test('plugin source and schemas remain complete, unknown extensions survive in raw, and inputs are not mutated', () => {
  const source = Array.from({ length: 3000 }, (_, index) => `// 完整源码第 ${index} 行`).join('\n')
  const input = {
    ...pluginInput,
    files: { 'main.mjs': source, 'empty.txt': '' },
    futureMetadata: { complete: ['未知字段', 0, false] }
  }
  const item = pending('plugin_create', pluginPreview('plugin_create', input), {
    manifest: pluginManifest,
    files: input.files
  })
  const original = JSON.stringify(item)
  const result = permissionPresentation(item)
  expect(result.sections.find((section) => section.id === 'plugin-files')?.files).toEqual([
    { path: 'main.mjs', content: source },
    { path: 'empty.txt', content: '' }
  ])
  expect(result.raw).toBe(`${item.question}\n\n原始调用参数\n${JSON.stringify(item.args, null, 2)}`)
  expect(result.raw).toContain('"futureMetadata":')
  expect(JSON.stringify(item)).toBe(original)
  const empty = { manifest: { ...pluginManifest, tools: [] }, files: {} }
  const emptyResult = permissionPresentation(pending('plugin_create', '待确认配置', empty))
  expect(emptyResult.sections.find((section) => section.id === 'plugin-tools')).toMatchObject({
    text: '无工具',
    pluginTools: []
  })
  expect(emptyResult.sections.find((section) => section.id === 'plugin-files')).toMatchObject({
    text: '无文件',
    files: []
  })
})
