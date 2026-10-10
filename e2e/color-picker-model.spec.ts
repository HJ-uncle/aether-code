/** 颜色面板纯逻辑：HEX/RGB/HSV 互转、主色定位、灰阶和输入边界，无 Electron 依赖。 */
import { expect, test } from '@playwright/test'
import { hexToHsv, hexToRgb, hsvToHex, rgbToHex } from '../src/renderer/src/contrib/settings/color-picker-model'

test('HSV 色相环的六个主色与 RGB 数值一致', () => {
  for (const [hex, h, rgb] of [
    ['#ff0000', 0, { r: 255, g: 0, b: 0 }],
    ['#ffff00', 60, { r: 255, g: 255, b: 0 }],
    ['#00ff00', 120, { r: 0, g: 255, b: 0 }],
    ['#00ffff', 180, { r: 0, g: 255, b: 255 }],
    ['#0000ff', 240, { r: 0, g: 0, b: 255 }],
    ['#ff00ff', 300, { r: 255, g: 0, b: 255 }]
  ] as const) {
    expect(hexToRgb(hex), hex).toEqual(rgb)
    expect(hexToHsv(hex), hex).toEqual({ h, s: 1, v: 1 })
    expect(hsvToHex({ h, s: 1, v: 1 })).toBe(hex)
  }
  expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe('#ff0000')
})

test('黑白灰没有饱和度，选择色相不会影响灰阶', () => {
  expect(hexToHsv('#000000')).toEqual({ h: 0, s: 0, v: 0 })
  expect(hexToHsv('#ffffff')).toEqual({ h: 0, s: 0, v: 1 })
  expect(hexToHsv('#808080')).toEqual({ h: 0, s: 0, v: 128 / 255 })
  expect(hsvToHex({ h: 240, s: 0, v: 0.5 })).toBe('#808080')
  expect(hsvToHex({ h: 120, s: 1, v: 0 })).toBe('#000000')
})

test('HEX 支持规范化简写并安全处理非法值', () => {
  expect(hexToRgb(' #AbC ')).toEqual({ r: 170, g: 187, b: 204 })
  expect(hsvToHex(hexToHsv(' #AbC '))).toBe('#aabbcc')
  for (const hex of ['', '#12', '#12345', '#12345678', '#zzzzzz', 'red', 'rgb(1,2,3)']) {
    expect(hexToRgb(hex), hex).toEqual({ r: 0, g: 0, b: 0 })
    expect(hexToHsv(hex), hex).toEqual({ h: 0, s: 0, v: 0 })
  }
})

test('RGB 夹紧并四舍五入，HSV 夹紧饱和度、明度和色相边界', () => {
  expect(rgbToHex({ r: -1, g: 127.5, b: 256 })).toBe('#0080ff')
  expect(rgbToHex({ r: NaN, g: Infinity, b: -Infinity })).toBe('#00ff00')
  expect(hsvToHex({ h: -120, s: 2, v: 2 })).toBe('#ff0000')
  expect(hsvToHex({ h: 420, s: 1, v: 1 })).toBe('#ff0000')
  expect(hsvToHex({ h: 120, s: -1, v: 1 })).toBe('#ffffff')
  expect(hsvToHex({ h: 120, s: 1, v: -1 })).toBe('#000000')
  expect(hsvToHex({ h: NaN, s: NaN, v: NaN })).toBe('#000000')
})

test('典型自定义色和分布于 RGB 立方体的色值往返不丢失精度', () => {
  for (const hex of ['#4b95f1', '#168a70', '#bf5af2', '#ff9f0a', '#010203', '#fefdfc']) {
    expect(rgbToHex(hexToRgb(hex)), hex).toBe(hex)
    expect(hsvToHex(hexToHsv(hex)), hex).toBe(hex)
  }
  for (const r of [0, 1, 64, 127, 128, 191, 254, 255]) {
    for (const g of [0, 1, 64, 127, 128, 191, 254, 255]) {
      for (const b of [0, 1, 64, 127, 128, 191, 254, 255]) {
        const hex = rgbToHex({ r, g, b })
        expect(hexToRgb(hex), hex).toEqual({ r, g, b })
        expect(hsvToHex(hexToHsv(hex)), hex).toBe(hex)
      }
    }
  }
})

test('HSV 中间色阶按 RGB 的字节精度往返', () => {
  for (const h of [15, 45, 90, 150, 210, 270, 330]) {
    const hsv = { h, s: 0.6, v: 0.8 }
    const actual = hexToHsv(hsvToHex(hsv))
    expect(Math.abs(actual.h - hsv.h)).toBeLessThan(1)
    expect(Math.abs(actual.s - hsv.s)).toBeLessThan(1 / 255)
    expect(Math.abs(actual.v - hsv.v)).toBeLessThan(1 / 255)
  }
})
