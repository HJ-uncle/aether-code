/** Pure geometry coverage: anchored overlays, modal backdrops, emulated viewport and host zoom. No Electron/window fixture. */
import { expect, test } from '@playwright/test'
import {
  overlapsBrowserSurface,
  projectBrowserSurfaceBounds,
  type BrowserSurfaceBounds
} from '../src/renderer/src/contrib/browser/browser-occlusion'

const surface: BrowserSurfaceBounds = { x: 500, y: 100, width: 700, height: 600 }

test('左栏用量浮层不应隐藏右栏网页，跨入网页的浮层必须让出原生视图', () => {
  const usage = { bounds: { x: 100, y: 200, width: 268, height: 220 }, visible: true }
  expect(overlapsBrowserSurface(surface, [usage])).toBe(false)
  expect(overlapsBrowserSurface(surface, [{ ...usage, bounds: { ...usage.bounds, x: 400 } }])).toBe(
    true
  )
})

test('只接触边缘、位于页面下方或隐藏的下拉菜单不遮挡网页', () => {
  expect(
    overlapsBrowserSurface(surface, [
      { bounds: { x: 232, y: 120, width: 268, height: 200 }, visible: true }
    ])
  ).toBe(false)
  expect(
    overlapsBrowserSurface(surface, [
      { bounds: { x: 550, y: 700, width: 200, height: 100 }, visible: true }
    ])
  ).toBe(false)
  expect(overlapsBrowserSurface(surface, [{ bounds: surface, visible: false }])).toBe(false)
})

test('全屏背景和真正模态对话框仍阻止原生网页越过遮罩接收交互', () => {
  const separateDialog = {
    bounds: { x: 10, y: 10, width: 300, height: 180 },
    visible: true,
    modal: true
  }
  expect(overlapsBrowserSurface(surface, [separateDialog])).toBe(true)
  expect(overlapsBrowserSurface(surface, [{ ...separateDialog, visible: false }])).toBe(false)
  expect(
    overlapsBrowserSurface(surface, [
      { bounds: { x: 0, y: 0, width: 1500, height: 900 }, visible: true }
    ])
  ).toBe(true)
})

test('关闭或尚未分配尺寸的页面不因浮层产生遮挡状态', () => {
  const overlay = { bounds: surface, visible: true, modal: true }
  expect(overlapsBrowserSurface({ ...surface, height: 0 }, [overlay])).toBe(false)
  expect(overlapsBrowserSurface({ ...surface, width: Number.NaN }, [overlay])).toBe(false)
  expect(overlapsBrowserSurface(surface, [{ ...overlay, bounds: { ...surface, width: 0 } }])).toBe(
    false
  )
})

test('自适应网页覆盖整个区域，手机投影留白上的浮层不应隐藏页面', () => {
  expect(projectBrowserSurfaceBounds(surface, null)).toEqual(surface)
  const phone = { width: 390, height: 844, mobile: true, deviceScaleFactor: 3 }
  const painted = projectBrowserSurfaceBounds(surface, phone)
  expect(painted).toEqual({ x: 712, y: 100, width: 277, height: 600 })
  expect(
    overlapsBrowserSurface(painted, [
      { bounds: { x: 520, y: 200, width: 180, height: 200 }, visible: true }
    ])
  ).toBe(false)
  expect(
    overlapsBrowserSurface(painted, [
      { bounds: { x: 700, y: 200, width: 180, height: 200 }, visible: true }
    ])
  ).toBe(true)
})

test('小视口不向上放大，下方留白不属于原生绘制区域', () => {
  const painted = projectBrowserSurfaceBounds(surface, {
    width: 320,
    height: 240,
    mobile: false,
    deviceScaleFactor: 1
  })
  expect(painted).toEqual({ x: 690, y: 100, width: 320, height: 240 })
  expect(
    overlapsBrowserSurface(painted, [
      { bounds: { x: 700, y: 350, width: 200, height: 100 }, visible: true }
    ])
  ).toBe(false)
})

test('宿主缩放与设备 DPR 分开：投影先转 DIP 再还原 CSS 坐标', () => {
  const viewport = { width: 800, height: 600, mobile: false, deviceScaleFactor: 2 }
  const painted = projectBrowserSurfaceBounds(surface, viewport, 2)
  expect(painted).toEqual({ x: 650, y: 100, width: 400, height: 300 })
  expect(
    overlapsBrowserSurface(painted, [
      { bounds: { x: 510, y: 150, width: 100, height: 200 }, visible: true }
    ])
  ).toBe(false)
  expect(projectBrowserSurfaceBounds(surface, { ...viewport, deviceScaleFactor: 1 }, 2)).toEqual(
    painted
  )
})
