import { useEffect, useId, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { getEngineSource } from '@renderer/core/engine/source'
import { useAppMode, type AppMode } from '@renderer/core/platform/app-mode'
import { useWorkbenchVisible } from '@renderer/core/platform/workbench-visibility'
import type { CommandJobSnapshot } from '@shared/command-job'
import { commandJobActive, commandJobDisplayLabel, commandJobInvocation, commandJobStopMessage, commandToolState, mergeCommandJob } from '@renderer/core/engine/command-job-state'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { cancelCommandJob, commandJobMissing, deleteCommandJob, ingestCommandJob, refreshCommandOutput, restartCommandJob, useCommandJob } from '@renderer/core/engine/command-job-store'
import { MotionPresence } from '@renderer/workbench/MotionPresence'
import { Icon } from '@renderer/workbench/icons'
import { exportToolDiagnostics } from '@renderer/core/engine/tool-feedback'
import { toast } from '@renderer/core/toast'
import { WorkToolOutcome } from '../work/WorkToolOutcome'
import { workToolFeedback } from '../work/work-tool-feedback'

export function CommandJobCard({ job: initial, sessionId, surfaceMode = 'code', active: surfaceActive = true, preserveHistory = false, presentation = 'card' }: { job: CommandJobSnapshot; sessionId: string; surfaceMode?: AppMode; active?: boolean; preserveHistory?: boolean; presentation?: 'card' | 'service' }): JSX.Element {
  const { engine, ready } = useApp()
  const mode = useAppMode()
  const visible = useWorkbenchVisible()
  const remoteReadOnly = engine.snapshot.mode === 'remote'
  const sourceEpoch = getEngineSource()
  const cached = useCommandJob(sessionId, initial.jobId)
  const job = cached ? mergeCommandJob(initial, cached.job) : initial
  const [outputError, setOutputError] = useState('')
  const [cancelError, setCancelError] = useState('')
  const [missing, setMissing] = useState(false)
  const [deleted, setDeleted] = useState(false)
  const [actionError, setActionError] = useState('')
  const [historyAction, setHistoryAction] = useState<'restart' | 'delete' | null>(null)
  const [stopping, setStopping] = useState(false)
  const [copied, setCopied] = useState(false)
  const detailsId = useId()
  const servicePresentation = surfaceMode === 'work' && presentation === 'service'
  // Live output is useful while a command is running; terminal jobs reopen as
  // compact summaries after a reload so an old script cannot fill the chat.
  const [open, setOpen] = useState(() => !servicePresentation && commandJobActive(initial))
  // Source passed through node -e should not compete with its actual output.
  const [commandOpen, setCommandOpen] = useState(false)
  const active = commandJobActive(job)
  const belongs = job.sessionId === sessionId
  const commandText = commandJobInvocation(job)
  const commandPreview = commandText.replace(/\s+/g, ' ').trim()
  const commandIsLong = commandPreview.length > 180
  const cancelledByStop = job.status === 'cancelled'
  const stopMessage = commandJobStopMessage(job)
  // Keep the engine receipt intact. Work only removes a confirmed stopped
  // background process from its live card area, including after a reload.
  // A background service that was interrupted or disappeared has no useful
  // card to inspect. Keep ordinary failed commands (which carry diagnostics)
  // visible, but remove stale service receipts from Work after their endpoint
  // reports 404 or the durable job reaches the interrupted terminal state.
  const staleBackground = job.background && (missing || job.status === 'interrupted')
  const dismissed = surfaceMode === 'work' && belongs && job.background && (deleted || missing || !preserveHistory && (cancelledByStop || staleBackground))
  const cardRef = useRef<HTMLElement>(null)
  const restoreFocusOnExit = useRef(false)
  const outcomeTool: ToolActivity = {
    id: job.toolCallId ?? job.jobId, name: 'execute_cmd',
    args: JSON.stringify({ command: job.command, args: job.args, cwd: job.cwd }),
    state: commandToolState(job), error: job.error?.code, commandJob: job,
    result: cached?.output.entries.map(entry => entry.text).join('') ?? ''
  }
  const feedback = surfaceMode === 'work' ? workToolFeedback(outcomeTool) : null
  useLayoutEffect(() => {
    if (!servicePresentation) return
    const node = cardRef.current
    // A stop receipt moves the row to history, unmounting it before its own
    // dismissed effect can run. Preserve keyboard position in that transition.
    return () => {
      if (node?.contains(document.activeElement)) node.closest('.work-service-tray__panel')?.querySelector<HTMLElement>('.work-service-tray__close')?.focus({ preventScroll: true })
    }
  }, [servicePresentation])
  useLayoutEffect(() => {
    if (!dismissed || !cardRef.current || !(cardRef.current.contains(document.activeElement)
      || restoreFocusOnExit.current && document.activeElement === document.body)) return
    const message = cardRef.current.closest('.work-message')
    const target = message?.querySelector<HTMLElement>('.work-message__process-toggle')
      ?? cardRef.current.closest('.work-conversation')?.querySelector<HTMLElement>('.work-composer [role="textbox"], .work-composer textarea')
      ?? cardRef.current.closest('.work-service-tray__panel')?.querySelector<HTMLElement>('.work-service-tray__close')
    target?.focus({ preventScroll: true })
  }, [dismissed])
  useEffect(() => { if (surfaceMode === 'work' && !active) setOpen(false) }, [surfaceMode, active])
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(timer)
  }, [copied])
  useEffect(() => { if (initial.sessionId === sessionId) ingestCommandJob(initial) }, [initial, sessionId])
  useEffect(() => {
    if (dismissed || !belongs || !ready || !visible || mode !== surfaceMode || !surfaceActive) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      let nextActive = true
      try {
        const view = await refreshCommandOutput(sessionId, initial.jobId)
        nextActive = commandJobActive(view.job) || view.output.cursor < view.job.cursor
        if (alive) setOutputError('')
      } catch (error) {
        if (commandJobMissing(error)) {
          nextActive = false
          if (alive) { setMissing(true); setOutputError('') }
        } else if (alive) setOutputError(`输出更新失败：${error instanceof Error ? error.message : String(error)}`)
      }
      if (alive && nextActive) timer = setTimeout(() => { void refresh() }, 1000)
    }
    void refresh()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [dismissed, belongs, initial.jobId, sessionId, ready, visible, mode, surfaceMode, surfaceActive])
  const stop = async (): Promise<void> => {
    if (!ready || sourceEpoch !== getEngineSource() || !belongs || stopping || !active) return
    restoreFocusOnExit.current = Boolean(cardRef.current?.contains(document.activeElement))
    const serviceFocusTarget = servicePresentation ? cardRef.current?.closest('.work-service-tray__panel')?.querySelector<HTMLElement>('.work-service-tray__close') : null
    setStopping(true); setCancelError('')
    try {
      await cancelCommandJob(sessionId, job.jobId)
      if (sourceEpoch === getEngineSource()) await refreshCommandOutput(sessionId, job.jobId)
    }
    catch (error) { if (sourceEpoch === getEngineSource()) setCancelError(`停止失败：${error instanceof Error ? error.message : String(error)}`) }
    finally {
      if (sourceEpoch === getEngineSource()) setStopping(false)
      if (restoreFocusOnExit.current && document.activeElement === document.body && serviceFocusTarget?.isConnected) serviceFocusTarget.focus({ preventScroll: true })
    }
  }
  const restart = async (): Promise<void> => {
    if (!ready || sourceEpoch !== getEngineSource() || !belongs || active || historyAction) return
    setHistoryAction('restart'); setActionError('')
    try { await restartCommandJob(sessionId, job.jobId) }
    catch (error) { if (sourceEpoch === getEngineSource()) setActionError(`重启失败：${error instanceof Error ? error.message : String(error)}`) }
    finally { if (sourceEpoch === getEngineSource()) setHistoryAction(null) }
  }
  const remove = async (): Promise<void> => {
    if (!ready || sourceEpoch !== getEngineSource() || !belongs || active || historyAction) return
    if (!window.confirm('删除这条服务历史及其日志？此操作无法撤销。')) return
    setHistoryAction('delete'); setActionError('')
    try { await deleteCommandJob(sessionId, job.jobId); setDeleted(true) }
    catch (error) { if (sourceEpoch === getEngineSource()) setActionError(`删除失败：${error instanceof Error ? error.message : String(error)}`) }
    finally { if (sourceEpoch === getEngineSource()) setHistoryAction(null) }
  }
  if (servicePresentation) {
    // The row identifies a process; its exact invocation belongs in the disclosure.
    const executable = job.command.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/)
    const executableName = (executable?.[1] ?? executable?.[2] ?? executable?.[3] ?? '命令').split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat)$/i, '') ?? '命令'
    const shortArgs = job.args.slice(0, 2).filter((arg, index) => !arg.startsWith('-') && arg.length < 48 && (index === 0 || job.args[0] === 'run'))
    const name = [executableName, ...shortArgs.map(arg => arg.split(/[\\/]/).pop())].join(' ')
    const copy = async (): Promise<void> => {
      try { await navigator.clipboard.writeText(exportToolDiagnostics(outcomeTool)); setCopied(true) }
      catch { toast.error('复制诊断失败，请重试') }
    }
    return <MotionPresence show={!dismissed} className="command-job-card-presence" data-command-presence={job.jobId}>
      <section ref={cardRef} className="work-service-card" data-surface="work" data-job-id={job.jobId} data-status={job.status} aria-label="后台服务任务">
        <div className="work-service-card__head">
          <button type="button" className="work-service-card__toggle" aria-label={`${open ? '收起' : '查看'}服务详情：${name}`} aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(value => !value)}>
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
            <strong>{name}</strong>
            <span className="work-service-card__status" role="status" aria-label="命令状态">{commandJobDisplayLabel(job)}</span>
          </button>
          {active && belongs ? <button type="button" className="work-service-card__action" aria-label="停止命令" title="停止命令" disabled={!ready || stopping || job.status === 'cancelling'} onClick={() => void stop()}><Icon name="stop" size={12} /></button> : null}
          {!active && belongs ? <>
            <button type="button" className="work-service-card__action" aria-label={historyAction === 'restart' ? '正在重启服务' : '重启服务'} title="按原命令重新启动" aria-busy={historyAction === 'restart'} disabled={!ready || historyAction !== null} onClick={() => void restart()}><Icon name="restart" size={13} /></button>
            <button type="button" className="work-service-card__action work-service-card__action--danger" aria-label={historyAction === 'delete' ? '正在删除服务历史' : '删除服务历史'} title="删除历史及日志" aria-busy={historyAction === 'delete'} disabled={!ready || historyAction !== null} onClick={() => void remove()}><Icon name="trash" size={13} /></button>
          </> : null}
        </div>
        {!belongs || cancelError || actionError || outputError ? <div className="work-service-card__error" role="alert">{!belongs ? '命令任务不属于当前会话' : cancelError || actionError || outputError}</div> : null}
        <MotionPresence show={open} id={detailsId}>
          <div className="work-service-card__details">
            <div className="work-service-card__detail-head"><span>命令</span><button type="button" className="work-service-card__action" aria-label={copied ? '已复制诊断' : '复制诊断'} title={copied ? '已复制' : '复制命令、错误与输出'} onClick={() => void copy()}><Icon name={copied ? 'check' : 'copy'} size={13} /></button></div>
            <code className="work-service-card__command">{commandText}</code>
            <dl className="work-service-card__metadata">
              <div><dt>工作目录</dt><dd>{job.cwd}</dd></div>
              {remoteReadOnly ? <div><dt>位置</dt><dd>远端命令任务</dd></div> : null}
              {job.ownerSessionId !== sessionId ? <div><dt>子代理</dt><dd>{job.ownerRunId ?? job.ownerSessionId}</dd></div> : null}
              {job.exitCode !== null ? <div><dt>退出码</dt><dd>{job.exitCode}</dd></div> : null}
              {job.signal ? <div><dt>信号</dt><dd>{job.signal}</dd></div> : null}
            </dl>
            {stopMessage || job.error ? <p className="work-service-card__note" role="note">{stopMessage ?? job.error?.message}{job.error && !stopMessage ? `（${job.error.code}）` : ''}</p> : null}
            <div className="work-service-card__detail-head"><span>日志</span>{cached?.output.truncated ? <span>仅保留最近输出</span> : null}</div>
            <pre className="work-service-card__output" aria-label="命令输出">{cached?.output.entries.length ? cached.output.entries.map(entry => <span key={entry.seq} data-stream={entry.stream}>{entry.text}</span>) : '暂无输出'}</pre>
          </div>
        </MotionPresence>
      </section>
    </MotionPresence>
  }
  const card = <section ref={cardRef} className="command-job-card" data-surface={surfaceMode} data-job-id={job.jobId} data-status={job.status} aria-label="命令任务">
    <div className="command-job-card__head">
      <button className="command-job-card__toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <strong>{job.background ? '后台命令' : '执行命令'}</strong>
        <span className={`command-job-card__status${cancelledByStop ? ' command-job-card__status--stopped' : ''}`} role="status" aria-label="命令状态">
          {feedback?.label ?? commandJobDisplayLabel(job)}
        </span>
      </button>
      {active && belongs ? <button className="subagent-card__stop" disabled={!ready || stopping || job.status === 'cancelling'} title="停止命令" onClick={() => { void stop() }}>{stopping || job.status === 'cancelling' ? '正在停止…' : '停止命令'}</button> : null}
    </div>
    <div className={`command-job-card__command${commandIsLong ? ' command-job-card__command--long' : ''}`}>
      {commandIsLong ? (
        <button type="button" className="command-job-card__command-toggle" aria-label={commandOpen ? '收起命令详情' : '展开完整命令'} aria-expanded={commandOpen} onClick={() => setCommandOpen(value => !value)}>
          <code>{commandText}</code>
          <span aria-hidden="true">{commandOpen ? '收起' : '展开'}</span>
        </button>
      ) : <code>{commandText}</code>}
    </div>
    {remoteReadOnly ? <div className="command-job-card__meta">远端命令任务</div> : null}
    <div className="command-job-card__meta" title={job.cwd}>工作目录：{job.cwd}{cancelledByStop || job.exitCode === null ? '' : ` · 退出码 ${job.exitCode}`}{!cancelledByStop && job.signal ? ` · ${job.signal}` : ''}</div>
    {job.ownerSessionId !== sessionId ? <div className="command-job-card__meta">子代理任务：{job.ownerRunId ?? job.ownerSessionId}</div> : null}
    {job.changeTracking ? <div className="command-job-card__meta" role="note" title={job.changeTracking.note}>
      {job.changeTracking.status === 'observing' ? '正在记录工作区文件变化' : `已记录 ${job.changeTracking.recordedCount ?? 0} 项文件变化`}
      {job.changeTracking.status === 'partial' ? ' · 部分文件未纳入记录' : job.changeTracking.status === 'unavailable' ? ' · 记录不可用' : ''}
      {(job.changeTracking.recordedCount ?? 0) > 0 ? ' · 请在改动中逐项确认回退' : ''}
    </div> : null}
    {stopMessage ? <div className="command-job-card__stop-reason" role="note">{stopMessage}</div> : null}
    {cancelledByStop ? <details className="command-job-card__diagnostics">
      <summary>停止详情</summary>
      <div>退出码：{job.exitCode ?? '未提供'}{job.signal ? ` · 信号：${job.signal}` : ''}</div>
      {job.error ? <div>{job.error.message}（{job.error.code}）</div> : null}
    </details> : null}
    {surfaceMode === 'code' && job.error && !stopMessage ? <div className="message__error" role="alert">{job.error.message} <span>({job.error.code})</span></div> : null}
    {job.status === 'interrupted' ? <div className="command-job-card__meta">任务已中断，未自动重新执行。</div> : null}
    {!belongs ? <div className="message__error" role="alert">命令任务不属于当前会话</div> : null}
    {cancelError ? <div className="message__error" role="alert">{cancelError}</div> : null}
    {outputError ? <div className="message__error" role="alert">{outputError}</div> : null}
    <MotionPresence show={open}><div className="command-job-card__body">
      {surfaceMode === 'work' ? <WorkToolOutcome tool={outcomeTool} /> : null}
      {cached?.output.truncated ? <div className="command-job-card__meta">较早输出已截断，仅显示最近保留的内容。</div> : null}
      <pre className="command-job-card__output" aria-label="命令输出">{cached?.output.entries.length ? cached.output.entries.map(entry => <span key={entry.seq} data-stream={entry.stream} className={entry.stream === 'stderr' ? 'command-job-card__stderr' : undefined}>{entry.text}</span>) : '暂无输出'}</pre>
    </div></MotionPresence>
  </section>
  return surfaceMode === 'work'
    ? <MotionPresence show={!dismissed} className="command-job-card-presence" data-command-presence={job.jobId}>{card}</MotionPresence>
    : card
}
