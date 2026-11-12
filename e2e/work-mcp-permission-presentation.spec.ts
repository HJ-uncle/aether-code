/** Pure MCP approval presentation: exact engine previews, public before/after
 * snapshots, complete call-argument fallback and unchanged approval replies. */
import { expect, test } from '@playwright/test'
import { buildToolResponse, normalizePending } from '../src/renderer/src/core/engine/pending'
import { permissionPresentation } from '../src/renderer/src/contrib/work/work-permission-presentation'
import type { PermissionPresentation } from '../src/renderer/src/contrib/work/work-permission-presentation'

const titles = {
  create: '创建 MCP 服务器', update: '编辑 MCP 服务器', set_enabled: '启停 MCP 服务器',
  delete: '删除 MCP 服务器', test: '测试 MCP 连接'
} as const
type Action = keyof typeof titles
const revision = `sha256:${'a'.repeat(64)}`
const configFile = 'D:/workspace/.aether/mcp.json'
const key = { id: 'research-docs', scope: 'project', expectedRevision: revision }
function server(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: key.id, scope: key.scope, name: '研究文档', description: '读取项目文档',
    transportType: 'stdio', enabled: false, revision, isBuiltIn: false,
    connection: { command: 'node.exe', argumentCount: 2, envKeys: ['DOCS_TOKEN'], headerKeys: [] },
    timeoutMs: 30000, disabledTools: ['write_document'], ...overrides
  }
}
function operation(action: Action, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action, id: key.id, scope: key.scope, configFile,
    ...(action !== 'create' ? { before: server() } : {}),
    ...(['create', 'update', 'set_enabled'].includes(action) ? { after: server() } : {}),
    ...overrides
  }
}
function preview(action: Action, value = operation(action)): string {
  return `${titles[action]}确认\n\n${JSON.stringify(value, null, 2)}\n\n确认后执行以上操作。`
}
function render(toolName: string, question: string, args?: Record<string, unknown>): PermissionPresentation {
  const pending = normalizePending({ permissionRequest: { requestId: 'mcp-approval', toolName, description: question, args } })!
  const original = JSON.stringify(pending)
  const result = permissionPresentation(pending)
  expect(JSON.stringify(pending)).toBe(original)
  expect(result.raw).toBe(args ? `${question}\n\n原始调用参数\n${JSON.stringify(args, null, 2)}` : question)
  for (const reply of ['approved', 'rejected'])
    expect(buildToolResponse(pending, [reply])).toEqual({ toolCallId: 'mcp-approval', name: toolName, output: reply })
  return result
}
const facts = (result: PermissionPresentation) => result.sections.find(section => section.id === 'mcp-configuration')?.facts ?? []
const details = (result: PermissionPresentation) => result.sections.find(section => section.id === 'mcp-details')?.facts ?? []

test('MCP creation displays the prepared public configuration and generated defaults', () => {
  const result = render('mcp_server_create', preview('create'), {
    id: key.id, name: '过期调用名称', transportType: 'stdio', command: 'D:/private/node.exe',
    args: ['private-script.mjs', '--token=private-value']
  })
  expect(result).toMatchObject({ kind: 'management', title: titles.create, confirmLabel: titles.create, summary: '研究文档', destructive: false })
  expect(result.fields).toEqual([{ label: '用途', value: '读取项目文档' }])
  expect(facts(result)).toContainEqual({ label: '状态', value: '停用' })
  expect(facts(result)).toContainEqual({ label: '启动程序', value: 'node.exe' })
  expect(facts(result)).toContainEqual({ label: '参数数量', value: '2' })
  expect(facts(result)).toContainEqual({ label: '环境变量', value: 'DOCS_TOKEN' })
  expect(JSON.stringify(result.sections)).not.toContain('private-value')
  expect(JSON.stringify(result.sections)).not.toContain('private-script')
  expect(facts(result).every(field => field.previous === undefined)).toBe(true)
  expect(details(result)).toEqual([
    { label: '服务器 ID', value: key.id }, { label: '范围', value: '当前项目' }, { label: '配置文件', value: configFile }
  ])
})

