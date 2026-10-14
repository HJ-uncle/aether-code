/** Pure display contracts: decoded reads preserve content and never conceal unknown failures. */
import { test, expect } from '@playwright/test'
import { formatActivityValue, readActivityPreview } from '../src/renderer/src/contrib/work/work-activity-presentation'

const hash = 'a'.repeat(64)
const exact = { path: 'D:/synthetic/index.js', expectedHash: hash, encoding: 'utf-8', lineEnding: 'CRLF', utf8Bom: false,
  startLine: 1, endLine: 2, totalLines: 2, content: 'const answer = 42;\r\n' }
const tool = (result: string) => ({ name: 'read_file', state: 'done', result })
const monitor = `[读取监控] 耗时: 2ms | 原始大小: 18B | 压缩后: 18B | 压缩率: 0%\n[文件版本] ${JSON.stringify({ path: exact.path, expectedHash: hash })}\n[精确编辑] 展示行号和格式化内容不是原文；edit_file 前可用 mode="exact" 获取无行号 content。\n\n1. const answer = 42;\n`

test('exact read reveals real newlines and keeps its raw receipt unchanged', () => {
  const receipt = tool(JSON.stringify(exact))
  const before = receipt.result
  expect(readActivityPreview(receipt)).toEqual({ content: exact.content })
  expect(receipt.result).toBe(before)
  expect(JSON.parse(receipt.result).expectedHash).toBe(hash)
})

test('formatted read separates the recognized envelope from its existing body', () => {
  const receipt = tool(monitor)
  expect(readActivityPreview(receipt)).toEqual({ content: '1. const answer = 42;\n' })
  expect(receipt.result).toBe(monitor)
})

test('empty file is an explicit empty preview', () => {
  expect(readActivityPreview(tool(JSON.stringify({ ...exact, content: '' })))).toEqual({ content: '' })
})

for (const [name, receipt] of [
  ['failed result', { ...tool(JSON.stringify(exact)), state: 'error' }],
  ['running partial result', { ...tool(JSON.stringify(exact)), state: 'running' }],
  ['different tool', { ...tool(JSON.stringify(exact)), name: 'subagent' }],
  ['unknown error sibling', tool(JSON.stringify({ ...exact, error: 'cannot read' }))],
  ['invalid hash', tool(JSON.stringify({ ...exact, expectedHash: 'wrong' }))],
  ['invalid line range', tool(JSON.stringify({ ...exact, startLine: 3 }))],
  ['malformed monitor version', tool(monitor.replace(hash, 'wrong'))],
  ['ordinary text mentioning a monitor', tool(`ordinary text\n${monitor}`)],
  ['partial JSON', tool('{"path":')]
] as const) test(`${name} keeps the complete fallback`, () => {
  expect(readActivityPreview(receipt)).toBeNull()
})

test('pretty printing changes only a JSON presentation, never ordinary whitespace', () => {
  expect(formatActivityValue('{"x":1}')).toBe('{\n  "x": 1\n}')
  expect(formatActivityValue(' a\r\n b ')).toBe(' a\r\n b ')
})
