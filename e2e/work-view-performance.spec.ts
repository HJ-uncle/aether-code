/** Pure Work rendering boundaries: long-history anchors, complete page
 * coverage and pointer coordinates independent of React commit frequency. */
import { expect, test } from '@playwright/test'
import { WORK_ACTIVITY_PAGE_SIZE, WORK_MESSAGE_PAGE_SIZE, workMessageStart, workPageRange, workPaneRatio, workToolSnapshot } from '../src/renderer/src/contrib/work/work-view-performance'

test('正文流式帧复用工具派生列表，工具回执与消息增删仍立即更新', () => {
  const tools = [{ id: 'call-1', result: '' }]
  const initial = workToolSnapshot([{ tools }])
  expect(workToolSnapshot([{ tools }], initial)).toBe(initial)
  const receipt = { id: 'call-1', result: 'completed' }
  const updated = workToolSnapshot([{ tools: [receipt] }], initial)
  expect(updated).not.toBe(initial)
  expect(updated.tools).toEqual([receipt])
  expect(workToolSnapshot([{ tools }, { tools: [] }], initial)).not.toBe(initial)
  expect(workToolSnapshot([], updated).tools).toEqual([])
})

test('活动分页覆盖每条工具记录，缩短列表时夹紧页码且空列表不会产生非法范围', () => {
  const first = workPageRange(181, 0, WORK_ACTIVITY_PAGE_SIZE)
  const last = workPageRange(181, 2, WORK_ACTIVITY_PAGE_SIZE)
  expect(first).toEqual({ page: 0, pages: 3, start: 0, end: 80 })
  expect(last).toEqual({ page: 2, pages: 3, start: 160, end: 181 })
  const positions = Array.from({ length: first.pages }, (_, page) => workPageRange(181, page, WORK_ACTIVITY_PAGE_SIZE))
  expect(positions.flatMap(({ start, end }) => Array.from({ length: end - start }, (_, offset) => start + offset))).toEqual(Array.from({ length: 181 }, (_, index) => index))
  expect(workPageRange(4, 9, 80)).toEqual({ page: 0, pages: 1, start: 0, end: 4 })
  expect(workPageRange(0, -1, 80)).toEqual({ page: 0, pages: 1, start: 0, end: 0 })
})

test('长历史初次只挂载最近消息，流式追加与向前展开保持原阅读锚点', () => {
  const messages = Array.from({ length: 500 }, (_, index) => ({ id: `message-${index}` }))
  const start = workMessageStart(messages, null)
  expect(start).toBe(500 - WORK_MESSAGE_PAGE_SIZE)
  expect(messages.slice(start)).toHaveLength(WORK_MESSAGE_PAGE_SIZE)
  const anchor = messages[start].id
  const appended = [...messages, { id: 'new-reply' }]
  expect(workMessageStart(appended, anchor)).toBe(start)
  expect(workMessageStart(appended, messages[start - WORK_MESSAGE_PAGE_SIZE].id)).toBe(start - WORK_MESSAGE_PAGE_SIZE)
  expect(workMessageStart(messages.slice(450), anchor)).toBe(0)
  expect(workMessageStart([], anchor)).toBe(0)
})

test('拖动宽度由初始坐标计算，多个未提交事件不会丢失位移且不能越过布局边界', () => {
  expect(workPaneRatio(44, 100, 130, 1000)).toBe(47)
  expect(workPaneRatio(44, 100, 160, 1000)).toBe(50)
  expect(workPaneRatio(44, 100, -1000, 1000)).toBe(35)
  expect(workPaneRatio(44, 100, 3000, 1000)).toBe(62)
  expect(workPaneRatio(44, 100, 100, 0)).toBe(44)
})
