import { useEffect, useMemo, useState, type JSX } from 'react'
import { Icon } from '@renderer/workbench/icons'
import { Popover } from '@renderer/workbench/Popover'
import { useHoverDetail } from '@renderer/workbench/useHoverDetail'
import { formatDuration, formatElapsedDuration, formatTimestamp, formatTokens, type UsageDetailRow } from './usage'
import { usagePercentage } from './usage-percentage'
import type { ChatMessage } from '@renderer/core/engine/useChat'
import { sessionExecutionDuration, sessionExecutionTiming } from './session-duration'
import './conversation-usage.css'

/** 一轮问答的累计用量（并入最后一条 AI 消息底部的过程行） */
export type TurnUsageInfo = {
  tokens: number
  summary: UsageDetailRow[]
  askedAt: number
  startedAt?: number
  endedAt?: number
  model?: string
  streaming: boolean
}

/**
 * 一次用户提问的累计用量（挂在「用户提问 + 其后的全部 AI 输出」整段的末尾）
 *
 * 一轮对话里 Agent 会跑很多步（思考 → 执行命令 → 再思考 …），逐步显示 token
 * 会把消息流打成碎片。这里按用户消息切分，只在该轮结尾给一个累计值。
 *
 * 除了 token，还要回答"这一轮是什么时候问的、跑了多久、用的哪个模型" ——
 * 这三项是回顾历史时最常需要的上下文，缺了就得翻设置页去猜。
 *
 * 外观与顶部会话用量一致，那它就也得能点开 —— 长得一样却有的能点有的不能点，
 * 比不能点本身更让人困惑。明细由调用方传入本轮的汇总行。
 */
function UsageBreakdown({ summary, total }: { summary: UsageDetailRow[]; total: number }): JSX.Element {
  return (
    <div className="usage-detail usage-detail--percentages">
      {summary.map(row => (
        <UsageBreakdownRow key={row.label} row={row} total={total} summary={summary} />
      ))}
    </div>
  )
}

function UsageBreakdownRow({ row, total, summary }: { row: UsageDetailRow; total: number; summary: UsageDetailRow[] }): JSX.Element {
  const percentage = usagePercentage(row, total, summary)
  const tokensKnown = Number.isFinite(row.tokens) && row.tokens >= 0 && !row.unknown
  const { triggerProps, tooltip } = useHoverDetail<HTMLDivElement>({
    enabled: true,
    placement: 'side',
    sideAnchor: '.popover__panel',
    label: `${row.label}用量详情`,
    content: <div className="usage-detail-tip">
      <div className="usage-detail-tip__label">{row.label}</div>
      <div className="usage-detail-tip__amount">{tokensKnown ? <>{row.tokens.toLocaleString('en-US')} <span>tokens</span></> : '用量未报告'}</div>
      {percentage.reason ? <p className="usage-detail-tip__note">{percentage.reason}</p> : <>
        <div className="usage-detail-tip__ratio">占{percentage.basisLabel} <strong>{percentage.value}</strong></div>
        <div className="usage-detail-tip__base">计算基数：{percentage.basisTokens?.toLocaleString('en-US')} tokens</div>
      </>}
      {row.title ? <p className="usage-detail-tip__note">{row.title}</p> : null}
    </div>
  })
  return <>
    <div {...triggerProps} tabIndex={0} role="group" aria-label={`${row.label}：${percentage.value}`}
      className={`usage-detail__row usage-detail__row--interactive${row.child ? ' usage-detail__row--child' : ''}${row.group === 'cache' ? ' usage-detail__row--cache' : ''}${row.subtotal ? ' usage-detail__row--subtotal' : ''}`}>
      {row.subtotal ? null : <span aria-hidden="true" className={`usage-detail__bar usage-detail__bar--${row.group}`} />}
      <span className="usage-detail__label">{row.label}</span>
      <span className="usage-detail__value">{percentage.value}</span>
    </div>
    {tooltip}
  </>
}

