/** Timeline compatibility: preserve mixed SSE order, avoid replay duplicates and
 * retain legacy messages; target summaries respect the Work task's workspace. */
import { expect, test } from '@playwright/test'
import type { ChatMessage, ToolActivity } from '../src/renderer/src/core/engine/useChat'
import { workMessageTimeline, workMessagePresentation, workToolTarget } from '../src/renderer/src/contrib/work/work-message-timeline'

const tool = (id: string, hidden = false): ToolActivity => ({ id, name: 'read_file', args: '{"path":"plan.md"}', result: 'read', state: 'done', hidden })
const message = (patch: Partial<ChatMessage>): ChatMessage => ({ id: 'reply', role: 'assistant', content: '', thinking: '', tools: [], items: [], status: 'done', createdAt: 1, ...patch })
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDdwAAAAASUVORK5CYII='

test('正文按引擎时间线分隔连续操作，隐藏控制帧与重复工具不会重复呈现', () => {
  const input = message({ content: '先看需求。开始开发。交付结果。', tools: [tool('a'), tool('hidden', true), tool('b'), tool('c')], items: [
    { kind: 'content', text: '先看需求。' }, { kind: 'thinking', text: 'internal' },
    { kind: 'tool', id: 'a' }, { kind: 'tool', id: 'hidden' }, { kind: 'tool', id: 'a' }, { kind: 'tool', id: 'b' },
    { kind: 'content', text: '开始开发。' }, { kind: 'tool', id: 'c' }, { kind: 'content', text: '交付结果。' }
  ] })
  const segments = workMessageTimeline(input)
  expect(segments.map(segment => segment.kind !== 'tools' ? segment.text : segment.tools.map(item => item.id))).toEqual([
    '先看需求。', 'internal', ['a', 'b'], '开始开发。', ['c'], '交付结果。'
  ])
  expect(input.items).toHaveLength(9)
})

test('旧版历史没有时间线时仍保留工具回执与正文，用户文本不被内部时间线替换', () => {
  const legacy = workMessageTimeline(message({ content: '最终报告', tools: [tool('a'), tool('b')] }))
  expect(legacy.map(segment => segment.kind !== 'tools' ? segment.text : segment.tools.map(item => item.id))).toEqual([['a', 'b'], '最终报告'])
  const user = workMessageTimeline(message({ role: 'user', content: '原始输入', items: [{ kind: 'content', text: '不是用户原文' }] }))
  expect(user).toEqual([{ kind: 'content', key: 'content', text: '原始输入' }])
})

test('工具截图留在过程且保留时间顺序，纯思考和旧历史不丢失', () => {
  const visual = { ...tool('image'), name: 'browser_screenshot', result: JSON.stringify({ filename: 'preview.png', dataUrl: png }) }
  // File receipts stay beside ordinary tool rows inside the process disclosure.
  const change = { ...tool('change'), change: { id: 'c', path: 'report.md', kind: 'write' as const, oldContent: null, newContent: 'report', status: 'pending' as const, createdAt: 1 } }
  const timeline = workMessageTimeline(message({ thinking: '先检查范围', tools: [tool('a'), change, visual], content: '已完成', items: [
    { kind: 'tool', id: 'a' }, { kind: 'tool', id: 'change' }, { kind: 'content', text: '已完成' }
  ] }))
  const presentation = workMessagePresentation(timeline)
  expect(presentation).toMatchObject([{ kind: 'process', segments: [{ kind: 'thinking', text: '先检查范围' },
    { kind: 'tools', tools: [{ id: 'a' }, { id: 'change' }] }, { kind: 'content', text: '已完成' },
    { kind: 'tools', tools: [visual] }] }])
  expect(presentation.some(segment => segment.kind === 'answer')).toBe(false)
  expect(presentation.some(segment => segment.kind === 'tool')).toBe(false)
  expect(presentation[0].kind === 'process' && presentation[0].segments[3].kind === 'tools' && presentation[0].segments[3].tools[0]).toBe(visual)
  expect(workMessagePresentation(workMessageTimeline(message({ thinking: '只有思考' })))).toMatchObject([{ kind: 'process', segments: [{ kind: 'thinking', text: '只有思考' }] }])
  expect(timeline.flatMap(segment => segment.kind === 'tools' ? segment.tools.map(item => item.id) : [])).toEqual(['a', 'change', 'image'])
})

