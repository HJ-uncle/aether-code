import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX, type MouseEvent } from 'react'
import { useApp } from '@renderer/core/app-context'
import { getEngineSource, subscribeEngineSource } from '@renderer/core/engine/source'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { isVisibleToolActivity } from '@renderer/core/engine/task-plan'
import type { SubagentToolCall } from '@shared/subagent'
import { getSubagentProtocol, stopSubagent } from '@renderer/core/engine/client'
import {
  isSubagentActive,
  mergeSubagentRun,
  subagentStopReasonLabel,
  toolStatusLabel
} from '@renderer/core/engine/subagent-state'
import {
  refreshSubagentRun,
  requestSubagentCancellation,
  captureSubagentRunScope,
  useSubagentRun
} from '@renderer/core/engine/subagent-store'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { Markdown } from './Markdown'
import { WorkErrorNotice } from '../work/WorkErrorNotice'
import { getSessionMeta } from '../history/session-meta'
import { toolDisplayName } from './tool-names'
import { SubagentToolHistory, SubagentToolRow } from './SubagentToolHistory'
import { canPageSubagentHistory, subagentToolPresentation } from './subagent-tool-presentation'
import { useCollapseMemory } from './useCollapseMemory'
import { formatTokens } from './usage'
import { readPublishedChild } from '@renderer/core/engine/published-snapshot-client'
import type { SubagentRun } from '@shared/subagent'
import { CodePublishedSubagentControl, CodeSubagentFollowup } from './SubagentFollowup'

type SubagentCardProps = { tool: ToolActivity; sessionId: string; defaultOpen?: boolean; visible?: boolean;
  onPublishedLoaded?: (run: SubagentRun, reference: import('@shared/published-child').PublishedChildReference) => void }

/** Recovery cards load only when requested and keep their published watermark. */
export function SubagentCard(props: SubagentCardProps): JSX.Element {
  const ref = props.tool.subagentRef
  const card = ref && !props.tool.subagent ? <PublishedReferenceCard key={JSON.stringify([ref.source, ref.sessionId, ref.snapshotId, ref.identity.runId, ref.atSeq, ref.projectionIndex])} {...props} /> : <SubagentRunCard {...props} />
  return <>{card}{ref ? <CodePublishedSubagentControl reference={ref} visible={props.visible !== false} /> : null}</>
}

