import { useMemo, useState, type JSX } from 'react'
import { Dialog } from '@renderer/workbench/Dialog'
import { Icon } from '@renderer/workbench/icons'
import type { GitPickItem } from './GitPickDialog'
import './git-multi-pick-dialog.css'

/** Wuzu's Git multi-picker, with native checkboxes for keyboard selection. */
export function GitMultiPickDialog({
  open = true,
  title,
  description,
  items,
  onPick,
  onClose
}: {
  open?: boolean
  title: string
  description?: string
  items: GitPickItem[]
  onPick: (ids: string[]) => void
  onClose: () => void
}): JSX.Element {
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
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
  return (
    <Dialog
      open={open}
      title={title}
      width={480}
      className="git-pickdlg"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={selected.size === 0}
            onClick={() =>
              onPick(items.filter((item) => selected.has(item.id)).map((item) => item.id))
            }
          >
            确定（{selected.size}）
          </button>
        </>
      }
    >
      <div className="git-pickdlg__body">
        {description ? <div className="git-pickdlg__description">{description}</div> : null}
        <div className="git-pickdlg__search">
          <Icon name="search" size={16} />
          <input
            className="git-pickdlg__input"
            aria-label="筛选远程仓库"
            placeholder="搜索远程仓库…"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
        </div>
        <div className="git-multipick__selection">
          <span role="status">
            已选 {selected.size} / {items.length}
          </span>
          <button
            type="button"
            className="btn"
            onClick={() => setSelected(new Set(filtered.map((item) => item.id)))}
          >
            全选
          </button>
          <button type="button" className="btn" onClick={() => setSelected(new Set())}>
            清空
          </button>
        </div>
        <div className="git-pickdlg__list">
          {filtered.length === 0 ? (
            <div className="git-pickdlg__empty">{keyword ? '无匹配项' : '暂无可选项'}</div>
          ) : (
            filtered.map((item) => (
              <label key={item.id} className="git-pickdlg__item">
                <input
                  type="checkbox"
                  checked={selected.has(item.id)}
                  aria-label={item.label ?? item.id}
                  onChange={(event) =>
                    setSelected((previous) => {
                      const next = new Set(previous)
                      if (event.target.checked) next.add(item.id)
                      else next.delete(item.id)
                      return next
                    })
                  }
                />
                <span className="git-pickdlg__item-main">
                  <span className="git-pickdlg__item-label">{item.label ?? item.id}</span>
                  {item.hint || item.description ? (
                    <span className="git-pickdlg__item-desc" title={item.hint ?? item.description}>{item.hint ?? item.description}</span>
                  ) : null}
                </span>
              </label>
            ))
          )}
        </div>
      </div>
    </Dialog>
  )
}
