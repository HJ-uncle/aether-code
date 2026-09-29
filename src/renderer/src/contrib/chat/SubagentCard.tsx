import { useEffect, useMemo, useState, type JSX, type MouseEvent } from 'react'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import type { SubagentToolCall } from '@shared/subagent'
import { stopSubagent } from '@renderer/core/engine/client'
import {
  isSubagentActive,
  mergeSubagentRun,
  subagentStopReasonLabel,
  toolStatusLabel
} from '@renderer/core/engine/subagent-state'
import {
  refreshSubagentRun,
  requestSubagentCancellation,
  useSubagentRun
} from '@renderer/core/engine/subagent-store'
import { Icon } from '@renderer/workbench/icons'
import { Markdown } from './Markdown'
import { toolDisplayName, toolParamSummary } from './tool-names'
import { useCollapseMemory } from './useCollapseMemory'
import { formatTokens } from './usage'

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

function readable(value: unknown): string {
  if (typeof value === 'string') return value
  return value == null ? '' : JSON.stringify(value, null, 2)
}

/** 行内参数摘要：args 是对象时先序列化再交给 toolParamSummary 提关键参数（避免 String(obj) → [object Object]） */
function argsSummary(args: unknown): string {
  if (args == null) return ''
  const json = typeof args === 'string' ? args : JSON.stringify(args)
  return toolParamSummary(json)
}
function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

/**
 * 紧凑工具调用行（对齐 wuzu-client 的 CliCompactToolRow）：
 * 圆点 + 名称 · 状态 + 摘要，一行 24px；点击展开看入参与输出。
 */
