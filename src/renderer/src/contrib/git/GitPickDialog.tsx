/**
 * Git 通用选择对话框（对齐 VSCode QuickPick 的用途）
 *
 * 移植自 wuzu-client components/code/GitPickDialog.vue，UI 原语从 element-plus
 * 换成 aether workbench 的 Dialog。纯展示组件，不持有任何 git 状态：
 * 父组件把选项列表经 items 传入，用户点击条目后回调 onPick，由父组件负责关闭。
 *
 * 与源的差异：
 * - v-model 显隐改为「挂载即显示」：React 里条件渲染 <GitPickDialog/> 即打开，
 *   onClose 负责卸载，不再维护 modelValue 布尔。
 * - 行首图标从 iconify 字符串换成 IconName（aether 内置图标集），
 *   不引入新的图标依赖。
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Dialog } from '../../workbench/Dialog'
import { Icon, type IconName } from '../../workbench/icons'

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
  title: string
  /** 顶部说明文字（可选） */
  description?: string
  items: GitPickItem[]
  searchPlaceholder?: string
  footerHint?: string
  /** 用户选中某项：回传该项 id，父组件负责关闭 */
  onPick: (id: string) => void
  onClose: () => void
}

export function GitPickDialog({
  title,
  description,
  items,
  searchPlaceholder = '搜索…',
  footerHint,
  onPick,
  onClose
}: GitPickDialogProps): JSX.Element {
  const [keyword, setKeyword] = useState('')
  /** 键盘导航：↑↓ 移动高亮，Enter 选中 */
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

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

  // 过滤结果变化后高亮回第 0 项，避免 Enter 选中看不见的条目
  useEffect(() => {
    setActiveIndex(0)
  }, [filtered.length, keyword])

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const picked = filtered[activeIndex]
      if (picked) onPick(picked.id)
    }
  }

  return (
    <Dialog title={title} width={480} className="git-pickdlg" onClose={onClose}>
      <div className="git-pickdlg__body">
        {description ? <div className="git-pickdlg__description">{description}</div> : null}

        <div className="git-pickdlg__search">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            className="git-pickdlg__input"
            value={keyword}
            placeholder={searchPlaceholder}
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>

        <div className="git-pickdlg__list">
          {filtered.length === 0 ? (
            <div className="git-pickdlg__empty">{keyword ? '无匹配项' : '暂无可选项'}</div>
          ) : (
            filtered.map((item, index) => (
              <div
                key={item.id}
                ref={index === activeIndex ? (el) => el?.scrollIntoView({ block: 'nearest' }) : null}
                className={`git-pickdlg__item${item.description ? ' git-pickdlg__item--tall' : ''}${index === activeIndex ? ' is-active' : ''}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => onPick(item.id)}
              >
                {item.icon ? (
                  <span className="git-pickdlg__item-icon">
                    <Icon name={item.icon} size={16} />
                  </span>
                ) : null}
                <div className="git-pickdlg__item-main">
                  <div className="git-pickdlg__item-row">
                    <span className="git-pickdlg__item-label">{item.label ?? item.id}</span>
                    {item.hint ? <span className="git-pickdlg__item-hint">{item.hint}</span> : null}
                  </div>
                  {item.description ? (
                    <div className="git-pickdlg__item-desc">{item.description}</div>
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
