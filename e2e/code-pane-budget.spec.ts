/** Pure layout allocation: the content region survives narrow windows and stored preferences remain intact. */
import { test, expect } from '@playwright/test'
import { codePaneBudget, type CodePaneRequest } from '../src/renderer/src/workbench/code-pane-budget'

const limits = { sidebarMin: 200, sidebarMax: 640, chatPanelMin: 280, chatPanelMax: 800 }
const request = (patch: Partial<CodePaneRequest> = {}): CodePaneRequest => ({ width: 940, chromeWidth: 62,
  sidebarVisible: true, sidebarWidth: 280, chatPanelVisible: true, chatPanelWidth: 380, ...patch })

test('940px leaves at least 320px for the editor or browser with both panes open', () => {
  const source = request()
  const before = { ...source }
  const budget = codePaneBudget(source, limits)
  expect(budget.mainMin).toBe(320)
  expect(budget.sidebarWidth).toBeGreaterThanOrEqual(200)
  expect(budget.chatPanelWidth).toBeGreaterThanOrEqual(280)
  expect(source.width - source.chromeWidth - budget.sidebarWidth - budget.chatPanelWidth).toBeGreaterThanOrEqual(320)
  expect(source).toEqual(before)
})

test('widening restores requested widths rather than saving temporary shrinkage', () => {
  const stored = request({ sidebarWidth: 640, chatPanelWidth: 800 })
  const narrow = codePaneBudget(stored, limits)
  expect(narrow.sidebarWidth).toBeLessThan(stored.sidebarWidth)
  const wide = codePaneBudget({ ...stored, width: 1900 }, limits)
  expect(wide.sidebarWidth).toBe(640)
  expect(wide.chatPanelWidth).toBe(800)
  expect(stored.sidebarWidth).toBe(640)
  expect(stored.chatPanelWidth).toBe(800)
})

for (const width of [940, 1100, 1440]) for (const sidebarVisible of [false, true]) for (const chatPanelVisible of [false, true]) {
  test(`budget ${width}px sidebar=${sidebarVisible} chat=${chatPanelVisible}`, () => {
    const source = request({ width, sidebarVisible, chatPanelVisible, sidebarWidth: 640, chatPanelWidth: 800 })
    const budget = codePaneBudget(source, limits)
    expect(budget.sidebarWidth + budget.chatPanelWidth + budget.mainMin + source.chromeWidth).toBeLessThanOrEqual(width)
    if (sidebarVisible) {
      expect(budget.sidebarWidth).toBeGreaterThanOrEqual(limits.sidebarMin)
      expect(budget.sidebarWidth).toBeLessThanOrEqual(limits.sidebarMax)
    } else expect(budget.sidebarWidth).toBe(0)
    if (chatPanelVisible) {
      expect(budget.chatPanelWidth).toBeGreaterThanOrEqual(limits.chatPanelMin)
      expect(budget.chatPanelWidth).toBeLessThanOrEqual(limits.chatPanelMax)
    } else expect(budget.chatPanelWidth).toBe(0)
  })
}

test('an unmeasured hidden Code surface preserves requested pane widths', () => {
  const budget = codePaneBudget(request({ width: Infinity }), limits)
  expect(budget.sidebarWidth).toBe(280)
  expect(budget.chatPanelWidth).toBe(380)
})

test('invalid saved sizes use finite bounds without producing NaN', () => {
  const budget = codePaneBudget(request({ sidebarWidth: NaN, chatPanelWidth: Infinity, chromeWidth: NaN }), limits)
  expect(budget.sidebarWidth).toBe(200)
  expect(budget.chatPanelWidth).toBe(280)
  expect(budget.mainMin).toBe(320)
})