test('MCP update displays real before and after values including explicit empty values', () => {
  const after = server({ name: '新文档', description: '', timeoutMs: 0, disabledTools: [],
    connection: { command: 'node.exe', argumentCount: 0, envKeys: [], headerKeys: [] } })
  const result = render('mcp_server_update', preview('update', operation('update', { after })), {
    ...key, changes: { name: '过期参数名称', timeoutMs: 9000 }
  })
  expect(result.summary).toBe('新文档')
  expect(facts(result)).toContainEqual({ label: '名称', value: '新文档', previous: '研究文档' })
  expect(facts(result)).toContainEqual({ label: '用途', value: '（空）', previous: '读取项目文档' })
  expect(facts(result)).toContainEqual({ label: '调用超时', value: '不限时', previous: '30000 毫秒' })
  expect(facts(result)).toContainEqual({ label: '停用工具', value: '无', previous: 'write_document' })
  expect(facts(result)).toContainEqual({ label: '参数数量', value: '0', previous: '2' })
  expect(facts(result)).toContainEqual({ label: '环境变量', value: '无', previous: 'DOCS_TOKEN' })
  expect(facts(result)).toContainEqual({ label: '启动程序', value: 'node.exe' })
})

test('MCP timeout reset and transport changes keep removed public fields visible', () => {
  const after = server({ transportType: 'http', connection: {
    endpoint: 'https://docs.example/[redacted]', hasQuery: true, hasCredentials: false, envKeys: [], headerKeys: ['Authorization']
  } })
  delete after.timeoutMs
  const result = render('mcp_server_update', preview('update', operation('update', { after })), {
    ...key, changes: { transportType: 'http', url: 'https://docs.example/private/path?token=secret', timeoutMs: null }
  })
  expect(facts(result)).toContainEqual({ label: '调用超时', value: '默认', previous: '30000 毫秒' })
  expect(facts(result)).toContainEqual({ label: '传输方式', value: 'http', previous: 'stdio' })
  expect(facts(result)).toContainEqual({ label: '启动程序', value: '无', previous: 'node.exe' })
  expect(facts(result)).toContainEqual({ label: '参数数量', value: '无', previous: '2' })
  expect(facts(result)).toContainEqual({ label: '连接地址', value: 'https://docs.example/[redacted]' })
  expect(facts(result)).toContainEqual({ label: '包含查询参数', value: '是' })
  expect(facts(result)).toContainEqual({ label: '包含连接凭据', value: '否' })
  expect(JSON.stringify(result.sections)).not.toContain('private/path')
  expect(JSON.stringify(result.sections)).not.toContain('token=secret')
})

test('MCP transport change back to stdio does not retain removed HTTP connection values', () => {
  const before = server({ transportType: 'http', connection: {
    endpoint: 'https://docs.example/[redacted]', hasQuery: true, hasCredentials: false, envKeys: [], headerKeys: ['Authorization']
  } })
  const result = render('mcp_server_update', preview('update', operation('update', { before })))
  expect(facts(result)).toContainEqual({ label: '连接地址', value: '无', previous: 'https://docs.example/[redacted]' })
  expect(facts(result)).toContainEqual({ label: '包含查询参数', value: '不适用', previous: '是' })
  expect(facts(result)).toContainEqual({ label: '包含连接凭据', value: '不适用', previous: '否' })
  expect(facts(result)).toContainEqual({ label: '请求头', value: '无', previous: 'Authorization' })
})

test('MCP delete preserves the exact global target and its current public configuration', () => {
  const before = server({ scope: 'global', enabled: true })
  const result = render('mcp_server_delete', preview('delete', operation('delete', {
    scope: 'global', configFile: 'D:/user/mcp.json', before
  })), { ...key, id: 'different-id' })
  expect(result).toMatchObject({ title: titles.delete, summary: '研究文档', confirmLabel: titles.delete, destructive: true })
  expect(details(result)).toEqual([
    { label: '服务器 ID', value: key.id }, { label: '范围', value: '本机全局' }, { label: '配置文件', value: 'D:/user/mcp.json' }
  ])
  expect(facts(result)).toContainEqual({ label: '状态', value: '启用' })
  expect(facts(result).every(field => field.previous === undefined)).toBe(true)
})

