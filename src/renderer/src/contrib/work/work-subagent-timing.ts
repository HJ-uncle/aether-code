import type { ToolActivity } from '@renderer/core/engine/useChat'
import { formatWorkElapsed } from './work-elapsed'

export interface WorkSubagentTiming {
  durationText: string
  durationMs?: number
  timestamp?: { value: number; dateTime: string; text: string; full: string }
  summary: string
}

function validTimestamp(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0 && value <= 8.64e15
}

function validDuration(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0
}

export function formatSubagentElapsed(durationMs: number): string {
  if (durationMs < 1000) return '不足 1 秒'
  return formatWorkElapsed(durationMs, true)
}

function timestamp(value: number | undefined, label: '开始' | '创建', now: number): WorkSubagentTiming['timestamp'] {
  if (!validTimestamp(value)) return undefined
  const date = new Date(value), today = new Date(now)
  const pad = (part: number): string => String(part).padStart(2, '0')
  const day = `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const sameDay = date.toDateString() === today.toDateString()
  const prefix = sameDay ? '' : `${date.getFullYear() === today.getFullYear() ? '' : `${date.getFullYear()}/`}${day} `
  return { value, dateTime: date.toISOString(), text: `${prefix}${clock} ${label}`,
    full: `${label}时间 ${date.getFullYear()}/${day} ${clock}:${pad(date.getSeconds())}` }
}

/** Timing belongs to this invocation. Never borrow an older round or count
 * admission/queue time as execution, and never advance a published snapshot. */
export function workSubagentTiming(tool: ToolActivity, now = Date.now()): WorkSubagentTiming {
  const reference = tool.subagentRef
  const run = tool.subagent && (!reference || tool.subagent.runId === reference.identity.runId) ? tool.subagent : undefined
  const createdAt = reference?.identity.createdAt ?? run?.createdAt
  const startedAt = run ? run.startedAt : reference ? undefined : tool.startedAt
  const finishedAt = run ? run.finishedAt : reference ? undefined : tool.finishedAt
  const active = !reference && (run ? ['queued', 'running', 'cancelling'].includes(run.status) : ['running', 'waiting'].includes(tool.state))
  let durationMs: number | undefined
  let durationText = '用时未记录'
  if (run?.status === 'queued' && !validTimestamp(run.startedAt)) {
    durationText = !reference && validTimestamp(createdAt) && validTimestamp(now)
      ? `排队 ${formatSubagentElapsed(Math.max(0, now - createdAt))}` : '等待开始'
  } else if (active && !run) {
    durationText = '准备中'
  } else if (active) {
    if (validTimestamp(startedAt) && validTimestamp(now)) durationMs = Math.max(0, now - startedAt)
    else durationText = '等待开始'
  } else if (validDuration(run?.durationMs) && (validTimestamp(startedAt) || run.durationMs > 0)) {
    durationMs = run.durationMs
  } else if (validTimestamp(startedAt) && validTimestamp(finishedAt) && finishedAt >= startedAt) {
    durationMs = finishedAt - startedAt
  } else if (run && !validTimestamp(startedAt) && run.durationMs === 0) {
    durationText = '未开始'
  }
  if (durationMs !== undefined) durationText = `本轮用时 ${formatSubagentElapsed(durationMs)}`
  // A parent tool's admission timestamp cannot prove the child began work.
  const stamp = timestamp(run ? run.startedAt : !reference && !active ? startedAt : undefined, '开始', now)
    ?? timestamp(createdAt ?? (!reference ? tool.startedAt : undefined), '创建', now)
  return { durationText, durationMs, timestamp: stamp, summary: [durationText, stamp?.text].filter(Boolean).join(' · ') }
}
