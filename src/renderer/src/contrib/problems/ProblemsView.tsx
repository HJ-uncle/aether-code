import type { JSX } from 'react'
import { openFile } from '@renderer/core/editor/editor-store'
import { useProblems, type ProblemItem } from '@renderer/core/lsp/problems-store'
import { Icon } from '@renderer/workbench/icons'

/**
 * 问题面板（对标 VS Code Problems）
 *
 * 展示引擎 LSP 诊断结果，按文件分组；点击条目打开文件并跳到对应行列。
 * 数据在保存文件或手动「诊断当前文件」时产生（见 core/lsp/diagnostics.ts）。
 */
export function ProblemsView(): JSX.Element {
  const { byFile } = useProblems()
  const files = [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const total = files.reduce((sum, [, items]) => sum + items.length, 0)

  return (
    <div className="problems-view" aria-label="问题">
      {files.length === 0 ? (
        <div className="problems-view__empty">
          没有问题。保存文件或运行「诊断当前文件」后显示引擎诊断。
        </div>
      ) : (
        <>
          <div className="problems-view__summary">
            {total} 个问题，{files.length} 个文件
          </div>
          <div className="problems-view__list">
            {files.map(([filePath, items]) => (
              <FileGroup key={filePath} filePath={filePath} items={items} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function FileGroup({ filePath, items }: { filePath: string; items: ProblemItem[] }): JSX.Element {
  const errors = items.filter((item) => item.severity === 'error').length
  return (
    <div className="problems-view__group">
      <div className="problems-view__file" title={filePath}>
        <Icon name="file" size={12} />
        <span className="problems-view__file-name">{fileName(filePath)}</span>
        <span className="problems-view__file-count">
          {errors > 0 ? `${errors} 错误，` : ''}
          {items.length} 项
        </span>
      </div>
      {items.map((item, index) => (
        <Item key={index} filePath={filePath} item={item} />
      ))}
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
