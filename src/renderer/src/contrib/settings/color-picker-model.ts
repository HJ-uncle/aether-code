import { normalizeAccentHex } from '../../../../shared/accent-color'

export type ColorHsv = { h: number; s: number; v: number }
export type ColorRgb = { r: number; g: number; b: number }

function clamp(value: number, minimum: number, maximum: number): number {
  return Number.isNaN(value) ? minimum : Math.min(maximum, Math.max(minimum, value))
}

export function hexToRgb(hex: string): ColorRgb {
  const normalized = normalizeAccentHex(hex) ?? '#000000'
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16)
  }
}

export function rgbToHex({ r, g, b }: ColorRgb): string {
  return `#${[r, g, b].map(channel =>
    Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, '0')
  ).join('')}`
}

export function hexToHsv(hex: string): ColorHsv {
  const rgb = hexToRgb(hex)
  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map(channel => channel / 255)
  const maximum = Math.max(r, g, b)
  const minimum = Math.min(r, g, b)
  const difference = maximum - minimum

  // 灰阶没有色相；面板保留上次有色的 hue，避免拖到灰阶后突然跳回红色。
  if (difference === 0) return { h: 0, s: 0, v: maximum }

  const sector = maximum === r
    ? (g - b) / difference
    : maximum === g
      ? (b - r) / difference + 2
      : (r - g) / difference + 4
  return {
    h: ((sector * 60) + 360) % 360,
    s: difference / maximum,
    v: maximum
  }
}

export function hsvToHex({ h, s, v }: ColorHsv): string {
  const hue = (clamp(h, 0, 360) % 360) / 60
  const saturation = clamp(s, 0, 1)
  const value = clamp(v, 0, 1)
  const chroma = value * saturation
  const secondary = chroma * (1 - Math.abs(hue % 2 - 1))
  const offset = value - chroma
  const channels = hue < 1 ? [chroma, secondary, 0]
    : hue < 2 ? [secondary, chroma, 0]
      : hue < 3 ? [0, chroma, secondary]
        : hue < 4 ? [0, secondary, chroma]
          : hue < 5 ? [secondary, 0, chroma]
            : [chroma, 0, secondary]
  return rgbToHex({
    r: (channels[0] + offset) * 255,
    g: (channels[1] + offset) * 255,
    b: (channels[2] + offset) * 255
  })
}
