export interface ChartScale {
  ticks: number[]
  formatTick(value: number): string
  position(value: number): number
}

/** Normalize before subtracting so valid large Excel values cannot overflow
 * the SVG coordinates (for example a range from -1e308 to +1e308). */
export function spreadsheetChartScale(values: readonly (number | null)[], includeZero = true): ChartScale {
  const finite = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  let largest = 0
  for (const value of finite) largest = Math.max(largest, Math.abs(value))
  // A power of ten preserves physical 1/2/5 steps. Using the maximum value
  // itself would turn a range ending at 38 into ticks at 7.6, 15.2, etc.
  const unit = 10 ** Math.max(-308, Math.min(308, Math.floor(Math.log10(largest || 1))))
  let lower = includeZero || !finite.length ? 0 : Infinity
  let upper = includeZero || !finite.length ? 0 : -Infinity
  for (const value of finite) { lower = Math.min(lower, value / unit); upper = Math.max(upper, value / unit) }
  if (lower === upper) { lower -= 0.5; upper += 0.5 }
  const rawStep = (upper - lower) / 4
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const fraction = rawStep / magnitude
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude
  lower = Math.floor(lower / step) * step
  upper = Math.ceil(upper / step) * step
  const ticks: number[] = []
  for (let index = 0; index <= Math.round((upper - lower) / step); index++) {
    const normalized = lower + step * index
    const value = (Math.abs(normalized) < step * 1e-8 ? 0 : normalized) * unit
    const tick = Number.isFinite(value) ? value : Math.sign(value) * Number.MAX_VALUE
    // Preserve representable differences; rounding ticks to a fixed number of
    // significant digits can collapse a tightly zoomed scatter axis.
    if (ticks.at(-1) !== tick) ticks.push(tick)
  }
  const stepExponent = Math.log10(step) + Math.log10(unit)
  return { ticks, formatTick: value => spreadsheetChartNumber(value, stepExponent), position: value => Math.max(0, Math.min(1, (value / unit - lower) / (upper - lower))) }
}

/** Category centers are equally spaced, but their visible labels are not
 * equally wide. Keep short month names while sampling only actual collisions. */
export function spreadsheetChartLabelIndices(widths: readonly number[], span: number, gap = 12): number[] {
  if (!widths.length || !(span > 0)) return []
  const result: number[] = []
  let previousRight = -Infinity
  for (const [index, width] of widths.entries()) {
    const center = (index + 0.5) / widths.length * span
    if (center - width / 2 < previousRight + gap) continue
    result.push(index)
    previousRight = center + width / 2
  }
  return result
}

export interface ChartPoint { x: number; y: number; index: number; value: number }
export function spreadsheetChartSegments(values: readonly (number | null)[], x: (index: number) => number, y: (value: number) => number): ChartPoint[][] {
  const segments: ChartPoint[][] = []
  let current: ChartPoint[] = []
  for (const [index, value] of values.entries()) {
    if (value === null || !Number.isFinite(value)) { if (current.length) segments.push(current); current = []; continue }
    current.push({ x: x(index), y: y(value), index, value })
  }
  if (current.length) segments.push(current)
  return segments
}

export interface ChartSlice { index: number; start: number; end: number; ratio: number }
export function spreadsheetChartSlices(values: readonly (number | null)[]): ChartSlice[] {
  // A negative share has no truthful pie representation. Let the caller show
  // the unsupported message instead of dropping negative source values.
  if (values.some(value => value !== null && (!Number.isFinite(value) || value < 0))) return []
  let largest = 0
  for (const value of values) if (value !== null) largest = Math.max(largest, value)
  if (!largest) return []
  const total = values.reduce<number>((sum, value) => sum + (value === null ? 0 : value / largest), 0)
  let angle = -Math.PI / 2
  return values.flatMap((value, index) => {
    if (value === null || value <= 0) return []
    const ratio = value / largest / total, start = angle
    angle += ratio * Math.PI * 2
    return [{ index, start, end: angle, ratio }]
  })
}

export function spreadsheetChartArc(slice: ChartSlice, cx: number, cy: number, radius: number, innerRadius = 0): string {
  const point = (angle: number, size: number) => `${cx + Math.cos(angle) * size} ${cy + Math.sin(angle) * size}`
  // SVG's arc cannot draw a complete circle with identical endpoints.
  const full = slice.end - slice.start >= Math.PI * 2 - 1e-8
  const middle = (slice.start + slice.end) / 2
  const outside = full
    ? `M ${point(slice.start, radius)} A ${radius} ${radius} 0 1 1 ${point(middle, radius)} A ${radius} ${radius} 0 1 1 ${point(slice.end, radius)}`
    : `M ${point(slice.start, radius)} A ${radius} ${radius} 0 ${slice.ratio > 0.5 ? 1 : 0} 1 ${point(slice.end, radius)}`
  if (!innerRadius) return `${outside} L ${cx} ${cy} Z`
  return full
    ? `${outside} L ${point(slice.end, innerRadius)} A ${innerRadius} ${innerRadius} 0 1 0 ${point(middle, innerRadius)} A ${innerRadius} ${innerRadius} 0 1 0 ${point(slice.start, innerRadius)} Z`
    : `${outside} L ${point(slice.end, innerRadius)} A ${innerRadius} ${innerRadius} 0 ${slice.ratio > 0.5 ? 1 : 0} 0 ${point(slice.start, innerRadius)} Z`
}

export function spreadsheetChartNumber(value: number, stepExponent?: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value === 0) return '0'
  const absolute = Math.abs(value)
  if (absolute >= 1e7 || absolute < 0.001) {
    const precision = stepExponent === undefined ? 2 : Math.max(0, Math.min(16, Math.floor(Math.log10(absolute)) - Math.floor(stepExponent)))
    return value.toExponential(precision).replace(/(\.\d*?[1-9])0+e/, '$1e').replace(/\.0+e/, 'e')
  }
  const precision = stepExponent === undefined ? 4 : Math.max(0, Math.min(20, -Math.floor(stepExponent)))
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: precision }).format(value)
}
