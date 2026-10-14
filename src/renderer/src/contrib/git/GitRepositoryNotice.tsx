import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import type { GitRepositoryOperation } from '@renderer/core/git/git-repository-operation'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { Icon } from '@renderer/workbench/icons'
import './git-repository-notice.css'

export function GitRepositoryNotice({ operation, onRefresh }: { operation: GitRepositoryOperation | null; onRefresh: () => void | Promise<void> }): JSX.Element | null {
  if (!operation) return null
  return <RepositoryNotice operation={operation} onRefresh={onRefresh} />
}
function RepositoryNotice({ operation, onRefresh }: { operation: GitRepositoryOperation; onRefresh: () => void | Promise<void> }): JSX.Element | null {
  const state = useSyncExternalStore(operation.subscribe, operation.getSnapshot)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const currentOperation = useRef(operation)
  currentOperation.current = operation
  const refreshInFlight = useRef<GitRepositoryOperation | null>(null)
  useEffect(() => { setRefreshing(false); setRefreshError('') }, [operation])
  const refresh = async (): Promise<void> => {
    if (refreshInFlight.current === operation || state.pending) return
    refreshInFlight.current = operation
    setRefreshing(true); setRefreshError('')
    try { await onRefresh() }
    catch (error) {
      if (currentOperation.current === operation) setRefreshError(error instanceof Error ? error.message : '刷新仓库失败')
    }
    finally {
      if (refreshInFlight.current === operation) refreshInFlight.current = null
      if (currentOperation.current === operation) setRefreshing(false)
    }
  }
  if (state.phase === 'running' || state.phase === 'succeeded' && !state.actionError) return null
  const unsafe = state.failure?.executionDisposition !== 'not_started'
  const headline = state.phase === 'succeeded' ? `${state.label}已完成` : state.recovered ? '中断占用已恢复' : state.lease?.recoverable ? '上次 Git 操作已中断' : state.lease?.busy ? '仓库正在处理其他操作' : `${state.label}未完成`
  const description = state.phase === 'succeeded' ? '可以刷新查看仓库的最新状态。' : unsafe ? '这项操作可能已经产生修改。先检查文件和提交记录，再选择下一项操作。' : state.lease?.busy ? '本次操作尚未开始。当前操作结束后，可重试原操作。' : '本次操作尚未开始，可以重试原操作。'
  const pendingText = state.pending === 'recover' ? '正在恢复…' : state.pending === 'retry' ? '正在重试…' : '正在核对…'
  return (
    <section className="git-repository-notice" aria-label="Git 操作状态">
      <div className="git-repository-notice__content" role="status" aria-live="polite" aria-atomic="true">
        <Icon name={state.phase === 'succeeded' ? 'check' : 'info'} size={16} />
        <div><strong>{headline}</strong><p>{description}</p></div>
      </div>
      {state.failure?.error && state.phase === 'failed' && <details><summary>查看错误详情</summary><p>{state.failure.error}</p></details>}
      {state.actionError && <p className="git-repository-notice__error" role="alert">{state.actionError}</p>}
      {refreshError && <p className="git-repository-notice__error" role="alert">{refreshError}</p>}
      <div className="git-repository-notice__actions">
        {state.pending || refreshing ? <span role="status"><Spinner size={12} />{refreshing ? '正在刷新…' : pendingText}</span> : <>
          {state.phase === 'failed' && <button type="button" className="btn" onClick={() => void operation.inspect()}>重新核对</button>}
          {state.phase === 'failed' && state.lease?.recoverable && <button type="button" className="btn" onClick={() => void operation.recover()}>恢复中断占用</button>}
          {state.retryAllowed && <button type="button" className="btn btn--primary" onClick={() => void operation.retry()}>重试原操作</button>}
          <button type="button" className="btn" onClick={() => void refresh()}>刷新仓库</button>
        </>}
      </div>
    </section>
  )
}
