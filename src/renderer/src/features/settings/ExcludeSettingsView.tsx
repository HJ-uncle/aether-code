import { useState, useSyncExternalStore, type JSX } from 'react'
import type { FilesExclude } from '@shared/ipc'
import { useApp } from '@renderer/core/app-context'
import { SettingsGroup, Toggle } from './SettingsGroup'
import './settings-pages.css'
import { useSettingsScope } from './settings-scope'
import { useWorkspace } from '@renderer/core/workspace/workspace-store'
import { clearWorkspaceSetting, getWorkspaceSettings, onWorkspaceSettingsChanged, setWorkspaceSettings } from '@renderer/core/workspace/workspace-settings'

/**
 * 排除规则表（files.exclude 与 search.exclude 共用）
 *
 * 照搬 VS Code 的交互：一张「glob 模式 → 是否排除」的表，逐行可改可删，
 * 底部再加一行空白输入用于新增。改动即时生效。
 *
 * 用「文本域整表编辑」会更省事，但那样用户看不到「一行一条规则」的结构，
 * 也容易把 JSON 写坏；这里选择逐行编辑，输入非法（空模式）时不落盘。
 *
 * files 与 search 两张表的编辑行为完全一致，差别只在文案与落到哪个字段，
 * 因此抽成同一个组件由两个薄封装传参调用。
 */

/** 一行编辑态。id 只用于 React key，模式本身可能重复（保存时去重） */
interface DraftRow {
  id: number
  pattern: string
  exclude: boolean
}

let nextRowId = 0
function makeRow(pattern: string, exclude: boolean): DraftRow {
  nextRowId += 1
  return { id: nextRowId, pattern, exclude }
}

function toDraft(exclude: FilesExclude): DraftRow[] {
  return Object.entries(exclude).map(([pattern, value]) => makeRow(pattern, value))
}

function fromDraft(rows: DraftRow[]): FilesExclude {
  const out: FilesExclude = {}
  for (const row of rows) {
    const pattern = row.pattern.trim()
    if (!pattern) continue
    out[pattern] = row.exclude
  }
  return out
}

/** 两张表是否等价（用于判断 dirty，与键顺序无关） */
function sameExclude(a: FilesExclude, b: FilesExclude): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => b[key] === a[key])
}

export interface ExcludeSettingsViewProps {
  settingKey: 'filesExclude' | 'searchExclude'
  /** 当前设置里的这张表 */
  value: FilesExclude
  /** 出厂默认值（「恢复默认」用） */
  defaults: FilesExclude
  /** 写回设置 */
  onChange: (next: FilesExclude) => void
  /** fieldset 标题 */
  legend: string
  /** 表格上方的说明段落 */
  hint: React.ReactNode
  /** 空表时的提示语 */
  emptyHint: string
  /** 新增行的输入框占位符 */
  placeholder: string
  /** 表格的 aria-label */
  ariaLabel: string
  /** 根节点附加类名，供文件排除与搜索排除页面复用同一视图 */
  className?: string
}

export function ExcludeSettingsView({
  value,
  settingKey,
  defaults,
  onChange,
  legend,
  hint,
  emptyHint,
  placeholder,
  ariaLabel,
  className
}: ExcludeSettingsViewProps): JSX.Element {
  const scope = useSettingsScope()
  const workspace = useWorkspace()
  const [rows, setRows] = useState<DraftRow[]>(() => toDraft(value))

  // 设置异步加载完成后对一次账：别处改了设置、或预设文件补了默认值，
  // 都要让编辑区跟着走。渲染期调和（而非 effect）避免多一轮闪烁。
  const [synced, setSynced] = useState(value)
  if (synced !== value) {
    setSynced(value)
    setRows(toDraft(value))
  }

  const persist = (next: DraftRow[]): void => {
    setRows(next)
    onChange(fromDraft(next))
  }

  const updateRow = (id: number, patch: Partial<DraftRow>): void => {
    persist(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

  const removeRow = (id: number): void => {
    persist(rows.filter((row) => row.id !== id))
  }

  const addRow = (): void => {
    setRows([...rows, makeRow('', true)])
  }

  const reset = (): void => {
    if (scope === 'workspace' && workspace.root) {
      clearWorkspaceSetting(workspace.root, settingKey)
      return
    }
    persist(toDraft({ ...defaults }))
  }

  const dirty = !sameExclude(fromDraft(rows), value)

  return (
    <div className={`settings-view${className ? ` ${className}` : ''}`}>
      <SettingsGroup title={legend} footer={typeof hint === 'string' ? hint : undefined}>
        <div className="sg__scope-note">
          当前作用域：{scope === 'workspace' ? `工作区${workspace.root ? '' : '（未打开工作区，将保存到用户设置）'}` : '用户'}
        </div>
        {typeof hint === 'string' ? null : <div className="sg__hint-block">{hint}</div>}

        {rows.length === 0 && <div className="sg__empty">{emptyHint}</div>}

        <div role="group" aria-label={ariaLabel}>
          {rows.map((row) => (
            <div className="sg__row" key={row.id}>
              <div className="sg__row-text">
                <input
                  className="field__input exclude-row__pattern"
                  type="text"
                  spellCheck={false}
                  placeholder={placeholder}
                  value={row.pattern}
                  onChange={(event) => updateRow(row.id, { pattern: event.target.value })}
                />
              </div>
              <div className="sg__row-control">
                <Toggle
                  checked={row.exclude}
                  onChange={(checked) => updateRow(row.id, { exclude: checked })}
                  label={row.exclude ? '已排除' : '不排除'}
                />
                <button
                  type="button"
                  className="exclude-row__remove"
                  aria-label="删除该规则"
                  title="删除该规则"
                  onClick={() => removeRow(row.id)}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      </SettingsGroup>

      <div className="settings-view__actions">
        <button type="button" className="btn" onClick={addRow}>
          添加规则
        </button>
        <button type="button" className="btn" onClick={reset}>
          恢复默认
        </button>
        {dirty && <span className="settings-view__saved">规则已更新</span>}
      </div>
    </div>
  )
}

/** 供两个薄封装共用的取数：从 context 读设置、写设置 */
export function useExcludeSettings(
  key: 'filesExclude' | 'searchExclude'
): [FilesExclude, (next: FilesExclude) => void] {
  const { userSettings, updateSettings } = useApp()
  const scope = useSettingsScope()
  const workspace = useWorkspace()
  const workspaceSettings = useSyncExternalStore(
    onWorkspaceSettingsChanged,
    () => getWorkspaceSettings(workspace.root),
    () => getWorkspaceSettings(null)
  )
  const workspaceValue = scope === 'workspace' ? workspaceSettings[key] : undefined
  const value = scope === 'workspace' ? (workspaceValue ?? userSettings[key]) : userSettings[key]
  const setValue = (next: FilesExclude): void => {
    if (scope === 'workspace' && workspace.root) {
      setWorkspaceSettings(workspace.root, key === 'filesExclude' ? { filesExclude: next } : { searchExclude: next })
    } else {
      void updateSettings(key === 'filesExclude' ? { filesExclude: next } : { searchExclude: next })
    }
  }
  return [value, setValue]
}
