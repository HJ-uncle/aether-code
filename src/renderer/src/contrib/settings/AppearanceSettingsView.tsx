import type { JSX } from 'react'
import type { AccentColor, Appearance } from '@shared/ipc'
import { useApp } from '@renderer/core/app-context'

/**
 * 外观设置
 *
 * 对齐 macOS「系统设置 → 外观」：明暗模式三选一 + 强调色色板。
 * 改动即时生效（不做「保存」按钮）——外观类设置立刻能看到结果，
 * 这也是 HIG 的做法；其余需要重启引擎的配置才走显式保存。
 */

const APPEARANCES: { value: Appearance; label: string; hint: string }[] = [
  { value: 'system', label: '跟随系统', hint: '随 macOS 的明暗设置自动切换' },
  { value: 'light', label: '浅色', hint: '始终使用亮色界面' },
  { value: 'dark', label: '深色', hint: '始终使用暗色界面' }
]

/**
 * 强调色色板。
 * 这里的色号只用于「预览圆点」本身，实际配色由 tokens.css 的
 * [data-accent='*'] 覆盖块决定 —— 两处必须保持同步，故放在一起便于对照。
 */
const ACCENTS: { value: AccentColor; label: string; swatch: string }[] = [
  { value: 'blue', label: '蓝色', swatch: '#0a84ff' },
  { value: 'purple', label: '紫色', swatch: '#bf5af2' },
  { value: 'pink', label: '粉色', swatch: '#ff375f' },
  { value: 'orange', label: '橙色', swatch: '#ff9f0a' },
  { value: 'green', label: '绿色', swatch: '#32d74b' },
  { value: 'graphite', label: '石墨', swatch: '#8e8e93' }
]

export function AppearanceSettingsView(): JSX.Element {
  const { settings, updateSettings } = useApp()

  return (
    <div className="settings-view">
      <fieldset className="field">
        <legend>外观</legend>
        {APPEARANCES.map((item) => (
          <label className="field__radio" key={item.value}>
            <input
              type="radio"
              name="appearance"
              checked={settings.appearance === item.value}
              onChange={() => void updateSettings({ appearance: item.value })}
            />
            <span>
              {item.label}
              <small>{item.hint}</small>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="field">
        <span className="field__label">强调色</span>
        <div className="accent-grid" role="radiogroup" aria-label="强调色">
          {ACCENTS.map((item) => (
            <button
              key={item.value}
              type="button"
              role="radio"
              aria-checked={settings.accent === item.value}
              aria-label={item.label}
              title={item.label}
              className={`accent-swatch${settings.accent === item.value ? ' is-active' : ''}`}
              onClick={() => void updateSettings({ accent: item.value })}
            >
              <span className="accent-swatch__dot" style={{ background: item.swatch }} />
            </button>
          ))}
        </div>
        <p className="field__hint">
          强调色作用于按钮、选中项与键盘焦点环，不改变正文与灰阶。
        </p>
      </div>

      {/* 预览区：改完立刻能在这里看到强调色落到真实控件上的效果 */}
      <div className="field">
        <span className="field__label">预览</span>
        <div className="theme-preview">
          <button type="button" className="btn btn--primary">
            主要操作
          </button>
          <button type="button" className="btn">
            次要操作
          </button>
          <span className="chip is-active">选中标签</span>
          <span className="chip">普通标签</span>
        </div>
      </div>
    </div>
  )
}
