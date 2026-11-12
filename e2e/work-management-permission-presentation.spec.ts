/** Pure knowledge/skill/cron approval rendering: authentic previews, safe fallback,
 * full content, exact changes, and unchanged approval identity. No Electron. */
import { expect, test } from '@playwright/test'
import { appendManagementPresentation } from '../src/renderer/src/contrib/work/work-management-permission-presentation'
import { buildToolResponse, normalizePending } from '../src/renderer/src/core/engine/pending'
import type { PermissionPresentation } from '../src/renderer/src/contrib/work/work-permission-presentation'

const hash = `sha256:${'a'.repeat(64)}`
const skillId = `skill-${'b'.repeat(32)}`
const base = { id: 'knowledge-1', name: '项目资料', description: '保留来源', revision: 4, documentCount: 3 }
const document = { id: 'document-1', filename: '指南.md', knowledgeBaseId: base.id, contentType: 'text/markdown', revision: 2 }
const beforeSkill = { name: 'research', description: '核对资料来源', enabled: false, hash, files: [{ path: 'SKILL.md', size: 0 }, { path: 'scripts/check.mjs', size: 130 }] }
const preview = (title: string, data: Record<string, unknown>): string => `${title}确认\n\n${JSON.stringify(data, null, 2)}\n\n确认后执行以上操作。`
function render(toolName: string, question: string, args?: Record<string, unknown>) {
  const pending = normalizePending({ permissionRequest: { requestId: 'management-call', toolName, description: question, args } })!
  const presentation: PermissionPresentation = { title: '', confirmLabel: '', destructive: false, fields: [], sections: [], raw: question }
  const accepted = appendManagementPresentation(presentation, pending)
  expect(presentation.raw).toBe(question)
  expect(buildToolResponse(pending, ['approved'])).toEqual({ toolCallId: 'management-call', name: toolName, output: 'approved' })
  return { accepted, ...presentation }
}
const facts = (value: PermissionPresentation) => value.sections.find(section => section.id === 'management-operation')?.facts ?? []
const operation = (value: PermissionPresentation) => value.sections.find(section => section.id === 'management-operation')?.text

test('knowledge creation uses the generated preview identity and readable purpose', () => {
  const result = render('knowledge_create', preview('创建知识库', { action: 'create', id: 'generated-id', input: { name: '评审资料', description: '保存决策依据' } }), { name: '旧参数' })
  expect(result).toMatchObject({ accepted: true, kind: 'management', title: '创建知识库', confirmLabel: '创建知识库', summary: '评审资料', destructive: false })
  expect(result.fields).toEqual([{ label: '用途', value: '保存决策依据' }])
  expect(result.sections[0]).toMatchObject({ id: 'management-operation', label: '知识库信息', facts: [{ label: '知识库 ID', value: 'generated-id' }] })
  expect(operation(result)).toContain('保存和检索')
})

test('knowledge updates preserve explicit empty descriptions and real previous values', () => {
  const result = render('knowledge_update', preview('更新知识库', { action: 'update', id: base.id, before: base, input: { name: '新项目资料', description: '' } }))
  expect(result.summary).toBe(base.name)
  expect(facts(result)).toContainEqual({ label: '名称', value: '新项目资料', previous: base.name })
  expect(facts(result)).toContainEqual({ label: '用途', value: '（空）', previous: base.description })
})

test('knowledge deletion describes document impact using the saved snapshot', () => {
  const result = render('knowledge_delete', preview('删除知识库', { action: 'delete', id: base.id, before: base, input: {} }))
  expect(result).toMatchObject({ summary: base.name, destructive: true, confirmLabel: '删除知识库' })
  expect(facts(result)).toContainEqual({ label: '文档数量', value: '3' })
  expect(operation(result)).toContain('其中的文档和检索索引')
})