function CompactToolRow({ call }: { call: SubagentToolCall }): JSX.Element {
  const [open, setOpen] = useState(false)
  const statusText =
    call.status === 'failed'
      ? '失败'
      : call.status === 'succeeded'
        ? '成功'
        : call.status === 'cancelled'
          ? '已取消'
          : '执行中'
  return (
    <div className="subagent-card__call">
      <span
        className={`subagent-card__call-dot${call.status === 'failed' ? ' subagent-card__call-dot--fail' : ''}`}
      />
      <button
        type="button"
        className="subagent-card__call-toggle"
        onClick={() => setOpen(!open)}
      >
        <span className="subagent-card__call-name">{toolDisplayName(call.name)}</span>
        <span className="subagent-card__call-summary">· {statusText}</span>
        {argsSummary(call.args) ? (
          <span className="subagent-card__call-args">{argsSummary(call.args)}</span>
        ) : null}
      </button>
      {open ? (
        <div className="subagent-card__call-detail">
          {call.args != null && call.args !== '' ? (
            <>
              <div className="subagent-card__call-section">参数</div>
              <pre className="subagent-card__call-pre">{readable(call.args)}</pre>
            </>
          ) : null}
          {call.error ? <div className="message__error">{call.error.message}</div> : null}
          {call.output ? (
            <>
              <div className="subagent-card__call-section">输出</div>
              <pre className="subagent-card__call-pre">{call.output}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** The run is the authority; a closed parent stream is not a child completion signal. */
export function SubagentCard({
  tool,
  sessionId
}: {
  tool: ToolActivity
  sessionId: string
}): JSX.Element {
  const cached = useSubagentRun(tool.subagent?.runId)
  const run = cached ? mergeSubagentRun(tool.subagent, cached) : tool.subagent
  const args = useMemo(() => parseObject(tool.args), [tool.args])
  const legacy = useMemo(() => parseLegacy(tool.result), [tool.result])
  const [manualOpen, setManualOpen] = useCollapseMemory(`subagent:${tool.id}`)
  const [goalExpanded, setGoalExpanded] = useState(false)
  // 「执行详情」折叠：运行中自动展开看进展、结束自动收起；用户点过后以用户为准（跨重建记忆）
  const [toolsManual, setToolsManual] = useCollapseMemory(`subagent-tools:${tool.id}`)
  const [requesting, setRequesting] = useState(false)
  const [requestError, setRequestError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [now, setNow] = useState(Date.now)
  const active = run ? isSubagentActive(run.status) : tool.state === 'running'
  const cancelling = run?.status === 'cancelling'
  const failed = run
    ? ['failed', 'blocked', 'interrupted'].includes(run.status)
    : tool.state === 'error'
  const open = manualOpen ?? (active || failed)
  const status = toolStatusLabel(run ? { ...tool, subagent: run } : tool)
  const reason = run?.error?.message || tool.error || (failed && !run ? legacy.text : '')
  const goal = run?.task || (typeof args.task === 'string' ? args.task : '')
  const title =
    run?.description ||
    (typeof args.description === 'string' ? args.description : '') ||
    goal.replace(/\s+/g, ' ').slice(0, 60) ||
    '子代理任务'
  const calls = run?.toolCalls ?? legacy.calls
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
  const currentCall = [...calls].reverse().find((call) => call.status === 'running')

  // 「执行详情」折叠态：运行中自动展开看进展，结束自动收起；用户点过后以用户为准
  const toolsCollapsed = toolsManual ?? !active

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
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])

  useEffect(() => {
    if (!open || !run?.runId) return
    let alive = true
    void refreshSubagentRun(run.runId)
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
  }, [open, run?.runId])

  const cancel = async (event: MouseEvent): Promise<void> => {
    event.preventDefault()
    event.stopPropagation()
    if (requesting || cancelling || !active) return
    setRequestError('')
    setRequesting(true)
    try {
      if (run) await requestSubagentCancellation(run.runId)
      else {
        const result = await stopSubagent({ sessionId, toolCallId: tool.id })
        if (!result.ok || !result.data?.cancelled)
          throw new Error(result.message || '引擎未确认停止请求')
      }
    } catch (error) {
      setRequestError(`停止失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setRequesting(false)
    }
  }

  return (
    <details
      className="subagent-card"
      open={open}
      data-run-id={run?.runId}
      data-status={run?.status ?? tool.state}
    >
      <summary
        onClick={(event) => {
          event.preventDefault()
          setManualOpen(!open)
        }}
      >
        <span className={`subagent-card__dot${failed ? ' subagent-card__dot--fail' : ''}`}>
          {active ? <span className="subagent-card__spinner" /> : <Icon name="circle" size={16} />}
        </span>
        <span className="subagent-card__name">子代理</span>
        <span className="subagent-card__task" title={goal}>
          {title}
        </span>
        <span className={failed ? 'subagent-card__fail' : 'subagent-card__stopped'}>{status}</span>
        <span className="subagent-card__stats">
          {calls.length} 次调用 · {tokenLabel} tokens
          {elapsed !== undefined ? ` · ${duration(elapsed)}` : ''}
        </span>
        {active ? (
          <button
            type="button"
            className="subagent-card__stop"
            title="停止子代理"
            aria-label="停止子代理"
            disabled={requesting || cancelling}
            onClick={(event) => {
              void cancel(event)
            }}
          >
            <Icon name="close" size={16} />
            {requesting || cancelling ? '取消中…' : '停止'}
          </button>
        ) : null}
        <Icon name="chevron" size={16} />
      </summary>

      {reason ? (
        <div className="message__error" role="alert">
          {reason}
        </div>
      ) : null}
      {requestError ? (
        <div className="message__error" role="alert">
          {requestError}
        </div>
      ) : null}
      {detailError ? <div className="message__error">{detailError}</div> : null}
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
        <div className="subagent-card__running">当前：{toolDisplayName(currentCall.name)}</div>
      ) : null}

      {/* 执行详情：默认收起一行（按类型统计），展开是紧凑日志行（对齐 wuzu） */}
      {calls.length === 0 ? (
        <div className="subagent-card__running">
          {active ? '子代理正在启动…' : '没有内部工具调用记录'}
        </div>
      ) : (
        <div className="subagent-card__tools-block">
          <button
            type="button"
            className="subagent-card__tools-header"
            onClick={() => setToolsManual(toolsCollapsed ? false : true)}
          >
            <Icon name={toolsCollapsed ? 'chevron-right' : 'chevron-down'} size={16} />
            <span>执行详情 · 工具调用 {calls.length}</span>
            {toolsCollapsed && toolsTypeSummary ? (
              <span className="subagent-card__tools-summary">{toolsTypeSummary}</span>
            ) : null}
            {failures > 0 ? (
              <span className="subagent-card__fail"> · {failures} 失败</span>
            ) : null}
          </button>
          {!toolsCollapsed ? (
            <div className="subagent-card__tools-list">
              {calls.map((call) => (
                <CompactToolRow key={call.id} call={call} />
              ))}
            </div>
          ) : null}
        </div>
      )}

      {/* 返回结果：实背景块，产出主体（对齐 wuzu：与过程记录拉开层次） */}
      {result ? (
        <div className="subagent-card__result-block">
          <div className="subagent-card__result-label">
            {run?.partialOutput && !run.resultSummary ? '部分结果' : '返回结果'}
          </div>
          <div className="subagent-card__result-inner">
            {failed ? (
              <pre className="subagent-card__result-text subagent-card__result-text--error">
                {result}
              </pre>
            ) : (
              <div className="subagent-card__result-markdown">
                <Markdown text={result} />
              </div>
            )}
          </div>
        </div>
      ) : null}
      <div className="subagent-card__footer">
        {run?.modelId ? <span>模型 {run.modelId}</span> : null}
        <span>工具调用 {calls.length}</span>
        <span>Tokens {tokenLabel}</span>
        {elapsed !== undefined ? <span>耗时 {duration(elapsed)}</span> : null}
      </div>
    </details>
  )
}