function PublishedReferenceCard(props: SubagentCardProps): JSX.Element {
  const reference = props.tool.subagentRef!
  const key = JSON.stringify([reference.source, reference.sessionId, reference.snapshotId, reference.identity.runId, reference.atSeq, reference.projectionIndex])
  const [state, setState] = useState<{ key: string; loading: boolean; error?: string; run?: SubagentRun }>({ key, loading: false })
  const pending = useRef<Promise<void> | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const loaded = state.key === key ? state : undefined
  const read = (): void => {
    if (pending.current || loaded?.loading || props.visible === false) return
    setState({ key, loading: true })
    const operation = readPublishedChild(reference).then(run => {
      if (mounted.current) { setState({ key, loading: false, run }); props.onPublishedLoaded?.(run, reference) }
    }).catch((error: unknown) => {
      if (mounted.current) setState({ key, loading: false, error: error instanceof Error ? error.message : '记录读取失败，请重试' })
    }).finally(() => { if (pending.current === operation) pending.current = null })
    pending.current = operation
  }
  if (loaded?.run) return <SubagentRunCard {...props} tool={{ ...props.tool, subagent: loaded.run }} />
  return <section className="subagent-card subagent-card--published" data-published-run={reference.identity.runId} data-published-seq={reference.atSeq} aria-busy={loaded?.loading === true}>
    <button type="button" className="subagent-card__header" onClick={read} disabled={loaded?.loading || props.visible === false}
      aria-label={`查看 ${reference.identity.agentName || '子代理'} 的已发布记录`}>
      <span className="subagent-card__dot"><Icon name="account-outline" size={16} /></span>
      <span className="subagent-card__name">{reference.identity.agentName || '子代理'}</span>
      <span className="subagent-card__task">{loaded?.loading ? '正在读取记录…' : loaded?.error ? '读取失败，点击重试' : '点击查看已发布记录'}</span>
      <span className="subagent-card__stopped">记录 #{reference.atSeq}</span>
      <Icon name="chevron" size={16} />
    </button>
    {loaded?.error ? <WorkErrorNotice error={loaded.error} /> : null}
  </section>
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Legacy markers only supply details; they cannot prove that an old task succeeded. */
function parseLegacy(result: string): {
  text: string
  calls: SubagentToolCall[]
  tokens?: number
  durationMs?: number
} {
  const index = result.lastIndexOf('__SUBAGENT_META__')
  if (index < 0) return { text: result, calls: [] }
  const meta = parseObject(result.slice(index + '__SUBAGENT_META__'.length))
  if (!Array.isArray(meta.toolCalls)) return { text: result, calls: [] }
  const calls: SubagentToolCall[] = []
  for (const [i, raw] of meta.toolCalls.entries()) {
    if (!raw || typeof raw !== 'object') continue
    const call = raw as Record<string, unknown>
    if (typeof call.name !== 'string') continue
    calls.push({
      id: `legacy-${i}`,
      name: call.name,
      args: call.summary ?? '',
      status: call.success === false ? 'failed' : 'succeeded'
    })
  }
  return {
    text: result.slice(0, index).trim(),
    calls,
    tokens: typeof meta.tokens === 'number' ? meta.tokens : undefined,
    durationMs: typeof meta.durationMs === 'number' ? meta.durationMs : undefined
  }
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

/** The run is the authority; a closed parent stream is not a child completion signal. */
function SubagentRunCard({
  tool,
  sessionId,
  defaultOpen,
  visible = true
}: {
  tool: ToolActivity
  sessionId: string
  defaultOpen?: boolean
  /** Hidden retained Work panes keep local state without polling or clocks. */
  visible?: boolean
}): JSX.Element {
  const { engine, ready } = useApp()
  const remoteReadOnly = engine.snapshot.mode === 'remote'
  const sourceEpoch = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const pinned = Boolean(tool.subagentRef)
  const cached = useSubagentRun(pinned ? undefined : tool.subagent?.runId, visible && !pinned)
  const run = cached ? mergeSubagentRun(tool.subagent, cached) : tool.subagent
  const args = useMemo(() => parseObject(tool.args), [tool.args])
  const legacy = useMemo(() => parseLegacy(tool.result), [tool.result])
  const [manualOpen, setManualOpen] = useCollapseMemory(`subagent:${tool.id}`)
  const [goalExpanded, setGoalExpanded] = useState(false)
  // 「执行详情」折叠：默认收起，点开后跨重建记住用户选择
  const [toolsManual, setToolsManual] = useCollapseMemory(`subagent-tools:${tool.id}`)
  const [requesting, setRequesting] = useState(false)
  const [requestError, setRequestError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [historyProtocol, setHistoryProtocol] = useState<{ source: number; runId: string; protocol: 1 | 2 | null; loading: boolean; error: string } | null>(null)
  const [historyRetry, setHistoryRetry] = useState(0)
  const historyPending = useRef(false)
  const [now, setNow] = useState(Date.now)
  const operationEpoch = useRef(0)
  const active = run ? isSubagentActive(run.status) : tool.state === 'running'
  const cancelling = run?.status === 'cancelling'
  const failed = run
    ? ['failed', 'blocked', 'interrupted'].includes(run.status)
    : tool.state === 'error'
  const open = manualOpen ?? defaultOpen ?? (active || failed)
  const status = toolStatusLabel(run ? { ...tool, subagent: run } : tool)
  const reason = run?.error?.message || tool.error || (failed && !run ? legacy.text : '')
  const goal = run?.task || (typeof args.task === 'string' ? args.task : '')
  const title =
    run?.description ||
    (typeof args.description === 'string' ? args.description : '') ||
    goal.replace(/\s+/g, ' ').slice(0, 60) ||
    '子代理任务'
  const agentLabel = run?.agentName?.trim() || '子代理'
  const presentation = useMemo(() => subagentToolPresentation(run, legacy.calls), [run, legacy.calls])
  const { calls, countLabel } = presentation
  const totalCalls = presentation.complete ? calls.length : presentation.historyCount
  const historyState = historyProtocol?.source === sourceEpoch && historyProtocol.runId === run?.runId ? historyProtocol : null
  const protocol = historyState?.protocol ?? null
  const historyError = historyState?.error ?? ''
  const historyLoading = historyState?.loading ?? Boolean(ready && run?.runId)
  const result = run?.resultSummary || run?.partialOutput || legacy.text
  const elapsed =
    active && (run?.startedAt ?? tool.startedAt)
      ? now - (run?.startedAt ?? tool.startedAt ?? now)
      : (run?.durationMs ??
        (run?.finishedAt && run.startedAt ? run.finishedAt - run.startedAt : legacy.durationMs))
  const tokens = run ? run.usage.totalTokens : legacy.tokens
  const tokenLabel = run?.usage.unknown
    ? '未知'
    : tokens === undefined
      ? '未记录'
      : `${run?.usage.estimated ? '约 ' : ''}${formatTokens(tokens)}`
  const failures = calls.filter((call) => call.status === 'failed').length
  const latestCall = run?.schemaVersion === 2 && run.latestActivity && isVisibleToolActivity(run.latestActivity) ? run.latestActivity : undefined
  const currentCall = latestCall?.status === 'running' ? latestCall : [...calls].sort((a, b) =>
    ('revisionSeq' in b && typeof b.revisionSeq === 'number' ? b.revisionSeq : b.startedAt ?? 0) -
    ('revisionSeq' in a && typeof a.revisionSeq === 'number' ? a.revisionSeq : a.startedAt ?? 0)).find(call => call.status === 'running')

  // 「执行详情」折叠态：默认收起（运行进展由「当前：xxx」行露出）；用户点过后以用户为准
  const toolsCollapsed = toolsManual ?? true
  const workspaceRoot = getSessionMeta(sessionId).workspacePath
  const fileContext = useMemo(() => ({ sessionId, workspaceRoot }), [sessionId, workspaceRoot])

  /** 收起态按类型统计：「读取文件 × 5 · 搜索内容 × 78…」，最多露 3 类 */
  const toolsTypeSummary = useMemo(() => {
    const counts = new Map<string, number>()
    for (const call of calls) {
      const name = toolDisplayName(call.name)
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    const parts = [...counts.entries()].map(([name, n]) => `${name} × ${n}`)
    if (parts.length <= 3) return parts.join(' · ')
    return `${parts.slice(0, 3).join(' · ')} 等`
  }, [calls])

  useEffect(() => {
    if (!active || !visible || pinned) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, visible, pinned])

  useEffect(() => {
    operationEpoch.current++
    setRequesting(false)
    setRequestError('')
    setDetailError('')
    return () => { operationEpoch.current++ }
  }, [sessionId, run?.runId, sourceEpoch])

  useEffect(() => {
    if (!visible) return
    if (!ready || !run?.runId) {
      historyPending.current = false
      setHistoryProtocol(null)
      return
    }
    let alive = true
    const runId = run.runId
    historyPending.current = true
    setHistoryProtocol(previous => ({ source: sourceEpoch, runId, protocol: null, loading: true,
      error: previous?.source === sourceEpoch && previous.runId === runId ? previous.error : '' }))
    void getSubagentProtocol().then(protocol => {
      if (alive && sourceEpoch === getEngineSource()) setHistoryProtocol({ source: sourceEpoch, runId, protocol, loading: false, error: '' })
    }).catch((error: unknown) => {
      if (alive && sourceEpoch === getEngineSource()) setHistoryProtocol({ source: sourceEpoch, runId, protocol: null, loading: false,
        error: `记录读取失败：${error instanceof Error ? error.message : String(error)}` })
    }).finally(() => {
      if (alive && sourceEpoch === getEngineSource()) historyPending.current = false
    })
    return () => { alive = false }
  }, [run?.runId, sourceEpoch, ready, historyRetry, visible])

  const retryHistory = (): void => {
    if (!ready || !run?.runId || historyPending.current || sourceEpoch !== getEngineSource()) return
    historyPending.current = true
    setHistoryProtocol({ source: sourceEpoch, runId: run.runId, protocol: null, loading: true, error: historyError })
    setHistoryRetry(value => value + 1)
  }

  useEffect(() => {
    if (!visible || !open || !ready || !run?.runId || pinned) return
    let alive = true
    void refreshSubagentRun(run.runId, captureSubagentRunScope(run, sourceEpoch))
      .then(() => {
        if (alive) setDetailError('')
      })
      .catch((error: unknown) => {
        if (alive)
          setDetailError(`详情更新失败：${error instanceof Error ? error.message : String(error)}`)
      })
    return () => {
      alive = false
    }
  }, [open, run?.runId, sourceEpoch, ready, visible, pinned])

  const cancel = async (event: MouseEvent): Promise<void> => {
    event.preventDefault()
    event.stopPropagation()
    if (!ready || sourceEpoch !== getEngineSource() || requesting || cancelling || !active) return
    setRequestError('')
    setRequesting(true)
    const epoch = operationEpoch.current
    try {
      if (run) await requestSubagentCancellation(run.runId, captureSubagentRunScope(run, sourceEpoch))
      else {
        const result = await stopSubagent({ sessionId, toolCallId: tool.id })
        if (!result.ok || !result.data?.cancelled)
          throw new Error(result.message || '引擎未确认停止请求')
      }
    } catch (error) {
      if (epoch === operationEpoch.current && sourceEpoch === getEngineSource()) setRequestError(`停止失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (epoch === operationEpoch.current && sourceEpoch === getEngineSource()) setRequesting(false)
    }
  }

  return (
    <details
      className="subagent-card"
      open={open}
      data-run-id={run?.runId}
      data-status={run?.status ?? tool.state}
      data-published-seq={tool.subagentRef?.atSeq}
    >
      <summary
        onClick={(event) => {
          event.preventDefault()
          setManualOpen(!open)
        }}
      >
        <span className={`subagent-card__dot${failed ? ' subagent-card__dot--fail' : ''}`}>
          {active && !pinned ? <Spinner size={12} className="subagent-card__spinner" /> : <Icon name="circle" size={16} />}
        </span>
        <span className="subagent-card__name" title={agentLabel}>{remoteReadOnly ? `远端 · ${agentLabel}` : agentLabel}</span>
        <span className="subagent-card__task" title={goal}>
          {title}
        </span>
        <span className={failed ? 'subagent-card__fail' : 'subagent-card__stopped'}>{pinned ? `已发布 · ${active ? '记录时运行中' : status}` : status}</span>
        <span className="subagent-card__stats">
          {countLabel} · {tokenLabel} tokens
          {elapsed !== undefined ? ` · ${duration(elapsed)}` : ''}
        </span>
        {active && !pinned ? (
          <button
            type="button"
            className="subagent-card__stop"
            title="停止子代理"
            aria-label="停止子代理"
            disabled={!ready || requesting || cancelling}
            onClick={(event) => {
              void cancel(event)
            }}
          >
            <Icon name="close" size={16} />
            {requesting || cancelling ? '取消中…' : '停止此 Agent'}
          </button>
        ) : null}
        <Icon name="chevron" size={16} />
      </summary>

      {reason ? (
        <WorkErrorNotice error={reason} />
      ) : null}
      {requestError ? (
        <WorkErrorNotice error={requestError} />
      ) : null}
      {detailError ? <WorkErrorNotice error={detailError} /> : null}
      {historyError ? <div className="subagent-history__error" role="alert">
        {historyError}<button type="button" disabled={!ready || historyLoading} onClick={retryHistory}>
          {historyLoading ? '正在重试…' : '重试读取'}
        </button>
      </div> : null}
      {run?.stopReason ? (
        <div className="subagent-card__running">
          结束原因：{subagentStopReasonLabel(run.stopReason)}
        </div>
      ) : null}
      {run?.externalEffectStatus === 'unknown' ? (
        <div className="subagent-card__running">已停止本地执行；外部操作结果可能未知</div>
      ) : null}

      {/* 目标任务：淡背景块，默认两行截断，点开看全文（对齐 wuzu：亮出原文才能核对父有没有写清目标） */}
      <div className="subagent-card__goal-block">
        <div className="subagent-card__goal-label">目标任务</div>
        <div className="subagent-card__goal-inner">
          {goalExpanded ? (
            <pre className="subagent-card__goal-text">{goal || '（未提供任务描述）'}</pre>
          ) : (
            <div className="subagent-card__goal-text subagent-card__goal-text--clamp">
              {goal || '（未提供任务描述）'}
            </div>
          )}
          {goal.length > 200 ? (
            <button
              type="button"
              className="subagent-card__goal-toggle"
              onClick={() => setGoalExpanded(!goalExpanded)}
            >
              {goalExpanded ? '收起' : '展开全文'}
            </button>
          ) : null}
        </div>
      </div>

      {currentCall ? (
        <div className="subagent-card__running">{pinned ? '记录时' : '当前'}：{toolDisplayName(currentCall.name)}</div>
      ) : active && presentation.unseenActiveCount > 0 ? <div className="subagent-card__running">{pinned ? '记录时仍有活动，详情可按需查看。' : '正在执行任务，详情可按需查看。'}</div> : latestCall ? <div className="subagent-card__running">最近：{toolDisplayName(latestCall.name)} · {latestCall.status === 'succeeded' ? '成功' : latestCall.status === 'cancelled' ? '已取消' : '失败'}</div> : null}

      {/* 执行详情：默认收起一行（按类型统计），展开是紧凑日志行（对齐 wuzu） */}
      {totalCalls === 0 ? (
        <div className="subagent-card__running">
          {active ? pinned ? '此记录保存时，子代理仍在执行。' : '子代理正在执行任务…' : '没有可显示的工具调用记录'}
        </div>
      ) : (
        <div className="subagent-card__tools-block">
          <button
            type="button"
            className="subagent-card__tools-header"
            onClick={() => setToolsManual(toolsCollapsed ? false : true)}
          >
            <Icon name={toolsCollapsed ? 'chevron-right' : 'chevron-down'} size={16} />
            <span>执行详情 · {countLabel}</span>
            {toolsCollapsed && toolsTypeSummary ? (
              <span className="subagent-card__tools-summary">{run?.schemaVersion === 2 && run.coverage.hasMore ? '最近记录：' : ''}{toolsTypeSummary}</span>
            ) : null}
            {failures > 0 ? (
              <span className="subagent-card__fail"> · {failures} 项已显示记录失败</span>
            ) : null}
          </button>
          {open && !toolsCollapsed ? (
            run?.schemaVersion === 2 && canPageSubagentHistory(run, protocol) ? <SubagentToolHistory run={run} /> : <div className="subagent-card__tools-list">
              {run && historyLoading ? <p className="subagent-history__notice" role="status">正在确认记录读取方式…</p> : null}
              {run && !ready ? <p className="subagent-history__notice">当前显示已保存的记录，连接引擎后可读取更多历史。</p> : null}
              {run && protocol === 1 ? <p className="subagent-history__notice">当前引擎仅支持已有工具记录，升级引擎后可按需加载历史与详情。</p> : null}
              {calls.map((call) => (
                <SubagentToolRow key={call.id} call={call} />
              ))}
            </div>
          ) : null}
        </div>
      )}

      {/* 返回结果：实背景块，产出主体（对齐 wuzu：与过程记录拉开层次） */}
      {open && visible && result ? (
        <div className="subagent-card__result-block">
          <div className="subagent-card__result-label">
            {run?.partialOutput && !run.resultSummary ? '部分结果' : '返回结果'}
          </div>
          <div className="subagent-card__result-inner">
            {failed ? (
              <WorkErrorNotice error={result} className="work-error-notice--subagent" />
            ) : (
              <div className="subagent-card__result-markdown">
                <Markdown text={result} fileContext={fileContext} />
              </div>
            )}
          </div>
        </div>
      ) : null}
      {!pinned && run ? <CodeSubagentFollowup run={run} sessionId={sessionId} source={sourceEpoch} visible={visible} /> : null}
      <div className="subagent-card__footer">
        {run?.modelId ? <span>模型 {run.modelId}</span> : null}
        <span>{countLabel}</span>
        <span>Tokens {tokenLabel}</span>
        {elapsed !== undefined ? <span>耗时 {duration(elapsed)}</span> : null}
      </div>
    </details>
  )
}
