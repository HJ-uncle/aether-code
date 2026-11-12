/** Pure general-tool approval presentation: exact argv, file changes, HTTP
 * parameters, recursive unknown values and unchanged approval replies. */
import { expect, test } from '@playwright/test'
import { normalizePending, buildToolResponse } from '../src/renderer/src/core/engine/pending'
import { permissionPresentation, type PermissionPresentation, type PermissionValueNode } from '../src/renderer/src/features/interactions/permission-presentation'

function render(toolName: string, args: Record<string, unknown>, question = '请核对本次操作。'): PermissionPresentation {
  const pending = normalizePending({ permissionRequest: { requestId: 'generic-approval', toolName, description: question, args } })!
  const original = JSON.stringify(pending)
  const result = permissionPresentation(pending)
  expect(JSON.stringify(pending)).toBe(original)
  expect(result.raw).toBe(`${question}\n\n原始调用参数\n${JSON.stringify(args, null, 2)}`)
  for (const output of ['approved', 'rejected'])
    expect(buildToolResponse(pending, [output])).toEqual({ toolCallId: 'generic-approval', name: toolName, output })
  return result
}
const section = (result: PermissionPresentation, id: string) => result.sections.find(item => item.id === id)
const child = (node: PermissionValueNode | undefined, label: string) => node?.children?.find(item => item.label === label)

test('execute_cmd keeps the program, ordered argv and working directory separately visible', () => {
  const script = 'const fs = require("node:fs");\r\n' + 'console.log("完整脚本 🤖");\n'.repeat(450)
  const args = { command: 'node', args: ['-e', script, '', '  exact space  ', 'a&b|c>out', '$value', '"literal quotes"'], cwd: 'mcp-test-server', timeoutMs: 15000, background: false }
  const result = render('execute_cmd', args)
  expect(result.kind).toBe('tool')
  expect(section(result, 'command')).toEqual({ id: 'command', label: '程序', text: 'node', code: true })
  expect(section(result, 'command-arguments')).toEqual({ id: 'command-arguments', label: '启动参数', items: args.args, code: true })
  expect(result.fields).toEqual([
    { label: '工作目录', value: 'mcp-test-server' }, { label: '超时', value: '15000 毫秒' }, { label: '运行方式', value: '前台运行' }
  ])
  expect(section(result, 'command')?.text).not.toContain('-e')
  expect(section(result, 'arguments')).toBeUndefined()
})

test('execute_cmd distinguishes missing, empty and malformed argv without adding defaults', () => {
  const missing = render('execute_cmd', { command: 'node' })
  expect(missing.fields).toEqual([])
  expect(section(missing, 'command-arguments')).toBeUndefined()
  const empty = render('execute_cmd', { command: 'node', args: [], background: true })
  expect(section(empty, 'command-arguments')).toMatchObject({ text: '无参数', items: [] })
  expect(empty.fields).toEqual([{ label: '运行方式', value: '后台运行' }])
  const malformed = render('execute_cmd', { command: 'node', args: ['-e', false, null] })
  expect(section(malformed, 'command-arguments')?.items).toBeUndefined()
  expect(section(malformed, 'command-arguments')?.tree?.[0]).toEqual({ label: 'args', kind: 'array', children: [
    { label: '第 1 项', kind: 'string', value: '-e' }, { label: '第 2 项', kind: 'boolean', value: 'false' }, { label: '第 3 项', kind: 'null', value: 'null' }
  ] })
})

test('command aliases remain independent text and cannot be stitched into an executable command', () => {
  const result = render('custom_command', { command: 'program', cmd: 'second input', script: 'third input\n', args: ['--flag'] })
  expect(result.sections.filter(item => item.code).map(item => item.text)).toEqual(['program', 'second input', 'third input\n'])
  expect(new Set(result.sections.map(item => item.id)).size).toBe(result.sections.length)
  expect(result.kind).toBeUndefined()
})

test('write_file preserves exact source and actual file conditions without a guessed old version', () => {
  const data = '\uFEFF完整文本\r\n尾部空格  \r\n\r\n'
  const result = render('write_file', { path: 'reports/说明.txt', data, expectedHash: 'missing', createOnly: true, trailingNewline: 'preserve' })
  expect(result.fields).toEqual([
    { label: '文件路径', value: 'reports/说明.txt' }, { label: '文件版本', value: '要求文件不存在' },
    { label: '仅新建', value: '是' }, { label: '尾部换行', value: '保持原样' }
  ])
  expect(section(result, 'write-content')).toEqual({ id: 'write-content', label: '写入内容', text: data, code: true })
  expect(result.sections.every(item => item.previous === undefined)).toBe(true)
  expect(result.destructive).toBe(false)
})

