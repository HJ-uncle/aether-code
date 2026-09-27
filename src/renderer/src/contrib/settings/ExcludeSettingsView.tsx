import { useState, type JSX } from 'react'
import type { FilesExclude } from '@shared/ipc'
import { useApp } from '@renderer/core/app-context'

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
}

export function ExcludeSettingsView({
  value,
  defaults,
  onChange,
  legend,
  hint,
  emptyHint,
  placeholder,
  ariaLabel
}: ExcludeSettingsViewProps): JSX.Element {
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
    persist(toDraft({ ...defaults }))
  }

  const dirty = !sameExclude(fromDraft(rows), value)

  return (
    <fieldset className="field">
      <legend>{legend}</legend>
      <p className="field__hint">{hint}</p>

      <div className="exclude-table" role="group" aria-label={ariaLabel}>
        {rows.length === 0 && <p className="field__hint">{emptyHint}</p>}

        {rows.map((row) => (
          <div className="exclude-row" key={row.id}>
            <label className="exclude-row__toggle" title={row.exclude ? '已排除' : '不排除'}>
              <input
                type="checkbox"
                checked={row.exclude}
                onChange={(event) => updateRow(row.id, { exclude: event.target.checked })}
              />
            </label>
            <input
              className="field__input exclude-row__pattern"
              type="text"
              spellCheck={false}
              placeholder={placeholder}
              value={row.pattern}
              onChange={(event) => updateRow(row.id, { pattern: event.target.value })}
            />
            <button
              type="button"
              className="btn btn--sm exclude-row__remove"
              aria-label="删除该规则"
              title="删除该规则"
              onClick={() => removeRow(row.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="settings-view__actions">
        <button type="button" className="btn" onClick={addRow}>
          添加规则
        </button>
        <button type="button" className="btn" onClick={reset}>
          恢复默认
        </button>
        {dirty && <span className="settings-view__saved">规则已更新</span>}
      </div>
    </fieldset>
  )
}

/** 供两个薄封装共用的取数：从 context 读设置、写设置 */
export function useExcludeSettings(
  key: 'filesExclude' | 'searchExclude'
): [FilesExclude, (next: FilesExclude) => void] {
  const { settings, updateSettings } = useApp()
  return [settings[key], (next) => void updateSettings({ [key]: next })]
}
