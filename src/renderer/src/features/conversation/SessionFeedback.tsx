import { useState, useEffect, type JSX, useRef, useLayoutEffect } from 'react'
import { toolDisplayName } from '@renderer/core/engine/tool-labels'
import { isVisibleToolActivity } from '@renderer/core/engine/task-plan'
import { Icon } from '@renderer/ui/icons'
import { Spinner } from '@renderer/ui/ui-primitives'
import { useHoverDetail } from '@renderer/ui/useHoverDetail'
import { sessionDependencyProgress } from '../sessions/dependency-progress'
import { formatSessionElapsed } from './elapsed'
import { sessionToolTarget } from './message-timeline'
import { sessionSubagentName } from '../collaboration/subagents'
import { sessionWaitingStatus } from './waiting-status'
import { type SessionController, reportError } from '../sessions/session-presentation'

/** Only real engine events change the phase; elapsed time never invents progress. */
function useSessionRunFeedback(controller: SessionController) {
  const [now, setNow] = useState(Date.now)
  const waiting = controller.pending.length > 0
  const recovering = !controller.ready || Boolean(controller.historyRecovery &&
    (controller.historyRecovery.phase === 'blocked' || controller.historyRecovery.failures > 0 &&
      ['connecting', 'retrying'].includes(controller.historyRecovery.phase)))
  const message = controller.messages.findLast((item) => item.role === 'assistant')
  const terminal = !controller.launching && message?.run && !['running', 'waiting'].includes(message.run.status)
  const active = !recovering && !terminal && (controller.streaming || controller.launching || controller.stopping || waiting)
  const current = message && (controller.stopping || ['streaming', 'waiting'].includes(message.status)) ? message : null
  const startedAt = current?.run?.startedAt ?? current?.startedAt ?? current?.createdAt
    ?? (controller.launching ? controller.activeTask?.createdAt : undefined)
  const compacting = current?.run?.compaction?.phase === 'running'
  const dependency = !controller.stopping && !controller.launching && !waiting && !compacting ? sessionDependencyProgress(current?.run) : undefined
  const running = current && !dependency
    ? [...current.tools].reverse().find((tool) => tool.state === 'running' && isVisibleToolActivity(tool))
    : null
  const thinking = current?.items?.at(-1)?.kind === 'thinking' || Boolean(current && !current.items?.length && current.thinking && !current.content && !running)
  const phase = controller.stopping
    ? 'stopping'
    : controller.launching
    ? 'preparing'
    : waiting
      ? 'waiting'
      : compacting
        ? 'compacting'
        : dependency
          ? 'waiting_children'
        : running
          ? 'tool'
          : thinking
            ? 'thinking'
            : current?.content
              ? 'generating'
              : 'processing'
  const label = controller.stopping
    ? '正在停止任务…'
    : controller.launching
    ? '正在准备任务…'
    : waiting
      ? sessionWaitingStatus(controller.pending.filter(item => item.kind === 'ask').length,
          controller.pending.filter(item => item.kind === 'permission').length).label
      : compacting
        ? '正在自动压缩上下文…'
        : dependency
          ? dependency.label
        : running
          ? `${running.name === 'subagent' || running.subagent ? sessionSubagentName(running) : toolDisplayName(running.name)}…`
          : thinking
            ? '正在思考…'
            : current?.content
              ? '正在生成回复…'
              : '等待 Agent 响应…'

  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])

  const seconds = Math.max(0, Math.floor((now - (startedAt ?? now)) / 1000))
  const elapsed = formatSessionElapsed(seconds * 1000)
  return { active, waiting, phase, label, elapsed, seconds, running, dependency }
}

/** The first response must be visible in the conversation, including the
 * preflight before the engine has emitted any assistant text or tool frames. */
