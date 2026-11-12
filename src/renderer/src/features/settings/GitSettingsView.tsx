import { useSyncExternalStore, type JSX } from 'react'
import { SettingsGroup, SettingsRow, Toggle } from './SettingsGroup'
import {
  DEFAULT_GIT_AUTO_FETCH,
  DEFAULT_GIT_AUTO_FETCH_INTERVAL_MS,
  getGitPreferences,
  onGitPreferencesChanged,
  setGitAutoFetch,
  setGitAutoFetchIntervalMs
} from '@renderer/core/git/git-pref'
import './settings-pages.css'

export function GitSettingsView(): JSX.Element {
  const preferences = useSyncExternalStore(onGitPreferencesChanged, getGitPreferences)
  const intervalMinutes = Math.round(preferences.autoFetchIntervalMs / 60000)

  return (
    <div className="settings-view settings-view--git">
      <SettingsGroup title="源代码管理" footer="自动获取只读取远端状态，不会修改工作区内容。失败时会静默退避。">
        <SettingsRow label="自动获取远端更新" description="在后台定期执行 git fetch，保持分支状态及时。">
          <Toggle checked={preferences.autoFetch} label="自动获取远端更新" onChange={setGitAutoFetch} />
        </SettingsRow>
        <SettingsRow label="获取间隔" description="两次后台检查之间的时间，范围为 1 到 60 分钟。">
          <div className="settings-inline-control">
            <input
              className="field__input settings-number-input"
              type="number"
              min={1}
              max={60}
              step={1}
              value={intervalMinutes}
              aria-label="Git 自动获取间隔（分钟）"
              onChange={(event) => setGitAutoFetchIntervalMs(Number(event.target.value) * 60000)}
            />
            <span className="settings-unit">分钟</span>
          </div>
        </SettingsRow>
      </SettingsGroup>
      <div className="settings-view__actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            setGitAutoFetch(DEFAULT_GIT_AUTO_FETCH)
            setGitAutoFetchIntervalMs(DEFAULT_GIT_AUTO_FETCH_INTERVAL_MS)
          }}
        >
          恢复默认
        </button>
      </div>
    </div>
  )
}
