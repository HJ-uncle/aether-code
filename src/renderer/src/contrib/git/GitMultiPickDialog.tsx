import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import { Dialog } from '@renderer/workbench/Dialog'
import { Icon } from '@renderer/workbench/icons'
import type { GitPickItem } from './GitPickDialog'
import './git-pick-dialog.css'
import './git-multi-pick-dialog.css'

/** Wuzu's Git multi-picker, with native checkboxes for keyboard selection. */
export function GitMultiPickDialog({
  open = true,
  title,
  description,
  items,
  searchPlaceholder = '搜索…',
  searchLabel = '搜索选项',
  footerHint,
  onPick,
  onClose
}: {
  open?: boolean
  title: string
  description?: string
  items: GitPickItem[]
  searchPlaceholder?: string
  searchLabel?: string
  footerHint?: string
  onPick: (ids: string[]) => void
  onClose: () => void
}): JSX.Element {
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    setKeyword('')
    setSelected(new Set())
    inputRef.current?.focus({ preventScroll: true })
  }, [open, title])
  const selectedIds = items.filter(item => selected.has(item.id)).map(item => item.id)
  const filtered = useMemo(() => {
    const query = keyword.trim().toLowerCase()
    return items.filter(
      (item) =>
        !query ||
        [item.id, item.label, item.hint, item.description].some((value) =>
          value?.toLowerCase().includes(query)
        )
    )
  }, [items, keyword])
  const focusOption = (index: number): void => {
    listRef.current?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[index]?.focus()
  }
  return (
    <Dialog
      open={open}
      title={title}
      width={560}
      className="git-dialog git-pickdlg git-multipick"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={selectedIds.length === 0}
            onClick={() => onPick(selectedIds)}
          >
            确定（{selectedIds.length}）
          </button>
        </>
      }
    >
      <div className="git-pickdlg__body">
        {description ? <div id={`${id}-description`} className="git-pickdlg__description">{description}</div> : null}
        <div className="git-pickdlg__search ui-input-shell">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            className="git-pickdlg__input ui-input-field"
            aria-label={searchLabel}
            aria-controls={`${id}-list`}
            aria-describedby={description ? `${id}-description` : undefined}
            placeholder={searchPlaceholder}
            autoComplete="off"
            spellCheck={false}
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.key !== 'ArrowDown') return
              event.preventDefault(); focusOption(0)
            }}
          />
          {keyword ? <button type="button" className="git-pickdlg__clear" aria-label="清空搜索"
            onClick={() => { setKeyword(''); inputRef.current?.focus() }}>
            <Icon name="close" size={14} />
          </button> : null}
        </div>
        <div className="git-multipick__selection">
          <span role="status">
            已选 {selectedIds.length} / {items.length}
          </span>
          <button
            type="button"
            className="btn"
            disabled={filtered.length === 0 || filtered.every(item => selected.has(item.id))}
            // Filtering should not discard choices already made in another search.
            onClick={() => setSelected(previous => new Set([...previous, ...filtered.map(item => item.id)]))}
          >
            {keyword ? '全选匹配项' : '全选'}
          </button>
          <button type="button" className="btn" disabled={selectedIds.length === 0} onClick={() => setSelected(new Set())}>
            清空
          </button>
        </div>
        <div ref={listRef} id={`${id}-list`} role="group" aria-label={`${title}选项`} className="git-pickdlg__list">
          {filtered.length === 0 ? (
            <div className="git-pickdlg__empty" role="status">{keyword ? '无匹配项' : '暂无可选项'}</div>
          ) : (
            filtered.map((item, index) => (
              <label key={item.id} className={`git-pickdlg__item${item.description ? ' git-pickdlg__item--tall' : ''}${selected.has(item.id) ? ' is-selected' : ''}`}>
                <input
                  className="git-multipick__checkbox"
                  type="checkbox"
                  checked={selected.has(item.id)}
                  aria-label={item.label ?? item.id}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return
                    if (event.key === 'ArrowDown') {
                      event.preventDefault(); focusOption(Math.min(index + 1, filtered.length - 1))
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault()
                      if (index === 0) inputRef.current?.focus()
                      else focusOption(index - 1)
                    }
                  }}
                  onChange={(event) =>
                    setSelected((previous) => {
                      const next = new Set(previous)
                      if (event.target.checked) next.add(item.id)
                      else next.delete(item.id)
                      return next
                    })
                  }
                />
                {item.icon ? <span className="git-pickdlg__item-icon"><Icon name={item.icon} size={16} /></span> : null}
                <span className="git-pickdlg__item-main">
                  <span className="git-pickdlg__item-row">
                    <span className="git-pickdlg__item-label" title={item.label ?? item.id}>{item.label ?? item.id}</span>
                    {item.hint ? <span className="git-pickdlg__item-hint" title={item.hint}>{item.hint}</span> : null}
                  </span>
                  {item.description ? <span className="git-pickdlg__item-desc" title={item.description}>{item.description}</span> : null}
                </span>
              </label>
            ))
          )}
        </div>
        {footerHint ? <div className="git-pickdlg__footer-hint">{footerHint}</div> : null}
      </div>
    </Dialog>
  )
}
