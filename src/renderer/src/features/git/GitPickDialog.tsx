/**
 * Git 通用选择对话框（对齐 VSCode QuickPick 的用途）
 *
 * 移植自 wuzu-client components/code/GitPickDialog.vue，UI 原语从 element-plus
 * 换成 aether workbench 的 Dialog。纯展示组件，不持有任何 git 状态：
 * 父组件把选项列表经 items 传入，用户点击条目后回调 onPick，由父组件负责关闭。
 *
 * 与源的差异：
 * - open 由父层控制，父层在退出期间保留选项；onPick/onClose 立即结算选择。
 * - 行首图标从 iconify 字符串换成 IconName（aether 内置图标集），
 *   不引入新的图标依赖。
 */
import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import { Dialog } from '../../ui/Dialog'
import { Icon, type IconName } from '../../ui/icons'
import './git-pick-dialog.css'

export interface GitPickItem {
  id: string
  /** 展示文本，缺省用 id */
  label?: string
  /** 行尾灰色小字（如远程 url、提交哈希） */
  hint?: string
  /** 第二行灰色描述（如最新提交说明+作者） */
  description?: string
  /** 行首图标 */
  icon?: IconName
}

interface GitPickDialogProps {
  open?: boolean
  title: string
  /** 顶部说明文字（可选） */
  description?: string
  items: GitPickItem[]
  searchPlaceholder?: string
  searchLabel?: string
  footerHint?: string
  /** 用户选中某项：回传该项 id，父组件负责关闭 */
  onPick: (id: string) => void
  onClose: () => void
}

export function GitPickDialog({
  open = true,
  title,
  description,
  items,
  searchPlaceholder = '搜索…',
  searchLabel = '搜索选项',
  footerHint,
  onPick,
  onClose
}: GitPickDialogProps): JSX.Element {
  const [keyword, setKeyword] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLDivElement>(null)
  const id = useId()

  useEffect(() => {
    if (!open) return
    setKeyword('')
    setActiveId(null)
    inputRef.current?.focus({ preventScroll: true })
  }, [open, title])

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return items
    return items.filter(
      (o) =>
        o.id.toLowerCase().includes(kw) ||
        (o.label ?? '').toLowerCase().includes(kw) ||
        (o.hint ?? '').toLowerCase().includes(kw) ||
        (o.description ?? '').toLowerCase().includes(kw)
    )
  }, [items, keyword])

  // Track identity instead of a stale index when an async refresh reorders rows.
  const activeIndex = Math.max(0, filtered.findIndex(item => item.id === activeId))
  const activeItem = filtered[activeIndex]
  useEffect(() => {
    const list = listRef.current, row = activeRef.current
    if (!open || !list || !row) return
    const bounds = list.getBoundingClientRect(), item = row.getBoundingClientRect()
    // Scroll only the results, so navigating cannot move the dialog itself.
    if (item.top < bounds.top) list.scrollTop -= bounds.top - item.top
    else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom
  }, [activeItem?.id, filtered, open])

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveId(filtered[Math.min(activeIndex + 1, filtered.length - 1)]?.id ?? null)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveId(filtered[Math.max(activeIndex - 1, 0)]?.id ?? null)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (activeItem) onPick(activeItem.id)
    }
  }

  return (
    <Dialog open={open} title={title} width={560} className="git-dialog git-pickdlg" onClose={onClose}>
      <div className="git-pickdlg__body">
        {description ? <div id={`${id}-description`} className="git-pickdlg__description">{description}</div> : null}

        <div className="git-pickdlg__search ui-input-shell">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            className="git-pickdlg__input ui-input-field"
            role="combobox"
            aria-label={searchLabel}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={`${id}-list`}
            aria-activedescendant={activeItem ? `${id}-option-${activeIndex}` : undefined}
            aria-describedby={description ? `${id}-description` : undefined}
            autoComplete="off"
            spellCheck={false}
            value={keyword}
            placeholder={searchPlaceholder}
            onChange={(event) => { setKeyword(event.target.value); setActiveId(null) }}
            onKeyDown={onKeyDown}
          />
          {keyword ? <button type="button" className="git-pickdlg__clear" aria-label="清空搜索"
            onClick={() => { setKeyword(''); setActiveId(null); inputRef.current?.focus() }}>
            <Icon name="close" size={14} />
          </button> : null}
        </div>

        <div ref={listRef} id={`${id}-list`} role="listbox" aria-label={`${title}选项`} className="git-pickdlg__list">
          {filtered.length === 0 ? (
            <div className="git-pickdlg__empty" role="status">{keyword ? '无匹配项' : '暂无可选项'}</div>
          ) : (
            filtered.map((item, index) => (
              <div
                key={item.id}
                id={`${id}-option-${index}`}
                ref={index === activeIndex ? activeRef : null}
                role="option"
                aria-selected={index === activeIndex}
                className={`git-pickdlg__item${item.description ? ' git-pickdlg__item--tall' : ''}${index === activeIndex ? ' is-active' : ''}`}
                onMouseEnter={() => setActiveId(item.id)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onPick(item.id)}
              >
                {item.icon ? (
                  <span className="git-pickdlg__item-icon">
                    <Icon name={item.icon} size={16} />
                  </span>
                ) : null}
                <div className="git-pickdlg__item-main">
                  <div className="git-pickdlg__item-row">
                    <span className="git-pickdlg__item-label" title={item.label ?? item.id}>{item.label ?? item.id}</span>
                    {item.hint ? <span className="git-pickdlg__item-hint" title={item.hint}>{item.hint}</span> : null}
                  </div>
                  {item.description ? (
                    <div className="git-pickdlg__item-desc" title={item.description}>{item.description}</div>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>

        {footerHint ? <div className="git-pickdlg__footer-hint">{footerHint}</div> : null}
      </div>
    </Dialog>
  )
}
