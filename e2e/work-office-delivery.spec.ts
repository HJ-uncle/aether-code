/** Pure markdown/projection and server-rendered checklist regressions. These
 * fixtures never launch Electron, connect to an engine or alter user history. */
import { expect, test } from '@playwright/test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import type { EngineTodo } from '../src/shared/ipc'
import type { FinalResult } from '../src/shared/final-result'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
import { finalAnswerForMessage } from '../src/renderer/src/core/engine/final-result'
import { sessionDeliveryProse } from '../src/renderer/src/features/conversation/delivery-prose'
import { sessionMessagePresentation, sessionMessageTimeline } from '../src/renderer/src/features/conversation/message-timeline'
import { sessionMessageRunning } from '../src/renderer/src/features/conversation/tool-presentation'

let TodoProgress: typeof import('../src/renderer/src/features/conversation/TodoProgress').TodoProgress
let fixture = ''
test.beforeAll(async () => {
  // Playwright transforms imported JSX into its component-testing wire format.
  // Compile the real component normally for React SSR, without a browser host.
  const parent = resolve(__dirname, '../.e2e-tmp')
  mkdirSync(parent, { recursive: true })
  fixture = mkdtempSync(join(parent, 'office-delivery-ssr-'))
  const outfile = join(fixture, 'todo.cjs')
  await build({ entryPoints: [resolve(__dirname, '../src/renderer/src/features/conversation/TodoProgress.tsx')],
    outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react'] })
  TodoProgress = createRequire(__filename)(outfile).TodoProgress
})
test.afterAll(() => {
  if (!fixture) return
  if (!fixture.startsWith(join(resolve(__dirname, '../.e2e-tmp'), 'office-delivery-ssr-'))) throw new Error('Unexpected fixture path')
  rmSync(fixture, { recursive: true, force: true })
})

const context = { sessionId: 'work-office', workspaceRoot: 'D:/project' }
const names = ['2048 项目台账.xlsx', '2048 项目说明文档.docx', '2048 项目汇报.pptx']
const result: FinalResult = { schemaVersion: 1, sessionId: context.sessionId, turnId: 'turn', runId: 'root',
  assistantMessageId: 'assistant', publishedAt: 100, text: '', items: names.map((name, index) => ({
    id: `item-${index}`, assetId: `asset-${index}`, name, path: `交付/${name}`, kind: 'file',
    mimeType: 'application/octet-stream', size: 100, sha256: 'a'.repeat(64)
  })) }
const link = (index = 0, sessionId = context.sessionId): string =>
  `/api/v1/workspace/file/download?${new URLSearchParams({ sessionId, path: result.items[index].path })}`
const list = names.map((name, index) => `- [${name}](${link(index)})`).join('\n')
const prose = `三份文件已完成。\n\n${list}\n\n**Excel 台账**：6 张表、11 个公式。\n\n请核对 PPT 第 3 页。`

test('published Office cards replace only the duplicate download list, preserving manifest and source', () => {
  const manifest = { ...result, text: prose }, before = structuredClone(manifest)
  const displayed = sessionDeliveryProse(prose, manifest, context)
  expect(displayed).not.toContain('/api/v1/workspace/file/download')
  expect(displayed).toContain('三份文件已完成。')
  expect(displayed).toContain('**Excel 台账**：6 张表、11 个公式。')
  expect(displayed).toContain('请核对 PPT 第 3 页。')
  expect(manifest).toEqual(before)
  expect(sessionDeliveryProse(displayed, manifest, context)).toBe(displayed)
})

test('unpublished, empty, foreign-session and non-card views retain their only download entry', () => {
  for (const manifest of [undefined, { ...result, items: [] }, { ...result, sessionId: 'other' }]) {
    expect(sessionDeliveryProse(prose, manifest, context)).toBe(prose)
  }
  const foreign = `- [${names[0]}](${link(0, 'other')})`
  expect(sessionDeliveryProse(foreign, result, context)).toBe(foreign)
})

test('Windows exported answers remove the same list while preserving CRLF and mixed source newlines', () => {
  for (const [text, duplicateList] of [
    [prose.replace(/\n/g, '\r\n'), list.replace(/\n/g, '\r\n')],
    [prose.replace(/\n/g, '\r'), list.replace(/\n/g, '\r')],
    [`旧记录\r\n\r\n${prose}\r\n保留说明`, list]
  ]) {
    const displayed = sessionDeliveryProse(text, result, context)
    expect(displayed).toBe(text.replace(duplicateList, ''))
    expect(displayed).not.toContain('/api/v1/workspace/file/download')
    expect(displayed).toContain('**Excel 台账**：6 张表、11 个公式。')
    expect(displayed).toContain('请核对 PPT 第 3 页。')
  }
})

test('canonical manifest paths match relative downloads in the owning workspace, never just by filename', () => {
  const canonical = { ...result, items: result.items.map(item => ({ ...item, path: `d:\\PROJECT\\${item.path.replace(/\//g, '\\')}` })) }
  expect(sessionDeliveryProse(prose, canonical, context)).toBe(sessionDeliveryProse(prose, result, context))
  const sibling = { ...canonical, items: canonical.items.map(item => ({ ...item, path: item.path.replace('PROJECT', 'PROJECT-copy') })) }
  expect(sessionDeliveryProse(prose, sibling, context)).toBe(prose)
  expect(sessionDeliveryProse(prose, canonical, { sessionId: context.sessionId })).toBe(prose)
  const linux = { ...result, items: result.items.map(item => ({ ...item, path: `/project/${item.path}` })) }
  expect(sessionDeliveryProse(prose, linux, { ...context, workspaceRoot: '/project' })).not.toContain('/download?')
  expect(sessionDeliveryProse(prose, linux, { ...context, workspaceRoot: '/Project' })).toBe(prose)
})

test('semantic labels, instructions, code, quotes, task lists, tables and mixed lists remain readable', () => {
  const cases = [
    `- [查看测试风险](${link()})`,
    `- [${names[0]}](${link()})：包含测试风险。`,
    `- [${names[0]}](${link()} "包含测试风险")`,
    `- [${names[0]}](${link()})\n  - 核对公式后再评审。`,
    `- [x] [${names[0]}](${link()})`,
    `> - [${names[0]}](${link()})`,
    `\`\`\`md\n${list}\n\`\`\``,
    `| 文件 |\n| --- |\n| [${names[0]}](${link()}) |`,
    `${list}\n- [其他报告](交付/其他报告.xlsx)`,
    `下载 [${names[0]}](${link()}) 后检查第 2 页。`,
    `- [${names[0]}](https://unrelated.example${link()})`
  ]
  for (const text of cases) expect(sessionDeliveryProse(text, result, context), text).toBe(text)
})

test('verified local/API paths and reference links match exact manifest paths without rewriting surrounding text', () => {
  for (const href of [link(), `https://engine.example${link()}`, `<D:/project/${result.items[0].path}>`, `<${result.items[0].path}>`]) {
    const text = `before\n\n- [${names[0]}](${href})\n\nafter`
    expect(sessionDeliveryProse(text, result, context, 'https://engine.example')).toMatch(/^before\s+after$/)
  }
  const references = `[office]: ${link()}\n\n介绍\n\n- [${names[0]}][office]\n\n说明`
  expect(sessionDeliveryProse(references, result, context)).toBe(references.replace(`- [${names[0]}][office]`, ''))
})

test('stream and durable manifest converge to one answer, whose cards are the only bare download entry', () => {
  const message: ChatMessage = { id: 'assistant', role: 'assistant', runId: result.runId, conversationId: result.turnId,
    content: prose, thinking: '', tools: [], items: [{ kind: 'content', text: '正在校验。' }, { kind: 'content', text: prose }],
    createdAt: 1, status: 'streaming', finalResult: { ...result, text: prose },
    run: { schemaVersion: 1, sessionId: result.sessionId, runId: result.runId, turnId: result.turnId,
      userMessageId: 'user', assistantMessageId: 'assistant', seq: 1, version: 1, status: 'running', createdAt: 1, updatedAt: 2, pending: [] } }
  expect(finalAnswerForMessage(message, result.sessionId)).toBe(false)
  message.status = 'done'; message.run = { ...message.run!, status: 'succeeded' }
  const presentation = sessionMessagePresentation(sessionMessageTimeline(message), undefined,
    finalAnswerForMessage(message, result.sessionId), sessionMessageRunning(message))
  const answers = presentation.filter(segment => segment.kind === 'answer')
  expect(answers).toHaveLength(1)
  expect(sessionDeliveryProse(answers[0].text, result, context)).not.toContain('/download?')
  expect(JSON.stringify(presentation.filter(segment => segment.kind === 'process'))).not.toContain('/download?')
  expect(message.content).toBe(prose)
})

const todos: EngineTodo[] = Array.from({ length: 6 }, (_, index) => ({ id: `todo-${index}`,
  title: index === 5 ? '登记并交付三份文件' : `已验证步骤 ${index + 1}`, status: index === 5 ? 'in_progress' : 'done' }))

test('settled checklist preserves 5/6 truth and stops every spinner, including the collapsed detail DOM', () => {
  const before = structuredClone(todos)
  const html = renderToStaticMarkup(createElement(TodoProgress, { todos, running: false }))
  expect(html).toContain('5 / 6 已完成')
  expect(html).toContain('登记并交付三份文件 · 未确认完成')
  expect(html).toContain('data-status="in_progress"')
  expect(html).not.toContain('ui-spinner')
  expect(html).not.toContain('进行中')
  expect(todos).toEqual(before)
})

test('live checklist retains progress and reconciled completion removes the pending description', () => {
  const live = renderToStaticMarkup(createElement(TodoProgress, { todos, running: true }))
  expect(live).toContain('ui-spinner')
  expect(live).toContain('进行中')
  const completed = renderToStaticMarkup(createElement(TodoProgress, {
    todos: todos.map(todo => ({ ...todo, status: 'done' })), running: false
  }))
  expect(completed).toContain('6 / 6 已完成')
  expect(completed).not.toContain('未确认完成')
  expect(completed).not.toContain('ui-spinner')
})
