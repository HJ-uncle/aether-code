import { useEffect, useState, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { getEngineSource } from '@renderer/core/engine/source'
import type { CommandJobSnapshot } from '@shared/command-job'
import { commandJobActive, commandJobDisplayLabel, commandJobInvocation, commandJobStopMessage, mergeCommandJob } from '@renderer/core/engine/command-job-state'
import { cancelCommandJob, commandJobMissing, ingestCommandJob, refreshCommandOutput, useCommandJob } from '@renderer/core/engine/command-job-store'

export function CommandJobCard({ job: initial, sessionId }: { job: CommandJobSnapshot; sessionId: string }): JSX.Element {
  const { engine, ready } = useApp()
  const remoteReadOnly = engine.snapshot.mode === 'remote'
  const sourceEpoch = getEngineSource()
  const cached = useCommandJob(sessionId, initial.jobId)
  const job = cached ? mergeCommandJob(initial, cached.job) : initial
  const [outputError, setOutputError] = useState('')
  const [cancelError, setCancelError] = useState('')
  const [stopping, setStopping] = useState(false)
  // Live output is useful while a command is running; terminal jobs reopen as
  // compact summaries after a reload so an old script cannot fill the chat.
  const [open, setOpen] = useState(() => commandJobActive(initial))
  // Source passed through node -e should not compete with its actual output.
  const [commandOpen, setCommandOpen] = useState(false)
  const active = commandJobActive(job)
  const belongs = job.sessionId === sessionId
  const commandText = commandJobInvocation(job)
  const commandPreview = commandText.replace(/\s+/g, ' ').trim()
  const commandIsLong = commandPreview.length > 180
  const cancelledByStop = job.status === 'cancelled'
  const stopMessage = commandJobStopMessage(job)
  useEffect(() => { if (initial.sessionId === sessionId) ingestCommandJob(initial) }, [initial, sessionId])
  useEffect(() => {
    if (!belongs) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      let nextActive = true
      try {
        const view = await refreshCommandOutput(sessionId, initial.jobId)
        nextActive = commandJobActive(view.job) || view.output.cursor < view.job.cursor
        if (alive) setOutputError('')
      } catch (error) {
        if (commandJobMissing(error)) nextActive = false
        if (alive) setOutputError(`输出更新失败：${error instanceof Error ? error.message : String(error)}`)
      }
      if (alive && nextActive) timer = setTimeout(() => { void refresh() }, 1000)
    }
    void refresh()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [belongs, initial.jobId, sessionId])
  const stop = async (): Promise<void> => {
    if (!ready || sourceEpoch !== getEngineSource() || !belongs || stopping || !active) return
    setStopping(true); setCancelError('')
    try {
      await cancelCommandJob(sessionId, job.jobId)
      if (sourceEpoch === getEngineSource()) await refreshCommandOutput(sessionId, job.jobId)
    }
    catch (error) { if (sourceEpoch === getEngineSource()) setCancelError(`停止失败：${error instanceof Error ? error.message : String(error)}`) }
    finally { if (sourceEpoch === getEngineSource()) setStopping(false) }
  }
  return <section className="command-job-card" data-job-id={job.jobId} data-status={job.status} aria-label="命令任务">
    <div className="command-job-card__head">
      <button className="command-job-card__toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <strong>{job.background ? '后台命令' : '执行命令'}</strong>
        <span className={`command-job-card__status${cancelledByStop ? ' command-job-card__status--stopped' : ''}`} role="status" aria-label="命令状态">
          {commandJobDisplayLabel(job)}
        </span>
      </button>
      {active && belongs ? <button className="subagent-card__stop" disabled={!ready || stopping || job.status === 'cancelling'} title="停止命令" onClick={() => { void stop() }}>{stopping || job.status === 'cancelling' ? '正在停止…' : '停止命令'}</button> : null}
    </div>
    <div className={`command-job-card__command${commandIsLong ? ' command-job-card__command--long' : ''}`}>
      {commandIsLong ? (
        <button type="button" className="command-job-card__command-toggle" aria-label={commandOpen ? '收起命令详情' : '展开完整命令'} aria-expanded={commandOpen} onClick={() => setCommandOpen(value => !value)}>
          <code>{commandOpen ? commandText : `${commandPreview.slice(0, 177)}…`}</code>
          <span aria-hidden="true">{commandOpen ? '收起' : '展开'}</span>
        </button>
      ) : <code>{commandText}</code>}
    </div>
    {remoteReadOnly ? <div className="command-job-card__meta">远端命令任务</div> : null}
    <div className="command-job-card__meta" title={job.cwd}>工作目录：{job.cwd}{cancelledByStop || job.exitCode === null ? '' : ` · 退出码 ${job.exitCode}`}{!cancelledByStop && job.signal ? ` · ${job.signal}` : ''}</div>
    {job.ownerSessionId !== sessionId ? <div className="command-job-card__meta">子代理任务：{job.ownerRunId ?? job.ownerSessionId}</div> : null}
    {stopMessage ? <div className="command-job-card__stop-reason" role="note">{stopMessage}</div> : null}
    {cancelledByStop ? <details className="command-job-card__diagnostics">
      <summary>停止详情</summary>
      <div>退出码：{job.exitCode ?? '未提供'}{job.signal ? ` · 信号：${job.signal}` : ''}</div>
      {job.error ? <div>{job.error.message}（{job.error.code}）</div> : null}
    </details> : null}
    {job.error && !stopMessage ? <div className="message__error" role="alert">{job.error.message} <span>({job.error.code})</span></div> : null}
    {job.status === 'interrupted' ? <div className="command-job-card__meta">任务已中断，未自动重新执行。</div> : null}
    {!belongs ? <div className="message__error" role="alert">命令任务不属于当前会话</div> : null}
    {cancelError ? <div className="message__error" role="alert">{cancelError}</div> : null}
    {outputError ? <div className="message__error" role="alert">{outputError}</div> : null}
    {open ? <div className="command-job-card__body">
      {cached?.output.truncated ? <div className="command-job-card__meta">较早输出已截断，仅显示最近保留的内容。</div> : null}
      <pre className="command-job-card__output" aria-label="命令输出">{cached?.output.entries.length ? cached.output.entries.map(entry => <span key={entry.seq} data-stream={entry.stream} className={entry.stream === 'stderr' ? 'command-job-card__stderr' : undefined}>{entry.text}</span>) : '暂无输出'}</pre>
    </div> : null}
  </section>
}
