/**
 * xterm 主题：从设计令牌取色
 *
 * 终端是「磨砂外壳里的一块画布」：背景必须与面板区同材质（--bg-surface），
 * 否则就是截图里那种"贴进来的纯黑砖"。前景/光标/选区跟随令牌，
 * 光标同样吃 --accent，与编辑器、全局焦点环保持一致的交互语义。
 *
 * ANSI 16 色取自 macOS 系统终端的配色体系，明暗两套：
 * 同一应用色相（红绿黄蓝紫青）在两种外观下用不同明度，保证 4.5:1 可读性。
 * xterm 会把颜色用于 canvas 绘制，因此只接受 hex / rgba，不碰 color-mix。
 */
import type { ITheme } from '@xterm/xterm'
import { cssVar, currentAppearance, withAlpha } from '@renderer/core/theme/palette'

/** 深色外观 ANSI（macOS 系统色 · Dark） */
const ANSI_DARK = {
  black: '#3a3a3c',
  red: '#ff453a',
  green: '#32d74b',
  yellow: '#ffd60a',
  blue: '#0a84ff',
  magenta: '#bf5af2',
  cyan: '#64d2ff',
  white: '#e5e5e7',
  brightBlack: '#6e6e73',
  brightRed: '#ff6961',
  brightGreen: '#5ce070',
  brightYellow: '#ffe14d',
  brightBlue: '#409cff',
  brightMagenta: '#d08bff',
  brightCyan: '#7cdfff',
  brightWhite: '#ffffff'
} satisfies Partial<ITheme>

/** 浅色外观 ANSI（macOS 系统色 · Light）：同色相压深保对比 */
const ANSI_LIGHT = {
  black: '#2b2b2e',
  red: '#d70015',
  green: '#1a7f37',
  yellow: '#b25000',
  blue: '#0071e3',
  magenta: '#8944ab',
  cyan: '#007fa3',
  white: '#98989d',
  brightBlack: '#6e6e73',
  brightRed: '#e0362c',
  brightGreen: '#249c47',
  brightYellow: '#cf7c00',
  brightBlue: '#1a82f0',
  brightMagenta: '#9c56bd',
  brightCyan: '#1d9cc4',
  brightWhite: '#ffffff'
} satisfies Partial<ITheme>

/** 按当前 <html> 令牌构建 xterm 主题。创建会话与主题变化时调用 */
export function buildTerminalTheme(): ITheme {
  const light = currentAppearance() === 'light'
  const accent = cssVar('--accent')
  const surface = cssVar('--bg-surface')

  return {
    background: surface,
    foreground: cssVar('--fg'),
    cursor: accent,
    // 光标是实心块时压在光标下的文字颜色：用画布色保证"镂空"观感
    cursorAccent: surface,
    selectionBackground: withAlpha(accent, light ? '40' : '59'),
    ...(light ? ANSI_LIGHT : ANSI_DARK)
  }
}
