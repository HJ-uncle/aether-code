import { useEffect, useMemo, useState, type JSX } from 'react'
import { getAllCommands } from '@renderer/core/platform/commands'
import {
  findKeybindingConflicts,
  formatKeybinding,
  getDefaultKeybinding,
  getKeybindingHint,
  isDefaultKeybindingRemoved,
  serializeKeybindingEvent
} from '@renderer/core/platform/keybindings'
import {
  clearCommandKeybinding,
  getEffectiveUserBinding,
  hasUserKeybindingRules,
  onUserKeybindingsChanged,
  resetCommandKeybindings,
  setUserKeybinding
} from '@renderer/core/platform/user-keybindings'
import './settings-pages.css'

/**
 * 键盘快捷方式编辑器（对标 VS Code 的 Keyboard Shortcuts Editor）
 *
 * 列出全部命令与其键位，支持：
 *   - 搜索过滤（命令标题 / 分类 / ID）；
 *   - 点击键位进入录制，Enter 确认、Esc 取消（VS Code 同款交互）；
 *   - 录制时提示冲突（该组合已被其他命令占用，确认后覆盖）；
 *   - 清除键位（写负规则屏蔽默认绑定）/ 重置（删除全部用户规则）。
 *
 * 用户规则落在 user-keybindings（localStorage），派发器自动优先读取，
 * 命令面板与菜单栏的键位提示随之更新。
 */

interface Recording {
  command: string
  /** 已录到的组合；null 表示还没录到主键 */
  keys: string | null
}

export function KeybindingsSettingsView(): JSX.Element {
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<Recording | null>(null)
  const [version, setVersion] = useState(0)

  // 用户规则变更时刷新列表（版本号触发重渲染，取数仍是普通函数调用）
  useEffect(() => onUserKeybindingsChanged(() => setVersion((value) => value + 1)), [])

  const commands = useMemo(() => {
    void version
    return getAllCommands()
  }, [version])

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (!text) return commands
    return commands.filter((entry) =>
      `${entry.category ?? ''} ${entry.title} ${entry.id}`.toLowerCase().includes(text)
    )
  }, [commands, query])

  // ── 录制：window 捕获阶段拦截，避免按键同时触发派发器或其他全局监听 ──
  useEffect(() => {
    if (!recording) return
    const onKeyDown = (event: KeyboardEvent): void => {
      event.stopImmediatePropagation()
      event.preventDefault()
      if (event.key === 'Escape') {
        setRecording(null)
        return
      }
      if (event.key === 'Enter') {
        if (recording.keys) {
          setUserKeybinding(recording.command, recording.keys)
          setRecording(null)
        }
        return
      }
      const keys = serializeKeybindingEvent(event)
      if (keys) setRecording((current) => (current ? { ...current, keys } : current))
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [recording])

  const sourceOf = (command: string): { label: string; modified: boolean } => {
    if (getEffectiveUserBinding(command)) return { label: '已修改', modified: true }
    if (hasUserKeybindingRules(command)) return { label: '已清除', modified: true }
    return { label: '默认', modified: false }
  }

  return (
    <div className="keybindings">
      <div className="keybindings__bar">
        <input
          className="keybindings__search"
          value={query}
          placeholder="按命令名、分类或 ID 过滤…"
          aria-label="搜索命令"
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="keybindings__tip">点击键位录制，Enter 确认，Esc 取消</span>
      </div>
      <div className="keybindings__head" role="row">
        <span>命令</span>
        <span>键位</span>
        <span>来源</span>
        <span />
      </div>
      <div className="keybindings__list">
        {filtered.length === 0 ? <div className="keybindings__empty">没有匹配的命令。</div> : null}
        {filtered.map((entry) => {
          const isRecording = recording?.command === entry.id
          const previewKeys = isRecording && recording.keys ? recording.keys : null
          const conflicts =
            previewKeys && isRecording ? findKeybindingConflicts(previewKeys, entry.id) : []
          const source = sourceOf(entry.id)
          const defaultKey = getDefaultKeybinding(entry.id)
          const canClear =
            !isRecording &&
            (getEffectiveUserBinding(entry.id) ||
              (defaultKey && !isDefaultKeybindingRemoved(defaultKey, entry.id)))
          const canReset = !isRecording && hasUserKeybindingRules(entry.id)

          return (
            <div className="keybindings__row" key={entry.id}>
              <div className="keybindings__command" title={entry.id}>
                <span className="keybindings__title">
                  {entry.category ? `${entry.category}: ` : ''}
                  {entry.title}
                </span>
                <span className="keybindings__id">{entry.id}</span>
              </div>
              <button
                type="button"
                className={`keybindings__key${isRecording ? ' is-recording' : ''}`}
                aria-label={`修改 ${entry.title} 的键位`}
                onClick={() => setRecording({ command: entry.id, keys: null })}
              >
                {isRecording
                  ? previewKeys
                    ? formatKeybinding(previewKeys)
                    : '按下组合键…'
                  : (getKeybindingHint(entry.id) ?? '无')}
              </button>
              <span className={`keybindings__source${source.modified ? ' is-modified' : ''}`}>
                {source.label}
              </span>
              <div className="keybindings__actions">
                {canClear ? (
                  <button
                    type="button"
                    className="keybindings__action"
                    onClick={() => clearCommandKeybinding(entry.id, getDefaultKeybinding(entry.id))}
                  >
                    清除键位
                  </button>
                ) : null}
                {canReset ? (
                  <button
                    type="button"
                    className="keybindings__action"
                    onClick={() => resetCommandKeybindings(entry.id)}
                  >
                    重置
                  </button>
                ) : null}
              </div>
              {isRecording && conflicts.length > 0 ? (
                <div className="keybindings__conflict" role="alert">
                  {formatKeybinding(previewKeys ?? '')} 已分配给{' '}
                  {conflicts.map((item) => item.title ?? item.command).join('、')}
                  ，确认后将覆盖
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
