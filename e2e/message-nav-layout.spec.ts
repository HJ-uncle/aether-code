/** Pure geometry coverage: centre-out navigation, narrow panes and long histories. */
import { expect, test } from '@playwright/test'
import { messageNavPanelLayout } from '../src/renderer/src/contrib/chat/message-nav'

test('消息导航以侧边中心展开，短列表不占满阅读区', () => {
  const panel = messageNavPanelLayout({ left: 220, right: 250, top: 360, bottom: 396 },
    { left: 220, right: 1200, top: 80, bottom: 720 }, 3)
  expect(panel.left).toBeGreaterThanOrEqual(250)
  expect(panel.top + panel.height / 2).toBe(378)
  expect(panel.originY).toBe(panel.height / 2)
  expect(panel.height).toBeLessThan(300)
})

test('长历史面板限制在窄阅读区，中心仍落在面板内部', () => {
  const bounds = { left: 78, right: 274, top: 70, bottom: 254 }
  const panel = messageNavPanelLayout({ left: 54, right: 84, top: 144, bottom: 180 }, bounds, 110)
  expect(panel.left).toBeGreaterThanOrEqual(bounds.left)
  expect(panel.left + panel.width).toBeLessThanOrEqual(bounds.right)
  expect(panel.top).toBeGreaterThanOrEqual(bounds.top)
  expect(panel.top + panel.height).toBeLessThanOrEqual(bounds.bottom)
  expect(panel.width).toBeGreaterThan(150)
  expect(panel.top + panel.originY).toBe(162)
})

test('靠近阅读区上下边界时夹取位置而不丢失展开原点', () => {
  const bounds = { left: 10, right: 900, top: 60, bottom: 700 }
  for (const center of [80, 680]) {
    const panel = messageNavPanelLayout({ left: 10, right: 40, top: center - 18, bottom: center + 18 }, bounds, 40)
    expect(panel.top).toBeGreaterThanOrEqual(bounds.top)
    expect(panel.top + panel.height).toBeLessThanOrEqual(bounds.bottom)
    expect(panel.top + panel.originY).toBe(center)
    expect(panel.height).toBeGreaterThan(300)
  }
})
