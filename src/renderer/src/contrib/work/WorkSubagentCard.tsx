import { createContext, useContext, useEffect, useMemo, useState, type JSX } from 'react'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { getEngineSource } from '@renderer/core/engine/source'
import { isSubagentActive, mergeSubagentRun, toolStatusLabel } from '@renderer/core/engine/subagent-state'
import { useSubagentRun } from '@renderer/core/engine/subagent-store'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { useHoverDetail } from '@renderer/workbench/useHoverDetail'
import { builtinAgentName } from '@shared/builtin-agents'
import type { ChatFileContext } from '../chat/chat-link'
import { workSubagentName } from './work-subagents'
import { requestWorkSubagent } from './work-subagent-navigation'
import { formatSubagentElapsed, workSubagentTiming } from './work-subagent-timing'
import './work-subagent-card.css'

/** Only process collaboration opts into receipt density; inspector and history
 * cards retain their own presentation and navigation constraints. */
export const WorkSubagentCompactContext = createContext(false)

/** Main conversation cards consume delivered state; only the inspector fetches details. */
export function WorkSubagentCard({ tool, fileContext, active = true }: {
  tool: ToolActivity
  fileContext: ChatFileContext
  active?: boolean
}): JSX.Element {
  const compact = useContext(WorkSubagentCompactContext)
  const reference = tool.subagentRef
  const cached = useSubagentRun(reference ? undefined : tool.subagent?.runId, active && !reference)
  const run = cached ? mergeSubagentRun(tool.subagent, cached) : tool.subagent
  const current = useMemo(() => run ? { ...tool, subagent: run } : tool, [tool, run])
  const name = workSubagentName(current)
  const role = useMemo(() => {
    if (run?.continuation?.builtinRole !== undefined) return builtinAgentName(run.continuation.builtinRole)
    try {
      const args: unknown = JSON.parse(tool.args)
      return args && typeof args === 'object' && 'builtinRole' in args ? builtinAgentName(args.builtinRole) : undefined
    } catch { return undefined }
  }, [run?.continuation?.builtinRole, tool.args])
  const running = !reference && (run ? isSubagentActive(run.status) : tool.state === 'running')
  const rawStatus = toolStatusLabel(current)
  const status = reference && !run ? '已发布' : reference && run && isSubagentActive(run.status) ? '记录时运行中'
    : rawStatus === '成功' ? '已完成' : rawStatus === '运行中' ? '正在运行' : rawStatus
  const failed = !reference && ['失败', '受阻', '已中断'].includes(status)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active || !running) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, running])
  const timing = workSubagentTiming(current, now)
  const identity = run ?? reference?.identity
  const canNavigate = !fileContext.receiptParentSessionId || fileContext.receiptParentSessionId === fileContext.sessionId
  const task = useMemo(() => {
    if (run?.task) return run.task
    try {
      const args: unknown = JSON.parse(tool.args)
      return args && typeof args === 'object' && 'task' in args && typeof args.task === 'string' ? args.task : ''
    } catch { return '' }
  }, [run?.task, tool.args])
  const { triggerProps, tooltip } = useHoverDetail({ enabled: compact && canNavigate, label: name, preferredSide: 'above',
    content: <div className="work-subagent-card__hover">
      <strong>{name}</strong>
      <span>{[role, status, timing.durationText].filter(Boolean).join(' · ')}</span>
      {timing.timestamp ? <span>{timing.timestamp.full}</span> : null}
      {task && task.trim() !== name.trim() ? <p>{task}</p> : null}
    </div> })
  const duration = compact && timing.durationMs !== undefined ? formatSubagentElapsed(timing.durationMs) : timing.durationText
  const heading = <>{compact ? <>
    <span className="work-subagent-card__icon" aria-hidden="true">{running ? <Spinner size={13} /> : <Icon name="account-outline" size={13} />}</span>
    <span className="work-subagent-card__action">{role ? `${role}任务` : '协作任务'}</span>
  </> : null}<span className="work-subagent-card__identity">
    <span className="work-subagent-card__name">{name}</span>
    {role && !compact ? <span className="work-subagent-card__role">{role}</span> : null}
    </span>
    <span className="work-subagent-card__timing" title={[timing.durationText, timing.timestamp?.full].filter(Boolean).join(' · ')}>{duration}</span>
    <span className={`work-subagent-card__status${failed ? ' work-subagent-card__status--failed' : ''}`}>
      {running && !compact ? <Spinner size={12} /> : null}{status}{canNavigate ? <Icon name="chevron-right" size={12} /> : null}
    </span></>
  return <section className={`work-subagent-card${compact ? ' work-subagent-card--compact' : ''}`} data-run-id={run?.runId ?? reference?.identity.runId} data-status={run?.status ?? tool.state}>
    {canNavigate ? <button {...(compact ? triggerProps : {})} type="button" className="work-subagent-card__open" aria-label={`${name}，${role ? `${role}，` : ''}${status}，查看子代理详情`}
      aria-description={timing.summary}
      onClick={() => requestWorkSubagent({ source: getEngineSource(), sessionId: fileContext.sessionId,
        childSessionId: identity?.childSessionId, toolCallId: identity?.parentToolCallId || tool.id,
        publishedRunId: reference?.identity.runId })}>
      {heading}
    </button> : <div className="work-subagent-card__open work-subagent-card__open--static"
      title={compact ? [name, role, status, timing.summary, task].filter(Boolean).join('\n') : undefined}>{heading}</div>}
    {tooltip}
  </section>
}
