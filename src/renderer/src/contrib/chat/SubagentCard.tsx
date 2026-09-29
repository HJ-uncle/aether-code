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
import { toolDisplayName } from './tool-names'
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
function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
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
  const [manualOpen, setManualOpen] = useState<boolean | null>(null)
  const [goalExpanded, setGoalExpanded] = useState(false)
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
          {active ? <span className="subagent-card__spinner" /> : <Icon name="circle" size={13} />}
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
            <Icon name="close" size={11} />
            {requesting || cancelling ? '取消中…' : '停止'}
          </button>
        ) : null}
        <Icon name="chevron" size={13} />
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

      {/* 目标任务默认收起：标题行已露任务摘要，展开是为了看完整说明 */}
      <details className="subagent-card__detail">
        <summary>
          目标任务 <span className="subagent-card__detail-stats">{goal ? `${goal.length} 字` : ''}</span>
        </summary>
        <div className="subagent-card__goal">
          {(goalExpanded ? goal : goal.slice(0, 200)) || '（未提供任务描述）'}
          {!goalExpanded && goal.length > 200 ? (
            <button
              type="button"
              className="subagent-card__expand"
              onClick={() => setGoalExpanded(true)}
            >
              展开全文
            </button>
          ) : null}
        </div>
      </details>
      {currentCall ? (
        <div className="subagent-card__running">当前：{toolDisplayName(currentCall.name)}</div>
      ) : null}
      <details className="subagent-card__detail">
        <summary>
          执行详情 <span className="subagent-card__detail-stats">工具调用 {calls.length}</span>
          {failures > 0 ? <span className="subagent-card__fail"> · {failures} 失败</span> : null}
        </summary>
        {calls.length ? (
          <ul className="subagent-card__calls">
            {calls.map((call) => (
              <li key={call.id} className="subagent-card__call">
                <span
                  className={`subagent-card__call-dot${call.status === 'failed' ? ' subagent-card__call-dot--fail' : ''}`}
                />
                <details>
                  <summary>
                    <span className="subagent-card__call-name">{toolDisplayName(call.name)}</span> ·{' '}
                    {call.status === 'failed'
                      ? '失败'
                      : call.status === 'succeeded'
                        ? '成功'
                        : call.status === 'cancelled'
                          ? '已取消'
                          : '执行中'}
                  </summary>
                  <pre className="subagent-card__result">{readable(call.args)}</pre>
                  {call.error ? <div className="message__error">{call.error.message}</div> : null}
                  {call.output ? <pre className="subagent-card__result">{call.output}</pre> : null}
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <div className="subagent-card__running">
            {run ? (active ? '等待工具调用…' : '没有内部工具调用') : '旧记录未保存详情'}
          </div>
        )}
      </details>

      <div className="subagent-card__section-label">
        {run?.partialOutput && !run.resultSummary ? '部分结果' : '返回结果'}
      </div>
      <div className="subagent-card__result">{result || (active ? '等待返回…' : '（无返回）')}</div>
      <div className="subagent-card__footer">
        {run?.modelId ? <span>模型 {run.modelId}</span> : null}
        <span>工具调用 {calls.length}</span>
        <span>Tokens {tokenLabel}</span>
        {elapsed !== undefined ? <span>耗时 {duration(elapsed)}</span> : null}
      </div>
    </details>
  )
}
