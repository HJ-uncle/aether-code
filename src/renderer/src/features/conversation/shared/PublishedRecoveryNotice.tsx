import type { JSX } from 'react'
import type { PublishedRecoveryProgress } from '@renderer/core/engine/published-recovery-control'

export function PublishedRecoveryNotice({ state, onCancel, onLoadBody, onRetry }: {
  state: PublishedRecoveryProgress | null
  onCancel: () => void
  onLoadBody: () => void
  onRetry: () => void
}): JSX.Element | null {
  if (!state || state.phase === 'complete') return null
  const stopped = state.phase === 'cancelled' || state.phase === 'failed'
  const retained = state.phase === 'retained'
  const body = state.phase === 'body'
  const label = retained ? '已恢复保留的记录，较早内容已归档或压缩' : stopped ? state.phase === 'cancelled' ? '记录加载已暂停' : '记录同步失败' :
    state.phase === 'body-ready' ? '已显示记录预览，完整内容可按需打开' : body ? '正在读取完整内容' : '正在恢复协作记录'
  const value = body ? state.loadedBodyParts : state.loadedReferences
  const total = body ? state.totalBodyParts : state.totalReferences
  return <section className="published-recovery-notice" aria-label="记录恢复" aria-busy={!stopped && !retained && state.phase !== 'body-ready'}>
    <div className="published-recovery-notice__label" role="status">
      <span>{stopped && state.message ? state.message : label}</span><span>{value} / {total}</span>
    </div>
    {!retained ? <progress max={Math.max(1, total)} value={value} aria-label={body ? '完整内容恢复进度' : '协作记录恢复进度'} /> : null}
    <div className="published-recovery-notice__actions">
      {stopped || retained ? <button type="button" className="btn btn--sm" onClick={onRetry}>重新同步</button> : <>
        {state.phase === 'body-ready' ? <button type="button" className="btn btn--sm" onClick={onLoadBody}>打开完整内容</button> : null}
        <button type="button" className="btn btn--sm" onClick={onCancel}>停止加载</button>
      </>}
      <span>{retained ? '完整历史以实际归档为准' : '后台任务继续运行'}</span>
    </div>
  </section>
}
