import { useEffect, useMemo, useState, type JSX } from 'react'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { getEngineSource } from '@renderer/core/engine/source'
import { isSubagentActive, mergeSubagentRun, toolStatusLabel } from '@renderer/core/engine/subagent-state'
import { useSubagentRun } from '@renderer/core/engine/subagent-store'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { builtinAgentName } from '@shared/builtin-agents'
import type { ChatFileContext } from '../chat/chat-link'
import { workSubagentName } from './work-subagents'
import { requestWorkSubagent } from './work-subagent-navigation'
import { workSubagentTiming } from './work-subagent-timing'
import './work-subagent-card.css'

/** Main conversation cards consume delivered state; only the inspector fetches details. */
export function WorkSubagentCard({ tool, fileContext, active = true }: {
  tool: ToolActivity
  fileContext: ChatFileContext
  active?: boolean
}): JSX.Element {
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
  const heading = <><span className="work-subagent-card__identity">
    <span className="work-subagent-card__name">{name}</span>
    {role ? <span className="work-subagent-card__role">{role}</span> : null}
    </span>
    <span className="work-subagent-card__timing" title={[timing.durationText, timing.timestamp?.full].filter(Boolean).join(' · ')}>{timing.durationText}</span>
    <span className={`work-subagent-card__status${failed ? ' work-subagent-card__status--failed' : ''}`}>
      {running ? <Spinner size={12} /> : null}{status}{canNavigate ? <Icon name="chevron-right" size={12} /> : null}
    </span></>
  return <section className="work-subagent-card" data-run-id={run?.runId ?? reference?.identity.runId} data-status={run?.status ?? tool.state}>
    {canNavigate ? <button type="button" className="work-subagent-card__open" aria-label={`${name}，${role ? `${role}，` : ''}${status}，查看子代理详情`}
      aria-description={timing.summary}
      onClick={() => requestWorkSubagent({ source: getEngineSource(), sessionId: fileContext.sessionId,
        childSessionId: identity?.childSessionId, toolCallId: identity?.parentToolCallId || tool.id,
        publishedRunId: reference?.identity.runId })}>
      {heading}
    </button> : <div className="work-subagent-card__open work-subagent-card__open--static">{heading}</div>}
  </section>
}