test('导航等待和截图都按时间线归入过程，最终图文完整保留在回答里', () => {
  const navigate = { ...tool('navigate'), name: 'browser_navigate', result: JSON.stringify({ filename: 'navigate.png', dataUrl: png }) }
  const wait = { ...tool('wait'), name: 'browser_wait', result: JSON.stringify({
    tab: { title: '验收页面', url: 'https://example.test' }, text: '页面已就绪', elements: [], truncated: false,
    screenshot: { dataUrl: png, width: 1, height: 1 }
  }) }
  const screenshot = { ...tool('screenshot'), name: 'browser_screenshot', result: JSON.stringify({ filename: 'final.png', dataUrl: png }) }
  const answer = '页面已验证。\n\n![最终页面](images/final.png)\n\n全部检查通过。'
  const receipts = [navigate, wait, screenshot]
  const original = structuredClone(receipts)
  const presentation = workMessagePresentation(workMessageTimeline(message({ tools: receipts, content: answer, items: [
    { kind: 'content', text: '先打开页面。' }, { kind: 'tool', id: 'navigate' },
    { kind: 'content', text: '等待页面稳定。' }, { kind: 'tool', id: 'wait' }, { kind: 'tool', id: 'screenshot' },
    { kind: 'content', text: answer }
  ] })))
  expect(presentation).toMatchObject([
    { kind: 'process', segments: [
      { kind: 'content', text: '先打开页面。' }, { kind: 'tools', tools: [navigate] },
      { kind: 'content', text: '等待页面稳定。' }, { kind: 'tools', tools: [wait, screenshot] }
    ] },
    { kind: 'answer', text: answer }
  ])
  expect(presentation).toHaveLength(2)
  const groupedTools = presentation.flatMap(segment => segment.kind === 'process'
    ? segment.segments.flatMap(item => item.kind === 'tools' ? item.tools : []) : [])
  expect(groupedTools.map(item => item.id)).toEqual(['navigate', 'wait', 'screenshot'])
  groupedTools.forEach((receipt, index) => expect(receipt).toBe(receipts[index]))
  expect(receipts).toEqual(original)
})

test('活动摘要不展示未完成 JSON，也不会把相似前缀目录误认为当前项目', () => {
  expect(workToolTarget({ ...tool('a'), args: '{"path":' })).toBe('')
  expect(workToolTarget({ ...tool('a'), args: JSON.stringify({ path: 'D:\\work\\project\\src\\index.ts' }) }, 'D:\\work\\project')).toBe('src/index.ts')
  expect(workToolTarget({ ...tool('a'), args: JSON.stringify({ path: 'D:/work/project-other/secret.txt' }) }, 'D:/work/project')).toBe('D:/work/project-other/secret.txt')
})

test('纯文字浏览器读取与导航按原顺序留在过程里，不因页面元数据变成独立成果', () => {
  const read = { ...tool('read-page'), name: 'browser_read', result: JSON.stringify({
    tab: { title: '围棋 H5', url: 'aether-local://opaque-capability/index.html' }, text: '页面内容', elements: [], truncated: false
  }) }
  const navigate = { ...tool('navigate-page'), name: 'browser_navigate', args: '{"url":"file:///D:/project/%E5%9B%B4%E6%A3%8B.html"}' }
  const presentation = workMessagePresentation(workMessageTimeline(message({ tools: [read, navigate], content: '检查完成' })))
  expect(presentation).toMatchObject([
    { kind: 'process', segments: [{ kind: 'tools', tools: [{ id: 'read-page' }, { id: 'navigate-page' }] }] },
    { kind: 'answer', text: '检查完成' }
  ])
  expect(workToolTarget(read)).toBe('围棋 H5')
  expect(workToolTarget(navigate)).toBe('围棋.html')
  expect(workToolTarget({ ...navigate, args: '{"url":"https://example.test/private/path?token=internal"}' })).toBe('example.test')
})

test('浏览器URL型标题使用页面名或域名摘要，不暴露能力地址与本地路径', () => {
  const read = (title: string, url: string): ToolActivity => ({ ...tool('url-title'), name: 'browser_read', args: '{"tabId":"page"}',
    result: JSON.stringify({ tab: { title, url }, text: '页面内容', elements: [], truncated: false }) })
  const local = 'file:///D:/private/%E5%9B%B4%E6%A3%8B.html'
  const capability = 'aether-local://private-capability-id/nested/index.html?token=hidden'
  const remote = 'https://example.test/private/path?token=hidden'
  for (const title of [local, 'file:/D:/private/other.html', ' FILE:/D:/private/other.html ']) {
    expect(workToolTarget(read(title, local))).toBe('围棋.html')
  }
  for (const title of [capability, 'aether-local:/private-capability-id/other.html']) {
    expect(workToolTarget(read(title, capability))).toBe('index.html')
  }
  for (const title of [remote, 'https://other.test/private/path', 'https://example.test']) {
    expect(workToolTarget(read(title, remote))).toBe('example.test')
  }
  expect(workToolTarget(read('about:blank', 'about:blank'))).toBe('浏览器页面')
  expect(workToolTarget(read('', 'aether-local://private-capability-id/'))).toBe('本地页面')
  expect(workToolTarget(read('文件未标题', local))).toBe('文件未标题')
  expect(workToolTarget(read('周报: 项目进展', remote))).toBe('周报: 项目进展')
  expect(workToolTarget(read('报'.repeat(90), remote))).toBe(`${'报'.repeat(77)}…`)
})
