import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { SubagentRun } from '@shared/subagent'
import { useApp } from '@renderer/core/app-context'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { getEngineSource, subscribeEngineSource } from '@renderer/core/engine/source'
import { getSubagentRuns, refreshSubagentRuns, subscribeSubagents } from '@renderer/core/engine/subagent-store'
import { isSubagentActive } from '@renderer/core/engine/subagent-state'
import { SubagentCard } from '../chat/SubagentCard'
import { workSubagentRole, workSubagentTools } from './work-subagents'
import './work-subagents.css'

export interface WorkSubagentsPanelProps {
  sessionId: string | null
  tools: ToolActivity[]
  busy?: boolean
  active?: boolean
  onContinue?: (run: SubagentRun, prompt: string) => Promise<void>
}

/** Uses Code's live child store and cards so cancellation and history share one source of truth. */
export function WorkSubagentsPanel({ sessionId, tools, busy = false, active: panelActive = true, onContinue }: WorkSubagentsPanelProps): JSX.Element {
  const { ready } = useApp()
  const [revision, setRevision] = useState(0)
  const [filter, setFilter] = useState<'all' | 'active' | 'history'>('all')
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [continuing, setContinuing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const generation = useRef(0)
  const mounted = useRef(true)
  const source = getEngineSource()
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; generation.current++ }
  }, [])
  useLayoutEffect(() => {
    if (!panelActive) return
    const notify = (): void => setRevision(value => value + 1)
    const off = subscribeSubagents(notify)
    const offSource = subscribeEngineSource(notify)
    // Hidden panels keep their continuation draft, but re-read the store before
    // painting when reopened after child updates received by another surface.
    notify()
    return () => { off(); offSource() }
  }, [panelActive])
  useEffect(() => {
    setFilter('all')
    setError('')
    setContinuing(null)
    setDraft('')
    generation.current++
    sendingRef.current = false
    setSending(false)
  }, [sessionId, source])
  useEffect(() => {
    if (!sessionId || !ready || !panelActive) return
    let alive = true
    let pending = false
    const refresh = async (): Promise<void> => {
      if (pending || document.hidden) return
      pending = true
      try {
        await refreshSubagentRuns(sessionId)
        if (alive && source === getEngineSource()) setError('')
      } catch (cause) {
        if (alive && source === getEngineSource()) setError(cause instanceof Error ? cause.message : String(cause))
      } finally { pending = false }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    document.addEventListener('visibilitychange', refresh)
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [sessionId, ready, source, refreshKey, panelActive])
  const children = useMemo(() => sessionId ? workSubagentTools(sessionId, tools, getSubagentRuns(sessionId)) : [], [sessionId, tools, revision])
  const active = (tool: ToolActivity): boolean => tool.subagent ? isSubagentActive(tool.subagent.status) : tool.state === 'running'
  const activeCount = children.filter(active).length
  const visible = children.filter(tool => filter === 'all' || (filter === 'active' ? active(tool) : !active(tool)))
  const continueRun = async (run: SubagentRun): Promise<void> => {
    if (!onContinue || !draft.trim() || busy || sendingRef.current || !ready) return
    sendingRef.current = true
    setSending(true)
    const currentGeneration = generation.current
    const current = (): boolean => mounted.current && currentGeneration === generation.current && source === getEngineSource()
    try {
      await onContinue(run, draft.trim())
      if (current()) { setContinuing(null); setDraft('') }
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause))
    } finally { if (current()) { sendingRef.current = false; setSending(false) } }
  }
  return <section className="work-subagents" aria-label="协作代理">
    <header className="work-subagents__header">
      <div><h3>协作代理</h3><p>{activeCount > 0 ? `${activeCount} 个正在执行 · 共 ${children.length} 个任务` : `${children.length} 个子任务 · 运行记录保留在当前对话`}</p></div>
      <button type="button" disabled={!sessionId || !ready} onClick={() => setRefreshKey(value => value + 1)}>刷新</button>
    </header>
    <div className="work-subagents__filters" role="group" aria-label="筛选代理任务">
      {(['all', 'active', 'history'] as const).map(value => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? '全部' : value === 'active' ? '进行中' : '历史记录'}</button>)}
    </div>
    {error ? <div className="work-subagents__error" role="alert">代理状态更新失败：{error}</div> : null}
    <div className="work-subagents__list">
      {visible.map(tool => <article className="work-subagents__item" key={tool.subagent?.runId || tool.id}>
        <div className="work-subagents__identity"><span>{workSubagentRole(tool.args)}</span>{tool.subagent?.modelId ? <span>{tool.subagent.modelId}</span> : null}</div>
        <SubagentCard tool={tool} sessionId={sessionId!} />
        {tool.subagent?.continuation && onContinue && !active(tool) ? <div className="work-subagents__continue">
          {continuing === tool.subagent.runId ? <form onSubmit={event => { event.preventDefault(); void continueRun(tool.subagent!) }}>
            <label htmlFor={`continue-${tool.subagent.runId}`}>给这个代理的新任务</label>
            <textarea id={`continue-${tool.subagent.runId}`} value={draft} onChange={event => setDraft(event.target.value)} disabled={sending} rows={3} autoFocus placeholder="补充要求或安排下一步，保留已有上下文" />
            <div><button type="button" disabled={sending} onClick={() => setContinuing(null)}>取消</button><button type="submit" disabled={!draft.trim() || busy || sending || !ready}>{sending ? '正在提交…' : '继续执行'}</button></div>
          </form> : <button type="button" disabled={busy || sending || !ready || children.some(other => other.subagent?.childSessionId === tool.subagent?.childSessionId && active(other))} onClick={() => { setContinuing(tool.subagent!.runId); setDraft('') }}>继续此代理</button>}
        </div> : null}
      </article>)}
      {!visible.length ? <p className="work-subagents__empty">{filter === 'active' ? '当前没有正在执行的子代理。' : filter === 'history' ? '完成的子任务会保留在这里，可展开查看结果与调用记录。' : '任务调用子代理后，这里会显示分工、执行进度与结果。'}</p> : null}
    </div>
    {children.length > 0 ? <p className="work-subagents__note">展开任务可查看输出与调用记录。继续执行会保留同一代理的上下文，每轮结果独立保存。</p> : null}
  </section>
}
