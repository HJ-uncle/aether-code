import { useMemo, useState, type JSX } from 'react'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { Icon } from '@renderer/workbench/icons'
import { toolDisplayName } from './tool-names'

/**
 * 子代理卡片（Trae 风格）
 *
 * 头部：状态点 + 子代理名 + 任务标题；正文：目标任务 / 执行详情（中文工具名
 * + 参数摘要 + 成败点）/ 返回结果；底栏：工具调用数 · Tokens · 耗时。
 *
 * 执行摘要由引擎 subagent 工具收集内层帧后附在输出末尾
 * （__SUBAGENT_META__{json}），这里解析后渲染；解析失败回退普通展示。
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

export function SubagentCard({ tool }: { tool: ToolActivity }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const args = useMemo(() => parseArgs(tool.args), [tool.args])
  const parsed = useMemo(
    () => (tool.state === 'running' ? { text: tool.result, meta: null } : parseMeta(tool.result)),
    [tool]
  )
  const meta = parsed.meta

  const taskTitle = (args?.task ?? '').replace(/\s+/g, ' ').slice(0, 60) || '子代理任务'
  const failed = tool.state === 'error'
  const failCount = meta?.toolCalls.filter((call) => !call.success).length ?? 0
  const resultText = parsed.text || (failed ? tool.result : '') || '（无返回）'
  // 目标任务默认收起展示前几行，可展开全文
  const goalText = args?.task ?? ''
  const goalPreview = expanded ? goalText : goalText.slice(0, 200)

  return (
    <details className="subagent-card" open={!failed}>
      <summary>
        <span className={`subagent-card__dot${failed ? ' subagent-card__dot--fail' : ''}`}>
          {tool.state === 'running' ? (
            <Icon name="circle-dot" size={13} />
          ) : (
            <Icon name="circle" size={13} />
          )}
        </span>
        <span className="subagent-card__name">子代理</span>
        <span className="subagent-card__task" title={args?.task}>
          {taskTitle}
        </span>
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
            <span>耗时 {Math.max(1, Math.round(meta.durationMs / 1000))}s</span>
          </div>
        </>
      ) : (
        <div className="subagent-card__running">
          {tool.state === 'running' ? '子代理执行中…' : '（未采集到执行详情）'}
        </div>
      )}
    </details>
  )
}
