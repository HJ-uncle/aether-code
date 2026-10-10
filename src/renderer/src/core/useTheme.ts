/**
 * 主题应用
 *
 * 把设置里的 appearance / accent 落到 <html> 的 data 属性上，
 * 由 CSS（tokens.css）根据这两个属性切换整套令牌。
 *
 * 预设色与自定义色共用令牌：自定义色在此统一解析对比和悬停色，
 * 再注入 tokens.css 的变量，避免各组件自行配色。
 */
import { useEffect } from 'react'
import { DEFAULT_SETTINGS, type AccentColor, type Appearance } from '@shared/ipc'
import { accentForBackground, accentForeground, mixAccent, normalizeAccentHex } from '@shared/accent-color'
import { cssColor } from './theme/palette'

interface ThemeSettings {
  appearance: Appearance
  accent: AccentColor
  customAccentColor: string
}

export interface AccentPreviewSession {
  preview(color: string): void
  cancel(): void
  commit(): void
}

let actualTheme: ThemeSettings = {
  appearance: DEFAULT_SETTINGS.appearance,
  accent: DEFAULT_SETTINGS.accent,
  customAccentColor: DEFAULT_SETTINGS.customAccentColor
}
let activeAccentPreview: { color: string | null } | null = null

/** 系统当前是否偏好浅色（用于 appearance === 'system'） */
function systemPrefersLight(): boolean {
  return window.matchMedia('(prefers-color-scheme: light)').matches
}

/** 把设置解析成最终生效的外观：'system' 需要问一次系统 */
function resolveAppearance(appearance: Appearance): 'dark' | 'light' {
  if (appearance === 'system') return systemPrefersLight() ? 'light' : 'dark'
  return appearance
}

function apply(appearance: Appearance, accent: AccentColor, customAccentColor: string): void {
  const root = document.documentElement
  root.dataset.appearance = resolveAppearance(appearance)
  root.dataset.accent = accent
  if (accent === 'custom') {
    const color = normalizeAccentHex(customAccentColor) ?? DEFAULT_SETTINGS.customAccentColor
    const background = normalizeAccentHex(cssColor('--bg-surface'))
    const resolved = background ? accentForBackground(color, background) : color
    const foreground = accentForeground(resolved)
    root.style.setProperty('--custom-accent', resolved)
    // 悬停色朝文字色的反方向变化，避免临界亮度的按钮在 hover 时失去对比。
    root.style.setProperty('--custom-accent-hover', mixAccent(resolved, foreground === 'light' ? 'dark' : 'light', 0.12))
    root.style.setProperty('--custom-accent-rgb', [1, 3, 5].map((offset) => parseInt(resolved.slice(offset, offset + 2), 16)).join(', '))
    root.dataset.customAccent = color
    root.dataset.customAccentForeground = foreground
  } else {
    root.style.removeProperty('--custom-accent')
    root.style.removeProperty('--custom-accent-hover')
    root.style.removeProperty('--custom-accent-rgb')
    delete root.dataset.customAccent
    delete root.dataset.customAccentForeground
  }
  // 告诉原生层当前明暗，让标题栏按钮/滚动条跟随（Electron 不读 CSS 变量）
  root.style.colorScheme = root.dataset.appearance
}

function applyCurrentTheme(): void {
  const color = activeAccentPreview?.color
  if (color !== null && color !== undefined) {
    apply(actualTheme.appearance, 'custom', color)
  } else {
    apply(actualTheme.appearance, actualTheme.accent, actualTheme.customAccentColor)
  }
}

/** 预览只覆盖当前主题；设置仍是取消时恢复预设色或自定义色的唯一来源。 */
export function beginAccentPreview(): AccentPreviewSession {
  const session: { color: string | null } = { color: null }
  const replacedPreview = activeAccentPreview !== null
  activeAccentPreview = session
  if (replacedPreview) applyCurrentTheme()

  return {
    preview(color): void {
      if (activeAccentPreview !== session) return
      session.color = color
      applyCurrentTheme()
    },
    cancel(): void {
      // 卸载/StrictMode 的旧清理不得取消后来打开的色板。
      if (activeAccentPreview !== session) return
      activeAccentPreview = null
      applyCurrentTheme()
    },
    commit(): void {
      if (activeAccentPreview !== session) return
      // 调用方已成功保存，React 的设置更新会应用实色；此刻回刷会短暂显示旧色。
      activeAccentPreview = null
    }
  }
}

export function useTheme(appearance: Appearance, accent: AccentColor, customAccentColor: string): void {
  useEffect(() => {
    actualTheme = { appearance, accent, customAccentColor }
    applyCurrentTheme()
  }, [appearance, accent, customAccentColor])

  // 'system' 模式下监听系统切换：系统在运行中改了明暗，界面要跟着走。
  // 只在 system 模式挂监听，固定深/浅时不必空转。
  useEffect(() => {
    if (appearance !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = (): void => applyCurrentTheme()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [appearance])
}