test('write_file content alias and empty source stay explicit and complete', () => {
  for (const content of ['', ' {"this":"stays a string"} \n']) {
    const result = render('write_file', { path: 'a.txt', content })
    expect(section(result, 'write-content-alias')).toEqual({ id: 'write-content-alias', label: '写入内容（content）', text: content, code: true })
    expect(section(result, 'write-content')).toBeUndefined()
  }
  const both = render('write_file', { path: 'a.txt', content: 'legacy', data: 'current' })
  expect(section(both, 'write-content')?.text).toBe('current')
  expect(section(both, 'write-content-alias')?.text).toBe('legacy')
})

test('write_file displays structured data and byte-copy source as trees, not fabricated file text', () => {
  const data = { title: '报告', enabled: false, rows: [['A', 0], ['B', null]], empty: {} }
  const result = render('write_file', { path: 'report.json', data })
  expect(section(result, 'write-content')?.text).toBeUndefined()
  expect(child(section(result, 'write-content')?.tree?.[0], 'enabled')).toEqual({ label: 'enabled', kind: 'boolean', value: 'false' })
  const copyFrom = { path: 'source.docx', expectedHash: `sha256:${'a'.repeat(64)}` }
  const copy = render('write_file', { path: 'copy.docx', copyFrom })
  expect(section(copy, 'copy-source')?.tree?.[0]).toEqual({ label: '复制来源', kind: 'object', children: [
    { label: 'path', kind: 'string', value: copyFrom.path }, { label: 'expectedHash', kind: 'string', value: copyFrom.expectedHash }
  ] })
  expect(section(copy, 'write-content')).toBeUndefined()
  expect(copy.fields.some(field => field.label === '文件版本')).toBe(false)
})

test('edit_file presents each exact replacement independently, including deletion and invalid entries', () => {
  const hash = `sha256:${'b'.repeat(64)}`
  const edits = [
    { oldText: '\uFEFF原文\r\n', newText: '\uFEFF更新\r\n', extra: { note: '未来字段' } },
    { oldText: '删除此段  ', newText: '' },
    { oldText: '缺少替换内容' }
  ]
  const result = render('edit_file', { path: 'main.ts', expectedHash: hash, edits })
  expect(result.fields).toEqual([{ label: '文件路径', value: 'main.ts' }, { label: '文件版本', value: hash }])
  expect(section(result, 'edit-1')).toMatchObject({ label: '修改 1', previous: edits[0].oldText, text: edits[0].newText, code: true })
  expect(section(result, 'edit-2')).toEqual({ id: 'edit-2', label: '修改 2', previous: edits[1].oldText, text: '', code: true })
  expect(section(result, 'edit-3')?.previous).toBeUndefined()
  expect(section(result, 'edit-3')?.tree?.[0]).toMatchObject({ kind: 'object', children: [{ label: 'oldText', kind: 'string', value: '缺少替换内容' }] })
  expect(section(result, 'edit-1')?.tree?.[0].label).toBe('extra')
})

test('file batches preserve order, per-file paths, structured content and copy metadata', () => {
  const files = [{ path: 'first.txt', data: 'first\n' }, { path: 'second.json', data: { value: 0 } }, { path: 'copy.bin', copyFrom: { path: 'original.bin', expectedHash: 'original-version' } }]
  const result = render('write_file', { files })
  const tree = section(result, 'files')?.tree
  expect(section(result, 'files')?.label).toBe('批量写入')
  expect(tree?.map(item => item.label)).toEqual(['文件 1', '文件 2', '文件 3'])
  expect(tree?.map(item => child(item, '文件路径')?.value)).toEqual(files.map(item => item.path))
  expect(child(tree?.[0], '写入内容')?.value).toBe('first\n')
  expect(child(child(tree?.[1], '写入内容'), 'value')?.value).toBe('0')
  expect(child(child(tree?.[2], '复制来源'), 'path')?.value).toBe('original.bin')
  expect(result.fields).toEqual([])
})

test('read_file shows requested range and explicit batch boundaries without pretending to mutate files', () => {
  const result = render('read_file', { path: 'README.md', mode: 'exact', start_line: 3, end_line: 10, start_column: 2 })
  expect(result.fields).toEqual([
    { label: '文件路径', value: 'README.md' }, { label: '读取方式', value: 'exact' }, { label: '起始行', value: '3' }, { label: '结束行', value: '10' }, { label: '起始列', value: '2' }
  ])
  expect(result.destructive).toBe(false)
  expect(result.sections).toEqual([])
  expect(section(render('read_file', { files: [{ path: 'a.md' }, { path: 'b.md' }] }), 'files')?.label).toBe('批量读取')
})