test('file imports preserve extracted content, canonical source and extractor warnings', () => {
  const content = '完整正文，保留全部来源。\n'.repeat(120)
  const result = render('knowledge_import', preview('导入知识文档', { action: 'import', id: 'new-document', before: base,
    input: { knowledgeBaseId: base.id, filename: '完整说明.docx', content, contentType: 'text/plain', bytes: new TextEncoder().encode(content).length, sha256: hash },
    source: { path: 'D:/project/完整说明.docx', submittedPath: './完整说明.docx', hash }, warning: '仅提取正文，图片未纳入检索。' }), { knowledgeBaseId: base.id, path: './完整说明.docx' })
  expect(result.summary).toBe('完整说明.docx')
  expect(result.sections.find(section => section.label === '文档内容')).toMatchObject({ text: content, facts: [
    { label: '内容大小', value: `${new TextEncoder().encode(content).length} 字节` }, { label: 'SHA-256', value: hash }
  ] })
  expect(result.sections.find(section => section.label === '来源文件')?.facts).toContainEqual({ label: '文件路径', value: 'D:/project/完整说明.docx' })
  expect(result.sections.find(section => section.label === '导入说明')?.text).toBe('仅提取正文，图片未纳入检索。')
})

test('document update shows null binding and does not invent the missing old body', () => {
  const result = render('knowledge_document_update', preview('更新知识文档', { action: 'document_update', id: document.id, before: document,
    input: { filename: '更新指南.md', knowledgeBaseId: null, content: '替换后的完整正文', bytes: 27, sha256: hash } }))
  expect(result.summary).toBe(document.filename)
  expect(facts(result)).toContainEqual({ label: '所属知识库', value: '未归属知识库', previous: base.id })
  expect(facts(result)).toContainEqual({ label: '文件名', value: '更新指南.md', previous: document.filename })
  expect(result.sections.find(section => section.label === '更新内容')).toMatchObject({ text: '替换后的完整正文' })
  expect(result.sections.every(section => section.previous === undefined)).toBe(true)
})

test('document deletion retains the exact target and removes no unrelated base', () => {
  const result = render('knowledge_document_delete', preview('删除知识文档', { action: 'document_delete', id: document.id, before: document, input: {} }))
  expect(result).toMatchObject({ summary: document.filename, destructive: true, confirmLabel: '删除知识文档' })
  expect(facts(result)).toContainEqual({ label: '文档 ID', value: document.id })
  expect(operation(result)).toBe('删除此知识文档及其检索索引。')
})

test('skill creation uses the prepared full document and resolved scope', () => {
  const content = '---\nname: research\ndescription: 研究任务\n---\n\n保留证据。\n'
  const result = render('skill_create', preview('创建技能', { action: 'create', id: skillId, scope: 'project', name: 'research', directory: 'D:/project/.aether/skills/research', content }),
    { name: 'research', description: '研究任务', content: '原始正文' })
  expect(result).toMatchObject({ summary: 'research', confirmLabel: '创建技能' })
  expect(result.fields).toContainEqual({ label: '用途', value: '研究任务' })
  expect(facts(result)).toContainEqual({ label: '范围', value: '当前项目' })
  expect(result.sections.find(section => section.label === '技能内容')?.text).toBe(content)
})

test('skill editing keeps the full replacement and existing attachment inventory without fake content diff', () => {
  const content = '---\nname: research\n---\n\n' + '资料内容'.repeat(800)
  const result = render('skill_update', preview('编辑技能', { action: 'update', id: skillId, scope: 'global', name: 'research', directory: 'D:/skills/research', before: beforeSkill, content }))
  expect(result.sections.find(section => section.label === '更新内容')).toMatchObject({ text: content })
  expect(result.sections.find(section => section.label === '更新内容')?.previous).toBeUndefined()
  expect(result.sections.find(section => section.label === '现有文件')?.items).toEqual(['SKILL.md · 0 字节', 'scripts/check.mjs · 130 字节'])
  expect(facts(result)).toContainEqual({ label: '范围', value: '本机全局' })
})

for (const enabled of [true, false]) test(`skill enabled=${enabled} uses explicit boolean and the actual prior status`, () => {
  const result = render('skill_set_enabled', preview('启停技能', { action: 'set_enabled', id: skillId, scope: 'project', name: 'research', directory: 'D:/skills/research', before: beforeSkill, enabled }))
  expect(result.confirmLabel).toBe(enabled ? '启用技能' : '停用技能')
  expect(facts(result)).toContainEqual({ label: '启用状态', value: enabled ? '启用' : '停用', previous: '停用' })
  expect(result.destructive).toBe(false)
})

test('skill deletion names the target files and whole-directory impact', () => {
  const result = render('skill_delete', preview('删除技能', { action: 'delete', id: skillId, scope: 'project', name: 'research', directory: 'D:/skills/research', before: beforeSkill }))
  expect(result.destructive).toBe(true)
  expect(result.sections.find(section => section.label === '将删除的文件')?.items).toHaveLength(2)
  expect(operation(result)).toContain('脚本和附件')
})

