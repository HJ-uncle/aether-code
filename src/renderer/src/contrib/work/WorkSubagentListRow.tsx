import type { JSX } from 'react'
import { Icon } from '@renderer/workbench/icons'
import type { WorkSubagentGroup, workSubagentStats } from './work-subagents'
import { workSubagentTiming } from './work-subagent-timing'
import { workSubagentIcon } from './work-subagents'

interface WorkSubagentListRowProps {
  group: WorkSubagentGroup
  stats: ReturnType<typeof workSubagentStats>
  now: number
  status: string
  task: string
  role: string | undefined
  tone: 'waiting' | 'active' | 'error' | 'complete'
  onOpen: () => void
  rowRef: (node: HTMLButtonElement | null) => void
}

export function WorkSubagentListRow({ group, stats, now, status, task, role, tone, onOpen, rowRef }: WorkSubagentListRowProps): JSX.Element {
  const timing = workSubagentTiming(group.latest, now)

  return <button ref={rowRef} type="button" className="work-subagents__row"
      data-child-session-id={group.childSessionId} data-agent-status={stats.status}
      data-model-id={stats.modelId || undefined} data-tool-count={stats.toolCount}
      data-active-tool-count={stats.activeToolCount} data-pending={stats.pending ? 'true' : 'false'}
      onClick={onOpen} aria-label={`查看 ${group.label} 子代理详情`} aria-description={`${status}。${timing.summary}。${task}`}>
      <span className="work-subagents__row-icon" aria-hidden="true"><Icon name={workSubagentIcon(group.latest)} size={16} /></span>
      <span className="work-subagents__row-content">
        <span className="work-subagents__row-heading">
          <strong>{group.label}</strong>
        </span>
        <span className="work-subagents__row-description">
          {role ? <span className="work-subagents__row-role">{role}</span> : null}
          {timing.timestamp ? <time className="work-subagents__row-time" dateTime={timing.timestamp.dateTime}>{timing.timestamp.text}</time> : null}
        </span>
      </span>
      <span className="work-subagents__row-metrics">
        <span className={`work-subagents__row-status work-subagents__row-status--${tone}`}>{status}</span>
        <span className="work-subagents__row-duration" data-duration-ms={timing.durationMs}>{timing.durationText}</span>
      </span>
      <span className="work-subagents__row-chevron" aria-hidden="true"><Icon name="chevron-right" size={12} /></span>
    </button>
}
