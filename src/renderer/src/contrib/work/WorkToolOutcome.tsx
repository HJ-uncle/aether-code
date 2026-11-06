import { useEffect, useState, type JSX } from 'react'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { exportToolDiagnostics, toolFailureMessage } from '@renderer/core/engine/tool-feedback'
import { toast } from '@renderer/core/toast'
import { Icon } from '@renderer/workbench/icons'
import { workToolFeedback } from './work-tool-feedback'
import './work-tool-outcome.css'

/** A step can fail during normal iteration; only the root run owns task alerts. */
export function WorkToolOutcome({ tool, state = tool.state }: { tool: ToolActivity; state?: ToolActivity['state'] }): JSX.Element | null {
  const feedback = workToolFeedback(tool, state)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1800)
    return () => window.clearTimeout(timer)
  }, [copied])
  if (!feedback) return null
  const diagnostic = toolFailureMessage(tool)
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(exportToolDiagnostics(tool) || feedback.detail); setCopied(true) }
    catch { toast.error('复制诊断失败，请重试') }
  }
  return <div className="work-tool-outcome" role="note">
    <div className="work-tool-outcome__summary"><span>{feedback.detail}</span>
    <button type="button" aria-label={copied ? '已复制诊断' : '复制诊断'} title={copied ? '已复制' : '复制命令、错误与输出'} onClick={() => void copy()}>
      <Icon name={copied ? 'check' : 'copy'} size={12} /><span>{copied ? '已复制' : '复制诊断'}</span>
    </button></div>
    {diagnostic && diagnostic !== feedback.detail && !tool.result.includes(diagnostic) ? <details className="work-tool-outcome__diagnostic">
      <summary>诊断详情</summary><pre>{diagnostic}</pre>
    </details> : null}
  </div>
}