test('valid argument fallback does not fabricate a generated ID, before snapshot or resolved path', () => {
  const created = render('knowledge_create', '普通安全提示', { name: '仅参数名称', description: '用途' })
  expect(created.summary).toBe('仅参数名称')
  expect(created.fields).toEqual([{ label: '用途', value: '用途' }])
  const changed = render('skill_update', '普通安全提示', { id: skillId, expectedHash: hash, content: '完整内容' })
  expect(facts(changed)).toEqual([{ label: '技能 ID', value: skillId }])
  expect(changed.sections[0]).toEqual({ id: 'management-0', label: '更新内容', text: '完整内容' })
  const imported = render('knowledge_import', '普通安全提示', { knowledgeBaseId: base.id, path: './待解析.docx' })
  expect(imported.sections).toHaveLength(1)
  expect(facts(imported)).toContainEqual({ label: '来源文件', value: './待解析.docx' })
})

test('mismatched, embedded, invalid and wrong-identity previews never become prepared facts', () => {
  const original = preview('更新知识库', { action: 'update', id: base.id, before: base, input: { name: '预览名称' } })
  for (const question of ['说明\n' + original, original + '\n额外文字', original.replace('"update"', '"delete"'),
    original.replace('"id": "knowledge-1"', '"id": "wrong-id"'), '更新知识库确认\n\n{invalid}\n\n确认后执行以上操作。']) {
    const result = render('knowledge_update', question, { id: base.id, name: '参数名称' })
    expect(result.summary).toBeUndefined()
    expect(facts(result)).toContainEqual({ label: '名称', value: '参数名称' })
    expect(facts(result).every(field => field.previous === undefined)).toBe(true)
  }
  const both = render('knowledge_import', '说明', { knowledgeBaseId: base.id, path: 'file.md', content: '', filename: 'file.md' })
  expect(both.fields).toEqual([])
  const invalid = render('skill_set_enabled', '说明', { id: skillId, enabled: 'false' })
  expect(invalid.fields).toEqual([])
  expect(invalid.confirmLabel).toBe('启停技能')
  expect(operation(invalid)).toContain('完整参数')
})

test('known wrapper supports CRLF while unrelated MCP/plugin tool names stay generic', () => {
  const content = preview('创建知识库', { action: 'create', id: 'new-id', input: { name: '资料' } })
  expect(render('knowledge_create', ('安全策略拦截了此操作，是否允许执行？\n原因：' + content).replace(/\n/g, '\r\n')).summary).toBe('资料')
  for (const tool of ['knowledge_list', 'knowledge_custom_create', 'skill_get', 'mcp_create', 'mcp__server__knowledge_create', 'plugin_create'])
    expect(render(tool, content).accepted).toBe(false)
})

test('long descriptions remain complete in a bounded detail section', () => {
  const description = '完整用途说明。\n'.repeat(120)
  const result = render('knowledge_update', preview('更新知识库', { action: 'update', id: base.id, before: base, input: { description } }))
  expect(result.sections).toContainEqual({ id: 'management-0', label: '用途', text: description, previous: base.description })
  expect(facts(result)).toEqual([{ label: '知识库 ID', value: base.id }])
})

const configuration = { version: 2, schedule: { kind: 'calendar', localTime: '09:30', daysOfWeek: [1, 2, 3, 4, 5], timeZone: 'Asia/Shanghai' },
  target: { kind: 'session', sessionId: 'existing-session' }, notificationPolicy: 'all_runs', toolProfile: 'general' }
const job = { id: 'cron-1', tenantId: 'default', name: '项目日报', message: '核对当天变更', description: '保留依据', enabled: true, configuration,
  cronExpr: null, sessionId: 'existing-session', agentId: 'agent-1', thinkingMode: 'high', timeoutSeconds: 120,
  revision: 3, scheduleRevision: 1, createdAt: 0, updatedAt: 0 }

