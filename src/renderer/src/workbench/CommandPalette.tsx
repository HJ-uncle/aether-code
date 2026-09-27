import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { executeCommand, isCommandEnabled, registerCommand } from '@renderer/core/platform/commands'
import { recordCommandRun } from '@renderer/core/platform/commands-history'
import { getKeybindingHint, registerKeybinding } from '@renderer/core/platform/keybindings'
import { buildCommandItems } from './command-filter'
import { FuzzyText } from './FuzzyText'

const TOGGLE_COMMAND = 'aether.commandPalette.toggle'

/**
 * 命令面板（对标 VS Code 的 Ctrl+Shift+P）
 *
 * 命令注册表当初收敛为 ID 的目标在这里兑现：面板零成本列出全部功能，
 * 不过滤、不感知具体实现。开关命令与键位注册在组件内部 —— 它们与面板
 * UI 同生共死，不放进 contrib（contrib 登记的是「功能」，这里是「原语」）。
 *
 * 行为照搬 VS Code CommandsQuickAccess：无输入时最近使用的命令置顶并
 * 分「最近使用 / 其他命令」两组；有输入时按模糊得分排序、命中字符高亮。
 * 打开时才挂载对话框子组件：query/选中项随挂载自然重置，不需要重置逻辑。
 */
export function CommandPalette(): JSX.Element | null {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const disposeCommand = registerCommand({
      id: TOGGLE_COMMAND,
      title: '命令面板',
      category: '视图',
      run: () => setOpen((value) => !value)
    })
    const disposeKeybinding = registerKeybinding({
      key: 'ctrl+shift+p',
      command: TOGGLE_COMMAND
    })
    return () => {
      disposeCommand()
      disposeKeybinding()
    }
  }, [])

  if (!open) return null
  return <PaletteOverlay onClose={() => setOpen(false)} />
}

function PaletteOverlay({ onClose }: { onClose: () => void }): JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const groups = useMemo(() => buildCommandItems(query), [query])
  const items = useMemo(() => groups.flatMap((group) => group.items), [groups])

  const run = (index: number): void => {
    const item = items[Math.min(index, items.length - 1)]
    if (!item || !isCommandEnabled(item.entry.id)) return
    onClose()
    recordCommandRun(item.entry.id)
    void executeCommand(item.entry.id)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((value) => Math.min(value + 1, items.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((value) => Math.max(value - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      run(active)
    }
  }

  // 选中项跟随滚动（ref 操作，无状态更新）
  useEffect(() => {
    listRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' })
  }, [active, query, items])

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="命令面板"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          className="palette__input"
          autoFocus
          value={query}
          placeholder="输入命令名过滤，回车执行…"
          aria-label="过滤命令"
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
        />
        <div className="palette__list" ref={listRef}>
          {items.length === 0 ? <div className="palette__empty">没有匹配的命令。</div> : null}
          {groups.map((group, groupIndex) => (
            <div key={group.label ?? groupIndex}>
              {group.label ? <div className="palette__group">{group.label}</div> : null}
              {group.items.map((item) => {
                const index = items.indexOf(item)
                const enabled = isCommandEnabled(item.entry.id)
                const hint = getKeybindingHint(item.entry.id)
                return (
                  <button
                    key={item.entry.id}
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    className={`palette__item${index === active ? ' is-active' : ''}${
                      enabled ? '' : ' is-disabled'
                    }`}
                    disabled={!enabled}
                    title={enabled ? item.entry.id : '当前条件下不可用'}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => run(index)}
                  >
                    <span>
                      {item.entry.category ? (
                        <span className="palette__category">{item.entry.category}: </span>
                      ) : null}
                      <FuzzyText text={item.entry.title} positions={item.positions} />
                    </span>
                    {hint ? <span className="palette__key">{hint}</span> : null}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