export function TurnUsage({
  tokens,
  summary,
  askedAt,
  startedAt,
  endedAt,
  model,
  streaming
}: {
  tokens: number
  summary: UsageDetailRow[]
  /** 用户提问时刻（epoch ms） */
  askedAt: number
  /** 本轮开始时刻；缺失表示尚未开始 */
  startedAt?: number
  /** 本轮结束时刻；缺失表示仍在进行中 */
  endedAt?: number
  /** 本轮使用的模型 id */
  model?: string
  /** 是否仍在输出：进行中用「当前时刻」估算已用时长 */
  streaming: boolean
}): JSX.Element {
  // 进行中时 endedAt 还没有：需要一个随渲染推进的值来累计已用时长
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!streaming) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [streaming])

  const duration = formatDuration(startedAt, streaming ? now : endedAt)
  const stamp = formatTimestamp(askedAt)

  return (
    <Popover
      className="turn-usage"
      label="本次问答用量"
      // 向上弹：每轮用量贴在消息流末尾，向下弹会盖住即将输入的区域
      placement="up"
      align="start"
      width={268}
      trigger={({ open }) => (
        <button
          type="button"
          className={`turn-usage__trigger${open ? ' is-open' : ''}`}
          title="查看本次问答的时间、耗时与 Token 明细"
        >
          <Icon name="model" size={16} />
          <span className="turn-usage__text">
            <span className="turn-usage__value">{formatTokens(tokens)}</span>
            <span className="turn-usage__unit">tokens{summary.some((row) => row.unknown) ? '（已知）' : ''}</span>
            {duration ? <span className="turn-usage__time">{duration}</span> : null}
            {model ? <span className="turn-usage__model">{model}</span> : null}
          </span>
        </button>
      )}
    >
      <div className="usage-popover__head">
        <span className="usage-popover__title">本次问答</span>
        {stamp ? <span className="usage-popover__meta">{stamp}</span> : null}
      </div>
      <div className="usage-popover__total">
        <span className="usage-popover__total-value" title={`${tokens.toLocaleString('en-US')} tokens`}>{formatTokens(tokens)}</span>
        <span className="usage-popover__total-unit">tokens{summary.some((row) => row.unknown) ? '（已知部分）' : ''}</span>
        {duration ? <span className="usage-popover__meta">耗时 {duration}</span> : null}
      </div>
      {model ? (
        <div className="usage-detail usage-detail--meta">
          <div className="usage-detail__row usage-detail__row--model">
            <Icon name="model" size={16} className="usage-detail__icon" />
            <span className="usage-detail__label">模型</span>
            <span className="usage-detail__value">{model}</span>
          </div>
          {stamp ? (
            <div className="usage-detail__row">
              <Icon name="clock-outline" size={16} className="usage-detail__icon" />
              <span className="usage-detail__label">对话时间</span>
              <span className="usage-detail__value">{stamp}</span>
            </div>
          ) : null}
          {duration ? (
            <div className="usage-detail__row">
              <Icon name="sync" size={16} className="usage-detail__icon" />
              <span className="usage-detail__label">任务耗时</span>
              <span className="usage-detail__value">{duration}</span>
            </div>
          ) : null}
        </div>
      ) : null}
      <UsageBreakdown summary={summary} total={tokens} />
    </Popover>
  )
}

/**
 * 页脚会话用量仪表
 *
 * 只统计整条会话的累计值 —— 会话可能先后用到多个模型，因此不显示模型名，
 * 时间仅累计已加载轮次的执行区间，不能用首尾跨度推算，避免计入轮间空闲。
 * 触发区用胶囊按钮，明细走锚定在按钮上方的浮层，
 * 符合 macOS 里「状态项 → 向上弹出 popover」的惯例。
 */
export function UsageMeter({
  total,
  rounds,
  summary,
  messages
}: {
  total: number
  rounds: number
  summary: UsageDetailRow[]
  messages: readonly ChatMessage[]
}): JSX.Element {
  const timing = useMemo(() => sessionExecutionTiming(messages), [messages])
  const active = timing.intervals.some(interval => interval.end === undefined)
  const [clock, setClock] = useState(() => ({ timing, now: Date.now() }))
  // Switching tasks must not reuse an earlier task's last clock tick.
  const now = clock.timing === timing ? clock.now : Date.now()

  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setClock({ timing, now: Date.now() }), 1000)
    return () => window.clearInterval(timer)
  }, [timing, active])

  const duration = formatElapsedDuration(sessionExecutionDuration(timing, now))
  const durationTitle = '已加载轮次的累计执行用时，含轮内等待，不含轮间空闲；并行时段只计算一次。' +
    (timing.incomplete ? '部分历史记录缺少起止时间，仅显示已知部分。' : '')

  return (
    <Popover
      className="usage-meter"
      label="会话用量明细"
      placement="down"
      align="end"
      width={268}
      trigger={({ open }) => (
        <button
          type="button"
          className={`usage-meter__trigger${open ? ' is-open' : ''}`}
          title="查看本会话的 Token 明细"
        >
          <Icon name="model" size={16} />
          <span className="usage-meter__tokens">{formatTokens(total)}</span>
          <span className="usage-meter__unit">tokens{summary.some((row) => row.unknown) ? '（已知）' : ''}</span>
          {duration ? <span className="usage-meter__time" title={durationTitle}>{timing.incomplete ? '≥' : ''}{duration}</span> : null}
        </button>
      )}
    >
      <div className="usage-popover__head">
        <span className="usage-popover__title">本会话用量</span>
        <span className="usage-popover__meta" title={durationTitle}>
          已加载 {rounds} 轮{duration ? ` · ${timing.incomplete ? '已知' : '累计'} ${duration}` : ''}
        </span>
      </div>
      <div className="usage-popover__total">
        <span className="usage-popover__total-value" title={`${total.toLocaleString('en-US')} tokens`}>{formatTokens(total)}</span>
        <span className="usage-popover__total-unit">tokens{summary.some((row) => row.unknown) ? '（已知部分）' : ''}</span>
      </div>
      <UsageBreakdown summary={summary} total={total} />
    </Popover>
  )
}

