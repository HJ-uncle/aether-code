/** 自定义强调色纯逻辑：输入边界、明度调整与 WCAG 对比度，不依赖 Electron。 */
import { expect, test } from '@playwright/test'
import { accentForBackground, accentForeground, normalizeAccentHex } from '../src/shared/accent-color'

function luminance(hex: string): number {
  const rgb = parseInt(hex.slice(1), 16)
  const linear = [rgb >> 16, (rgb >> 8) & 255, rgb & 255].map(channel => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}

function contrast(a: string, b: string): number {
  const first = luminance(a), second = luminance(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

test('仅接收完整不透明 HEX，并规范化简写、大小写和空格', () => {
  expect(normalizeAccentHex(' #AbC ')).toBe('#aabbcc')
  expect(normalizeAccentHex('#168A70')).toBe('#168a70')
  for (const input of [null, 123, '', '#12', '#12345', '#12345678', '#zzzzzz', 'red', 'rgb(0,0,0)', 'var(--accent)', 'url(example)']) {
    expect(normalizeAccentHex(input), String(input)).toBeNull()
  }
})

test('调整不可见颜色，保留已有对比度的原色', () => {
  for (const background of ['#fafafa', '#28282b']) {
    for (const color of ['#000000', '#ffffff', '#ffff00', '#00ff00', '#0000ff', '#168a70', '#777777']) {
      const effective = accentForBackground(color, background)
      expect(effective).toMatch(/^#[0-9a-f]{6}$/)
      expect(contrast(effective, background), `${color} 在 ${background}`).toBeGreaterThanOrEqual(3)
      if (contrast(color, background) >= 3) expect(effective).toBe(color)
    }
  }
})

test('按钮前景在深浅和中间色阶上达到文字对比度', () => {
  for (let channel = 0; channel <= 255; channel += 17) {
    for (const color of [`#${channel.toString(16).padStart(2, '0').repeat(3)}`, '#ffff00', '#168a70', '#bf5af2']) {
      const foreground = accentForeground(color) === 'dark' ? '#000000' : '#ffffff'
      expect(contrast(color, foreground), color).toBeGreaterThanOrEqual(4.5)
    }
  }
})
