/** Session-owned inline file names resolve from receipts only; no Electron, disk scan or network. */
import { expect, test } from '@playwright/test'
import { Marked } from 'marked'
import type { ChatMessage, ToolActivity } from '../src/renderer/src/core/engine/useChat'
import type { EngineFileChange } from '../src/shared/ipc'
import type { FinalResult } from '../src/shared/final-result'
import { buildSessionInlineFileResolver } from '../src/renderer/src/features/conversation/inline-file-references'

const sessionId = 'work-office'
const root = 'D:/tasks/office'
const names = ['2048-项目说明书.docx', '2048-项目台账.xlsx', '2048-项目汇报.pptx']
const tool = (path: string, extra: Partial<ToolActivity> = {}): ToolActivity => ({
  id: path, name: 'read_file', args: JSON.stringify({ path }), result: 'read successfully', state: 'done', ...extra
})
const message = (extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'assistant', role: 'assistant', content: '', thinking: '', tools: [], items: [], status: 'done', createdAt: 1, ...extra
})
const change = (path: string, extra: Partial<EngineFileChange> = {}): EngineFileChange => ({
  id: path, path, sessionId, kind: 'write', status: 'pending', oldContent: null, newContent: null, truncated: true, createdAt: 1, ...extra
})
const run = (owner = sessionId): NonNullable<ChatMessage['run']> => ({
  schemaVersion: 1, sessionId: owner, runId: 'root', turnId: 'turn', userMessageId: 'user', assistantMessageId: 'assistant',
  version: 1, seq: 1, status: 'succeeded', createdAt: 1, updatedAt: 2, pending: []
})
const finalResult = (): FinalResult => ({
  schemaVersion: 1, sessionId, turnId: 'turn', runId: 'root', assistantMessageId: 'assistant', text: '', publishedAt: 10,
  items: names.map((name, index) => ({ id: `item-${index}`, name, path: `${root}/交付/${name}`, assetId: `asset-${index}`,
    mimeType: 'application/octet-stream', size: 100, sha256: 'a'.repeat(64), kind: 'file' }))
})

