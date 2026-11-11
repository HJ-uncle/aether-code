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
import { permissionPresentation } from '../src/renderer/src/contrib/work/work-permission-presentation'

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
  expect(result.sections[0]).toEqual({ id: 'command', label: '命令', text: command })
  expect(JSON.parse(result.sections.find((section) => section.id === 'arguments')!.text!)).toEqual({
    flags: args.flags,
    customValue: args.customValue
  })
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
  expect(
    JSON.parse(result.sections.find((section) => section.id === 'additional-config')!.text!)
  ).toEqual({ futureConfig: data.futureConfig })
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
