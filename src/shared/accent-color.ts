/** 只接受不透明 hex，避免任意 CSS 字符串进入主题令牌或持久化配置。 */
export function normalizeAccentHex(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const hex = value.trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex
  if (/^#[0-9a-f]{3}$/.test(hex)) {
    return `#${hex.slice(1).split('').map((digit) => digit + digit).join('')}`
  }
  return null
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

/** 选择对比度更高的黑/白文字；色值本身仍由 tokens.css 定义。 */
export function accentForeground(hex: string): 'dark' | 'light' {
  const value = luminance(hex)
  return (value + 0.05) / 0.05 >= 1.05 / (value + 0.05) ? 'dark' : 'light'
}

export function mixAccent(hex: string, target: 'dark' | 'light', amount: number): string {
  const endpoint = target === 'light' ? 255 : 0
  return `#${[1, 3, 5].map((offset) => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16)
    return Math.round(channel + (endpoint - channel) * amount).toString(16).padStart(2, '0')
  }).join('')}`
}

/** 颜色既用于填充也用于文字/边框；只调整对当前背景不足 3:1 的颜色。 */
export function accentForBackground(hex: string, background: string): string {
  const backdrop = luminance(background)
  const target = backdrop > 0.179 ? 'dark' : 'light'
  for (let step = 0; step <= 255; step++) {
    const candidate = mixAccent(hex, target, step / 255)
    const value = luminance(candidate)
    const contrast = (Math.max(value, backdrop) + 0.05) / (Math.min(value, backdrop) + 0.05)
    if (contrast >= 3) return candidate
  }
  return hex
}