export function SessionTurnFeedback({ controller, announce, openActivity, onVisibilityChange }: {
  controller: SessionController
  announce: boolean
  openActivity: (toolId: string) => void
  onVisibilityChange?: (visible: boolean) => void
}): JSX.Element | null {
  // Keep this card in the scroll flow. Removing it when the footer appears
  // changes the bottom distance and can repeatedly switch the two surfaces.
  const feedback = useSessionRunFeedback(controller)
  const headingRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!onVisibilityChange) return
    const heading = headingRef.current
    const viewport = heading?.closest<HTMLElement>('.work-conversation__scroll')
    if (!feedback.active || !heading || !viewport) {
      onVisibilityChange(false)
      return
    }
    // The heading contains phase, stop and time. A long activity description
    // below it must not cause a second copy of those already visible controls.
    const measure = (): boolean => {
      const bounds = heading.getBoundingClientRect(), root = viewport.getBoundingClientRect()
      const left = root.left + viewport.clientLeft, top = root.top + viewport.clientTop
      const width = Math.max(0, Math.min(bounds.right, left + viewport.clientWidth) - Math.max(bounds.left, left))
      const height = Math.max(0, Math.min(bounds.bottom, top + viewport.clientHeight) - Math.max(bounds.top, top))
      return bounds.width > 0 && bounds.height > 0 && width * height / (bounds.width * bounds.height) >= 0.99
    }
    onVisibilityChange(measure())
    const observer = new IntersectionObserver(entries => {
      const entry = entries.at(-1)
      if (entry) onVisibilityChange(entry.isIntersecting && entry.intersectionRatio >= 0.99)
    }, { root: viewport, threshold: [0, 0.99, 1] })
    observer.observe(heading)
    return () => observer.disconnect()
  }, [feedback.active, controller.activeTask?.id, onVisibilityChange])
  const target = feedback.running ? sessionToolTarget(feedback.running, controller.workspacePath) : ''
  const fullTarget = feedback.running ? sessionToolTarget(feedback.running, undefined, true) : ''
  const activityLabel = feedback.running ? toolDisplayName(feedback.running.name) : ''
  const { triggerProps, tooltip } = useHoverDetail({ enabled: feedback.active && Boolean(fullTarget), label: activityLabel,
    content: <><div className="logline-hover__heading"><strong>{activityLabel}</strong></div><div className="logline-hover__target">{fullTarget}</div></> })
  if (!feedback.active) return null
  const agentName = feedback.running && (feedback.running.name === 'subagent' || feedback.running.subagent)
    ? sessionSubagentName(feedback.running)
    : controller.agentIdentity.name || 'Agent'
  const detail = feedback.phase === 'stopping'
    ? '正在停止当前任务，已生成的内容会保留。'
    : feedback.phase === 'preparing'
    ? '正在连接任务会话，准备开始执行。'
    : feedback.phase === 'waiting'
      ? '请回复上方的问题或确认请求，任务会继续执行。'
      : feedback.phase === 'compacting'
        ? '正在整理上下文，完成后继续当前任务。'
        : feedback.dependency
          ? feedback.dependency.detail
        : feedback.phase === 'thinking'
          ? 'Agent 已开始分析任务，结果会接着显示在这里。'
          : feedback.phase === 'generating'
            ? '回复正在生成，可以随时停止。'
            : feedback.phase === 'tool'
              ? target || '正在执行操作，点击可查看活动详情。'
              : feedback.seconds >= 15
                ? '暂未收到回复内容，可以继续等待或停止任务。'
                : '任务已发送，正在等待首个响应。'
  return (
    <><div className="work-turn-feedback" data-phase={feedback.phase} data-state={feedback.waiting ? 'waiting' : 'running'} data-current-run-feedback={announce ? 'true' : undefined} aria-label="Agent 执行反馈">
      <span className="work-turn-feedback__indicator" aria-hidden="true">
        {feedback.waiting ? <Icon name="chat" size={16} /> : <Spinner size={16} />}
      </span>
      <div className="work-turn-feedback__body">
        <div ref={headingRef} className="work-turn-feedback__heading">
          <strong title={agentName}>{agentName}</strong>
          <span role="status" aria-live={announce ? 'polite' : 'off'} aria-atomic="true" aria-label={feedback.dependency?.accessibleLabel ?? '任务运行状态'}>{feedback.label}</span>
          <div className="work-turn-feedback__controls">
            <SessionRootStop controller={controller} compact />
            <span className="work-turn-feedback__elapsed" title="本轮累计用时（含等待）">{feedback.elapsed}</span>
          </div>
        </div>
        {feedback.running ? (
          <button {...triggerProps} type="button" className="work-turn-feedback__activity" aria-label="查看正在执行的活动" onClick={() => openActivity(feedback.running!.id)}>
            <span>{detail}</span><Icon name="chevron-right" size={12} />
          </button>
        ) : <p>{detail}</p>}
      </div>
    </div>{tooltip}</>
  )
}

/** Root cancellation stays discoverable when the conversation pane is hidden. */
export function SessionRootStop({ controller, compact = false }: { controller: SessionController; compact?: boolean }): JSX.Element | null {
  const stopping = controller.stopping
  const terminal = controller.currentRun && !['running', 'waiting'].includes(controller.currentRun.status)
  const active = controller.pendingInitialStart || controller.launching || !terminal &&
    (controller.streaming || stopping || controller.pending.length > 0 || ['running', 'waiting'].includes(controller.activeTask?.status ?? ''))
  if (!active) return null
  return <button className={compact ? 'work-quiet-button work-run-stop' : 'btn btn--sm'} type="button"
    aria-label={stopping ? '正在停止任务' : '停止任务'} aria-busy={stopping} title={stopping ? '正在停止任务' : '停止当前任务'}
    disabled={!controller.ready || stopping} onClick={() => {
    if (stopping) return
    void controller.stop().catch(reportError)
  }}>
    {stopping ? <Spinner size={13} /> : <Icon name="stop" size={13} />}
    {compact ? stopping ? '停止中' : '停止' : stopping ? '正在停止…' : '停止任务'}
  </button>
}

/** Reading earlier messages keeps one compact status beside the composer. */
export function SessionRunStatus({ controller }: { controller: SessionController }): JSX.Element | null {
  const feedback = useSessionRunFeedback(controller)
  if (!feedback.active) return null
  const { waiting, elapsed } = feedback
  return (
    <div
      className="work-run-status"
      data-current-run-feedback="true"
      data-state={waiting ? 'waiting' : 'running'}
      data-phase={feedback.phase}
    >
      <div
        className="work-run-status__label"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={feedback.dependency?.accessibleLabel ?? '任务运行状态'}
        title={feedback.dependency?.detail}
      >
        {waiting ? <Icon name="chat" size={14} /> : <Spinner size={13} />}
        <span>{feedback.dependency ? feedback.dependency.accessibleLabel : feedback.label}</span>
      </div>
      <SessionRootStop controller={controller} compact />
      <span className="work-run-status__elapsed" title="本轮累计用时（含等待）">
        {elapsed}
      </span>
    </div>
  )
}
