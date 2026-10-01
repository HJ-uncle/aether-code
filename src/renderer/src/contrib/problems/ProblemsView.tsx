import { useState, type JSX } from 'react'
import { openFile } from '@renderer/core/editor/editor-store'
import { useProblems, type ProblemItem } from '@renderer/core/lsp/problems-store'
import { Icon, type IconName } from '@renderer/workbench/icons'
import { pushPendingMention, pushPendingMentions } from '@renderer/contrib/chat/pending-mentions'
import type { Mention } from '@renderer/contrib/chat/MentionInput'
import { getWorkspaceState } from '@renderer/core/workspace/workspace-store'
import { fileIdentity } from '@renderer/core/editor/file-identity'
import { toast } from '@renderer/core/toast'

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
  const { byFile, diagnoses } = useProblems()
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

  const addProblem = (filePath: string, item: ProblemItem): void => {
    pushPendingMention(toMention(filePath, item))
    toast.success('问题已添加到当前会话')
  }

  const addVisibleProblems = (): void => {
    const mentions = files.flatMap(({ filePath, items }) => items.map((item) => toMention(filePath, item)))
    if (mentions.length === 0) return
    pushPendingMentions(mentions)
    toast.success(`已添加 ${mentions.length} 个问题到当前会话`)
  }

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
      {[...diagnoses.entries()].filter(([, diagnosis]) => diagnosis.status !== 'completed').map(([filePath, diagnosis]) => (
        <div className="problems-view__summary" role="status" key={filePath}>
          {fileName(filePath)}：{diagnosis.status === 'running' ? '诊断中' : diagnosis.status === 'unsupported' ? '不支持诊断' : '诊断失败'}
          {diagnosis.message ? '（' + diagnosis.message + '）' : ''}
        </div>
      ))}
      {total === 0 ? (
        <div className="problems-view__empty">
          尚无可显示的诊断条目。保存文件或运行「诊断当前文件」后查看结果。
        </div>
      ) : (
        <>
          <div className="problems-view__toolbar" role="toolbar" aria-label="问题工具">
            <div className="problems-view__filters" aria-label="严重级筛选">
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
            <button
              type="button"
              className="problems-view__chat-action"
              title="将当前筛选结果全部添加到会话输入框"
              aria-label="将当前问题清单添加到会话"
              onClick={addVisibleProblems}
            >
              <Icon name="chat" size={14} />
              <span>添加到会话</span>
            </button>
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
                onAdd={addProblem}
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
  onToggle,
  onAdd
}: {
  filePath: string
  items: ProblemItem[]
  collapsed: boolean
  onToggle: () => void
  onAdd: (filePath: string, item: ProblemItem) => void
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
            <Item key={index} filePath={filePath} item={item} onAdd={onAdd} />
          ))}
        </div>
      )}
    </div>
  )
}

function Item({ filePath, item, onAdd }: { filePath: string; item: ProblemItem; onAdd: (filePath: string, item: ProblemItem) => void }): JSX.Element {
  const length = item.endColumn && item.endColumn > item.column ? item.endColumn - item.column : 1
  return (
    <div className="problems-view__item-row">
      <button
        type="button"
        className="problems-view__item"
        title={`${item.message}（行 ${item.line}，列 ${item.column}）`}
        onClick={() => void openFile(filePath, item.line, item.column, length)}
      >
        <span className={`problems-view__dot is-${item.severity}`} aria-hidden="true" />
        <span className="problems-view__message">{item.message}</span>
        <span className="problems-view__meta">
          {item.source}
          {item.code ? ` ${item.code}` : ''} [行 {item.line}，列 {item.column}]
        </span>
      </button>
      <button
        type="button"
        className="problems-view__item-chat"
        title="将此问题添加到会话输入框"
        aria-label={`将问题添加到会话：${item.message}`}
        onClick={(event) => {
          event.stopPropagation()
          onAdd(filePath, item)
        }}
      >
        <Icon name="chat" size={14} />
      </button>
    </div>
  )
}

function fileName(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() ?? filePath
}

/** Keep the diagnostic location as a code mention so the chat can jump to the exact range. */
function toMention(filePath: string, item: ProblemItem): Mention {
  const normalized = filePath.replace(/\\/g, '/')
  const root = getWorkspaceState().root?.replace(/\\/g, '/').replace(/\/+$/, '')
  const path = root && fileIdentity(normalized).startsWith(`${fileIdentity(root)}/`)
    ? normalized.slice(root.length + 1)
    : normalized
  return {
    source: 'code',
    path,
    startLine: item.line,
    endLine: item.endLine && item.endLine >= item.line ? item.endLine : item.line,
    startColumn: item.column,
    endColumn: item.endColumn,
    displayText: `${fileName(path)}:${item.line}`
  }
}