test('three Office filenames resolve in table codespans without interpreting Markdown or scanning files', () => {
  const paths = names.map(name => `${root}/交付/${name}`)
  const resolve = buildSessionInlineFileResolver([message({ tools: paths.map(path => tool(path)) })], sessionId, root)
  const markdown = `| 文件 | 说明 |\n| --- | --- |\n${names.map(name => `| \`${name}\` | 已完成 |`).join('\n')}`
  const table = new Marked({ gfm: true }).lexer(markdown).find(token => token.type === 'table')
  if (!table || table.type !== 'table') throw new Error('Fixture must contain a Markdown table')
  const references = table.rows.flatMap(row => row.flatMap(cell => cell.tokens.filter(token => token.type === 'codespan').map(token => resolve(token.text))))
  expect(references).toEqual(paths)
  expect(resolve(markdown)).toBeUndefined()
  paths.forEach((path, index) => {
    expect(resolve(path)).toBe(path)
    expect(resolve(`交付/${names[index]}`)).toBe(path)
  })
})

test('only completed successful top-level path fields supply tool candidates', () => {
  const accepted = ['path', 'filePath', 'file_path', 'file'].map((key, index) => tool(`unused-${index}`, {
    args: JSON.stringify({ [key]: `交付/field-${index}.docx` })
  }))
  const rejected = ['running', 'error', 'unknown', 'cancelled', 'waiting', 'interrupted'].map(state =>
    tool(`${state}.docx`, { state: state as ToolActivity['state'] }))
  const resolve = buildSessionInlineFileResolver([message({ tools: [...accepted, ...rejected,
    tool('failed.docx', { error: 'read failed' }), tool('metadata-failed.docx', { metadata: { success: false } }),
    tool('unfinished.docx', { args: '{"path":"unfinished.docx"' }), tool('array.docx', { args: '[{"path":"array.docx"}]' }),
    tool('nested.docx', { args: '{"options":{"path":"nested.docx"}}' }),
    tool('result.docx', { args: '{}', result: '{"path":"result.docx"}' }),
    tool('command.docx', { name: 'execute_cmd', args: '{"command":"cat command.docx"}' }),
    tool('D:/folder', { name: 'list_directory' })
  ] })], sessionId, root)
  for (let index = 0; index < 4; index++) expect(resolve(`field-${index}.docx`)).toBe(`交付/field-${index}.docx`)
  for (const name of [...rejected.map(item => `${item.state}.docx`), 'failed.docx', 'metadata-failed.docx', 'unfinished.docx',
    'array.docx', 'nested.docx', 'result.docx', 'command.docx', 'folder']) expect(resolve(name), name).toBeUndefined()
})

test('explicit foreign message, tool and change ownership never enters the current index', () => {
  const ownChange = change(`${root}/own.docx`)
  const foreignChange = change(`${root}/foreign-change.docx`, { sessionId: 'other' })
  const resolve = buildSessionInlineFileResolver([
    message({ run: run('other'), tools: [tool('foreign-message.docx')] }),
    message({ role: 'user', run: run('other'), attachments: [{ path: 'foreign-upload.docx', name: 'foreign-upload.docx', size: 1, type: 'text/plain' }] }),
    message({ tools: [tool('foreign-args.docx', { args: '{"sessionId":"other","path":"foreign-args.docx"}' }),
      tool(foreignChange.path, { change: foreignChange }), tool('own.docx', { changes: [ownChange] })] })
  ], sessionId, root)
  for (const name of ['foreign-message.docx', 'foreign-upload.docx', 'foreign-args.docx', 'foreign-change.docx']) expect(resolve(name)).toBeUndefined()
  expect(resolve('own.docx')).toBe(ownChange.path)
  const isolated = buildSessionInlineFileResolver([message({ tools: [tool('elsewhere.docx')] })], 'other', '/other')
  expect(resolve('elsewhere.docx')).toBeUndefined()
  expect(isolated('own.docx')).toBeUndefined()
})

test('typed writes, legacy primary receipts and original attachment names retain their actual paths', () => {
  const attachedPath = 'uploads/uuid-原始 报告.docx'
  const resolve = buildSessionInlineFileResolver([
    message({ role: 'user', attachments: [{ path: attachedPath, name: '原始 报告.docx', type: 'application/octet-stream', size: 50 }] }),
    message({ tools: [tool('unused', { args: '{}', change: change(`${root}/README`),
      changes: [change(`${root}/交付/result.xlsx`)] })] })
  ], sessionId, root)
  expect(resolve('原始 报告.docx')).toBe(attachedPath)
  expect(resolve('uuid-原始 报告.docx')).toBe(attachedPath)
  expect(resolve('README')).toBe(`${root}/README`)
  expect(resolve('交付/result.xlsx')).toBe(`${root}/交付/result.xlsx`)
})

test('only a fully bound successful manifest contributes published files', () => {
  const published = message({ run: run(), runId: 'root', conversationId: 'turn', finalResult: finalResult() })
  const resolve = buildSessionInlineFileResolver([published], sessionId, root)
  names.forEach((name, index) => expect(resolve(name)).toBe(published.finalResult!.items[index].path))
  for (const invalid of [
    { ...published, status: 'streaming' as const }, { ...published, run: run('other') },
    { ...published, finalResult: { ...finalResult(), sessionId: 'other' } },
    { ...published, finalResult: { ...finalResult(), assistantMessageId: 'different' } },
    { ...published, run: { ...run(), status: 'failed' as const } }
  ]) expect(buildSessionInlineFileResolver([invalid], sessionId, root)(names[0])).toBeUndefined()
})

test('duplicate canonical paths remain unique while genuinely different same-name files stay ambiguous', () => {
  const first = `${root}/a/Report.docx`
  const resolve = buildSessionInlineFileResolver([message({ tools: [tool(first), tool('d:\\TASKS\\OFFICE\\a\\REPORT.docx'),
    tool('a/./Report.docx')] })], sessionId, root)
  expect(resolve('report.DOCX')).toBe(first)
  expect(resolve('A\\REPORT.docx')).toBe(first)
  const ambiguous = buildSessionInlineFileResolver([message({ tools: [tool(first), tool(`${root}/b/report.docx`)] })], sessionId, root)
  expect(ambiguous('Report.docx')).toBeUndefined()
  expect(ambiguous('a/Report.docx')).toBe(first)
  expect(ambiguous('b/report.docx')).toBe(`${root}/b/report.docx`)
  const rootDuplicate = buildSessionInlineFileResolver([message({ tools: [tool('Report.docx'), tool('b/Report.docx')] })], sessionId, root)
  expect(rootDuplicate('Report.docx')).toBeUndefined()
  expect(rootDuplicate('./Report.docx')).toBe('Report.docx')
})

test('Linux preserves case while Windows drive and UNC paths normalize slash and case', () => {
  const linux = buildSessionInlineFileResolver([message({ tools: [tool('/project/Report.docx'), tool('/project/report.docx')] })], sessionId, '/project')
  expect(linux('Report.docx')).toBe('/project/Report.docx')
  expect(linux('report.docx')).toBe('/project/report.docx')
  expect(linux('REPORT.docx')).toBeUndefined()
  expect(linux('/Project/Report.docx')).toBeUndefined()
  const unc = '\\\\Server\\Share\\Docs\\Report.docx'
  const resolve = buildSessionInlineFileResolver([message({ tools: [tool(unc)] })], sessionId, '\\\\server\\share')
  expect(resolve('//SERVER/SHARE/DOCS/report.DOCX')).toBe(unc)
  expect(resolve('docs/report.docx')).toBe(unc)
})

test('paths with URL-sensitive and Markdown-sensitive filename characters remain literal', () => {
  const name = "设计 #1 50% & [终版] (A+B) '说明'.docx"
  const path = `${root}/资料/${name}`
  const resolve = buildSessionInlineFileResolver([message({ tools: [tool(path)] })], sessionId, root)
  expect(resolve(name)).toBe(path)
  expect(resolve(`资料/${name}`)).toBe(path)
  expect(resolve(encodeURIComponent(name))).toBeUndefined()
  expect(resolve(`${name}#page=1`)).toBeUndefined()
})