test('MCP connection test retains the prepared notice without inventing test results', () => {
  const notice = '将启动扩展或发送网络请求，只发现工具目录，不调用业务工具；15 秒内结束。'
  const result = render('mcp_server_test', preview('test', operation('test', { notice })), key)
  expect(result).toMatchObject({ title: titles.test, confirmLabel: titles.test, summary: '研究文档', destructive: false })
  expect(result.sections.find(section => section.id === 'mcp-test-notice')?.text).toBe(notice)
  expect(facts(result)).toContainEqual({ label: '状态', value: '停用' })
  expect(facts(result).every(field => field.previous === undefined)).toBe(true)
  expect(JSON.stringify(result.sections)).not.toContain('测试成功')
})

for (const enabled of [true, false]) {
  test(`MCP set_enabled displays the prepared ${enabled ? 'enabled' : 'disabled'} state and real previous value`, () => {
    const result = render('mcp_server_set_enabled', preview('set_enabled', operation('set_enabled', {
      before: server({ enabled: !enabled }), after: server({ enabled })
    })), { ...key, enabled: !enabled })
    expect(result.title).toBe(enabled ? '启用 MCP 服务器' : '停用 MCP 服务器')
    expect(result.confirmLabel).toBe(result.title)
    expect(facts(result)).toContainEqual({ label: '状态', value: enabled ? '启用' : '停用', previous: enabled ? '停用' : '启用' })
  })
}

test('MCP exact security wrapper accepts both LF and CRLF engine previews', () => {
  for (const question of [preview('create'), `安全策略拦截了此操作，是否允许执行？\n原因：${preview('create')}`]) {
    for (const text of [question, question.replace(/\n/g, '\r\n')])
      expect(render('mcp_server_create', text).summary).toBe('研究文档')
  }
})

test('MCP action, title, suffix and embedded wrapper mismatches fall back to original arguments', () => {
  const args = { id: 'fallback-server', transportType: 'stdio', command: 'node', name: '原始参数名称' }
  const invalid = [
    preview('create', { ...operation('create'), action: 'delete' }),
    preview('update'),
    preview('create').replace('确认后执行以上操作。', '确认执行。'),
    `请参考：\n${preview('create')}`,
    `安全策略拦截了此操作，是否允许执行？\n原因：\n${preview('create')}`,
    `${preview('create')}\n附加说明`,
    '创建 MCP 服务器确认\n\n{broken}\n\n确认后执行以上操作。'
  ]
  for (const question of invalid) {
    const result = render('mcp_server_create', question, args)
    expect(result.summary).toBe(args.name)
    expect(facts(result)).toContainEqual({ label: '启动命令', value: args.command })
    expect(details(result)).toEqual([{ label: '服务器 ID', value: args.id }])
  }
})

test('MCP mismatched snapshot identity and incomplete public view never claim prepared changes', () => {
  const args = { ...key, changes: { name: '原始修改' } }
  const broken = [
    operation('update', { before: server({ id: 'another-id' }) }),
    operation('update', { after: server({ scope: 'global' }) }),
    operation('update', { before: undefined }),
    operation('update', { after: undefined }),
    operation('update', { after: server({ connection: { envKeys: [] } }) }),
    operation('update', { after: server({ enabled: 'false' }) }),
    operation('update', { after: server({ connection: { command: 42, envKeys: [], headerKeys: [] } }) }),
    operation('update', { configFile: '' })
  ]
  for (const value of broken) {
    const result = render('mcp_server_update', preview('update', value), args)
    expect(result.summary).toBe(args.changes.name)
    expect(facts(result)).toEqual([{ label: '名称', value: args.changes.name }])
    expect(details(result).some(field => field.label === '配置文件')).toBe(false)
  }
  expect(render('mcp_server_create', preview('create', operation('create', { before: server() }))).summary).toBeUndefined()
  for (const action of ['delete', 'test'] as const)
    expect(render(`mcp_server_${action}`, preview(action, operation(action, { after: server() }))).summary).toBeUndefined()
})

