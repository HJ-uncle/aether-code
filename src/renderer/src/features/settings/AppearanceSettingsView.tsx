import { useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { AccentColor, Appearance } from '@shared/ipc'
import { useApp } from '@renderer/core/app-context'
import { beginAccentPreview, type AccentPreviewSession } from '@renderer/core/useTheme'
import { useGraphicsSnapshot } from '@renderer/core/useVisualEffects'
import type { GraphicsMode, VisualEffects } from '@shared/graphics'
import { Icon } from '@renderer/ui/icons'
import { Popover } from '@renderer/ui/Popover'
import { AccentColorPicker } from './AccentColorPicker'
import {
  SettingsGroup,
  SettingsRow,
  SettingsContent,
  SettingsDisclosure,
  Segmented,
  Toggle
} from './SettingsGroup'
import './settings-pages.css'
import './appearance-settings.css'

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
  const [appearanceError, setAppearanceError] = useState('')
  const [resettingRecovery, setResettingRecovery] = useState(false)
  const [recoveryNotice, setRecoveryNotice] = useState('')
  const [previewSelected, setPreviewSelected] = useState(false)
  const [previewEnabled, setPreviewEnabled] = useState(true)
  const [previewStatus, setPreviewStatus] = useState('可试用按钮与开关')
  const { settings, updateSettings } = useApp()
  const [pickerOpen, setPickerOpen] = useState(false)
  const openerRef = useRef<HTMLButtonElement | null>(null)
  const previewRef = useRef<AccentPreviewSession | null>(null)
  const confirmingRef = useRef(false)
  const selectedAccent = pickerOpen ? 'custom' : settings.accent

  const resetRecovery = async (): Promise<void> => {
    if (resettingRecovery) return
    setResettingRecovery(true)
    setGraphicsError('')
    setRecoveryNotice('')
    try {
      await window.aether.graphics.resetRecovery()
      setRecoveryNotice('已清除回退记录；图形加速设置将在下次启动时应用。')
    } catch (error) {
      setGraphicsError(String(error))
    } finally {
      setResettingRecovery(false)
    }
  }

  const cancelPicker = (restoreFocus = true): void => {
    if (confirmingRef.current) return
    previewRef.current?.cancel()
    previewRef.current = null
    setPickerOpen(false)
    if (restoreFocus) openerRef.current?.focus({ preventScroll: true })
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
      <SettingsGroup title="外观" ariaLabel="外观">
        <SettingsRow label="主题" ariaLabel="主题">
          <Segmented
            options={APPEARANCES}
            value={settings.appearance}
            onChange={(value) => {
              setAppearanceError('')
              void updateSettings({ appearance: value }).catch((error) =>
                setAppearanceError(String(error))
              )
            }}
          />
        </SettingsRow>
        <SettingsRow label="强调色" description="按钮、选中项与焦点">
          <div className="appearance-accent-control">
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
                    cancelPicker(false)
                    setAppearanceError('')
                    void updateSettings({ accent: item.value }).catch((error) =>
                      setAppearanceError(String(error))
                    )
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
          </div>
        </SettingsRow>
        {appearanceError ? (
          <p className="settings-view__error" role="alert">
            {appearanceError}
          </p>
        ) : null}
      </SettingsGroup>

      <SettingsGroup
        ariaLabel="图形与视觉效果"
        title={
          <span className="appearance-group-heading">
            <span>图形与视觉效果</span>
            <span className="appearance-render-status" role="status">
              <span>当前渲染</span>
              <strong>
                {graphics ? (graphics.hardwareAcceleration ? '硬件加速' : '软件渲染') : '正在检测…'}
              </strong>
            </span>
          </span>
        }
        footer={graphics?.environmentOverride ? '当前渲染由启动配置指定。' : undefined}
      >
        <SettingsRow
          label="图形加速"
          description={graphics?.restartRequired ? '重启应用后生效' : '下次启动时应用'}
          ariaLabel="图形加速"
        >
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
        <SettingsRow label="视觉效果" description="立即生效" ariaLabel="视觉效果">
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
        {graphics?.recovery && (
          <SettingsContent>
            <div className="appearance-recovery" role="group" aria-label="图形回退">
              <Icon name="info" size={16} />
              <div>
                <strong>检测到图形启动异常</strong>
                <p>
                  {graphics.recovery.reason === 'gpu-process-failed'
                    ? '自动模式将在下次启动时使用软件渲染。'
                    : '上次启动未完成，自动模式会使用软件渲染。'}
                </p>
              </div>
              <button
                type="button"
                className="btn btn--sm"
                aria-label="清除图形回退记录"
                disabled={resettingRecovery}
                onClick={() => void resetRecovery()}
              >
                {resettingRecovery ? '清除中…' : '清除回退记录'}
              </button>
            </div>
          </SettingsContent>
        )}
        {recoveryNotice ? (
          <SettingsContent>
            <span className="sg__row-desc" role="status">
              {recoveryNotice}
            </span>
          </SettingsContent>
        ) : null}
        {graphicsError ? (
          <p className="settings-view__error" role="alert">
            {graphicsError}
          </p>
        ) : null}
        <SettingsDisclosure title="图形选项说明" className="appearance-explanation">
          <dl>
            <div>
              <dt>图形加速</dt>
              <dd>
                自动模式优先使用显卡，启动异常后回退；启用模式始终尝试加速；软件渲染不使用显卡加速。
              </dd>
            </div>
            <div>
              <dt>视觉效果</dt>
              <dd>
                自动模式使用精简效果；完整保留模糊，精简只在小型浮层保留，实色关闭透明效果。设置窗口始终使用实色。
              </dd>
            </div>
            <div>
              <dt>系统适配</dt>
              <dd>
                软件渲染或系统要求减少透明度时，实际效果使用实色。自定义强调色会随主题调整明度以保持可读性。
              </dd>
            </div>
          </dl>
        </SettingsDisclosure>
      </SettingsGroup>

      <SettingsGroup title="控件预览" ariaLabel="控件预览" footer="仅供体验，不影响已保存的设置。">
        <SettingsContent className="appearance-preview__content">
          <div className="appearance-preview__controls">
            <button
              type="button"
              className="btn btn--primary"
              aria-label="体验主要按钮"
              aria-pressed={previewSelected}
              onClick={() => {
                setPreviewSelected((value) => !value)
                setPreviewStatus(previewSelected ? '已取消选择' : '已选择主要按钮')
              }}
            >
              {previewSelected ? <Icon name="check" size={14} /> : null}主要按钮
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setPreviewSelected(false)
                setPreviewEnabled(true)
                setPreviewStatus('已重置预览')
              }}
            >
              重置预览
            </button>
            <div className="appearance-preview__switch">
              <span>开关</span>
              <Toggle
                checked={previewEnabled}
                label="预览开关"
                onChange={(value) => {
                  setPreviewEnabled(value)
                  setPreviewStatus(value ? '预览开关已打开' : '预览开关已关闭')
                }}
              />
            </div>
          </div>
          <span className="appearance-preview__status" role="status">
            {previewStatus}
          </span>
        </SettingsContent>
      </SettingsGroup>
    </div>
  )
}