test('unknown names, code, URLs and transcript prose never create candidates', () => {
  const resolve = buildSessionInlineFileResolver([message({ content: '`guessed.docx` [report](guessed.xlsx)',
    tools: [tool('known.docx'), tool('https://example.test/remote.docx'), tool('javascript:alert.docx')] })], sessionId, root)
  for (const value of ['guessed.docx', 'guessed.xlsx', 'missing.docx', 'console.log(file)', 'const file = "known.docx"',
    '`known.docx`', 'https://example.test/known.docx', 'file:///D:/known.docx', 'javascript:alert.docx', 'remote.docx',
    'known.docx\n', 'known.docx\u0000']) expect(resolve(value), value).toBeUndefined()
  expect(resolve('known.docx')).toBe('known.docx')
})

test('deleted and reverted receipts withdraw older arguments, with later writes restoring availability', () => {
  const path = `${root}/report.docx`
  const written = change(path, { id: 'write', createdAt: 1 })
  const deleted = change(path, { id: 'delete', kind: 'delete', createdAt: 2 })
  const history = [message({ tools: [tool(path, { change: written }), tool(path, { name: 'delete_file', change: deleted })] })]
  expect(buildSessionInlineFileResolver(history, sessionId, root)('report.docx')).toBeUndefined()
  const restored = change(path, { id: 'rewrite', createdAt: 3 })
  expect(buildSessionInlineFileResolver([...history, message({ tools: [tool(path, { change: restored })] })], sessionId, root)('report.docx')).toBe(path)
  const reverted = { ...written, status: 'reverted' as const }
  expect(buildSessionInlineFileResolver([message({ tools: [tool(path, { changes: [reverted], change: written })] })], sessionId, root)('report.docx')).toBeUndefined()
  expect(buildSessionInlineFileResolver([message({ tools: [tool(path, { change: written }), tool(path, { change: reverted })] })], sessionId, root)('report.docx')).toBeUndefined()
})

