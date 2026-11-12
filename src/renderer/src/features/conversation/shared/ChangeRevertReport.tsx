import { useId, useState, type JSX } from 'react'
import { groupRevertResults, revertComplete, revertStatusLabel, revertSummary, type RevertReport } from '@renderer/core/engine/change-revert'
import { Icon } from '@renderer/ui/icons'
import { FileGlyph } from '../../explorer/FileGlyph'
import './change-revert-report.css'

interface ChangeRevertReportProps {
  report: RevertReport
  onDismiss: () => void
  label?: string
}

/** All entry points present the same receipt; a new receipt resets disclosure,
 * while unrelated refreshes preserve the reader's choice. */
export function ChangeRevertReport(props: ChangeRevertReportProps): JSX.Element {
  return <ReportContent key={JSON.stringify(props.report)} {...props} />
}

function ReportContent({ report, onDismiss, label = '文件回退结果' }: ChangeRevertReportProps): JSX.Element {
  const complete = revertComplete(report)
  const empty = complete && report.total === 0
  const previouslyReverted = complete && !empty && report.results.every(item => item.status === 'already_reverted')
  const hasRestored = report.results.some(item => item.status === 'reverted' || item.status === 'already_reverted')
  const [expanded, setExpanded] = useState(!complete)
  const detailsId = useId()
  const missing = Math.max(0, report.total - report.results.length)
  const title = empty ? '没有需要撤回的改动' : !complete ? hasRestored ? '部分改动未能回退' : '文件回退未完成' : previouslyReverted ? '此前已撤回' : '文件回退完成'
  return <section className="change-revert-report" aria-label={label} aria-live="polite" data-complete={complete}>
    <div className="change-revert-report__header">
      <span className="change-revert-report__icon"><Icon name={empty ? 'info' : complete ? 'check' : 'alert-circle'} size={15} /></span>
      <div className="change-revert-report__heading">
        <strong>{title}</strong>
        {!empty ? <span className="change-revert-report__count">{report.total} 处改动</span> : null}
      </div>
      <div className="change-revert-report__controls">
        {!empty ? <button type="button" className="change-revert-report__button" aria-label="逐文件结果" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)}>
          <span>详情</span><Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={12} />
        </button> : null}
        <button type="button" className="change-revert-report__button change-revert-report__dismiss" aria-label="关闭回退结果" title="关闭回退结果" onClick={onDismiss}><Icon name="close" size={14} /></button>
      </div>
    </div>
    {!empty ? <div className="change-revert-report__details" id={detailsId} hidden={!expanded}>
      <p className="change-revert-report__summary">{revertSummary(report)}</p>
      {!complete ? <p className="change-revert-report__hint">{missing ? `有 ${missing} 处改动尚未返回结果。` : report.results.length !== report.total ? '返回的结果数量与回退范围不一致。' : ''}请检查未完成项后重试。</p> : null}
      <ul>{groupRevertResults(report).map(({ path, items }) => <li key={path}>
        <span className="change-revert-report__file-icon">{items.every(item => item.entryType === 'directory')
          ? <Icon name="folder-outline" size={16} /> : <FileGlyph name={path} size={16} />}</span>
        <div className="change-revert-report__file">
          <span className="change-revert-report__path">{path.replace(/\\/g, '/') || '未提供路径的改动'}</span>
          <span className="change-revert-report__statuses">{[...new Set(items.map(item => item.status))].map(status => <span key={status} data-status={status}>{revertStatusLabel[status]} {items.filter(item => item.status === status).length} 处</span>)}</span>
          {[...new Set(items.map(item => item.message).filter(Boolean))].map(message => <p className="change-revert-report__message" key={message}>{message}</p>)}
        </div>
      </li>)}</ul>
    </div> : null}
  </section>
}
