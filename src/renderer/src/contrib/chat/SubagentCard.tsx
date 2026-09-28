import { useEffect, useMemo, useRef, useState, type JSX, type MouseEvent } from 'react'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { stopSubagent } from '@renderer/core/engine/client'
import { Icon } from '@renderer/workbench/icons'
import { toolDisplayName } from './tool-names'

/**
 * 子代理卡片（对齐 wuzu CliSubagentCard）
 *
 * 头部一行：状态点/spinner + 子代理名 + 任务标题 + 收起态统计
 * （N 次调用 · tokens · 耗时，运行中每秒跳动）+ 停止按钮（仅运行中）+ chevron。
 * 正文：目标任务 / 执行详情（中文工具名 + 参数摘要 + 成败点）/ 返回结果。
 *
 * 执行摘要由引擎 subagent 工具收集内层帧后附在输出末尾
 * （__SUBAGENT_META__{json}），这里解析后渲染；解析失败回退普通展示。
 * 停止走引擎 POST /subagent/cancel，只中断该子代理，不影响主会话。
 */

interface SubagentMeta {
  toolCalls: Array<{ name: string; success: boolean; summary: string }>
  tokens: number
  durationMs: number
}

const META_MARKER = '__SUBAGENT_META__'

function parseArgs(argsJson: string): { task?: string; role?: string } | null {
  try {
    const parsed = JSON.parse(argsJson)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function parseMeta(result: string): { text: string; meta: SubagentMeta | null } {
  const idx = result.lastIndexOf(META_MARKER)
  if (idx === -1) return { text: result, meta: null }
  try {
    const meta = JSON.parse(result.slice(idx + META_MARKER.length)) as SubagentMeta
    if (meta && Array.isArray(meta.toolCalls)) {
      return { text: result.slice(0, idx).trim(), meta }
    }
  } catch {
    // fallthrough
  }
  return { text: result, meta: null }
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return String(tokens)
}

/** 耗时格式化：<60s 显示秒，否则 Xm Ys（对齐 wuzu formatDuration） */
function formatDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  return `${m}m${total % 60}s`
}

/** 运行中每秒跳动的耗时；结束后返回 null（由 meta.durationMs 接手） */
function useRunningElapsed(running: boolean, startedAt?: number): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  if (!running) return null
  return now - (startedAt ?? now)
}

export function SubagentCard({
  tool,
  sessionId
}: {
  tool: ToolActivity
  sessionId: string
}): JSX.Element {
  // 默认收起：只露头部一行（运行中除外，实时围观执行过程）。
  const [expanded, setExpanded] = useState(false)
  const [stopping, setStopping] = useState(false)
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const args = useMemo(() => parseArgs(tool.args), [tool.args])
  const parsed = useMemo(
    () => (tool.state === 'running' ? { text: tool.result, meta: null } : parseMeta(tool.result)),
    [tool]
  )
  const meta = parsed.meta
  const running = tool.state === 'running'
  const elapsedMs = useRunningElapsed(running, tool.startedAt)

  useEffect(
    () => () => {
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
    },
    []
  )

  const taskTitle = (args?.task ?? '').replace(/\s+/g, ' ').slice(0, 60) || '子代理任务'
  const failed = tool.state === 'error'
  const stopped = !running && /已被手动停止/.test(tool.result)
  const failCount = meta?.toolCalls.filter((call) => !call.success).length ?? 0
  const resultText = parsed.text || (failed ? tool.result : '') || '（无返回）'
  // 目标任务默认收起展示前几行，可展开全文
  const goalText = args?.task ?? ''
  const goalPreview = expanded ? goalText : goalText.slice(0, 200)

  // 收起态统计：「N 次调用 · 35k tokens · 22s」
  const statParts: string[] = []
  if (meta) statParts.push(`${meta.toolCalls.length} 次调用`)
  if (meta && meta.tokens > 0) statParts.push(formatTokens(meta.tokens))
  if (running && elapsedMs !== null) statParts.push(formatDuration(elapsedMs))
  else if (meta) statParts.push(formatDuration(meta.durationMs))

  const handleStop = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (stopping || !running) return
    setStopping(true)
    void stopSubagent({ sessionId, toolCallId: tool.id })
    // 8s 后恢复按钮，防止引擎无响应时按钮永久禁用（对齐 wuzu 的超时重置）
    stopTimerRef.current = setTimeout(() => setStopping(false), 8000)
  }

  return (
    // 默认收起（运行中除外，实时围观执行过程）；展开后由内层 details 管「执行详情」
    <details className="subagent-card" open={running || undefined}>
      <summary>
        <span className={`subagent-card__dot${failed ? ' subagent-card__dot--fail' : ''}`}>
          {running ? <span className="subagent-card__spinner" /> : <Icon name="circle" size={13} />}
        </span>
        <span className="subagent-card__name">子代理</span>
        <span className="subagent-card__task" title={args?.task}>
          {taskTitle}
        </span>
        {stopped ? <span className="subagent-card__stopped">已停止</span> : null}
        {statParts.length > 0 ? (
          <span className="subagent-card__stats">{statParts.join(' · ')}</span>
        ) : null}
        {running ? (
          <button
            type="button"
            className="subagent-card__stop"
            title="停止子代理"
            disabled={stopping}
            onClick={handleStop}
          >
            <Icon name="close" size={11} />
            {stopping ? '停止中…' : '停止'}
          </button>
        ) : null}
        <Icon name="chevron" size={13} />
      </summary>

      <div className="subagent-card__section-label">目标任务</div>
      <div className="subagent-card__goal">
        {goalPreview || '（未提供任务描述）'}
        {goalText.length > goalPreview.length ? (
          <button type="button" className="subagent-card__expand" onClick={() => setExpanded(true)}>
            展开全文
          </button>
        ) : null}
      </div>

      {meta ? (
        <>
          <details className="subagent-card__detail" open>
            <summary>
              执行详情
              <span className="subagent-card__detail-stats">
                工具调用 {meta.toolCalls.length}
                {failCount > 0 ? (
                  <span className="subagent-card__fail"> · {failCount}失败</span>
                ) : null}
              </span>
            </summary>
            <ul className="subagent-card__calls">
              {meta.toolCalls.map((call, index) => (
                <li key={index} className="subagent-card__call">
                  <span
                    className={`subagent-card__call-dot${call.success ? '' : ' subagent-card__call-dot--fail'}`}
                  />
                  <span className="subagent-card__call-name">{toolDisplayName(call.name)}</span>
                  {call.summary ? (
                    <code className="subagent-card__call-summary">{call.summary}</code>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>

          <div className="subagent-card__section-label">返回结果</div>
          <div className="subagent-card__result">{resultText}</div>

          <div className="subagent-card__footer">
            <span>工具调用 {meta.toolCalls.length}</span>
            <span>Tokens {formatTokens(meta.tokens)}</span>
            <span>耗时 {formatDuration(meta.durationMs)}</span>
          </div>
        </>
      ) : (
        <div className="subagent-card__running">
          {running ? '子代理执行中…' : stopped ? '已被手动停止' : '（未采集到执行详情）'}
        </div>
      )}
    </details>
  )
}
