import { useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { AccentColor, Appearance } from '@shared/ipc'
import { useApp } from '@renderer/core/app-context'
import { beginAccentPreview, type AccentPreviewSession } from '@renderer/core/useTheme'
import { useGraphicsSnapshot } from '@renderer/core/useVisualEffects'
import type { GraphicsMode, VisualEffects } from '@shared/graphics'
import { Icon } from '@renderer/workbench/icons'
import { Popover } from '@renderer/workbench/Popover'
import { AccentColorPicker } from './AccentColorPicker'
import {
  Segmented,
  SettingsContent,
  SettingsGroup,
  SettingsRow,
  SettingsStatusRow
} from './SettingsGroup'
import './settings-pages.css'

/**
 * 外观设置
 *
 * 对齐 macOS「系统设置 → 外观」：明暗模式分段选择 + 强调色色板。
 * 预设直接应用，自定义颜色先预览、完成后保存；关闭面板取消本次草稿。
 */

const APPEARANCES: { value: Appearance; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
]

const GRAPHICS: { value: GraphicsMode; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'enabled', label: '启用' },
  { value: 'software', label: '软件渲染' }
]
const EFFECTS: { value: VisualEffects; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'full', label: '完整' },
  { value: 'reduced', label: '精简' },
  { value: 'solid', label: '实色' }
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
  const graphics = useGraphicsSnapshot()
  const [graphicsError, setGraphicsError] = useState('')
  const { settings, updateSettings } = useApp()
  const [pickerOpen, setPickerOpen] = useState(false)
  const openerRef = useRef<HTMLButtonElement | null>(null)
  const previewRef = useRef<AccentPreviewSession | null>(null)
  const confirmingRef = useRef(false)
  const selectedAccent = pickerOpen ? 'custom' : settings.accent

  const cancelPicker = (): void => {
    if (confirmingRef.current) return
    previewRef.current?.cancel()
    previewRef.current = null
    setPickerOpen(false)
    openerRef.current?.focus({ preventScroll: true })
  }
  const openPicker = (): void => {
    if (previewRef.current) return
    previewRef.current = beginAccentPreview()
    previewRef.current.preview(settings.customAccentColor)
    setPickerOpen(true)
  }
  const confirmPicker = async (color: string): Promise<void> => {
    const preview = previewRef.current
    confirmingRef.current = true
    try {
      await updateSettings({ accent: 'custom', customAccentColor: color })
      preview?.commit()
      if (previewRef.current === preview) {
        previewRef.current = null
        setPickerOpen(false)
        openerRef.current?.focus({ preventScroll: true })
      }
    } finally {
      confirmingRef.current = false
    }
  }
  // 关闭设置页或切换分类同样取消预览，不能把临时颜色留在整个工作台。
  useLayoutEffect(
    () => () => {
      previewRef.current?.cancel()
      previewRef.current = null
    },
    []
  )

  return (
    <div className="settings-view settings-view--appearance">
      <SettingsGroup title="外观">
        <SettingsContent>
          <div className="sg-row-inline">
            <span className="sg__row-label">主题</span>
            <Segmented
              options={APPEARANCES}
              value={settings.appearance}
              onChange={(value) => void updateSettings({ appearance: value })}
            />
          </div>
        </SettingsContent>
      </SettingsGroup>

      <SettingsGroup
        title="强调色"
        footer="强调色作用于按钮、选中项与键盘焦点环，不改变正文与灰阶。自定义颜色会随外观适当调整明度，保证可读性。"
      >
        <SettingsContent className="accent-content">
          <div className="accent-grid" role="radiogroup" aria-label="强调色">
            {ACCENTS.map((item) => (
              <button
                key={item.value}
                type="button"
                role="radio"
                aria-checked={selectedAccent === item.value}
                aria-label={item.label}
                title={item.label}
                className={`accent-swatch${selectedAccent === item.value ? ' is-active' : ''}`}
                onClick={() => {
                  if (confirmingRef.current) return
                  cancelPicker()
                  void updateSettings({ accent: item.value })
                }}
              >
                <span className="accent-swatch__dot" style={{ background: item.swatch }} />
              </button>
            ))}
            <Popover
              width={320}
              align="end"
              flush
              label="自定义强调色"
              className="accent-color-popover"
              open={pickerOpen}
              onOpenChange={(open) => {
                if (open) openPicker()
                else cancelPicker()
              }}
              trigger={({ open }) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={selectedAccent === 'custom'}
                  aria-label="自定义颜色"
                  aria-haspopup="dialog"
                  aria-expanded={open}
                  title="自定义颜色"
                  className={`accent-swatch accent-swatch--custom${selectedAccent === 'custom' ? ' is-active' : ''}`}
                  onClick={(event) => {
                    openerRef.current = event.currentTarget
                  }}
                >
                  <span
                    className="accent-swatch__dot"
                    style={{ background: settings.customAccentColor }}
                  />
                  <span className="accent-swatch__label">自定义</span>
                </button>
              )}
            >
              <AccentColorPicker
                value={settings.customAccentColor}
                onPreview={(color) => previewRef.current?.preview(color)}
                onConfirm={confirmPicker}
                onCancel={cancelPicker}
              />
            </Popover>
          </div>
          {settings.accent === 'custom' && (
            <div className="custom-accent-summary">
              <span>{pickerOpen ? '已保存颜色' : '当前颜色'}</span>
              <button
                type="button"
                className="custom-accent-summary__edit"
                aria-label="编辑自定义强调色"
                aria-haspopup="dialog"
                aria-expanded={pickerOpen}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  openerRef.current = event.currentTarget
                  if (pickerOpen) cancelPicker()
                  else openPicker()
                }}
              >
                <span
                  className="custom-accent-summary__dot"
                  style={{ background: settings.customAccentColor }}
                />
                <code>{settings.customAccentColor.toUpperCase()}</code>
                <Icon name="pencil" size={12} />
              </button>
            </div>
          )}
        </SettingsContent>
      </SettingsGroup>

      <SettingsGroup
        title="图形与视觉效果"
        footer="图形加速在下次启动时生效。自动模式遇到启动异常后使用软件渲染；视觉效果立即生效，软件渲染或系统要求减少透明度时自动使用实色。"
      >
        <SettingsRow label="图形加速" description="自动模式优先使用显卡，异常后保留安全回退。">
          <Segmented
            options={GRAPHICS}
            value={settings.graphicsMode}
            onChange={(value) => {
              setGraphicsError('')
              void updateSettings({ graphicsMode: value }).catch((error) =>
                setGraphicsError(String(error))
              )
            }}
          />
        </SettingsRow>
        <SettingsRow
          label="视觉效果"
          description="精简模式只在小型浮层保留模糊；设置窗口始终使用实色。"
        >
          <Segmented
            options={EFFECTS}
            value={settings.visualEffects}
            onChange={(value) => {
              setGraphicsError('')
              void updateSettings({ visualEffects: value }).catch((error) =>
                setGraphicsError(String(error))
              )
            }}
          />
        </SettingsRow>
        <SettingsStatusRow
          label="当前渲染"
          value={graphics ? (graphics.hardwareAcceleration ? '硬件加速' : '软件渲染') : '正在检测'}
          detail={
            graphics?.restartRequired
              ? '重启应用后生效'
              : graphics?.environmentOverride
                ? '当前由启动配置指定'
                : undefined
          }
        />
        {graphics?.recovery && (
          <SettingsContent>
            <p>
              {graphics.recovery.reason === 'gpu-process-failed'
                ? '检测到图形进程异常，自动模式将在下次启动时使用软件渲染。'
                : '上次图形启动未完成，自动模式已保守回退。可重新尝试加速。'}
            </p>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setGraphicsError('')
                void window.aether.graphics
                  .resetRecovery()
                  .catch((error) => setGraphicsError(String(error)))
              }}
            >
              清除回退记录（重启后重试）
            </button>
          </SettingsContent>
        )}
        {graphicsError && (
          <SettingsContent>
            <p role="alert">{graphicsError}</p>
          </SettingsContent>
        )}
      </SettingsGroup>

      {/* 预览区：改完立刻能在这里看到强调色落到真实控件上的效果 */}
      <SettingsGroup title="预览">
        <SettingsContent>
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
        </SettingsContent>
      </SettingsGroup>
    </div>
  )
}
