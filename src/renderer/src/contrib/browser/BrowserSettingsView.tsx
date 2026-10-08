import { useEffect, useState, type JSX } from 'react'
import { SettingsGroup, SettingsRow, Toggle } from '../settings/SettingsGroup'
import { Select } from '@renderer/workbench/Select'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { toast } from '@renderer/core/toast'
import {
  browserAction,
  initializeBrowser,
  openBrowser,
  refreshBrowserSettings,
  updateBrowserSettings,
  useBrowserState
} from './browser-store'
import '../settings/settings-pages.css'
import './browser.css'
import {
  PHONE_VIEWPORT,
  DESKTOP_VIEWPORT,
  viewportPreset,
  customViewportLabel
} from './viewport-display'

export function BrowserSettingsView(): JSX.Element {
  const { settings, ready, error } = useBrowserState()
  const [homeUrl, setHomeUrl] = useState(settings.homeUrl)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  useEffect(() => {
    void initializeBrowser().then(refreshBrowserSettings)
  }, [])
  const [observedHomeUrl, setObservedHomeUrl] = useState(settings.homeUrl)
  if (observedHomeUrl !== settings.homeUrl) {
    setObservedHomeUrl(settings.homeUrl)
    setHomeUrl(settings.homeUrl)
  }
  const saveHome = async (): Promise<void> => {
    setSaving(true)
    setSaveError('')
    try {
      await updateBrowserSettings({ homeUrl: homeUrl.trim() || 'about:blank' })
    } catch (reason: unknown) {
      setSaveError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }
  const clear = async (): Promise<void> => {
    const confirmed = await confirmDialog({
      title: '清除浏览器数据？',
      body: '将清除内置浏览器中的登录状态、Cookie、缓存和站点存储。代码、对话和引擎配置不受影响。',
      confirmText: '清除数据',
      danger: true
    })
    if (!confirmed) return
    await window.aether.browser.clearData()
    toast.success('浏览器数据已清除')
  }
  return (
    <div className="settings-view browser-settings">
      <SettingsGroup
        title="打开网页"
        footer="这些偏好用于新建网页标签；已有标签可在浏览器工具栏中单独调整。"
      >
        <SettingsRow
          label="默认地址"
          description="可以是项目开发服务地址；about:blank 表示空白页。"
        >
          <form
            className="browser-settings__address"
            onSubmit={(event) => {
              event.preventDefault()
              void saveHome()
            }}
          >
            <input
              className="field__input"
              aria-label="浏览器默认地址"
              value={homeUrl}
              onChange={(event) => setHomeUrl(event.target.value)}
              placeholder="http://localhost:5173"
            />
            <button
              type="submit"
              className="btn"
              disabled={!ready || saving || homeUrl === settings.homeUrl}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </form>
        </SettingsRow>
        <SettingsRow label="默认网页缩放" description="只调整网页内容，不改变 IDE 的文字和布局。">
          <Select
            value={String(settings.zoomFactor)}
            title="默认网页缩放"
            options={[...new Set([0.5, 0.75, 1, 1.25, 1.5, 2, settings.zoomFactor])]
              .sort((a, b) => a - b)
              .map((value) => ({ value: String(value), label: `${Math.round(value * 100)}%` }))}
            disabled={!ready}
            onChange={(value) =>
              browserAction(() => updateBrowserSettings({ zoomFactor: Number(value) }))
            }
          />
        </SettingsRow>
        <SettingsRow
          label="默认视口"
          description="手机视口使用触摸模拟，桌面视口用于固定尺寸检查。"
        >
          <Select
            value={viewportPreset(settings.defaultViewport)}
            title="默认浏览器视口"
            options={[
              { value: 'fit', label: '适应编辑区域' },
              { value: 'desktop', label: '桌面 · 1280 × 800' },
              { value: 'phone', label: '手机 · 390 × 844' },
              ...(viewportPreset(settings.defaultViewport) === 'custom'
                ? [{ value: 'custom', label: customViewportLabel(settings.defaultViewport) }]
                : [])
            ]}
            disabled={!ready}
            onChange={(value) => {
              if (value === 'custom') return
              browserAction(() =>
                updateBrowserSettings({
                  defaultViewport:
                    value === 'fit' ? null : value === 'phone' ? PHONE_VIEWPORT : DESKTOP_VIEWPORT
                })
              )
            }}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="会话与 AI">
        <SettingsRow
          label="保存网页登录状态"
          description="开启后保留站点登录和本地存储；切换后新建标签生效。"
        >
          <Toggle
            checked={settings.persistSession}
            label="保存网页登录状态"
            disabled={!ready}
            onChange={(persistSession) =>
              browserAction(() => updateBrowserSettings({ persistSession }))
            }
          />
        </SettingsRow>
        <SettingsRow
          label="允许 AI 使用内置浏览器"
          description="当前对话中的 AI 可以读取和操作分配给它的网页，操作过程在编辑器中可见。"
        >
          <Toggle
            checked={settings.aiEnabled}
            label="允许 AI 使用内置浏览器"
            disabled={!ready}
            onChange={(aiEnabled) => browserAction(() => updateBrowserSettings({ aiEnabled }))}
          />
        </SettingsRow>
        <SettingsRow label="站点数据" description="清除内置浏览器的 Cookie、缓存和登录状态。">
          <button type="button" className="btn" onClick={() => browserAction(clear)}>
            清除浏览器数据…
          </button>
        </SettingsRow>
      </SettingsGroup>
      {saveError || error ? (
        <div role="alert" className="settings-view__error">
          {saveError || error}
        </div>
      ) : null}
      <div className="settings-view__actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => browserAction(() => openBrowser())}
        >
          打开浏览器
        </button>
      </div>
    </div>
  )
}
