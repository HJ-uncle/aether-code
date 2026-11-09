import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import type { SubagentResultPage, SubagentRun } from '@shared/subagent'
import { useApp } from '@renderer/core/app-context'
import { captureSubagentConnection, getSubagentResultPage } from '@renderer/core/engine/client'
import { getEngineSource } from '@renderer/core/engine/source'
import { subagentResultPresentation } from '@renderer/core/engine/subagent-result'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import './subagent-result-reader.css'

/** Keep a single page resident. Closing releases it; history stores only byte offsets. */
export function SubagentResultReader({ run, visible, children }: {
  run: SubagentRun; visible: boolean; children: ReactNode
}): JSX.Element {
  const { ready } = useApp()
  const identity = JSON.stringify([getEngineSource(), run.runId, run.parentSessionId, run.resultRef])
  const [page, setPage] = useState<SubagentResultPage>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const pending = useRef(false)
  const previous = useRef<number[]>([])
  const result = subagentResultPresentation(run)
  const reset = (): void => {
    generation.current++
    pending.current = false
    previous.current = []
    setPage(undefined)
    setError('')
    setLoading(false)
  }
  useEffect(() => { reset(); return () => { generation.current++ } }, [identity, ready, visible])

  const read = async (offset: number): Promise<void> => {
    if (!ready || !visible || pending.current) return
    const epoch = generation.current, connection = captureSubagentConnection()
    const current = (): boolean => epoch === generation.current && connection.source === getEngineSource()
    pending.current = true
    setLoading(true)
    setError('')
    try {
      const next = await getSubagentResultPage(run, { connection, offset, limitBytes: 16 * 1024 })
      if (!current()) return
      if (page && offset > page.offset) previous.current = [...previous.current, page.offset].slice(-64)
      else if (page && offset < page.offset) previous.current = previous.current.filter(value => value < offset)
      setPage(next)
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (current()) { pending.current = false; setLoading(false) } }
  }

  return <div className="subagent-result-reader" aria-busy={loading}>
    {!page && result.notice ? <p className="subagent-result-reader__notice">{result.notice}</p> : null}
    {result.referenced && (result.truncated || page) ? <div className="subagent-result-reader__actions">
      <button type="button" className="subagent-result-reader__read" disabled={!ready || !visible || loading}
        onClick={() => page ? reset() : void read(0)} aria-expanded={Boolean(page)}>
        {loading ? <Spinner size={12} /> : <Icon name={page ? 'chevron-up' : 'file'} size={14} />}
        {page ? '返回预览' : '读取完整结果'}
      </button>
      {page ? <>
        <span className="subagent-result-reader__range" role="status">{page.offset.toLocaleString()}–{(page.offset + new TextEncoder().encode(page.text).byteLength).toLocaleString()} / {page.totalBytes.toLocaleString()} bytes{page.hasMore || page.offset > 0 ? ' · 分页内容' : ' · 完整内容'}</span>
        <button type="button" className="subagent-result-reader__page" aria-label="从头读取结果" title="从头读取结果"
          disabled={loading || page.offset === 0} onClick={() => { previous.current = []; void read(0) }}><Icon name="restart" size={16} /></button>
        <button type="button" className="subagent-result-reader__page" aria-label="上一页结果" title="上一页结果"
          disabled={loading || !previous.current.length} onClick={() => void read(previous.current.at(-1)!)}><Icon name="chevron-left" size={16} /></button>
        <button type="button" className="subagent-result-reader__page" aria-label="下一页结果" title="下一页结果"
          disabled={loading || !page.hasMore} onClick={() => { if (page.nextOffset !== undefined) void read(page.nextOffset) }}><Icon name="chevron-right" size={16} /></button>
      </> : null}
    </div> : null}
    {error ? <p className="subagent-result-reader__error" role="alert">{error}</p> : null}
    {/* A page can start inside Markdown syntax, so preserve its exact text instead of inventing formatting. */}
    {page ? <pre className="subagent-result-reader__text">{page.text}</pre> : children}
  </div>
}
