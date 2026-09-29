import { useState, type JSX } from 'react'
import { openFile } from '@renderer/core/editor/editor-store'
import { useProblems, type ProblemItem } from '@renderer/core/lsp/problems-store'
import { Icon, type IconName } from '@renderer/workbench/icons'

/**
 * 问题面板（对标 VS Code Problems）
 *
 * 展示引擎 LSP 诊断结果，按文件分组；点击条目打开文件并跳到对应行列。
 * 数据在保存文件或手动「诊断当前文件」时产生（见 core/lsp/diagnostics.ts）。
 *
 * 交互（对齐 VS Code）：
 *   - 顶部严重级筛选（错误/警告/其它），按当前筛选计数
 *   - 文件组可折叠/展开（默认展开），组行显示各类计数
 *   - 单文件条数过多时条目区滚动，文件组徽章 ≥10 显示 9+
 */
type SeverityFilter = 'all' | 'error' | 'warning' | 'info'

const FILTERS: Array<{
  id: SeverityFilter
  label: string
  icon: IconName
}> = [
  { id: 'error', label: '错误', icon: 'close' },
  { id: 'warning', label: '警告', icon: 'warning' },
  { id: 'info', label: '提示', icon: 'info' },
  { id: 'all', label: '全部', icon: 'search' }
]

/** info + hint 归入「提示」档 */
function inFilter(item: ProblemItem, filter: SeverityFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'info') return item.severity === 'info' || item.severity === 'hint'
  return item.severity === filter
}

export function ProblemsView(): JSX.Element {
  const { byFile } = useProblems()
  const [filter, setFilter] = useState<SeverityFilter>('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const files = [...byFile.entries()]
    .map(([filePath, items]) => ({ filePath, items: items.filter((i) => inFilter(i, filter)) }))
    .filter((group) => group.items.length > 0)
    .sort((a, b) => a.filePath.localeCompare(b.filePath))

  const counts = { error: 0, warning: 0, info: 0 }
  for (const items of byFile.values()) {
    for (const item of items) {
      if (item.severity === 'error') counts.error++
      else if (item.severity === 'warning') counts.warning++
      else counts.info++
    }
  }
  const total = counts.error + counts.warning + counts.info

  const toggleCollapse = (filePath: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(filePath)) next.delete(filePath)
      else next.add(filePath)
      return next
    })
  }

  return (
    <div className="problems-view" aria-label="问题">
      {total === 0 ? (
        <div className="problems-view__empty">
          没有问题。保存文件或运行「诊断当前文件」后显示引擎诊断。
        </div>
      ) : (
        <>
          <div className="problems-view__filters" role="toolbar" aria-label="严重级筛选">
            {FILTERS.map((f) => {
              const count = f.id === 'all' ? total : counts[f.id]
              return (
                <button
                  key={f.id}
                  type="button"
                  className={`problems-view__filter${filter === f.id ? ' is-active' : ''}`}
                  aria-pressed={filter === f.id}
                  onClick={() => setFilter(f.id)}
                >
                  <Icon name={f.icon} size={16} />
                  {f.label}
                  <span className="problems-view__filter-count">{count >= 10 ? '9+' : count}</span>
                </button>
              )
            })}
          </div>
          <div className="problems-view__summary">
            {files.reduce((sum, g) => sum + g.items.length, 0)} 个问题，{files.length} 个文件
          </div>
          <div className="problems-view__list">
            {files.map((group) => (
              <FileGroup
                key={group.filePath}
                filePath={group.filePath}
                items={group.items}
                collapsed={collapsed.has(group.filePath)}
                onToggle={() => toggleCollapse(group.filePath)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function badgeCount(n: number): string {
  return n >= 10 ? '9+' : String(n)
}

function FileGroup({
  filePath,
  items,
  collapsed,
  onToggle
}: {
  filePath: string
  items: ProblemItem[]
  collapsed: boolean
  onToggle: () => void
}): JSX.Element {
  const errors = items.filter((item) => item.severity === 'error').length
  const warnings = items.filter((item) => item.severity === 'warning').length
  return (
    <div className="problems-view__group">
      <button
        type="button"
        className="problems-view__file"
        title={filePath}
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <span className={`problems-view__chevron${collapsed ? '' : ' is-open'}`} aria-hidden="true">
          <Icon name="chevron-right" size={16} />
        </span>
        <Icon name="file" size={16} />
        <span className="problems-view__file-name">{fileName(filePath)}</span>
        <span className="problems-view__file-count">
          {errors > 0 ? `${badgeCount(errors)} 错误` : ''}
          {errors > 0 && warnings > 0 ? '，' : ''}
          {warnings > 0 ? `${badgeCount(warnings)} 警告` : ''}
          {errors === 0 && warnings === 0 ? `${badgeCount(items.length)} 项` : ''}
        </span>
      </button>
      {collapsed ? null : (
        <div className="problems-view__items">
          {items.map((item, index) => (
            <Item key={index} filePath={filePath} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}

function Item({ filePath, item }: { filePath: string; item: ProblemItem }): JSX.Element {
  const length = item.endColumn && item.endColumn > item.column ? item.endColumn - item.column : 1
  return (
    <button
      type="button"
      className="problems-view__item"
      onClick={() => void openFile(filePath, item.line, item.column, length)}
    >
      <span className={`problems-view__dot is-${item.severity}`} aria-hidden="true" />
      <span className="problems-view__message">{item.message}</span>
      <span className="problems-view__meta">
        {item.source}
        {item.code ? ` ${item.code}` : ''} [行 {item.line}，列 {item.column}]
      </span>
    </button>
  )
}

function fileName(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() ?? filePath
}
