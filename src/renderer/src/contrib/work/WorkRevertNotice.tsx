import { useSyncExternalStore, type JSX } from 'react'
import { dismissRevertReport, getRevertReport, groupRevertResults, revertComplete, revertStatusLabel, revertSummary, subscribeReverts } from '@renderer/core/engine/change-revert'
import { Icon } from '@renderer/workbench/icons'
import './work-change-review.css'

/** A delivery manifest hides the process review panel. Keep rollback failures
 * visible in the conversation itself until the user dismisses them. */
export function WorkRevertNotice({ sessionId }: { sessionId: string }): JSX.Element | null {
  const report = useSyncExternalStore(subscribeReverts, () => getRevertReport(sessionId))
  if (!report) return null
  const complete = revertComplete(report)
  return <section className="work-change-review work-revert-notice" aria-label="本次回退结果" aria-live="polite">
    <div className="work-change-review__report">
      <header><strong>{complete ? '文件回退完成' : '部分文件未能回退'}</strong><button type="button" aria-label="关闭回退结果" onClick={() => dismissRevertReport(sessionId)}><Icon name="close" size={14} /></button></header>
      <p>{revertSummary(report)}</p>
      {!complete ? <p>已回退的文件与成果已更新。对话暂时保留；请处理下列未完成项后，再从原消息重试回退。</p> : null}
      <details open={!complete}><summary>逐文件结果</summary><ul>
        {groupRevertResults(report).map(({ path, items }) => <li key={path}>
          <span>{path.replace(/\\/g, '/')}</span>
          <span className="work-change-review__statuses">{[...new Set(items.map(item => item.status))].map(status => revertStatusLabel[status]).join(' · ')}</span>
          {[...new Set(items.map(item => item.message).filter(Boolean))].map(message => <p key={message}>{message}</p>)}
        </li>)}
      </ul></details>
    </div>
  </section>
}
