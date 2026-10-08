import type { JSX } from 'react'
import { SettingsGroup, SettingsRow, Toggle } from './SettingsGroup'
import {
  DEFAULT_TERMINAL_PREFERENCES,
  resetTerminalPreferences,
  setTerminalPreferences,
  useTerminalPreferences
} from '@renderer/contrib/terminal/terminal-preferences'
import './settings-pages.css'
import './terminal-settings.css'

export function TerminalSettingsView(): JSX.Element {
  const preferences = useTerminalPreferences()
  return (
    <div className="settings-view settings-view--terminal">
      <SettingsGroup title="集成终端" footer="设置会实时应用到已打开的终端，并用于新建终端会话。">
        <SettingsRow label="字体" description="终端使用的等宽字体族。">
          <input
            className="field__input terminal-settings__font"
            aria-label="终端字体"
            value={preferences.fontFamily}
            onChange={(event) => setTerminalPreferences({ fontFamily: event.target.value })}
          />
        </SettingsRow>
        <SettingsRow label="字号" description="终端文字的显示字号。">
          <input
            className="field__input terminal-settings__number"
            type="number"
            min={8}
            max={32}
            aria-label="终端字号"
            value={preferences.fontSize}
            onChange={(event) => setTerminalPreferences({ fontSize: Number(event.target.value) })}
          />
        </SettingsRow>
        <SettingsRow label="行高" description="终端行高倍率，范围为 1 到 2.5。">
          <input
            className="field__input terminal-settings__number"
            type="number"
            min={1}
            max={2.5}
            step={0.05}
            aria-label="终端行高"
            value={preferences.lineHeight}
            onChange={(event) => setTerminalPreferences({ lineHeight: Number(event.target.value) })}
          />
        </SettingsRow>
        <SettingsRow label="光标闪烁" description="终端获得焦点时显示闪烁光标。">
          <Toggle checked={preferences.cursorBlink} label="光标闪烁" onChange={(cursorBlink) => setTerminalPreferences({ cursorBlink })} />
        </SettingsRow>
        <SettingsRow label="滚动缓冲行数" description="保留在终端滚动区域中的历史行数。">
          <input
            className="field__input terminal-settings__number"
            type="number"
            min={500}
            max={50000}
            step={500}
            aria-label="滚动缓冲行数"
            value={preferences.scrollback}
            onChange={(event) => setTerminalPreferences({ scrollback: Number(event.target.value) })}
          />
        </SettingsRow>
      </SettingsGroup>
      <div className="settings-view__actions">
        <button type="button" className="btn" onClick={resetTerminalPreferences}>
          恢复默认（{DEFAULT_TERMINAL_PREFERENCES.fontSize}px）
        </button>
      </div>
    </div>
  )
}
