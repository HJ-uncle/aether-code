import { useEffect, useRef, useState, type JSX } from 'react'
import { getEngineSource, getEngineStorageKey } from '@renderer/core/engine/source'
import {
  getKnowledgeBaseBindingIds,
  isKnowledgeSourceCurrent,
  listKnowledgeBases,
  saveKnowledgeBinding,
  type KnowledgeBase
} from '@renderer/core/engine/knowledge'
import { Popover } from '@renderer/workbench/Popover'
import './knowledge-picker.css'

export function KnowledgePicker({ sessionId, source, disabled, selectedIds, onSelectionChange }: {
  sessionId: string
  source: number
  disabled?: boolean
  /** Optional controlled selection supplied by the chat composer. */
  selectedIds?: readonly string[]
  /** Keep the composer resource chips in sync with direct KB picker changes. */
  onSelectionChange?: (ids: string[]) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [bases, setBases] = useState<KnowledgeBase[]>([])
  const requestRef = useRef(0)
  const [selected, setSelected] = useState<string[]>(() => selectedIds ? [...selectedIds] : getKnowledgeBaseBindingIds(sessionId, getEngineStorageKey()))

  useEffect(() => {
    if (selectedIds) setSelected([...selectedIds])
  }, [selectedIds])

  // When the composer owns the selection, render directly from that value so
  // chip removal is reflected immediately even while the picker popover is open.
  const effectiveSelected = selectedIds ?? selected

  useEffect(() => {
    if (!sessionId || source !== getEngineSource()) return
    requestRef.current += 1
    setSelected(getKnowledgeBaseBindingIds(sessionId, getEngineStorageKey()))
    setBases([])
    setLoadError('')
  }, [sessionId, source])

  useEffect(() => {
    if (!open || !sessionId || source !== getEngineSource()) return
    const requestId = ++requestRef.current
    const sourceAtStart = source
    setLoadError('')
    setLoading(true)
    void listKnowledgeBases()
      .then(next => {
        if (requestRef.current === requestId && isKnowledgeSourceCurrent(sourceAtStart, getEngineSource())) setBases(next)
      })
      .catch(reason => {
        if (requestRef.current === requestId && isKnowledgeSourceCurrent(sourceAtStart, getEngineSource())) {
          setBases([])
          setLoadError(reason instanceof Error ? reason.message : String(reason))
        }
      })
      .finally(() => {
        if (requestRef.current === requestId && isKnowledgeSourceCurrent(sourceAtStart, getEngineSource())) setLoading(false)
      })
    return () => { requestRef.current += 1 }
  }, [open, sessionId, source])

  const toggle = (id: string): void => {
    if (source !== getEngineSource()) return
    const next = effectiveSelected.includes(id) ? effectiveSelected.filter(item => item !== id) : [...effectiveSelected, id]
    setSelected(next)
    saveKnowledgeBinding(sessionId, next, getEngineStorageKey())
    onSelectionChange?.(next)
  }

  const label = effectiveSelected.length === 0 ? '知识库：关闭' : '知识库：' + effectiveSelected.length + ' 个'
  return (
    <Popover
      className="knowledge-picker"
      label="选择知识库"
      placement="up"
      align="end"
      width={300}
      flush
      disabled={disabled}
      open={open}
      onOpenChange={setOpen}
      trigger={({ open: isOpen }) => (
        <button type="button" className={'knowledge-picker__trigger' + (isOpen ? ' is-open' : '')} aria-label="选择知识库" title="选择本轮对话使用的知识库">
          <span>{label}</span>
          <span className="knowledge-picker__caret">⌃</span>
        </button>
      )}
    >
      <div className="knowledge-picker__popup" role="menu" aria-label="知识库选择">
        <div className="knowledge-picker__heading">本轮对话使用的知识库</div>
        {loading ? <div className="knowledge-picker__hint">加载中…</div> : loadError ? <div className="knowledge-picker__hint knowledge-picker__hint--error" role="alert">{loadError}</div> : bases.length === 0 ? <div className="knowledge-picker__hint">暂无知识库，请先在设置中创建。</div> : bases.map(base => (
          <button key={base.id} type="button" role="menuitemcheckbox" aria-checked={effectiveSelected.includes(base.id)} className={'knowledge-picker__item' + (effectiveSelected.includes(base.id) ? ' is-active' : '')} onClick={() => toggle(base.id)}>
            <span className="knowledge-picker__check">{effectiveSelected.includes(base.id) ? '✓' : ''}</span>
            <span className="knowledge-picker__copy"><strong>{base.name}</strong><small>{base.documentCount ?? 0} 篇文档</small></span>
          </button>
        ))}
        <button type="button" className="knowledge-picker__clear" disabled={effectiveSelected.length === 0} onClick={() => { if (source !== getEngineSource()) return; saveKnowledgeBinding(sessionId, [], getEngineStorageKey()); setSelected([]); onSelectionChange?.([]) }}>关闭知识库注入</button>
      </div>
    </Popover>
  )
}

