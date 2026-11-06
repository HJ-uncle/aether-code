/** Pure Work conversation geometry: real distance from the latest content,
 * fractional-DPR rounding, hidden panes and layout changes while reading. */
import { expect, test } from '@playwright/test'
import { workConversationAwayFromBottom } from '../src/renderer/src/contrib/work/work-conversation-scroll'

test('短内容、恰好填满和 1px 舍入差异不需要回到最新', () => {
  for (const scrollHeight of [240, 600, 601]) {
    expect(workConversationAwayFromBottom({ scrollHeight, clientHeight: 600, scrollTop: 0 }),
      `内容高度 ${scrollHeight} 不应误报离开底部`).toBe(false)
  }
})

test('只有真实溢出且距底部至少 70px 才需要回到最新', () => {
  const viewport = { scrollHeight: 1_200, clientHeight: 600 }
  expect(workConversationAwayFromBottom({ ...viewport, scrollTop: 0 })).toBe(true)
  expect(workConversationAwayFromBottom({ ...viewport, scrollTop: 530 })).toBe(true)
  expect(workConversationAwayFromBottom({ ...viewport, scrollTop: 530.25 })).toBe(false)
  expect(workConversationAwayFromBottom({ ...viewport, scrollTop: 600 })).toBe(false)
})

test('滚动位置越界不会凭空增加底部距离或误报已贴底的内容', () => {
  // Negative offsets can occur during overscroll; they must not turn a short
  // remaining distance into an apparent page of unread content.
  expect(workConversationAwayFromBottom({ scrollHeight: 650, clientHeight: 600, scrollTop: -100 })).toBe(false)
  expect(workConversationAwayFromBottom({ scrollHeight: 601, clientHeight: 600, scrollTop: -100 })).toBe(false)
  expect(workConversationAwayFromBottom({ scrollHeight: 1_200, clientHeight: 600, scrollTop: -100 })).toBe(true)
  expect(workConversationAwayFromBottom({ scrollHeight: 1_200, clientHeight: 600, scrollTop: 750 })).toBe(false)
})

test('隐藏面板的零高度不能确认当前位置是否离开最新', () => {
  expect(workConversationAwayFromBottom({ scrollHeight: 0, clientHeight: 0, scrollTop: 0 })).toBeNull()
  expect(workConversationAwayFromBottom({ scrollHeight: 1_200, clientHeight: 0, scrollTop: 300 })).toBeNull()
})

test('暂停阅读的位置不变时，内容折叠或视口增大会消除回到最新提示', () => {
  const reading = { scrollHeight: 1_200, clientHeight: 600, scrollTop: 300 }
  expect(workConversationAwayFromBottom(reading)).toBe(true)
  expect(workConversationAwayFromBottom({ ...reading, scrollHeight: 900 })).toBe(false)
  expect(workConversationAwayFromBottom({ ...reading, clientHeight: 900 })).toBe(false)
  // A later expansion can put the latest content offscreen again without
  // requiring the user's paused follow intent or reading position to change.
  expect(workConversationAwayFromBottom({ ...reading, clientHeight: 900, scrollHeight: 1_600 })).toBe(true)
})
