import { useState, useSyncExternalStore, type JSX } from 'react'
import {
  getEditorDisplayOptions,
  onEditorDisplayOptionsChanged,
  resetEditorDisplayOptions,
  setEditorDisplayOptions
} from '@renderer/core/editor/editor-display-options'
import { Toggle } from '@renderer/contrib/settings/SettingsGroup'

/** 编辑器内的轻量偏好入口；命令与面板共用同一个持久化 store。 */
export function EditorSettings(): JSX.Element {
  const options = useSyncExternalStore(onEditorDisplayOptionsChanged, getEditorDisplayOptions)
  return (
    <section className="editor-settings" aria-label="编辑器显示设置">
      <div className="editor-settings__heading">
        <strong>编辑器设置</strong>
        <button type="button" className="editor-settings__reset" onClick={resetEditorDisplayOptions}>
          恢复默认
        </button>
      </div>
      <p className="editor-settings__description">应用于所有文件，自动保存。</p>
      <PreferenceInput
        label="字体"
        value={options.fontFamily}
        onCommit={(fontFamily) => setEditorDisplayOptions({ fontFamily })}
      />
      <div className="editor-settings__numbers">
        <PreferenceInput label="字号" value={options.fontSize} min={10} max={32}
          onCommit={(value) => setEditorDisplayOptions({ fontSize: Number(value) })} />
        <PreferenceInput label="行高" value={options.lineHeight} min={Math.max(16, options.fontSize)} max={64}
          onCommit={(value) => setEditorDisplayOptions({ lineHeight: Number(value) })} />
        <PreferenceInput label="缩进空格数" value={options.tabSize} min={1} max={8}
          onCommit={(value) => setEditorDisplayOptions({ tabSize: Number(value) })} />
      </div>
      <SettingSwitch label="字体连字" checked={options.fontLigatures}
        onChange={(fontLigatures) => setEditorDisplayOptions({ fontLigatures })} />
      <SettingSwitch label="自动换行" checked={options.wordWrap === 'on'}
        onChange={(enabled) => setEditorDisplayOptions({ wordWrap: enabled ? 'on' : 'off' })} />
      <SettingSwitch label="显示小地图" checked={options.minimapEnabled}
        onChange={(minimapEnabled) => setEditorDisplayOptions({ minimapEnabled })} />
      <pre className="editor-settings__preview" style={{
        fontFamily: options.fontFamily,
        fontSize: options.fontSize,
        lineHeight: `${options.lineHeight}px`,
        fontVariantLigatures: options.fontLigatures ? 'normal' : 'none'
      }}>{'const greet = () => {\n' + ' '.repeat(options.tabSize) + 'return "你好，Aether"\n}'}</pre>
    </section>
  )
}

function SettingSwitch({ label, checked, onChange }: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <div className="editor-settings__switch">
      <span>{label}</span>
      <Toggle label={label} checked={checked} onChange={onChange} />
    </div>
  )
}

function PreferenceInput({ label, value, min, max, onCommit }: {
  label: string
  value: string | number
  min?: number
  max?: number
  onCommit: (value: string) => void
}): JSX.Element {
  const [draft, setDraft] = useState(String(value))
  const [previousValue, setPreviousValue] = useState(value)
  // 命令或「恢复默认」也能修改值；同步草稿，不用 key 重建输入框丢失焦点。
  if (value !== previousValue) {
    setPreviousValue(value)
    if (String(value) !== draft.trim()) setDraft(String(value))
  }
  const commit = (): void => {
    if (typeof value === 'number' && (!draft.trim() || !Number.isFinite(Number(draft)))) {
      setDraft(String(value))
      return
    }
    if (typeof value === 'number') {
      const bounded = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, Math.round(Number(draft))))
      setDraft(String(bounded))
      onCommit(String(bounded))
    } else {
      const trimmed = draft.trim()
      if (!trimmed) { setDraft(String(value)); return }
      onCommit(trimmed)
    }
  }
  return (
    <label className="editor-settings__field">
      <span>{label}</span>
      <input
        type={typeof value === 'number' ? 'number' : 'text'}
        aria-label={label}
        value={draft}
        min={min}
        max={max}
        maxLength={typeof value === 'string' ? 256 : undefined}
        step={typeof value === 'number' ? 1 : undefined}
        onChange={(event) => {
          const next = event.target.value
          setDraft(next)
          // 外部点击会先卸载浮层再触发 blur；合法输入即更新，避免最后一次编辑丢失。
          if (typeof value === 'number') {
            const numeric = Number(next)
            if (next.trim() && Number.isInteger(numeric) && numeric >= (min ?? -Infinity) && numeric <= (max ?? Infinity)) onCommit(next)
          } else if (next.trim()) onCommit(next)
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          }
        }}
      />
    </label>
  )
}
