/**
 * 文件/目录引用选择面板
 *
 * 两个入口共用：
 *   1. 输入框里敲「@」触发的内联补全（keyword 由 MentionInput 实时给出，无搜索框）
 *   2. 「+」菜单的「从工作空间选择」（showSearch=true，面板自带搜索框）
 *
 * 数据源：fs.listAll（递归列工作区文件，跳过 node_modules 等），目录列表从
 * 文件路径的父目录推导。键盘 ↑↓ 选择、Enter/Tab 确认、Esc 关闭。
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { FileGlyph } from '@renderer/contrib/explorer/FileGlyph'
import { listAllFiles } from '@renderer/core/workspace/fs-client'
import { formatPathDisplay, type Mention } from './MentionInput'

interface FileRefPaletteProps {
  /** 工作区根目录；为空时面板不展示 */
  root: string
  /** @ 触发时的实时关键词；showSearch 模式下忽略（面板自己管理） */
  keyword: string
  /** 自带搜索框（+ 菜单模式） */
  showSearch?: boolean
  onSelect: (mention: Mention) => void
  onClose: () => void
}

interface Entry {
  /** 相对工作区路径 */
  path: string
  isDir: boolean
}

export function FileRefPalette({
  root,
  keyword,
  showSearch = false,
  onSelect,
  onClose
}: FileRefPaletteProps): JSX.Element {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [search, setSearch] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const query = showSearch ? search : keyword

  // 全量列表只拉一次（按 root 缓存于组件存活期内）
  useEffect(() => {
    let cancelled = false
    void listAllFiles(root)
      .then((files) => {
        if (cancelled) return
        const dirs = new Set<string>()
        for (const file of files) {
          const normalized = file.replace(/\\/g, '/')
          const parts = normalized.split('/')
          // 父目录逐级入集合：src/a/b.ts → src、src/a
          for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
        }
        setEntries([
          ...[...dirs].map((path) => ({ path, isDir: true })),
          ...files.map((path) => ({ path: path.replace(/\\/g, '/'), isDir: false }))
        ])
      })
      .catch(() => {
        if (!cancelled) setEntries([])
      })
    return () => {
      cancelled = true
    }
  }, [root])

  const filtered = useMemo(() => {
    if (!entries) return []
    const q = query.trim().toLowerCase()
    const matched = q
      ? entries.filter((entry) => entry.path.toLowerCase().includes(q))
      : entries
    // 文件名/目录名开头命中的排前面，其余按路径长度短的优先
    const scored = matched.map((entry) => {
      const base = (entry.path.split('/').pop() ?? '').toLowerCase()
      const startsWithBase = base.startsWith(q) ? 0 : 1
      return { entry, score: startsWithBase * 10000 + entry.path.length }
    })
    scored.sort((a, b) => a.score - b.score)
    return scored.slice(0, 30).map((item) => item.entry)
  }, [entries, query])

  // 关键词变化后回到第一项
  useEffect(() => setActiveIndex(0), [query])

  // 选中项滚进可视区
  useEffect(() => {
    const list = listRef.current
    const active = list?.children[activeIndex]
    if (active instanceof HTMLElement) active.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  // 键盘导航：捕获阶段拦截，先于输入框的 Enter=发送 生效
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (filtered.length === 0) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        setActiveIndex((index) => {
          const delta = event.key === 'ArrowDown' ? 1 : -1
          return (index + delta + filtered.length) % filtered.length
        })
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        event.stopPropagation()
        const entry = filtered[activeIndex]
        if (entry) {
          onSelect({
            displayText: formatPathDisplay(entry.path),
            source: entry.isDir ? 'dir' : 'file',
            path: entry.path
          })
        }
      }
    }
    // capture + window：要在 MentionInput 的 keydown 之前拦下导航键
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [filtered, activeIndex, onSelect, onClose])

  return (
    <div className="file-palette">
      {showSearch ? (
        <input
          type="text"
          className="file-palette__search"
          placeholder="搜索文件或目录…"
          autoFocus
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      ) : null}
      <div ref={listRef} className="file-palette__list">
        {entries === null ? (
          <div className="file-palette__empty">加载中…</div>
        ) : filtered.length === 0 ? (
          <div className="file-palette__empty">没有匹配的文件或目录</div>
        ) : (
          filtered.map((entry, index) => (
            <button
              key={`${entry.isDir ? 'd' : 'f'}:${entry.path}`}
              type="button"
              className={`file-palette__item${index === activeIndex ? ' is-active' : ''}`}
              // mousedown 抢在输入框 blur 之前触发选择
              onMouseDown={(event) => {
                event.preventDefault()
                onSelect({
                  displayText: formatPathDisplay(entry.path),
                  source: entry.isDir ? 'dir' : 'file',
                  path: entry.path
                })
              }}
              onMouseEnter={() => setActiveIndex(index)}
            >
              {entry.isDir ? (
                <span className="file-palette__dir" />
              ) : (
                <FileGlyph name={entry.path.split('/').pop() ?? entry.path} size={14} />
              )}
              <span className="file-palette__name">{entry.path.split('/').pop()}</span>
              <span className="file-palette__path">{entry.path}</span>
            </button>
          ))
        )}
      </div>
      <div className="file-palette__hint">↑↓ 选择 · Enter 确认 · Esc 关闭</div>
    </div>
  )
}
