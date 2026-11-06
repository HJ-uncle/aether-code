import { memo, useMemo, useState, type JSX } from 'react'
import { Dialog } from '@renderer/workbench/Dialog'
import { BrowserSnapshotResult } from './BrowserSnapshotResult'
import { parseToolResult, type ParsedToolResult, type ToolResultImage } from './tool-result'
import { AutomationCard } from '../automations/AutomationCard'
import { parseAutomationReceipt } from '../automations/automation-draft'
import { looksLikeStructuredResult, ToolResultData } from './ToolResultData'
import { parseToolResultData } from './tool-result-data'
import './tool-result.css'

function ResultImage({ image }: { image: ToolResultImage }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [failedSource, setFailedSource] = useState('')
  const failed = failedSource === image.src
  return (
    <figure className="tool-result__image">
      {failed ? <div className="tool-result__image-error" role="status">图片无法显示</div> : (
        <button type="button" className="tool-result__preview" aria-label={`放大查看 ${image.alt}`} onClick={() => setExpanded(true)}>
          <img src={image.src} alt={image.alt} decoding="async" onError={() => setFailedSource(image.src)} />
        </button>
      )}
      {/* Controlled presence lets a keyboard reopen cancel the closing animation. */}
      <Dialog title={image.alt} className="modal--tool-result-image" width={960} open={expanded} onClose={() => setExpanded(false)}>
        <div className="tool-result__expanded"><img src={image.src} alt={image.alt} /></div>
      </Dialog>
    </figure>
  )
}

/** The same renderer is used for parent tools, child tools and restored history. */
export const ToolResult = memo(function ToolResult({
  value,
  parsed,
  toolName,
  textClassName,
  structured = false,
  surfaceMode = 'code'
}: {
  value?: unknown
  parsed?: ParsedToolResult
  toolName?: string
  textClassName?: string
  structured?: boolean
  surfaceMode?: 'code' | 'work'
}): JSX.Element {
  const result = useMemo(() => parsed ?? parseToolResult(value), [parsed, value])
  const data = useMemo(() => (structured || surfaceMode === 'work') && !result.images.length && !result.browserSnapshots?.length ? parseToolResultData(result.text) : null, [structured, surfaceMode, result])
  const receipt = useMemo(() => ['cron_create', 'cron_update'].includes(toolName ?? '')
    ? parseAutomationReceipt(value ?? result.text) : null, [toolName, value, result.text])
  if (receipt) return <><AutomationCard receipt={receipt} />{surfaceMode === 'code' ? <details className="automation-card-receipt"><summary>原始收据</summary><pre className={textClassName}>{result.text}</pre></details> : null}</>
  if (data) return <ToolResultData data={data} raw={result.text} surfaceMode={surfaceMode} />
  if (!result.images.length && !result.browserSnapshots?.length) {
    // Unbounded or incomplete JSON is not a useful user-facing fallback. Keep
    // ordinary prose/logs verbatim, without exposing a second diagnostic view.
    if (surfaceMode === 'work' && looksLikeStructuredResult(result.text)) return <div className="tool-result__summary">结果已返回，暂无可展示的摘要</div>
    return <pre className={textClassName}>{result.text}</pre>
  }
  return (
    <div className="tool-result">
      <div className="tool-result__images">
        {result.images.map((image, index) => <ResultImage key={`${index}:${image.alt}`} image={image} />)}
        {result.browserSnapshots?.map((snapshot, index) => <BrowserSnapshotResult key={`${index}:${snapshot.url}`} snapshot={snapshot} clickResult={toolName === 'browser_click'} surfaceMode={surfaceMode} />)}
      </div>
      {result.text && surfaceMode === 'code' ? (
        <details className="tool-result__metadata">
          <summary>{result.browserSnapshots?.length ? '原始数据' : '结果详情'}</summary>
          <pre className={textClassName}>{result.text}</pre>
        </details>
      ) : null}
    </div>
  )
})