test('delete_file names the actual recycle-bin behavior and directory creation stays separate', () => {
  const deletion = render('delete_file', { path: 'report.docx' })
  expect(deletion.destructive).toBe(true)
  expect(deletion.confirmLabel).toBe('移入回收站')
  expect(section(deletion, 'file-operation')?.text).toBe('将文件移入系统回收站。')
  const creation = render('create_dir', { path: 'reports/2026' })
  expect(creation.destructive).toBe(false)
  expect(creation.fields).toEqual([{ label: '目录路径', value: 'reports/2026' }])
  expect(section(creation, 'file-operation')?.text).toBe('创建指定目录及缺少的父目录。')
})

test('HTTP requests expose headers, exact body, authentication and only explicitly supplied options', () => {
  const body = '{"title":"保留原样", "list":[0,false]}\r\n'
  const args = { url: 'https://example.test/resource', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Empty': '' }, body,
    auth: { type: 'bearer', token: 'fixture-token' }, timeout: 0, followRedirects: false, responseType: 'json' }
  const result = render('http_request', args)
  expect(result.fields).toEqual([
    { label: '网址', value: args.url }, { label: '请求方法', value: 'POST' }, { label: '超时', value: '不限时' },
    { label: '跟随重定向', value: '否' }, { label: '响应格式', value: 'json' }
  ])
  expect(section(result, 'http-body')).toEqual({ id: 'http-body', label: '请求内容', text: body, code: true })
  expect(child(section(result, 'http-headers')?.tree?.[0], 'X-Empty')?.value).toBe('')
  expect(child(section(result, 'http-auth')?.tree?.[0], 'type')?.value).toBe('bearer')
  expect(render('http_request', { url: args.url }).fields).toEqual([{ label: '网址', value: args.url }])
})

test('unknown values retain recursive structure, duplicate values, empty containers and original types', () => {
  const args = JSON.parse('{"unknown":{"empty":"","zero":0,"no":false,"nil":null,"array":[],"object":{},"nested":["same","same",{"value":"{not parsed}"}]},"constructor":"literal","__proto__":{"safe":"value"}}')
  const result = render('custom_tool', args)
  const nodes = section(result, 'arguments')?.tree
  expect(section(result, 'arguments')?.text).toBeUndefined()
  expect(nodes?.map(item => item.label)).toEqual(['unknown', 'constructor', '__proto__'])
  expect(nodes?.[0].children?.slice(0, 6)).toEqual([
    { label: 'empty', kind: 'string', value: '' }, { label: 'zero', kind: 'number', value: '0' },
    { label: 'no', kind: 'boolean', value: 'false' }, { label: 'nil', kind: 'null', value: 'null' },
    { label: 'array', kind: 'array', children: [] }, { label: 'object', kind: 'object', children: [] }
  ])
  expect(child(nodes?.[0], 'nested')?.children?.map(item => item.label)).toEqual(['第 1 项', '第 2 项', '第 3 项'])
  expect(result.fields).toEqual([])
})

test('unrecognized lookalike tools receive no file operation semantics or destructive state', () => {
  for (const toolName of ['mcp__server__delete_file', 'delete_file_extra', 'custom_write_file']) {
    const result = render(toolName, { path: 'important.txt', data: 'text', edits: [{ oldText: 'before', newText: 'after' }] })
    expect(result.kind).toBeUndefined()
    expect(result.destructive).toBe(false)
    expect(result.confirmLabel).toBe('允许执行')
    expect(section(result, 'file-operation')).toBeUndefined()
    expect(section(result, 'arguments')?.tree?.map(item => item.label)).toEqual(['data', 'edits'])
  }
})

test('human reasons stay available while an exact repeated argument payload stays in raw details', () => {
  const args = { command: 'node', args: ['-e', 'console.log("test")'] }
  const reason = '需确认后执行。\n\n' + '完整解释。'.repeat(120)
  const detailed = render('execute_cmd', args, `安全策略拦截了此操作，是否允许执行？\n原因：${reason}`)
  expect(section(detailed, 'description')?.text).toBe(reason)
  expect(detailed.reason).toBeUndefined()
  const duplicate = render('execute_cmd', args, JSON.stringify(args, null, 2))
  expect(section(duplicate, 'description')).toBeUndefined()
  expect(duplicate.reason).toBeUndefined()
  const different = render('execute_cmd', args, JSON.stringify({ advisory: '检查路径' }))
  expect(different.reason).toBe('{"advisory":"检查路径"}')
})