for (const [action, args] of [
  ['create', { id: key.id, transportType: 'stdio', name: '原始新配置', command: 'node', args: ['index.mjs', '--mode=read'], timeoutMs: null }],
  ['update', { ...key, changes: { description: '', timeoutMs: 0, disabledTools: [] } }],
  ['delete', key], ['test', key], ['set_enabled', { ...key, enabled: false }]
] as const) {
  test(`MCP ${action} displays actual original arguments when no preview exists`, () => {
    const result = render(`mcp_server_${action}`, '请确认此操作。', args)
    expect(result.kind).toBe('management')
    expect(result.summary).toBe(action === 'create' ? '原始新配置' : key.id)
    expect(details(result)).toContainEqual({ label: '服务器 ID', value: key.id })
    expect(facts(result).every(field => field.previous === undefined)).toBe(true)
    expect(details(result).some(field => field.label === '配置文件')).toBe(false)
    if (action === 'create') {
      expect(facts(result)).toContainEqual({ label: '启动参数', value: 'index.mjs\n--mode=read' })
      expect(facts(result)).toContainEqual({ label: '调用超时', value: '默认' })
      expect(facts(result).some(field => field.label === '状态')).toBe(false)
      expect(details(result).some(field => field.label === '范围')).toBe(false)
    }
    if (action === 'update') {
      expect(facts(result)).toContainEqual({ label: '用途', value: '（空）' })
      expect(facts(result)).toContainEqual({ label: '调用超时', value: '不限时' })
    }
    if (action === 'set_enabled') expect(result.confirmLabel).toBe('停用 MCP 服务器')
  })
}

test('MCP malformed arguments do not invent a target, connection or enabled state', () => {
  for (const [action, args] of [
    ['create', { name: '缺少目标', transportType: 'stdio' }],
    ['create', { id: key.id, name: '缺少传输方式' }],
    ['create', { id: key.id, transportType: 'stdio', args: [false] }],
    ['update', { ...key, changes: { name: ['错误类型'] } }],
    ['update', { ...key, changes: [] }],
    ['delete', { id: key.id, scope: 'workspace' }],
    ['set_enabled', { enabled: true }],
    ['set_enabled', { ...key, enabled: 'false' }]
  ] as const) {
    const result = render(`mcp_server_${action}`, '待确认参数', args)
    expect(result.title).toBe(titles[action])
    expect(result.summary).toBeUndefined()
    expect(facts(result)).toEqual([])
    expect(details(result)).toEqual([])
  }
})

test('MCP lookalike tools stay generic and cannot inherit a management operation', () => {
  for (const tool of ['mcp_server_get', 'mcp_server_list', 'mcp_server_create_extra', 'mcp__server__mcp_server_create', 'mcp_create']) {
    const result = render(tool, preview('create'), { id: key.id, name: '普通参数' })
    expect(result.kind).toBeUndefined()
    expect(result.sections.some(section => section.id.startsWith('mcp-'))).toBe(false)
    expect(result.confirmLabel).toBe('允许执行')
  }
})

test('MCP original delete and test arguments do not masquerade as saved configuration', () => {
  for (const action of ['delete', 'test', 'set_enabled'] as const) {
    const args = { ...key, ...(action === 'set_enabled' ? { enabled: true } : {}),
      name: '非协议配置名称', description: '未读取的配置', connection: { command: 'unverified.exe', envKeys: [], headerKeys: [] } }
    const result = render(`mcp_server_${action}`, '待确认', args)
    expect(result.summary).toBe(key.id)
    expect(result.fields).toEqual([])
    expect(facts(result)).toEqual(action === 'set_enabled' ? [{ label: '状态', value: '启用' }] : [])
    expect(result.raw).toContain('非协议配置名称')
  }
})

test('MCP complete original values and unknown preview metadata remain available without truncation', () => {
  const description = '完整的用途描述。\n'.repeat(600)
  const value = operation('update', { after: server({ description }), futureMetadata: { preserved: ['future', false, 0] } })
  const result = render('mcp_server_update', preview('update', value), { ...key, changes: { description } })
  expect(result.fields).toContainEqual({ label: '用途', value: description })
  expect(facts(result)).toContainEqual({ label: '用途', value: description, previous: '读取项目文档' })
  expect(result.raw).toContain('"futureMetadata":')
})