test('paused cron creation preserves the instruction and resolved schedule without inventing an ID', () => {
  const message = '核对当天变更，列出来源。\n'.repeat(150)
  const result = render('cron_create', preview('创建定时任务', { name: '日报', message, configuration, enabled: false }), { name: '旧名称', message: '旧指令', cronExpr: '* * * * *' })
  expect(result).toMatchObject({ summary: '日报', confirmLabel: '创建定时任务', kind: 'management', destructive: false })
  expect(result.sections[0]).toMatchObject({ label: '任务指令', text: message })
  expect(facts(result)).toContainEqual({ label: '执行规则', value: '工作日 09:30 · Asia/Shanghai' })
  expect(facts(result)).toContainEqual({ label: '执行位置', value: '已有会话 · existing-session' })
  expect(facts(result)).toContainEqual({ label: '计划状态', value: '暂停' })
  expect(facts(result).some(item => item.label === '任务 ID')).toBe(false)
  expect(operation(result)).toContain('启用前不会按计划运行')
})

test('cron changes retain exact prior instructions, cleared fields and execution settings', () => {
  const changes = { expectedRevision: 3, name: '新日报', message: '完整的新指令', description: '', agentId: null, thinkingMode: false, timeoutSeconds: null,
    configuration: { version: 2, schedule: { kind: 'interval', everyMinutes: 90, anchorAt: 0 }, target: { kind: 'workspace', sourceSessionId: 'workspace-source' }, notificationPolicy: 'silent', toolProfile: 'code' } }
  const result = render('cron_update', preview('更新定时任务', { before: job, changes }))
  expect(result.summary).toBe(job.name)
  expect(result.sections[0]).toMatchObject({ label: '任务指令', text: changes.message, previous: job.message })
  expect(facts(result)).toEqual(expect.arrayContaining([
    { label: '用途', value: '（空）', previous: '保留依据' },
    { label: 'Agent', value: '清除 Agent 选择', previous: 'agent-1' },
    { label: '思考模式', value: '关闭', previous: '高' },
    { label: '运行时限', value: '不限时', previous: '120 秒' },
    { label: '执行规则', value: '每 90 分钟', previous: '工作日 09:30 · Asia/Shanghai' },
    { label: '间隔起点', value: '1970-01-01T00:00:00.000Z' },
    { label: '执行位置', value: '项目工作区 · 来源会话 workspace-source', previous: '已有会话 · existing-session' }
  ]))
  expect(result.sections).toHaveLength(2)
})

test('cron enable and pause keep the actual prior state and use explicit action labels', () => {
  for (const enabled of [false, true]) {
    const result = render('cron_update', preview('更新定时任务', { before: job, changes: { expectedRevision: job.revision, enabled } }))
    expect(result.confirmLabel).toBe(enabled ? '启用定时任务' : '暂停定时任务')
    expect(facts(result)).toContainEqual({ label: '计划状态', value: enabled ? '启用' : '暂停', previous: '启用' })
    expect(result.sections[0]).toMatchObject({ label: '执行设置', id: 'management-operation' })
    expect(result.destructive).toBe(false)
  }
})

test('cron deletion preserves the history and does not claim to cancel running jobs', () => {
  const result = render('cron_delete', preview('删除定时任务', job))
  expect(result).toMatchObject({ summary: job.name, destructive: true, confirmLabel: '删除定时任务' })
  expect(facts(result)).toContainEqual({ label: '任务 ID', value: job.id })
  expect(operation(result)).toBe('删除此定时任务并保留运行历史，不会停止已经开始的运行。')
  expect(result.sections.find(item => item.label === '任务指令')?.text).toBe(job.message)
})

test('invalid cron envelopes fall back without inventing previous values or legacy time zones', () => {
  const args = { id: job.id, cronExpr: '0 10 * * *' }
  for (const question of [preview('更新定时任务', { before: job, changes: { enabled: 'false', expectedRevision: 3 } }),
    preview('更新定时任务', { before: job, changes: { enabled: false, expectedRevision: 9 } }),
    preview('创建定时任务', { name: 'wrong action', message: 'wrong', configuration })]) {
    const result = render('cron_update', question, args)
    expect(result.summary).toBeUndefined()
    expect(facts(result)).toEqual([{ label: '任务 ID', value: job.id }, { label: 'Cron 规则', value: '0 10 * * *' }])
  }
  const invalid = render('cron_create', '说明', { name: '日报', message: '检查', configuration: { ...configuration, schedule: { kind: 'interval', everyMinutes: 0, anchorAt: 0 } } })
  expect(operation(invalid)).toContain('完整参数')
  expect(invalid.sections).toHaveLength(1)
})
