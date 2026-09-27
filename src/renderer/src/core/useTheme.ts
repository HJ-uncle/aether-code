/**
 * 主题应用
 *
 * 把设置里的 appearance / accent 落到 <html> 的 data 属性上，
 * 由 CSS（tokens.css）根据这两个属性切换整套令牌。
 *
 * 之所以用 data 属性而不是往 style 里内联具体颜色值：
 *   1. 颜色全部留在 CSS，渲染层不需要知道"强调色具体是什么色号"
 *   2. 可以复用 prefers-color-scheme 媒体查询实现「跟随系统」
 *   3. 切换主题只改一个属性，浏览器自动重算受影响的变量继承链
 */
import { useEffect } from 'react'
import type { AccentColor, Appearance } from '@shared/ipc'

/** 系统当前是否偏好浅色（用于 appearance === 'system'） */
function systemPrefersLight(): boolean {
  return window.matchMedia('(prefers-color-scheme: light)').matches
}

/** 把设置解析成最终生效的外观：'system' 需要问一次系统 */
function resolveAppearance(appearance: Appearance): 'dark' | 'light' {
  if (appearance === 'system') return systemPrefersLight() ? 'light' : 'dark'
  return appearance
}

function apply(appearance: Appearance, accent: AccentColor): void {
  const root = document.documentElement
  root.dataset.appearance = resolveAppearance(appearance)
  root.dataset.accent = accent
  // 告诉原生层当前明暗，让标题栏按钮/滚动条跟随（Electron 不读 CSS 变量）
  root.style.colorScheme = root.dataset.appearance
}

export function useTheme(appearance: Appearance, accent: AccentColor): void {
  useEffect(() => {
    apply(appearance, accent)
  }, [appearance, accent])

  // 'system' 模式下监听系统切换：系统在运行中改了明暗，界面要跟着走。
  // 只在 system 模式挂监听，固定深/浅时不必空转。
  useEffect(() => {
    if (appearance !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = (): void => apply(appearance, accent)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [appearance, accent])
}
