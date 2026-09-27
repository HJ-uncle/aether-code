/**
 * 主题取色与变更监听
 *
 * CSS 变量（tokens.css）是配色的唯一事实来源，但有些渲染目标吃不了 CSS 级联：
 * Monaco / xterm 的配色只能通过 JS API 传具体色值。这里提供两件事：
 *   1. cssVar()          —— 从 <html> 上读当前生效的令牌值
 *   2. watchTheme()      —— 订阅 data-appearance / data-accent 的变化
 *
 * 用 MutationObserver 而不是把 settings 逐层传进组件，原因有二：
 *   - 'system' 模式下系统明暗切换只改 data 属性，不经过任何 settings 变更，
 *     观察者是唯一能统一覆盖两种来源的接入点
 *   - 组件不需要感知 settings 的加载时序，data 属性写好即生效
 */

/** 读当前生效的 CSS 变量值（已 trim，返回 rgba() / hex 原文） */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/**
 * 读颜色令牌并归一化成 Monaco 可解析的 #RRGGBBAA。
 *
 * 关键坑：Monaco 的 Color.fromHex 对解析失败的输入静默回退成纯红色
 * （`parseHex(hex) || Color.red`），而 tokens 里 --bg-hover / --accent-soft /
 * --material-bg 等都是 rgba() 字符串 —— 直接喂给 Monaco 会整片变红
 * （光标行红条、词高亮红块全是这么来的）。这里把 rgba()/rgb() 统一转成
 * 8 位 hex；hex 原样返回，无法识别的值也原样返回（调用方自行兜底）。
 */
export function cssColor(name: string): string {
  const raw = cssVar(name)
  const m = raw.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,]+([\d.]+))?\s*\)$/)
  if (!m) return raw
  const byte = (v: string) => Number(v).toString(16).padStart(2, '0')
  const alpha =
    m[4] === undefined ? 'ff' : Math.round(Math.min(Math.max(parseFloat(m[4]), 0), 1) * 255).toString(16).padStart(2, '0')
  return `#${byte(m[1])}${byte(m[2])}${byte(m[3])}${alpha}`
}

/**
 * 给 6 位 hex 追加 alpha，返回 #RRGGBBAA。
 * Monaco/xterm 的部分内部消费（canvas 渲染、颜色解析）对 rgba() 字符串
 * 支持不全，透明度一律用 8 位 hex 最稳。tokens 约定强调色恒为 6 位 hex。
 */
export function withAlpha(hex: string, alpha: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? `${hex}${alpha}` : hex
}

/** 当前生效外观（useTheme 已把解析结果写到 <html> 上；未写入前按深色兜底） */
export function currentAppearance(): 'dark' | 'light' {
  return document.documentElement.dataset.appearance === 'light' ? 'light' : 'dark'
}

/**
 * 订阅主题变化：挂载时立即回调一次，之后 data 属性每次变化都会回调。
 * 返回退订函数。
 */
export function watchTheme(onChange: () => void): () => void {
  onChange()
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-appearance', 'data-accent']
  })
  return () => observer.disconnect()
}
