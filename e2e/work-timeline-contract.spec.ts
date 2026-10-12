/** Timeline compatibility: preserve mixed SSE order, avoid replay duplicates and
 * retain legacy messages; target summaries respect the Work task's workspace. */
import { expect, test } from '@playwright/test'
import type { ChatMessage, ToolActivity } from '../src/renderer/src/core/engine/useChat'
import { workMessageTimeline, workToolTarget } from '../src/renderer/src/contrib/work/work-message-timeline'

const tool = (id: string, hidden = false): ToolActivity => ({ id, name: 'read_file', args: '{"path":"plan.md"}', result: 'read', state: 'done', hidden })
const message = (patch: Partial<ChatMessage>): ChatMessage => ({ id: 'reply', role: 'assistant', content: '', thinking: '', tools: [], items: [], status: 'done', createdAt: 1, ...patch })

test('正文按引擎时间线分隔连续操作，隐藏控制帧与重复工具不会重复呈现', () => {
  const input = message({ content: '先看需求。开始开发。交付结果。', tools: [tool('a'), tool('hidden', true), tool('b'), tool('c')], items: [
    { kind: 'content', text: '先看需求。' }, { kind: 'thinking', text: 'internal' },
    { kind: 'tool', id: 'a' }, { kind: 'tool', id: 'hidden' }, { kind: 'tool', id: 'a' }, { kind: 'tool', id: 'b' },
    { kind: 'content', text: '开始开发。' }, { kind: 'tool', id: 'c' }, { kind: 'content', text: '交付结果。' }
  ] })
  const segments = workMessageTimeline(input)
  expect(segments.map(segment => segment.kind === 'content' ? segment.text : segment.tools.map(item => item.id))).toEqual([
    '先看需求。', ['a', 'b'], '开始开发。', ['c'], '交付结果。'
  ])
  expect(input.items).toHaveLength(9)
})

test('旧版历史没有时间线时仍保留工具回执与正文，用户文本不被内部时间线替换', () => {
  const legacy = workMessageTimeline(message({ content: '最终报告', tools: [tool('a'), tool('b')] }))
  expect(legacy.map(segment => segment.kind === 'content' ? segment.text : segment.tools.map(item => item.id))).toEqual([['a', 'b'], '最终报告'])
  const user = workMessageTimeline(message({ role: 'user', content: '原始输入', items: [{ kind: 'content', text: '不是用户原文' }] }))
  expect(user).toEqual([{ kind: 'content', key: 'content', text: '原始输入' }])
})

test('活动摘要不展示未完成 JSON，也不会把相似前缀目录误认为当前项目', () => {
  expect(workToolTarget({ ...tool('a'), args: '{"path":' })).toBe('')
  expect(workToolTarget({ ...tool('a'), args: JSON.stringify({ path: 'D:\\work\\project\\src\\index.ts' }) }, 'D:\\work\\project')).toBe('src/index.ts')
  expect(workToolTarget({ ...tool('a'), args: JSON.stringify({ path: 'D:/work/project-other/secret.txt' }) }, 'D:/work/project')).toBe('D:/work/project-other/secret.txt')
})