test('later successful reads and reverted deletes preserve evidence that a file still exists', () => {
  const path = `${root}/report.docx`
  const deleted = change(path, { kind: 'delete', createdAt: 2 })
  const history = message({ tools: [tool(path), tool(path, { name: 'delete_file', change: deleted }), tool(path)] })
  expect(buildSessionInlineFileResolver([history], sessionId, root)('report.docx')).toBe(path)
  const reverted = message({ tools: [tool(path), tool(path, { name: 'delete_file', change: { ...deleted, status: 'reverted' } })] })
  expect(buildSessionInlineFileResolver([reverted], sessionId, root)('report.docx')).toBe(path)
  const legacy = message({ tools: [tool(path), tool(path, { name: 'delete_file' })] })
  expect(buildSessionInlineFileResolver([legacy], sessionId, root)('report.docx')).toBeUndefined()
  const legacyAfterWrite = message({ tools: [tool(path, { change: change(path) }), tool(path, { name: 'delete_file' })] })
  expect(buildSessionInlineFileResolver([legacyAfterWrite], sessionId, root)('report.docx')).toBeUndefined()
})

test('resolver identity survives streaming-only updates and canonical duplicates but changes with scope or candidates', () => {
  const ownedTool = tool(`${root}/result.docx`)
  const messages = [message({ tools: [ownedTool] })]
  const first = buildSessionInlineFileResolver(messages, sessionId, root)
  const updated = [message({ tools: [ownedTool], content: 'next streaming token', status: 'streaming' })]
  expect(buildSessionInlineFileResolver(updated, sessionId, root, first)).toBe(first)
  expect(buildSessionInlineFileResolver([message({ tools: [ownedTool, tool('d:\\TASKS\\office\\result.docx')] })], sessionId, root, first)).toBe(first)
  expect(buildSessionInlineFileResolver(updated, 'other', root, first)).not.toBe(first)
  expect(buildSessionInlineFileResolver(updated, sessionId, '/other', first)).not.toBe(first)
  const added = buildSessionInlineFileResolver([message({ tools: [ownedTool, tool('new.docx')] })], sessionId, root, first)
  expect(added).not.toBe(first)
  expect(added('new.docx')).toBe('new.docx')
  ownedTool.args = JSON.stringify({ path: 'changed.docx' })
  const mutated = buildSessionInlineFileResolver([message({ tools: [ownedTool] })], sessionId, root, first)
  expect(mutated('changed.docx')).toBe('changed.docx')
  expect(mutated('result.docx')).toBeUndefined()
})

test('text-only streaming updates compare message evidence without touching old tool arguments', () => {
  let reads = 0
  const ownedTool = tool('stable.docx')
  Object.defineProperty(ownedTool, 'args', { get: () => { reads++; return '{"path":"stable.docx"}' } })
  const tools = [ownedTool]
  const first = buildSessionInlineFileResolver([message({ tools, content: 'first', status: 'streaming' })], sessionId, root)
  const before = reads
  const second = buildSessionInlineFileResolver([message({ tools, content: 'first next token', status: 'streaming' })], sessionId, root, first)
  expect(second).toBe(first)
  expect(reads).toBe(before)
  expect(second('stable.docx')).toBe('stable.docx')
})
