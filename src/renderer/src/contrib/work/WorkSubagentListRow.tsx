import { useCallback, type JSX } from 'react'
import { Icon } from '@renderer/workbench/icons'
import { useHoverDetail } from '@renderer/workbench/useHoverDetail'
import type { WorkSubagentGroup, workSubagentStats } from './work-subagents'
import { workSubagentTiming } from './work-subagent-timing'

interface WorkSubagentListRowProps {
  group: WorkSubagentGroup
  stats: ReturnType<typeof workSubagentStats>
  now: number
  status: string
  task: string
  role: string | undefined
  tone: 'waiting' | 'active' | 'error' | 'complete'
  statusHint?: string
  onOpen: () => void
  rowRef: (node: HTMLButtonElement | null) => void
}

export function WorkSubagentListRow({ group, stats, now, status, task, role, tone, statusHint, onOpen, rowRef }: WorkSubagentListRowProps): JSX.Element {
  const timing = workSubagentTiming(group.latest, now)
  const { triggerProps, tooltip } = useHoverDetail({
    enabled: true,
    label: `${group.label} 的任务`,
    content: <div className="work-subagents__row-preview">
      <strong>{group.label}</strong>
      <div className="work-subagents__row-preview-meta"><span>{status}</span>{role ? <span>{role}</span> : null}</div>
      <div className="work-subagents__row-preview-meta"><span>{timing.durationText}</span>{timing.timestamp ? <time dateTime={timing.timestamp.dateTime}>{timing.timestamp.full}</time> : null}</div>
      <p>{task}</p>
      {statusHint && statusHint !== task ? <p className="work-subagents__row-preview-hint">{statusHint}</p> : null}
    </div>
  })
  const hoverRef = triggerProps.ref
  // Both the reading popover and returning from a conversation use this button.
  const ref = useCallback((node: HTMLButtonElement | null) => {
    hoverRef.current = node
    rowRef(node)
  }, [hoverRef, rowRef])

  return <>
    <button {...triggerProps} ref={ref} type="button" className="work-subagents__row"
      data-child-session-id={group.childSessionId} data-agent-status={stats.status}
      data-model-id={stats.modelId || undefined} data-tool-count={stats.toolCount}
      data-active-tool-count={stats.activeToolCount} data-pending={stats.pending ? 'true' : 'false'}
      onClick={onOpen} aria-label={`查看 ${group.label} 子代理详情`} aria-description={`${status}。${timing.summary}。${task}`}>
      <span className="work-subagents__row-icon" aria-hidden="true"><Icon name="account-outline" size={18} /></span>
      <span className="work-subagents__row-content">
        <span className="work-subagents__row-heading">
          <strong>{group.label}</strong>
          <span className={`work-subagents__row-status work-subagents__row-status--${tone}`}>{status}</span>
        </span>
        <span className="work-subagents__row-description">
          {role ? <span className="work-subagents__row-role">{role}</span> : null}
          <span className="work-subagents__row-duration" data-duration-ms={timing.durationMs}>{timing.durationText}</span>
          {timing.timestamp ? <time className="work-subagents__row-time" dateTime={timing.timestamp.dateTime}>{timing.timestamp.text}</time> : null}
        </span>
      </span>
      <span className="work-subagents__row-chevron" aria-hidden="true"><Icon name="chevron-right" size={14} /></span>
    </button>
    {tooltip}
  </>
}
