import { useSyncExternalStore, type JSX } from 'react'
import { dismissRevertReport, getRevertReport, subscribeReverts } from '@renderer/core/engine/change-revert'
import { ChangeRevertReport } from '../conversation/shared/ChangeRevertReport'
import './change-review.css'

/** A delivery manifest hides the process review panel. Keep rollback failures
 * visible in the conversation itself until the user dismisses them. */
export function RevertNotice({ sessionId }: { sessionId: string }): JSX.Element | null {
  const report = useSyncExternalStore(subscribeReverts, () => getRevertReport(sessionId))
  if (!report) return null
  return <div className="work-revert-notice">
    <ChangeRevertReport report={report} label="本次回退结果" onDismiss={() => dismissRevertReport(sessionId)} />
  </div>
}
