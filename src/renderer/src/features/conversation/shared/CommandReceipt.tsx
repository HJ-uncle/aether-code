import { useLayoutEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import type { CommandJobSnapshot } from '@shared/command-job'
import { useApp } from '@renderer/core/app-context'
import { commandStatusLabels } from '@renderer/core/engine/command-job-state'
import { commandInvocation } from '@renderer/core/engine/tool-feedback'
import { getEngineSource, subscribeEngineSource } from '@renderer/core/engine/source'
import { Spinner } from '@renderer/ui/ui-primitives'
import { Icon } from '@renderer/ui/icons'
import { useMotionVisibility } from '@renderer/ui/MotionPresence'
import type { ChatFileContext } from './chat-link'
import type { CommandReceipt as Receipt, CommandReceiptItem } from '@shared/command-receipt'
import { commandReceiptBelongs, commandReceiptJob, readCommandReceiptPage } from './command-receipt-client'
import './command-receipt.css'

function Invocation({ job, args }: { job?: CommandJobSnapshot; args?: unknown }): JSX.Element | null {
  const input = job ? JSON.stringify({ command: job.command, args: job.args }) : typeof args === 'string' ? args : JSON.stringify(args ?? {})
  const command = commandInvocation(input)
  return command ? <details className="command-receipt__command"><summary>查看命令</summary><pre>{command}</pre>
    {job?.cwd ? <div className="command-receipt__cwd">{job.cwd}</div> : null}</details> : null
}

function ReceiptPage({ initial, job, context, active, args }: {
  initial: Receipt; job?: CommandJobSnapshot; context?: ChatFileContext; active: boolean; args?: unknown
}): JSX.Element {
  const { ready } = useApp()
  const ancestorVisible = useMotionVisibility(), readingActive = active && ancestorVisible
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const [page, setPage] = useState(initial), [loading, setLoading] = useState(false), [error, setError] = useState('')
  const [retryPrevious, setRetryPrevious] = useState(false)
  const [trail, setTrail] = useState<Array<{ cursor: number; offset: number }>>([])
  const [position, setPosition] = useState<{ cursor: number; offset: number } | null>(null)
  const epoch = useRef(0), pending = useRef(false)
  const identity = JSON.stringify([source, context?.sessionId, context?.receiptParentSessionId, initial.jobId,
    job?.sessionId, job?.ownerSessionId, job?.runId, job?.ownerRunId, job?.turnId, job?.toolCallId, readingActive])
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  useLayoutEffect(() => {
    epoch.current++
    pending.current = false
    setPage(initial); setTrail([]); setPosition(null); setError(''); setLoading(false)
    return () => { epoch.current++ }
  }, [identity, initial])
  const canRead = Boolean(readingActive && ready && job && commandReceiptBelongs(job, context))
  const read = async (previous = false): Promise<void> => {
    if (pending.current) return
    if (previous && trail.length === 0) { setPage(initial); setPosition(null); setError(''); return }
    if (!canRead || !job) return
    const target = previous ? trail[trail.length - 1] : { cursor: page.nextCursor, offset: page.nextOffset ?? 0 }
    const generation = epoch.current
    const current = (): boolean => generation === epoch.current && currentIdentity.current === identity && source === getEngineSource()
    pending.current = true; setLoading(true); setError('')
    try {
      const next = await readCommandReceiptPage(job, target.cursor, target.offset, source)
      if (!current()) return
      setTrail(previous ? trail.slice(0, -1) : position ? [...trail, position] : trail)
      setPosition(target); setPage(next)
    } catch (cause) { if (current()) { setError(cause instanceof Error ? cause.message : String(cause)); setRetryPrevious(previous) } }
    finally { if (current()) { pending.current = false; setLoading(false) } }
  }
  const running = page.status === 'running' || page.status === 'cancelling'
  return <section className="command-receipt" aria-label="命令结果" aria-busy={loading} data-command-job-id={initial.jobId}>
    <div className="command-receipt__status" role="status"><span>{commandStatusLabels[page.status]}</span>
      {page.exitCode !== null ? <span>退出码 {page.exitCode}</span> : null}{page.signal ? <span>信号 {page.signal}</span> : null}
      {position ? <span>后续输出 · 第 {trail.length + 2} 页</span> : null}</div>
    <Invocation job={job} args={args} />
    {page.notice ? <p className="command-receipt__notice" role="status">{page.notice}</p> : null}
    {page.error ? <p className="command-receipt__error">{page.error.message || page.error.code}</p> : null}
    {page.truncated ? <p className="command-receipt__notice">较早的日志已超出保留范围，以下为仍可读取的输出。</p> : null}
    {page.entries.length ? <pre className="command-receipt__log" tabIndex={0} aria-label="命令输出">{page.entries.map((entry, index) =>
      <span key={`${entry.seq}:${index}`} data-stream={entry.stream}>{entry.text}</span>)}</pre> : <p className="command-receipt__notice">{running ? '暂时没有新输出' : '此页没有输出'}</p>}
    {error ? <p className="command-receipt__error" role="alert">{error}</p> : null}
    {position || page.hasMore || running || error ? <div className="command-receipt__actions">
      {position ? <button type="button" disabled={loading || trail.length > 0 && !canRead} onClick={() => void read(true)}>上一页</button> : null}
      {page.hasMore || running || error ? <button type="button" disabled={!canRead || loading} onClick={() => void read(error ? retryPrevious : false)}
        aria-label={page.hasMore ? '读取更多命令输出' : '更新命令输出'} title={page.hasMore ? undefined : '更新输出'}>
        {loading ? <Spinner size={13} /> : <Icon name={page.hasMore ? 'chevron-right' : 'restart'} size={14} />}{page.hasMore ? '读取更多' : error ? '重试' : null}</button> : null}
      {page.hasMore && !canRead ? <span className="command-receipt__notice">{ready && active ? '此记录缺少可验证的命令归属，无法继续读取。' : '连接就绪后可继续读取。'}</span> : null}
    </div> : null}
  </section>
}

export function CommandReceipts({ receipts, metadata, context, active = true, args }: {
  receipts: CommandReceiptItem[]; metadata?: Record<string, unknown>; context?: ChatFileContext; active?: boolean; args?: unknown
}): JSX.Element {
  return <div className="command-receipts">{receipts.length ? receipts.map((item, index) => 'type' in item
    ? <ReceiptPage key={`${context?.sessionId ?? ''}:${item.jobId}:${index}`} initial={item} job={commandReceiptJob(item.jobId, metadata)} context={context} active={active} args={args} />
    : <p key={`${item.jobId}:${index}`} className="command-receipt__error" role="alert">命令读取失败：{item.error}</p>) : <p className="command-receipt__notice">本次未返回命令结果。</p>}</div>
}

export function LegacyCommandResult({ text, metadata, args }: { text: string; metadata?: Record<string, unknown>; args?: unknown }): JSX.Element {
  const value = metadata?.commandJob
  const job = value && typeof value === 'object' && 'jobId' in value && typeof value.jobId === 'string' ? commandReceiptJob(value.jobId, metadata) : undefined
  return <div className="command-receipt"><Invocation job={job} args={args} /><pre className="command-receipt__log" tabIndex={0} aria-label="命令输出">{text}</pre></div>
}
