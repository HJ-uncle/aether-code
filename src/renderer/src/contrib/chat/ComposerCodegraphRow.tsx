import type { JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { useCodegraphIndex } from '@renderer/core/engine/useCodegraphIndex'
import { Icon } from '@renderer/workbench/icons'

export function ComposerCodegraphRow({ sessionId, path, active }: {
  sessionId: string
  path?: string
  active: boolean
}): JSX.Element {
  const { ready } = useApp()
  const index = useCodegraphIndex({ sessionId, path, active, ready })
  const summary = !ready ? '连接恢复后可建立索引' : index.error ? index.queryFailed ? '暂时无法读取索引，请重试。' : '索引未能完成，请重试。'
    : index.busy ? index.label : index.initialized ? '当前工作区的代码索引已就绪'
      : index.checking || !index.known ? '正在读取当前工作区…' : '帮助 AI 查找代码与引用关系'
  const label = !ready ? '未连接' : index.busy ? '索引中…' : index.checking || (!index.known && !index.queryFailed) ? '读取中…'
    : index.queryFailed ? '重新读取' : index.error ? '重试' : index.initialized ? '已建立' : '建索引'
  return <div className="composer-options__row composer-options__index" aria-busy={index.busy || index.checking}>
    <Icon name="search" size={16} />
    <div className="composer-options__text">
      <div className="composer-options__title">代码索引</div>
      <div className="composer-options__summary" role="status" title={index.error || path || undefined}>{summary}</div>
    </div>
    <button type="button" className="composer-options__dd-btn composer-options__index-action"
      disabled={!active || !ready || index.busy || index.checking || (!index.known && !index.queryFailed) || (index.initialized && !index.error)}
      onClick={index.queryFailed ? index.refresh : index.start}>
      {index.initialized && !index.busy && !index.error ? <Icon name="check" size={14} /> : null}
      <span>{label}</span>
    </button>
  </div>
}
